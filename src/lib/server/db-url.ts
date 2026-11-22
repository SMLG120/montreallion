/**
 * Normalizes a Postgres URL for postgres.js: drops query params that postgres.js would forward as
 * server settings (Supabase adds `supa=...`, Neon `channel_binding=...`), and `sslmode` (TLS is set explicitly).
 * Shared by the app and scripts/db.ts, so no server-only import.
 */
export function cleanDbUrl(raw: string): string {
  const u = new URL(raw);
  for (const k of ["supa", "sslmode", "pgbouncer", "channel_binding"]) u.searchParams.delete(k);
  return u.toString();
}

export const isLocalDb = (url: string) => /@?(localhost|127\.0\.0\.1)[:/]/.test(url);
