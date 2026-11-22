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
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npm run build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: { ADMIN_TOKEN: E2E_ADMIN_TOKEN },
  },
});
