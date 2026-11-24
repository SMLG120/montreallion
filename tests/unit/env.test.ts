import { describe, expect, it } from "vitest";
import { configProblems } from "@/lib/server/env";

const good = { VERCEL: "1", DATABASE_URL: "postgres://u:p@aws-0-ca-central-1.pooler.supabase.com:6543/postgres", RATE_LIMIT_SALT: "x".repeat(32), DATABASE_POOL_MAX: "1" };

describe("configProblems", () => {
  it("is silent outside deployments", () => expect(configProblems({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toEqual([]));
  it("accepts a complete Vercel config", () => expect(configProblems(good as unknown as NodeJS.ProcessEnv)).toEqual([]));
  it("flags missing database, weak salt, big pool, session pooler and short admin token", () => {
    expect(configProblems({ VERCEL: "1" } as unknown as NodeJS.ProcessEnv)).toEqual(expect.arrayContaining([expect.stringMatching(/DATABASE_URL/), expect.stringMatching(/RATE_LIMIT_SALT/)]));
    const p = configProblems({ ...good, DATABASE_URL: good.DATABASE_URL.replace("6543", "5432"), DATABASE_POOL_MAX: "10", ADMIN_TOKEN: "short" } as unknown as NodeJS.ProcessEnv);
    expect(p).toHaveLength(3);
  });
  it("accounts: Neon Auth URL and cookie secret together, https, 32+ char secret; test backend flagged", () => {
    const env = (x: Record<string, string>) => configProblems({ ...good, ...x } as unknown as NodeJS.ProcessEnv);
    const secret = "s".repeat(32);
    expect(env({ NEON_AUTH_BASE_URL: "https://ep-x.neonauth.us-east-1.aws.neon.tech/neondb/auth", NEON_AUTH_COOKIE_SECRET: secret })).toEqual([]);
    expect(env({ NEON_AUTH_BASE_URL: "https://ep-x.neonauth.aws.neon.tech/auth" })).toEqual([expect.stringMatching(/together/)]);
    expect(env({ NEON_AUTH_BASE_URL: "http://x", NEON_AUTH_COOKIE_SECRET: secret })).toEqual([expect.stringMatching(/https/)]);
    expect(env({ NEON_AUTH_BASE_URL: "https://x", NEON_AUTH_COOKIE_SECRET: "short" })).toEqual([expect.stringMatching(/32/)]);
    expect(env({ AUTH_DEV_BACKEND: "1" })).toEqual([expect.stringMatching(/test-only/)]);
  });
});
