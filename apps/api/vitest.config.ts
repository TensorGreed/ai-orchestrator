import { defineConfig } from "vitest/config";

// Phase 13.1 — Postgres test stores are cloned from one template the global setup migrates (only when
// TEST_POSTGRES_URL is set); each file drops its databases after its last test. SQLite runs are unaffected.
export default defineConfig({
  test: {
    globalSetup: ["./src/test-support/postgres-global-setup.ts"],
    setupFiles: ["./src/test-support/postgres-file-setup.ts"]
  }
});
