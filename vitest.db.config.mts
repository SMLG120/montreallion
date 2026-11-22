import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Postgres integration tests. Requires TEST_DATABASE_URL pointing at a disposable local *_test database. */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: { include: ["tests/integration/**/*.test.ts"], environment: "node", fileParallelism: false, testTimeout: 20_000, hookTimeout: 60_000 },
});
