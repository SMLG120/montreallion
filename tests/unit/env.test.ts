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
  it("accounts: needs URL and key together, https only, and never a service-role key", () => {
    const env = (x: Record<string, string>) => configProblems({ ...good, ...x } as unknown as NodeJS.ProcessEnv);
    expect(env({ SUPABASE_URL: "https://abc.supabase.co", SUPABASE_ANON_KEY: "k" })).toEqual([]);
    expect(env({ SUPABASE_URL: "https://abc.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x" })).toEqual([]);
    expect(env({ SUPABASE_URL: "https://abc.supabase.co" })).toEqual([expect.stringMatching(/together/)]);
    expect(env({ SUPABASE_URL: "http://abc", SUPABASE_ANON_KEY: "k" })).toEqual([expect.stringMatching(/https/)]);
    expect(env({ SUPABASE_URL: "https://abc.supabase.co", SUPABASE_ANON_KEY: "k", SUPABASE_SERVICE_ROLE_KEY: "s" })).toEqual([expect.stringMatching(/service-role/)]);
  });
});
