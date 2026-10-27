/**
 * Phase 13.1 — vitest setup file (vitest.config.ts): after a file's last test, drops the Postgres test databases its
 * stores' cleanups deferred. Nothing to do on SQLite.
 */
import { afterAll } from "vitest";
import { dropPendingTestDatabases } from "./test-store.js";

afterAll(async () => {
  await dropPendingTestDatabases();
}, 600_000);
