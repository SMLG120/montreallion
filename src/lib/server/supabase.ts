import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { checkDisplayName } from "@/lib/game/names";
import { entitlements, sanitizeLook, type Appearance } from "@/lib/game/climb";
import { accountStats, type AccountStats } from "@/lib/game/profile";
import { dateKey } from "@/lib/game/daily";
import { defaultStore } from "@/lib/game/store";

/**
 * Accounts (phase F): Supabase Auth, called only from the server with the project's public anon/publishable key.
 * Profile rows are read and written with the signed-in user's own session, so Postgres RLS enforces ownership;
 * no service-role key is used anywhere. Game data (rides, names on leaderboards) stays on the game database,
 * linked by the opaque auth user id. Emails are returned only to their owner and never stored with game data.
 */
export function authConfig(env: NodeJS.ProcessEnv = process.env): { url: string; key: string } | null {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
  return url && key ? { url, key } : null;
}

/** A per-request Supabase client bound to the request's auth cookies (route handlers only: it may refresh them). */
export async function supabaseForRequest() {
  const cfg = authConfig();
  if (!cfg) return null;
  const jar = await cookies();
  return createServerClient(cfg.url, cfg.key, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (list) => {
        for (const { name, value, options } of list) jar.set(name, value, options);
      },
    },
  });
}

export type Me = { email: string; displayName: string | null; appearance: Appearance; fresh: boolean; stats: AccountStats };

/** The verified signed-in user (checked with the Auth server, not just the cookie), or null. */
export async function currentUser(sb: NonNullable<Awaited<ReturnType<typeof supabaseForRequest>>>) {
  const { data, error } = await sb.auth.getUser();
  return error || !data.user ? null : { id: data.user.id, email: data.user.email ?? "" };
}

export async function loadMe(sb: NonNullable<Awaited<ReturnType<typeof supabaseForRequest>>>, user: { id: string; email: string }): Promise<Me> {
  const store = await defaultStore();
  const [{ data: profile }, players] = await Promise.all([
    sb.from("profiles").select("display_name, appearance").eq("id", user.id).maybeSingle(),
    store.accountPlayers(user.id),
  ]);
  const stats = accountStats(await store.finishedRides(players, 500), dateKey());
  const raw = (profile?.appearance ?? {}) as Record<string, unknown>;
  return {
    email: user.email,
    displayName: profile?.display_name ?? null,
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
