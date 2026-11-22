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
  return problems;
}
