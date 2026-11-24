import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock("@neon/auth/next/server", () => ({ createNeonAuth: () => ({}) }));

const { authConfig, devCore } = await import("@/lib/server/auth");
const env = (x: Record<string, string>) => x as unknown as NodeJS.ProcessEnv;

describe("authConfig", () => {
  const secret = "s".repeat(32);
  it("is off without configuration", () => expect(authConfig(env({}))).toBeNull());
  it("uses Neon Auth with an https URL and a 32+ character cookie secret", () => {
    expect(authConfig(env({ NEON_AUTH_BASE_URL: "https://x.neon.tech/auth", NEON_AUTH_COOKIE_SECRET: secret }))).toEqual({ kind: "neon", baseUrl: "https://x.neon.tech/auth", secret });
    expect(authConfig(env({ NEON_AUTH_BASE_URL: "http://x", NEON_AUTH_COOKIE_SECRET: secret }))).toBeNull();
    expect(authConfig(env({ NEON_AUTH_BASE_URL: "https://x", NEON_AUTH_COOKIE_SECRET: "short" }))).toBeNull();
  });
  it("allows the in-memory test backend only off Vercel", () => {
    expect(authConfig(env({ AUTH_DEV_BACKEND: "1" }))).toEqual({ kind: "dev" });
    expect(authConfig(env({ AUTH_DEV_BACKEND: "1", VERCEL: "1" }))).toBeNull();
  });
  it("prefers Neon Auth when both are set", () => {
    expect(authConfig(env({ AUTH_DEV_BACKEND: "1", NEON_AUTH_BASE_URL: "https://x", NEON_AUTH_COOKIE_SECRET: secret }))?.kind).toBe("neon");
  });
});

describe("test backend core", () => {
  it("issues 6-digit single-use codes and stable user ids", () => {
    const core = devCore();
    const code = core.issue("a@x.test");
    expect(code).toMatch(/^\d{6}$/);
    const ok = core.verify("a@x.test", code);
    expect(typeof ok).toBe("object");
    expect(core.verify("a@x.test", code)).toBe("invalid"); // used
    const again = core.verify("a@x.test", core.issue("a@x.test"));
    if (typeof ok !== "object" || typeof again !== "object") throw new Error("expected sessions");
    expect(again.user.id).toBe(ok.user.id);
    expect(core.session(ok.token)).toEqual(ok.user);
    core.end(ok.token);
    expect(core.session(ok.token)).toBeNull();
  });
  it("refuses wrong, expired and brute-forced codes", () => {
    let t = 0;
    const core = devCore(() => t);
    const code = core.issue("b@x.test");
    const wrong = code === "000000" ? "111111" : "000000";
    expect(core.verify("b@x.test", wrong)).toBe("invalid");
    expect(core.verify("c@x.test", code)).toBe("invalid"); // another address
    for (let i = 0; i < 4; i++) core.verify("b@x.test", wrong);
    expect(core.verify("b@x.test", code)).toBe("rate"); // 5 tries used
    const fresh = core.issue("b@x.test");
    t += 11 * 60_000;
    expect(core.verify("b@x.test", fresh)).toBe("invalid"); // expired
  });
});
