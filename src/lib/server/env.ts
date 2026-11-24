import "server-only";

/**
 * Deployment configuration problems (names only, never values).
 * Checked by /api/health; a deployed instance with any problem reports 503.
 */
export function configProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const deployed = Boolean(env.VERCEL) || (env.NODE_ENV === "production" && Boolean(env.REQUIRE_PROD_CONFIG));
  if (!deployed) return [];
  const problems: string[] = [];
  const url = env.DATABASE_URL || env.POSTGRES_URL;
  if (!url) problems.push("DATABASE_URL (or POSTGRES_URL) missing");
  else if (/:5432\//.test(url) && /pooler\.supabase\.com/.test(url)) problems.push("DATABASE_URL uses the session pooler (5432); use the transaction pooler (6543) on serverless");
  if (!env.RATE_LIMIT_SALT || env.RATE_LIMIT_SALT.length < 16) problems.push("RATE_LIMIT_SALT missing or shorter than 16 characters");
  const pool = Number(env.DATABASE_POOL_MAX ?? 5);
  if (!(pool >= 1 && pool <= 3)) problems.push("DATABASE_POOL_MAX should be 1-3 on serverless");
  if (env.ADMIN_TOKEN && env.ADMIN_TOKEN.length < 24) problems.push("ADMIN_TOKEN shorter than 24 characters (admin disabled)");
  const sbUrl = env.SUPABASE_URL;
  const sbKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
  if (Boolean(sbUrl) !== Boolean(sbKey)) problems.push("SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_PUBLISHABLE_KEY) must be set together (accounts disabled)");
  if (sbUrl && !/^https:\/\//.test(sbUrl)) problems.push("SUPABASE_URL must be https");
  if (env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY) problems.push("A Supabase service-role key is set; the app never needs it, so remove it");
  return problems;
}
