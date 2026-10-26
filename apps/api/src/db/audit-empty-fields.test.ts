/**
 * Phase 13.1 — audit hash chain with empty optional fields, on both stores (Postgres when TEST_POSTGRES_URL is set).
 *
 * The write path hashes each optional text field as given (`?? null`, so an empty string stays ""). Before this fix
 * the verify path read stored values by truthiness, turning "" into null, so one audited request with an empty
 * `User-Agent` header made verifyAuditChain fail at that row forever. Verify now reads stored fields with `?? null`,
 * so chains already written that way verify again with no migration, and AuditService.record stores "" as null.
 */
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AuditService } from "../services/audit-service.js";
import type { Store } from "./store.js";
import { createTestStore, noticePostgresSkipped, testPostgresPool, testPostgresUrl, type TestStore, type TestStoreKind } from "../test-support/test-store.js";
import { SqliteStore } from "./database.js";

type Entry = Parameters<Store["writeAuditLog"]>[0];

/** Every optional text field of the hash payload, empty. */
const EMPTY_OPTIONALS: Partial<Entry> = {
  actorUserId: "",
  actorEmail: "",
  resourceType: "",
  resourceId: "",
  projectId: "",
  ipAddress: "",
  userAgent: "",
  message: ""
};

const OPTIONAL_COLUMNS = ["actor_user_id", "actor_email", "resource_type", "resource_id", "project_id", "ip_address", "user_agent", "message"] as const;

function entry(id: string, overrides: Partial<Entry> = {}): Entry {
  return { id, eventType: "auth.login", category: "auth", action: "login", outcome: "failure", ...overrides };
}

const kinds: TestStoreKind[] = testPostgresUrl() ? ["sqlite", "postgres"] : ["sqlite"];
if (!testPostgresUrl()) noticePostgresSkipped("audit empty optional fields");

for (const kind of kinds) {
  describe(`audit chain with empty optional fields [${kind}]`, () => {
    let current: TestStore | undefined;
    let reopened: SqliteStore | undefined;
    afterEach(async () => {
      await reopened?.close();
      reopened = undefined;
      // The SQLite store was closed before tampering; cleanup still removes its directory.
      await current?.cleanup().catch(() => undefined);
      current = undefined;
    });

    /** Runs `sql` directly against the store's database (an attacker with write access), then returns a usable store. */
    async function tamper(sql: string): Promise<Store> {
      const test = current!;
      if (test.kind === "postgres") {
        const pool = testPostgresPool(test.schema);
        try {
          await pool.query(sql);
        } finally {
          await pool.end();
        }
        return test.store;
      }
      await test.store.close();
      const db = new Database(test.file!);
      db.exec(sql);
      db.close();
      reopened = await SqliteStore.create(test.file!);
      return reopened;
    }

    it("a chain written with an empty User-Agent (as main wrote it) verifies, and later rows are checked", async () => {
      current = await createTestStore({ kind });
      const store = current.store;
      await store.writeAuditLog(entry("before"));
      await store.writeAuditLog(entry("empty-ua", { userAgent: "" }));
      await store.writeAuditLog(entry("after", { userAgent: "curl/8" }));
      expect(await store.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 3 });
    });

    it("every optional field empty at once verifies; tampering with any of them still breaks the chain", async () => {
      current = await createTestStore({ kind });
      await current.store.writeAuditLog(entry("e1", { ...EMPTY_OPTIONALS, metadata: "" }));
      await current.store.writeAuditLog(entry("e2", EMPTY_OPTIONALS));
      await current.store.writeAuditLog(entry("e3"));
      expect(await current.store.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 3 });
      // "" -> NULL is a change the hash must still see.
      const store = await tamper(`UPDATE audit_logs SET user_agent = NULL WHERE id = 'e2'`);
      expect(await store.verifyAuditChain()).toMatchObject({ ok: false, rowsChecked: 1, firstBrokenAt: { id: "e2" } });
    });

    for (const column of OPTIONAL_COLUMNS) {
      it(`a stored "" changed to a value in ${column} fails verification`, async () => {
        current = await createTestStore({ kind });
        await current.store.writeAuditLog(entry("t1", EMPTY_OPTIONALS));
        await current.store.writeAuditLog(entry("t2"));
        const store = await tamper(`UPDATE audit_logs SET ${column} = 'x' WHERE id = 't1'`);
        expect(await store.verifyAuditChain()).toMatchObject({ ok: false, rowsChecked: 0, firstBrokenAt: { id: "t1" } });
      });
    }

    it("a NULL changed to an empty string fails verification", async () => {
      current = await createTestStore({ kind });
      await current.store.writeAuditLog(entry("n1"));
      const store = await tamper(`UPDATE audit_logs SET message = '' WHERE id = 'n1'`);
      expect(await store.verifyAuditChain()).toMatchObject({ ok: false, firstBrokenAt: { id: "n1" } });
    });

    it("AuditService.record stores empty optional fields as null", async () => {
      current = await createTestStore({ kind });
      const audit = new AuditService(current.store, { enabled: true });
      const recorded = await audit.record({
        eventType: "auth.login",
        category: "auth",
        action: "login",
        outcome: "failure",
        actor: { userId: "", email: "", ipAddress: "", userAgent: "" },
        resourceType: "",
        resourceId: "",
        projectId: "",
        message: ""
      });
      expect(recorded).toMatchObject({ actorUserId: null, actorEmail: null, ipAddress: null, userAgent: null, resourceType: null, resourceId: null, projectId: null, message: null });
      const [stored] = (await current.store.listAuditLogs()).items;
      expect(stored).toMatchObject({ actorUserId: null, actorEmail: null, ipAddress: null, userAgent: null, resourceType: null, resourceId: null, projectId: null, message: null });
      expect(await current.store.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 1 });
    });
  });
}
