import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SqliteStore } from "./db/database.js";
import { AuditService } from "./services/audit-service.js";
import { AuditExportService } from "./services/audit-export-service.js";

describe("Phase 8.4 — audit hash chain + export", () => {
  let tempDir: string;
  let store: SqliteStore;
  let audit: AuditService;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-phase8-4-"));
    store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
    audit = new AuditService(store, { enabled: true });
  });

  afterEach(() => {
    try { store.close(); } catch { /* may already be closed by tampering test */ }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("hash chain", () => {
    it("first row links from the genesis hash (64 zeros)", () => {
      audit.record({ category: "auth", eventType: "login", action: "auth", outcome: "success" });
      const result = store.verifyAuditChain();
      expect(result.ok).toBe(true);
      expect(result.rowsChecked).toBe(1);
    });

    it("each row's prev_hash equals the previous row's entry_hash", () => {
      audit.record({ category: "auth", eventType: "login", action: "auth", outcome: "success" });
      audit.record({ category: "auth", eventType: "logout", action: "auth", outcome: "success" });
      audit.record({ category: "workflow", eventType: "create", action: "create", outcome: "success" });
      const result = store.verifyAuditChain();
      expect(result.ok).toBe(true);
      expect(result.rowsChecked).toBe(3);
    });

    it("verifyAuditChain detects tampering with metadata", async () => {
      audit.record({ category: "auth", eventType: "login", action: "auth", outcome: "success", actor: { email: "alice@example.com" } });
      audit.record({ category: "auth", eventType: "login", action: "auth", outcome: "success", actor: { email: "bob@example.com" } });

      // Tamper directly through a parallel better-sqlite3 connection so we
      // mimic an attacker with DB write access — exactly the threat model
      // the chain is meant to defend against.
      const dbPath = path.join(tempDir, "orchestrator.db");
      store.close();
      const tamper = new Database(dbPath);
      tamper.exec(`UPDATE audit_logs SET actor_email = 'eve@evil.example.com' WHERE actor_email = 'bob@example.com'`);
      tamper.close();

      const reopened = await SqliteStore.create(dbPath);
      const result = reopened.verifyAuditChain();
      expect(result.ok).toBe(false);
      expect(result.firstBrokenAt).toBeDefined();
      reopened.close();
    });
  });

  describe("listAuditLogsAfter cursor", () => {
    it("returns rows after the given id, in chronological order", () => {
      audit.record({ category: "auth", eventType: "a", action: "auth", outcome: "success" });
      const second = audit.record({ category: "auth", eventType: "b", action: "auth", outcome: "success" })!;
      audit.record({ category: "auth", eventType: "c", action: "auth", outcome: "success" });
      audit.record({ category: "auth", eventType: "d", action: "auth", outcome: "success" });

      const after = store.listAuditLogsAfter({ afterId: second.id, limit: 10 });
      expect(after.map((r) => r.eventType)).toEqual(["c", "d"]);
    });

    it("returns the full list when afterId is null", () => {
      audit.record({ category: "auth", eventType: "x", action: "auth", outcome: "success" });
      audit.record({ category: "auth", eventType: "y", action: "auth", outcome: "success" });
      const all = store.listAuditLogsAfter({ afterId: null, limit: 10 });
      expect(all).toHaveLength(2);
    });

    it("respects the limit", () => {
      for (let i = 0; i < 10; i++) {
        audit.record({ category: "auth", eventType: `e${i}`, action: "auth", outcome: "success" });
      }
      const first3 = store.listAuditLogsAfter({ afterId: null, limit: 3 });
      expect(first3).toHaveLength(3);
    });
  });

  describe("export destinations CRUD", () => {
    it("create + list + update + delete round-trip", () => {
      store.createAuditExportDestination({
        id: "axd_1",
        name: "Datadog",
        kind: "http",
        config: { url: "https://http-intake.logs.datadoghq.com", headers: { "DD-API-KEY": "abc" } }
      });
      let list = store.listAuditExportDestinations();
      expect(list).toHaveLength(1);
      expect(list[0]!.kind).toBe("http");
      expect((list[0]!.config as { url: string }).url).toBe("https://http-intake.logs.datadoghq.com");

      store.updateAuditExportDestination("axd_1", { intervalSeconds: 600, enabled: false });
      const after = store.getAuditExportDestination("axd_1")!;
      expect(after.intervalSeconds).toBe(600);
      expect(after.enabled).toBe(false);

      store.deleteAuditExportDestination("axd_1");
      list = store.listAuditExportDestinations();
      expect(list).toHaveLength(0);
    });
  });

  describe("AuditExportService.runDestination", () => {
    it("delivers NDJSON to a file destination and advances the cursor", async () => {
      const filePath = path.join(tempDir, "audit.ndjson");
      store.createAuditExportDestination({
        id: "axd_file",
        name: "local file",
        kind: "file",
        config: { path: filePath }
      });
      audit.record({ category: "auth", eventType: "login", action: "auth", outcome: "success" });
      audit.record({ category: "auth", eventType: "logout", action: "auth", outcome: "success" });

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

    it("rejects file paths outside the safeFsRoot", async () => {
      const safeRoot = path.join(tempDir, "safe");
      fs.mkdirSync(safeRoot, { recursive: true });
      // Try to write to /tmp directly (outside safe root)
      store.createAuditExportDestination({
        id: "axd_bad",
        name: "escape",
        kind: "file",
        config: { path: path.join(tempDir, "outside.ndjson") } // outside safeRoot
      });
      audit.record({ category: "auth", eventType: "login", action: "auth", outcome: "success" });

      const exporter = new AuditExportService(store, { batchSize: 100, safeFsRoot: safeRoot });
      const outcome = await exporter.runDestination("axd_bad");
      expect(outcome.status).toBe("failure");
      expect(outcome.error).toContain("must live under");
    });

    it("records a run row even when the destination is empty", async () => {
      store.createAuditExportDestination({
        id: "axd_empty",
        name: "no rows",
        kind: "file",
        config: { path: path.join(tempDir, "empty.ndjson") }
      });
      const exporter = new AuditExportService(store, { batchSize: 100, safeFsRoot: tempDir });
      const outcome = await exporter.runDestination("axd_empty");
      expect(outcome.status).toBe("success");
      expect(outcome.rowsExported).toBe(0);
      const runs = store.listAuditExportRuns("axd_empty");
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("success");
    });

    it("records a failure run when delivery throws", async () => {
      store.createAuditExportDestination({
        id: "axd_bad_url",
        name: "bad url",
        kind: "http",
        config: { url: "http://localhost:1/this-port-is-closed" }
      });
      audit.record({ category: "auth", eventType: "login", action: "auth", outcome: "success" });
      const exporter = new AuditExportService(store, { batchSize: 100, safeFsRoot: tempDir });
      const outcome = await exporter.runDestination("axd_bad_url");
      expect(outcome.status).toBe("failure");
      const runs = store.listAuditExportRuns("axd_bad_url");
      expect(runs[0]!.status).toBe("failure");
      expect(runs[0]!.error).toBeTruthy();
      // Cursor should NOT advance on failure
      const dest = store.getAuditExportDestination("axd_bad_url")!;
      expect(dest.lastExportId).toBeNull();
    });
  });
});

