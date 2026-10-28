import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";
import { AuditService } from "./services/audit-service.js";
import { AuditExportBusyError, AuditExportService, type AuditExportLock } from "./services/audit-export-service.js";
import { AuditExportCursorMovedError } from "./db/store-errors.js";

describe("Phase 8.4 — audit hash chain + export", () => {
  let tempDir: string;
  let store: Store;
  let audit: AuditService;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-phase8-4-"));
    store = await openTestStore(path.join(tempDir, "orchestrator.db"));
    audit = new AuditService(store, { enabled: true });
  });

  afterEach(async () => {
    try { await store.close(); } catch { /* may already be closed by tampering test */ }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("hash chain", () => {
    it("first row links from the genesis hash (64 zeros)", async () => {
      await audit.record({ category: "auth", eventType: "login", action: "auth", outcome: "success" });
      const result = await store.verifyAuditChain();
      expect(result.ok).toBe(true);
      expect(result.rowsChecked).toBe(1);
    });

    it("each row's prev_hash equals the previous row's entry_hash", async () => {
      await audit.record({ category: "auth", eventType: "login", action: "auth", outcome: "success" });
      await audit.record({ category: "auth", eventType: "logout", action: "auth", outcome: "success" });
      await audit.record({ category: "workflow", eventType: "create", action: "create", outcome: "success" });
      const result = await store.verifyAuditChain();
      expect(result.ok).toBe(true);
      expect(result.rowsChecked).toBe(3);
    });

    it("verifyAuditChain detects tampering with metadata", async () => {
      await audit.record({ category: "auth", eventType: "login", action: "auth", outcome: "success", actor: { email: "alice@example.com" } });
      await audit.record({ category: "auth", eventType: "login", action: "auth", outcome: "success", actor: { email: "bob@example.com" } });

      // Tamper with the rows directly (not through the store) to mimic an attacker with
      // DB write access — exactly the threat model the chain is meant to defend against.
      const dbPath = path.join(tempDir, "orchestrator.db");
      await testSql(store).run(`UPDATE audit_logs SET actor_email = 'eve@evil.example.com' WHERE actor_email = 'bob@example.com'`);
      await store.close();

      const reopened = await openTestStore(dbPath);
      const result = await reopened.verifyAuditChain();
      expect(result.ok).toBe(false);
      expect(result.firstBrokenAt).toBeDefined();
      await reopened.close();
    });
  });

  describe("listAuditLogsAfter cursor", () => {
    it("returns rows after the given id, in chronological order", async () => {
      await audit.record({ category: "auth", eventType: "a", action: "auth", outcome: "success" });
      const second = (await audit.record({ category: "auth", eventType: "b", action: "auth", outcome: "success" }))!;
      await audit.record({ category: "auth", eventType: "c", action: "auth", outcome: "success" });
      await audit.record({ category: "auth", eventType: "d", action: "auth", outcome: "success" });

      const after = await store.listAuditLogsAfter({ afterId: second.id, limit: 10 });
      expect(after.map((r) => r.eventType)).toEqual(["c", "d"]);
    });

    it("returns the full list when afterId is null", async () => {
      await audit.record({ category: "auth", eventType: "x", action: "auth", outcome: "success" });
      await audit.record({ category: "auth", eventType: "y", action: "auth", outcome: "success" });
      const all = await store.listAuditLogsAfter({ afterId: null, limit: 10 });
      expect(all).toHaveLength(2);
    });

    it("respects the limit", async () => {
      for (let i = 0; i < 10; i++) {
        await audit.record({ category: "auth", eventType: `e${i}`, action: "auth", outcome: "success" });
      }
      const first3 = await store.listAuditLogsAfter({ afterId: null, limit: 3 });
      expect(first3).toHaveLength(3);
    });
  });

  describe("export destinations CRUD", () => {
    it("create + list + update + delete round-trip", async () => {
      await store.createAuditExportDestination({
        id: "axd_1",
        name: "Datadog",
        kind: "http",
        config: { url: "https://http-intake.logs.datadoghq.com", headers: { "DD-API-KEY": "abc" } }
      });
      let list = await store.listAuditExportDestinations();
      expect(list).toHaveLength(1);
      expect(list[0]!.kind).toBe("http");
      expect((list[0]!.config as { url: string }).url).toBe("https://http-intake.logs.datadoghq.com");

      await store.updateAuditExportDestination("axd_1", { intervalSeconds: 600, enabled: false });
      const after = (await store.getAuditExportDestination("axd_1"))!;
      expect(after.intervalSeconds).toBe(600);
      expect(after.enabled).toBe(false);

      await store.deleteAuditExportDestination("axd_1");
      list = await store.listAuditExportDestinations();
      expect(list).toHaveLength(0);
    });
  });

  describe("AuditExportService.runDestination", () => {
    it("delivers NDJSON to a file destination and advances the cursor", async () => {
      const filePath = path.join(tempDir, "audit.ndjson");
      await store.createAuditExportDestination({
        id: "axd_file",
        name: "local file",
        kind: "file",
        config: { path: filePath }
      });
      await audit.record({ category: "auth", eventType: "login", action: "auth", outcome: "success" });
      await audit.record({ category: "auth", eventType: "logout", action: "auth", outcome: "success" });

      const exporter = new AuditExportService(store, { batchSize: 100, safeFsRoot: tempDir });
      const outcome = await exporter.runDestination("axd_file");
      expect(outcome.status).toBe("success");
      expect(outcome.rowsExported).toBe(2);

      const written = fs.readFileSync(filePath, "utf8").trim().split("\n");
      expect(written).toHaveLength(2);
      const parsed = JSON.parse(written[0]!);
      expect(parsed.eventType).toBe("login");
      expect(parsed.entryHash).toBeTypeOf("string");

      // Cursor advanced — second run with no new rows is a no-op
      const second = await exporter.runDestination("axd_file");
      expect(second.rowsExported).toBe(0);
    });

    it("Phase 13.1: with a cluster lock, exports inside it; a lock held elsewhere fails Export now and skips the tick", async () => {
      const filePath = path.join(tempDir, "locked.ndjson");
      await store.createAuditExportDestination({ id: "axd_lock", name: "file", kind: "file", config: { path: filePath }, intervalSeconds: 0 });
      await audit.record({ category: "auth", eventType: "login", action: "auth", outcome: "success" });
      let held = false;
      const calls: Array<{ id: string; waitMs: number }> = [];
      const lock: AuditExportLock = async (destinationId, waitMs, work) => {
        calls.push({ id: destinationId, waitMs });
        if (held) return { acquired: false };
        return { acquired: true, value: await work() };
      };
      const exporter = new AuditExportService(store, { batchSize: 100, safeFsRoot: tempDir, lock });
      expect((await exporter.runDestination("axd_lock")).rowsExported).toBe(1);
      expect(calls).toEqual([{ id: "axd_lock", waitMs: 10_000 }]);

      held = true;
      await audit.record({ category: "auth", eventType: "logout", action: "auth", outcome: "success" });
      await expect(exporter.runDestination("axd_lock")).rejects.toBeInstanceOf(AuditExportBusyError);
      const warnings: string[] = [];
      exporter.setLogger({ info: () => undefined, warn: (message) => warnings.push(message) });
      await exporter.tick();
      // The tick tried without waiting and skipped quietly; nothing was exported meanwhile.
      expect(calls.at(-1)).toEqual({ id: "axd_lock", waitMs: 0 });
      expect(warnings).toEqual([]);
      expect(fs.readFileSync(filePath, "utf8").trim().split("\n")).toHaveLength(1);

      held = false;
      await exporter.tick();
      expect(fs.readFileSync(filePath, "utf8").trim().split("\n")).toHaveLength(2);
      expect(exporter.isRunning()).toBe(false);
      exporter.start();
      expect(exporter.isRunning()).toBe(true);
      await exporter.stop();
      expect(exporter.isRunning()).toBe(false);
    });

    it("Phase 13.1: a cursor compare-and-set refuses a run whose batch was read after a cursor that has since moved", async () => {
      await store.createAuditExportDestination({ id: "axd_cas", name: "file", kind: "file", config: { path: path.join(tempDir, "cas.ndjson") }, intervalSeconds: 0 });
      const run = (id: string, lastId: string, cursorFrom?: string | null) =>
        store.recordAuditExportRun({
          id, destinationId: "axd_cas", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), status: "success",
          rowsExported: 1, firstId: lastId, lastId, ...(cursorFrom !== undefined ? { cursorFrom } : {})
        });
      await run("r1", "a-1", null);
      expect((await store.getAuditExportDestination("axd_cas"))!.lastExportId).toBe("a-1");
      // A second shipper read the same (old) cursor: refused, nothing recorded, the cursor stays.
      await expect(run("r2", "a-0", null)).rejects.toBeInstanceOf(AuditExportCursorMovedError);
      expect((await store.getAuditExportDestination("axd_cas"))!.lastExportId).toBe("a-1");
      expect((await store.listAuditExportRuns("axd_cas")).map((row) => row.id)).toEqual(["r1"]);
      await run("r3", "a-2", "a-1");
      expect((await store.getAuditExportDestination("axd_cas"))!.lastExportId).toBe("a-2");
      // Without cursorFrom the cursor moves as before.
      await run("r4", "a-0");
      expect((await store.getAuditExportDestination("axd_cas"))!.lastExportId).toBe("a-0");
    });

    it("rejects file paths outside the safeFsRoot", async () => {
      const safeRoot = path.join(tempDir, "safe");
      fs.mkdirSync(safeRoot, { recursive: true });
      // Try to write to /tmp directly (outside safe root)
      await store.createAuditExportDestination({
        id: "axd_bad",
        name: "escape",
        kind: "file",
        config: { path: path.join(tempDir, "outside.ndjson") } // outside safeRoot
      });
      await audit.record({ category: "auth", eventType: "login", action: "auth", outcome: "success" });

      const exporter = new AuditExportService(store, { batchSize: 100, safeFsRoot: safeRoot });
      const outcome = await exporter.runDestination("axd_bad");
      expect(outcome.status).toBe("failure");
      expect(outcome.error).toContain("must live under");
    });

    it("records a run row even when the destination is empty", async () => {
      await store.createAuditExportDestination({
        id: "axd_empty",
        name: "no rows",
        kind: "file",
        config: { path: path.join(tempDir, "empty.ndjson") }
      });
      const exporter = new AuditExportService(store, { batchSize: 100, safeFsRoot: tempDir });
      const outcome = await exporter.runDestination("axd_empty");
      expect(outcome.status).toBe("success");
      expect(outcome.rowsExported).toBe(0);
      const runs = await store.listAuditExportRuns("axd_empty");
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("success");
    });

    it("records a failure run when delivery throws", async () => {
      await store.createAuditExportDestination({
        id: "axd_bad_url",
        name: "bad url",
        kind: "http",
        config: { url: "http://localhost:1/this-port-is-closed" }
      });
      await audit.record({ category: "auth", eventType: "login", action: "auth", outcome: "success" });
      const exporter = new AuditExportService(store, { batchSize: 100, safeFsRoot: tempDir });
      const outcome = await exporter.runDestination("axd_bad_url");
      expect(outcome.status).toBe("failure");
      const runs = await store.listAuditExportRuns("axd_bad_url");
      expect(runs[0]!.status).toBe("failure");
      expect(runs[0]!.error).toBeTruthy();
      // Cursor should NOT advance on failure
      const dest = (await store.getAuditExportDestination("axd_bad_url"))!;
      expect(dest.lastExportId).toBeNull();
    });
  });
});

