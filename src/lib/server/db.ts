import postgres from "postgres";
import { cleanDbUrl, isLocalDb } from "./db-url";

/**
 * Server-only Postgres client (Supabase in production).
 * DATABASE_URL should be the Supabase *transaction pooler* URL (port 6543) on Vercel;
 * prepared statements are disabled for pgbouncer/Supavisor compatibility.
 * Returns null when no database is configured (local dev falls back to memory).
 */
type Sql = ReturnType<typeof postgres>;
const g = globalThis as unknown as { __mlSql?: Sql | null };

export function getSql(): Sql | null {
  if (g.__mlSql !== undefined) return g.__mlSql;
  // POSTGRES_URL is the transaction-pooler URL the Vercel ↔ Supabase integration injects.
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    if (process.env.VERCEL) throw new Error("DATABASE_URL is required in deployed environments (in-memory sessions are not safe on serverless).");
    return (g.__mlSql = null);
  }
  g.__mlSql = postgres(cleanDbUrl(url), {
    prepare: false,
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
    ssl: isLocalDb(url) ? false : "require",
  });
  return g.__mlSql;
}

export type { Sql };
