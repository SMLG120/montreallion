import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
/** Test-only admin secret, used unless ADMIN_TOKEN is already set in the environment. */
export const E2E_ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "e2e-admin-token-not-for-production-0001";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [
    // Each project is a different "player" for the per-IP rate limits (20 game starts/min), as real players would be.
    // Local `next start` trusts x-forwarded-for; on Vercel the platform sets it, so production limits are unaffected.
    { name: "desktop", use: { ...devices["Desktop Chrome"], extraHTTPHeaders: { "x-forwarded-for": "198.51.100.1" } } },
    { name: "mobile", use: { ...devices["Pixel 7"], extraHTTPHeaders: { "x-forwarded-for": "198.51.100.2" } } },
  ],
  webServer: {
    command: `npm run build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    // Accounts run on the in-memory test auth backend (no local Neon Auth emulator exists); refused on Vercel.
    env: { ADMIN_TOKEN: E2E_ADMIN_TOKEN, AUTH_DEV_BACKEND: "1" },
  },
});
