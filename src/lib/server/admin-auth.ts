import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const ADMIN_COOKIE = "ml_admin";
const TTL_S = 12 * 60 * 60;
const MIN_TOKEN = 24;

/** The console is disabled unless ADMIN_TOKEN is set to a long random secret. */
export function adminEnabled(token = process.env.ADMIN_TOKEN): boolean {
  return !!token && token.length >= MIN_TOKEN;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");
const sign = (payload: string, token: string) => createHmac("sha256", `ml-admin:${token}`).update(payload).digest("base64url");

/** Constant-time check of a submitted token (hashing first equalizes lengths). */
export function tokenMatches(input: string, token = process.env.ADMIN_TOKEN ?? ""): boolean {
  if (!adminEnabled(token)) return false;
  const a = createHash("sha256").update(input).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

/** Cookie value: <expiry>.<b64 reviewer>.<hmac>. Rotating ADMIN_TOKEN invalidates every session. */
export function makeAdminSession(reviewer: string, now = Date.now(), token = process.env.ADMIN_TOKEN ?? ""): string {
  const payload = `${Math.floor(now / 1000) + TTL_S}.${b64(reviewer)}`;
  return `${payload}.${sign(payload, token)}`;
}

export function readAdminSession(value: string | undefined, now = Date.now(), token = process.env.ADMIN_TOKEN ?? ""): { reviewer: string } | null {
  if (!value || !adminEnabled(token)) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [exp, who, sig] = parts;
  const expected = sign(`${exp}.${who}`, token);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < now) return null;
  const reviewer = unb64(who);
  return reviewer ? { reviewer } : null;
}

export async function getAdmin(): Promise<{ reviewer: string } | null> {
  return readAdminSession((await cookies()).get(ADMIN_COOKIE)?.value);
}

/** Use at the top of every admin page and server action. */
export async function requireAdmin(): Promise<{ reviewer: string }> {
  const a = await getAdmin();
  if (!a) redirect("/admin/login");
  return a;
}

export async function setAdminCookie(reviewer: string) {
  (await cookies()).set(ADMIN_COOKIE, makeAdminSession(reviewer), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: TTL_S,
  });
}

export async function clearAdminCookie() {
  (await cookies()).delete(ADMIN_COOKIE);
}
