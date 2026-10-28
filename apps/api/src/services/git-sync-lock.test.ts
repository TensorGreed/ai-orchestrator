/**
 * Phase 13.1 — git sync under a cluster lock: a pull or push runs inside it, and one that cannot get it answers
 * "busy" without touching the clone.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Store } from "../db/store.js";
import { openTestStore } from "../test-support/test-store.js";
import { GIT_SYNC_BUSY_ERROR, GitSyncService } from "./git-sync-service.js";
import { SecretService } from "./secret-service.js";
import { VariablesService } from "./variables-service.js";

let tempDir: string;
let store: Store;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-git-lock-"));
  store = await openTestStore(path.join(tempDir, "orchestrator.db"));
});

afterEach(async () => {
  await store.close().catch(() => undefined);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function service(exclusive?: ConstructorParameters<typeof GitSyncService>[3]["exclusive"]): GitSyncService {
  return new GitSyncService(store, new SecretService(store, "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="), new VariablesService(store), {
    workdirRoot: path.join(tempDir, "sync"),
    ...(exclusive ? { exclusive } : {})
  });
}

describe("git sync cluster lock", () => {
  it("answers busy without running the sync when another instance holds the lock", async () => {
    let asked = 0;
    const sync = service(async () => {
      asked += 1;
      return { acquired: false };
    });
    expect(await sync.push({})).toEqual({ ok: false, error: GIT_SYNC_BUSY_ERROR });
    expect(await sync.pull({})).toEqual({ ok: false, error: GIT_SYNC_BUSY_ERROR });
    expect(asked).toBe(2);
    expect(fs.existsSync(path.join(tempDir, "sync"))).toBe(false);
  });

  it("runs the sync inside the lock (here it fails for want of a configuration, inside the lock)", async () => {
    const order: string[] = [];
    const sync = service(async (work) => {
      order.push("locked");
      try {
        return { acquired: true, value: await work() };
      } finally {
        order.push("unlocked");
      }
    });
    await expect(sync.push({})).rejects.toThrow();
    expect(order).toEqual(["locked", "unlocked"]);
    // Without a lock (one instance) the same call runs directly.
    await expect(service().push({})).rejects.toThrow();
  });
});
