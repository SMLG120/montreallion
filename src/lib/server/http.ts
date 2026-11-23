import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { GameError } from "@/lib/game/engine";
import { getSql } from "./db";
import { pgRateHit } from "./rate-limit-pg";

export const PLAYER_COOKIE = "ml_pid";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Anonymous player identity stored in an httpOnly cookie (no signup needed). */
export async function getPlayerId(create: boolean): Promise<string | null> {
  const jar = await cookies();
  const existing = jar.get(PLAYER_COOKIE)?.value;
  if (existing && UUID_RE.test(existing)) return existing;
  if (!create) return null;
  const id = randomUUID();
  jar.set(PLAYER_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 400,
  });
  return id;
}

/* ---------- Fixed-window rate limiter: Postgres when configured (shared across instances), else memory. ---------- */
type Bucket = { count: number; resetAt: number };
const g = globalThis as unknown as { __mlRate?: Map<string, Bucket> };
const buckets = (g.__mlRate ??= new Map());

function clientKey(ip: string): string {
  // Never store raw IPs: salted hash, truncated.
  return createHash("sha256")
    .update(`${process.env.RATE_LIMIT_SALT ?? "montreallion"}:${ip}`)
    .digest("hex")
    .slice(0, 32);
}

export async function rateLimit(scope: string, limit: number, windowMs = 60_000): Promise<boolean> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
  const key = `${scope}:${clientKey(ip)}`;
  const sql = getSql();
  if (sql) {
    return (await pgRateHit(sql, key, windowMs / 1000)) <= limit;
  }
  const now = Date.now();
  if (buckets.size > 10_000) for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  b.count += 1;
  return b.count <= limit;
}

export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function errorResponse(e: unknown) {
  if (e instanceof GameError) {
    const status = { not_found: 404, forbidden: 403, out_of_order: 409, not_served: 409, finished: 409, unavailable: 422, bad_choice: 409 }[e.code];
    return json({ error: e.code }, status);
  }
  console.error(e);
  return json({ error: "server_error" }, 500);
}

export const tooMany = () => json({ error: "rate_limited" }, 429);
