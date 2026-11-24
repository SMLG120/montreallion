import "server-only";
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { createNeonAuth } from "@neon/auth/next/server";
import { checkDisplayName } from "@/lib/game/names";
import { entitlements, sanitizeLook, type Appearance } from "@/lib/game/climb";
import { accountStats, type AccountStats } from "@/lib/game/profile";
import { dateKey } from "@/lib/game/daily";
import { defaultStore } from "@/lib/game/store";

/**
 * Accounts: email + one-time code sign-in through Neon Auth (managed Better Auth), called only from the server.
 * Sign-up, sign-in and recovery are the same flow. Users, emails and sessions live in Neon Auth; the game database
 * stores only the opaque user id (account_players, account_profiles). Emails go only to their owner.
 *
 * A second, in-memory backend exists for end-to-end tests only (there is no local Neon Auth emulator). It needs
 * AUTH_DEV_BACKEND=1 and is refused on Vercel; /api/health reports it as a problem if it's set there.
 */
export type AuthUser = { id: string; email: string };
export type SendResult = { ok: true } | { ok: false; reason: "rate" | "failed" };
export type VerifyResult = { ok: true; user: AuthUser } | { ok: false; reason: "invalid" | "rate" | "failed" };

export interface AuthBackend {
  kind: "neon" | "dev";
  sendCode(email: string): Promise<SendResult>;
  verifyCode(email: string, code: string): Promise<VerifyResult>;
  currentUser(): Promise<AuthUser | null>;
  signOut(): Promise<void>;
}

export type AuthConfig = { kind: "neon"; baseUrl: string; secret: string } | { kind: "dev" } | null;

export function authConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const baseUrl = env.NEON_AUTH_BASE_URL;
  const secret = env.NEON_AUTH_COOKIE_SECRET;
  if (baseUrl && secret && /^https:\/\//.test(baseUrl) && secret.length >= 32) return { kind: "neon", baseUrl, secret };
  if (env.AUTH_DEV_BACKEND === "1" && !env.VERCEL) return { kind: "dev" };
  return null;
}

const g = globalThis as unknown as { __mlAuth?: { key: string; backend: AuthBackend } };

/** The configured backend, or null when accounts are off on this deployment. */
export function authBackend(): AuthBackend | null {
  const cfg = authConfig();
  if (!cfg) return null;
  const key = cfg.kind === "neon" ? `neon:${cfg.baseUrl}` : "dev";
  if (g.__mlAuth?.key !== key) g.__mlAuth = { key, backend: cfg.kind === "neon" ? neonBackend(cfg.baseUrl, cfg.secret) : devBackend() };
  return g.__mlAuth.backend;
}

/* ---------------- Neon Auth ---------------- */

type ApiResult = Promise<{ data: unknown; error: { status?: number; message?: string } | null }>;
/**
 * The server SDK proxies every Better Auth endpoint (its endpoint table includes `email-otp/send-verification-otp`
 * and `sign-in/email-otp`), but its TypeScript surface omits the email-OTP plugin methods; this is that subset.
 */
type EmailOtpServer = {
  emailOtp: { sendVerificationOtp(args: { email: string; type: "sign-in" }): ApiResult };
  signIn: { emailOtp(args: { email: string; otp: string }): ApiResult };
  getSession(): ApiResult;
  signOut(): ApiResult;
};

function neonBackend(baseUrl: string, secret: string): AuthBackend {
  const auth = createNeonAuth({ baseUrl, cookies: { secret }, logLevel: "warn" }) as unknown as EmailOtpServer;
  return {
    kind: "neon",
    async sendCode(email) {
      const { error } = await auth.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
      if (!error) return { ok: true };
      return { ok: false, reason: error.status === 429 ? "rate" : "failed" };
    },
    async verifyCode(email, code) {
      const { data, error } = await auth.signIn.emailOtp({ email, otp: code });
      if (error) return { ok: false, reason: error.status === 429 ? "rate" : error.status && error.status < 500 ? "invalid" : "failed" };
      const user = (data as { user?: { id?: string; email?: string } } | null)?.user;
      return user?.id ? { ok: true, user: { id: user.id, email: user.email ?? email } } : { ok: false, reason: "failed" };
    },
    async currentUser() {
      const { data } = await auth.getSession();
      const user = (data as { user?: { id?: string; email?: string } } | null)?.user;
      return user?.id ? { id: user.id, email: user.email ?? "" } : null;
    },
    async signOut() {
      await auth.signOut();
    },
  };
}

/* ---------------- dev/test backend (never on Vercel) ---------------- */

const DEV_COOKIE = "ml_dev_session";
const CODE_TTL_MS = 10 * 60_000;
const MAX_TRIES = 5;

/** Pure in-memory core of the test backend (exported for unit tests). */
export function devCore(now: () => number = Date.now) {
  const codes = new Map<string, { code: string; exp: number; tries: number }>();
  const users = new Map<string, string>(); // email → id
  const sessions = new Map<string, string>(); // token → email
  return {
    issue(email: string) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      codes.set(email, { code, exp: now() + CODE_TTL_MS, tries: 0 });
      return code;
    },
    lastCode: (email: string) => codes.get(email)?.code ?? null,
    verify(email: string, code: string): { token: string; user: AuthUser } | "invalid" | "rate" {
      const c = codes.get(email);
      if (!c || c.exp < now()) return "invalid";
      if (c.tries >= MAX_TRIES) return "rate";
      c.tries++;
      const a = Buffer.from(c.code);
      const b = Buffer.from(code.padEnd(6).slice(0, 6));
      if (a.length !== b.length || !timingSafeEqual(a, b)) return "invalid";
      codes.delete(email); // one use
      if (!users.has(email)) users.set(email, randomUUID());
      const token = randomBytes(24).toString("base64url");
      sessions.set(token, email);
      return { token, user: { id: users.get(email)!, email } };
    },
    session(token: string | undefined): AuthUser | null {
      const email = token ? sessions.get(token) : undefined;
      return email ? { id: users.get(email)!, email } : null;
    },
    end(token: string | undefined) {
      if (token) sessions.delete(token);
    },
  };
}

const gd = globalThis as unknown as { __mlDevAuth?: ReturnType<typeof devCore> };
export const devAuth = () => (gd.__mlDevAuth ??= devCore());

function devBackend(): AuthBackend {
  const core = devAuth();
  return {
    kind: "dev",
    async sendCode(email) {
      core.issue(email);
      return { ok: true };
    },
    async verifyCode(email, code) {
      const r = core.verify(email, code);
      if (r === "invalid" || r === "rate") return { ok: false, reason: r };
      (await cookies()).set(DEV_COOKIE, r.token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
      return { ok: true, user: r.user };
    },
    async currentUser() {
      return core.session((await cookies()).get(DEV_COOKIE)?.value);
    },
    async signOut() {
      const jar = await cookies();
      core.end(jar.get(DEV_COOKIE)?.value);
      jar.delete(DEV_COOKIE);
    },
  };
}

/* ---------------- profile + progress ---------------- */

export type Me = { email: string; displayName: string | null; appearance: Appearance; fresh: boolean; stats: AccountStats };

export async function loadMe(user: AuthUser): Promise<Me> {
  const store = await defaultStore();
  const [profile, players] = await Promise.all([store.getProfile(user.id), store.accountPlayers(user.id)]);
  const stats = accountStats(await store.finishedRides(players, 500), dateKey());
  const raw = profile?.appearance ?? {};
  return {
    email: user.email,
    displayName: profile?.displayName ?? null,
    appearance: sanitizeLook(raw, entitlements(true, stats.achievements)),
    fresh: Object.keys(raw).length === 0,
    stats,
  };
}

/** Link this device's guest player to the account and carry the account's public name onto it. */
export async function linkDevice(userId: string, playerId: string, displayName: string | null) {
  const store = await defaultStore();
  await store.ensurePlayer(playerId);
  const ok = await store.linkAccount(userId, playerId);
  if (ok && displayName) await store.setDisplayName(playerId, displayName);
  return ok;
}

export { checkDisplayName };
