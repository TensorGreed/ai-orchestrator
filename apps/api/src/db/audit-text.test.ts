/**
 * Phase 13.1 — audit text the database cannot store as given, on both stores (Postgres when TEST_POSTGRES_URL is set).
 *
 * A lone UTF-16 surrogate is hashed by JSON.stringify as the escape `\ud800` but stored by pg (and by better-sqlite3 on
 * Node 24) as U+FFFD, so before the fix one such row stopped verifyAuditChain for good. better-sqlite3 on Node 20 stores
 * it as generalized UTF-8 bytes instead, which SqliteStore reads back exactly. Writes now store and hash the
 * well-formed text. Rows written the old way are checked by the rule in audit-chain.ts: text kept exactly is verified
 * exactly; otherwise one U+FFFD is searched exhaustively (verified or broken), two or more make the row `unverifiable`
 * (ok: false, the chain continues past it). The tamper cases below
 * pin that the rule never turns an edited row into a passing one.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { parseConfig } from "../config.js";
import { AuthService } from "../services/auth-service.js";
import { AuditService } from "../services/audit-service.js";
import { SecretService } from "../services/secret-service.js";
import { createTestStore, noticePostgresSkipped, testPostgresUrl, type TestStore, type TestStoreKind, testStorePool } from "../test-support/test-store.js";
import { auditEntryHash, GENESIS_HASH, wellFormedAuditText, type AuditCanonicalInput } from "./audit-chain.js";
import { SqliteStore } from "./database.js";
import type { Store } from "./store.js";

type Entry = Parameters<Store["writeAuditLog"]>[0];

function entry(id: string, overrides: Partial<Entry> = {}): Entry {
  return { id, eventType: "tag.create", category: "workflow", action: "create", outcome: "success", ...overrides };
}

/** `value` in generalized UTF-8 (WTF-8): a lone surrogate as its own 3-byte sequence, as better-sqlite3 on Node 20 stores it. */
function wtf8(value: string): Buffer {
  const bytes: number[] = [];
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return Buffer.from(bytes);
}

describe("wellFormedAuditText", () => {
  it("replaces lone surrogates and U+0000 with U+FFFD and keeps everything else", () => {
    expect(wellFormedAuditText("a\ud800b")).toBe("a�b");
    expect(wellFormedAuditText("a\udc00b")).toBe("a�b");
    expect(wellFormedAuditText("\udc00\ud800")).toBe("��");
    expect(wellFormedAuditText("x\u0000y")).toBe("x�y");
    expect(wellFormedAuditText("ok 😀 � é")).toBe("ok 😀 � é");
    expect(wellFormedAuditText(null)).toBeNull();
    for (const s of ["\ud800", "a\udfffb𐀀", "\udbff􏰀"]) {
      expect(wellFormedAuditText(s)).toBe((s as unknown as { toWellFormed(): string }).toWellFormed());
    }
  });
});

const kinds: TestStoreKind[] = testPostgresUrl() ? ["sqlite", "postgres"] : ["sqlite"];
if (!testPostgresUrl()) noticePostgresSkipped("audit text normalisation");

for (const kind of kinds) {
  describe(`audit text and the hash chain [${kind}]`, () => {
    let current: TestStore | undefined;
    let reopened: SqliteStore | undefined;
    afterEach(async () => {
      await reopened?.close();
      reopened = undefined;
      await current?.cleanup().catch(() => undefined);
      current = undefined;
    }, 60_000);

    async function fresh(): Promise<Store> {
      current = await createTestStore({ kind });
      return current.store;
    }

    /** Runs `fn` with raw database access (an old build's write, or an attacker), then returns a usable store. */
    async function raw(fn: (exec: (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>) => Promise<void>): Promise<Store> {
      const test = current!;
      if (test.kind === "postgres") {
        const pool = testStorePool(test!);
        try {
          await fn(async (sql, params = []) => {
            let i = 0;
            return (await pool.query(sql.replace(/\?/g, () => `$${++i}`), params)).rows as Array<Record<string, unknown>>;
          });
        } finally {
          await pool.end();
        }
        return test.store;
      }
      const store = reopened ?? test.store;
      await store.close();
      reopened = undefined;
      const db = new Database(test.file!);
      try {
        await fn(async (sql, params = []) => {
          const stmt = db.prepare(sql);
          if (stmt.reader) return stmt.all(...params) as Array<Record<string, unknown>>;
          stmt.run(...params);
          return [];
        });
      } finally {
        db.close();
      }
      reopened = await SqliteStore.create(test.file!);
      return reopened;
    }

    const tamper = (sql: string, params: unknown[] = []) => raw(async (exec) => { await exec(sql, params); });

    /**
     * Appends a row the way a build before the fix did: the hash over the raw text, the text stored as the driver of
     * that build stored it. Which one depends on the Node version it ran on, so the test picks it instead of the Node
     * running the test:
     *  - "replacement": each lone surrogate stored as U+FFFD (pg on any Node; better-sqlite3 on Node 24).
     *  - "wtf8": each lone surrogate stored as its 3-byte generalized UTF-8 form, ED A0 80 for U+D800 (better-sqlite3 on
     *    Node 20, the former runtime image). SQLite only: Postgres refuses those bytes.
     */
    function writeOldFormat(
      id: string,
      text: { message?: string; resourceId?: string },
      createdAt: string,
      storedAs: "replacement" | "wtf8" = "replacement"
    ): Promise<Store> {
      return raw(async (exec) => {
        const order = kind === "postgres" ? "seq" : "rowid";
        const last = await exec(`SELECT entry_hash FROM audit_logs WHERE entry_hash IS NOT NULL ORDER BY ${order} DESC LIMIT 1`);
        const prev = (last[0]?.entry_hash as string | undefined) ?? GENESIS_HASH;
        const fields: AuditCanonicalInput = {
          id, createdAt, eventType: "tag.create", category: "workflow", action: "create", outcome: "success",
          actorUserId: null, actorEmail: null, actorType: "user", resourceType: "tag", resourceId: text.resourceId ?? null,
          projectId: null, ipAddress: null, userAgent: null, metadataJson: null, message: text.message ?? null
        };
        const stored = (value: string | null): unknown =>
          value === null ? null : storedAs === "wtf8" ? wtf8(value) : (value as unknown as { toWellFormed(): string }).toWellFormed();
        const textParam = storedAs === "wtf8" ? "CAST(? AS TEXT)" : "?";
        await exec(
          `INSERT INTO audit_logs (id, event_type, category, action, outcome, actor_type, resource_type, resource_id, message,
             created_at, prev_hash, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ${textParam}, ${textParam}, ?, ?, ?)`,
          [id, fields.eventType, fields.category, fields.action, fields.outcome, fields.actorType, fields.resourceType,
            stored(fields.resourceId), stored(fields.message), createdAt, prev, auditEntryHash(prev, fields)]
        );
      });
    }

    it("a lone surrogate or U+0000 in any text field is stored and hashed as U+FFFD; the chain verifies", async () => {
      const store = await fresh();
      await store.writeAuditLog(entry("w1", { resourceId: "\ud800", message: "name \udc00 x", actorEmail: "a\u0000b@example.com", userAgent: "ua\ud83d", metadata: { name: "\ud800\u0000" } }));
      await store.writeAuditLog(entry("w2", { message: "after" }));
      expect(await store.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 2 });
      const row = (await store.listAuditLogs()).items.find((item) => item.id === "w1")!;
      expect(row).toMatchObject({ resourceId: "�", message: "name � x", actorEmail: "a�b@example.com", userAgent: "ua�", metadata: { name: "\ud800\u0000" } });
    }, 60_000);

    it("AuditService.record returns the text it stored", async () => {
      const store = await fresh();
      const recorded = await new AuditService(store, { enabled: true }).record({
        eventType: "tag.create", category: "workflow", action: "create", resourceType: "tag", resourceId: "t\ud800", message: "m\u0000"
      });
      expect(recorded).toMatchObject({ resourceId: "t�", message: "m�" });
      expect((await store.listAuditLogs()).items[0]).toMatchObject({ resourceId: "t�", message: "m�" });
      expect(await store.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 1 });
    }, 60_000);

    it("POST /api/tags with a lone-surrogate name no longer breaks the chain", async () => {
      const store = await fresh();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-audit-text-"));
      const config = parseConfig({
        LOG_LEVEL: "warn", SEED_SAMPLE_WORKFLOWS: "false", SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
        COOKIE_SECURE: "false", RATE_LIMIT_ENABLED: "false", MCP_PROBE_INTERVAL_MS: "0", GIT_SYNC_WORKDIR: path.join(dir, "sync")
      });
      const authService = new AuthService(store, config.SESSION_TTL_HOURS);
      const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), authService);
      try {
        await app.ready();
        await authService.register({ email: "admin@example.com", password: "Admin-Pass-123!", role: "admin" });
        const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "Admin-Pass-123!" } });
        const setCookie = login.headers["set-cookie"];
        const cookie = (Array.isArray(setCookie) ? setCookie[0] : String(setCookie)).split(";")[0]!;
        const created = await app.inject({
          method: "POST", url: "/api/tags", headers: { cookie, "content-type": "application/json" }, payload: '{"name":"\\ud800"}'
        });
        expect(created.statusCode).toBe(200);
        await app.inject({ method: "POST", url: "/api/tags", headers: { cookie }, payload: { name: "plain" } });
        const verify = await app.inject({ method: "GET", url: "/api/audit-log/verify-chain", headers: { cookie } });
        const body = verify.json() as { ok: boolean; rowsChecked: number; unverifiable?: unknown };
        expect(body.ok).toBe(true);
        expect(body.unverifiable).toBeUndefined();
        // Sorted: the two rows can share a millisecond, and SQLite's order within one is not insertion order.
        const audited = (await store.listAuditLogs({ eventType: "tag.create" })).items.map((item) => item.resourceId).sort();
        expect(audited).toEqual(["plain", "�"]);
        expect(body.rowsChecked).toBe((await store.listAuditLogs({ pageSize: 500 })).total);
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);

    it("an old row with one lone surrogate is verified by the full search; later rows verify", async () => {
      await (await fresh()).writeAuditLog(entry("before"));
      let store = await writeOldFormat("old1", { resourceId: "\ud800" }, "2026-01-01T00:00:00.000Z");
      await store.writeAuditLog(entry("after1"));
      await store.writeAuditLog(entry("after2"));
      expect(await store.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 4 });
      // The same row with its other text edited (U+FFFD kept): no surrogate explains it.
      store = await tamper(`UPDATE audit_logs SET action = 'delete' WHERE id = 'old1'`);
      expect(await store.verifyAuditChain()).toMatchObject({ ok: false, rowsChecked: 1, firstBrokenAt: { id: "old1" } });
    }, 60_000);

    it("an old row with two lone surrogates is reported unverifiable, and every later row is still verified", async () => {
      await (await fresh()).writeAuditLog(entry("before"));
      const store = await writeOldFormat("old2", { resourceId: "\ud800", message: "a \udc00 b" }, "2026-01-01T00:00:00.000Z");
      await store.writeAuditLog(entry("after1"));
      await store.writeAuditLog(entry("after2"));
      const result = await store.verifyAuditChain();
      expect(result).toMatchObject({ ok: false, rowsChecked: 3, unverifiable: [{ id: "old2", createdAt: "2026-01-01T00:00:00.000Z" }] });
      expect(result.firstBrokenAt).toBeUndefined();
      expect(result.unverifiable?.[0]?.reason).toMatch(/2 U\+FFFD/);
    }, 60_000);

    if (kind === "sqlite") {
      it("an old row whose lone surrogates were stored as generalized UTF-8 (Node 20) is verified exactly, however many it holds", async () => {
        await (await fresh()).writeAuditLog(entry("before"));
        let store = await writeOldFormat("old3", { resourceId: "\ud800", message: "a \udc00 b \udbff" }, "2026-01-01T00:00:00.000Z", "wtf8");
        await store.writeAuditLog(entry("after1"));
        await store.writeAuditLog(entry("after2"));
        expect(await store.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 4 });
        // The store kept this row's text exactly, so any edit is broken: no U+FFFD search, no "unverifiable".
        store = await tamper(`UPDATE audit_logs SET action = 'delete' WHERE id = 'old3'`);
        const result = await store.verifyAuditChain();
        expect(result).toMatchObject({ ok: false, rowsChecked: 1, firstBrokenAt: { id: "old3" } });
        expect(result.unverifiable).toBeUndefined();
      }, 60_000);

      it("a generalized-UTF-8 row given another lone surrogate is broken, and bytes no writer stored never verify", async () => {
        await (await fresh()).writeAuditLog(entry("before"));
        let store = await writeOldFormat("old1", { message: "x \udfff y" }, "2026-01-01T00:00:00.000Z", "wtf8");
        await store.writeAuditLog(entry("after1"));
        expect(await store.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 3 });
        // Seen as U+FFFD, \udffe and \udfff look the same; the stored bytes do not, and the hash covers \udfff.
        store = await tamper(`UPDATE audit_logs SET message = CAST(? AS TEXT) WHERE id = 'old1'`, [wtf8("x \udffe y")]);
        expect(await store.verifyAuditChain()).toMatchObject({ ok: false, rowsChecked: 1, firstBrokenAt: { id: "old1" } });
        // A truncated sequence, and U+DFFF after a high surrogate written as two 3-byte halves (CESU-8, not generalized UTF-8).
        for (const hex of ["7820edbf2079", "7820eda080edbfbf2079"]) {
          store = await tamper(`UPDATE audit_logs SET message = CAST(? AS TEXT) WHERE id = 'old1'`, [Buffer.from(hex, "hex")]);
          const result = await store.verifyAuditChain();
          // Read with U+FFFD for each invalid sequence, as the driver reads them: broken or unverifiable, never verified.
          expect(result.ok).toBe(false);
          expect(result.firstBrokenAt?.id ?? result.unverifiable?.[0]?.id).toBe("old1");
        }
        store = await tamper(`UPDATE audit_logs SET message = CAST(? AS TEXT) WHERE id = 'old1'`, [wtf8("x \udfff y")]);
        expect(await store.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 3 });
      }, 60_000);
    }

    it("a row after an unverifiable row is still checked: editing it breaks the chain there", async () => {
      await (await fresh()).writeAuditLog(entry("before"));
      let store = await writeOldFormat("old2", { message: "\ud800\ud800" }, "2026-01-01T00:00:00.000Z");
      await store.writeAuditLog(entry("after1"));
      await store.writeAuditLog(entry("after2"));
      store = await tamper(`UPDATE audit_logs SET message = 'edited' WHERE id = 'after2'`);
      expect(await store.verifyAuditChain()).toMatchObject({ ok: false, rowsChecked: 2, firstBrokenAt: { id: "after2" }, unverifiable: [{ id: "old2" }] });
    }, 60_000);

    it("deleting an unverifiable row breaks the chain at the next row", async () => {
      await (await fresh()).writeAuditLog(entry("before"));
      let store = await writeOldFormat("old2", { message: "\ud800\ud800" }, "2026-01-01T00:00:00.000Z");
      await store.writeAuditLog(entry("after1"));
      store = await tamper(`DELETE FROM audit_logs WHERE id = 'old2'`);
      expect(await store.verifyAuditChain()).toMatchObject({ ok: false, rowsChecked: 1, firstBrokenAt: { id: "after1" } });
    }, 60_000);

    it("tampering with a row written after the fix: no U+FFFD fails, one U+FFFD fails, two are named unverifiable (never ok)", async () => {
      const store0 = await fresh();
      await store0.writeAuditLog(entry("n1", { message: "hello" }));
      await store0.writeAuditLog(entry("n2", { message: "real � kept" }));
      await store0.writeAuditLog(entry("n3"));
      expect(await store0.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 3 });

      let store = await tamper(`UPDATE audit_logs SET message = 'hullo' WHERE id = 'n1'`);
      expect(await store.verifyAuditChain()).toMatchObject({ ok: false, rowsChecked: 0, firstBrokenAt: { id: "n1" } });
      store = await tamper(`UPDATE audit_logs SET message = 'hello' WHERE id = 'n1'`);
      expect(await store.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 3 });

      store = await tamper(`UPDATE audit_logs SET message = ? WHERE id = 'n1'`, ["hel�o"]);
      expect(await store.verifyAuditChain()).toMatchObject({ ok: false, rowsChecked: 0, firstBrokenAt: { id: "n1" } });
      // A row that already held a real U+FFFD, edited elsewhere: still one U+FFFD, the search finds nothing.
      store = await tamper(`UPDATE audit_logs SET message = 'hello' WHERE id = 'n1'`);
      store = await tamper(`UPDATE audit_logs SET action = 'delete' WHERE id = 'n2'`);
      expect(await store.verifyAuditChain()).toMatchObject({ ok: false, rowsChecked: 1, firstBrokenAt: { id: "n2" } });
      store = await tamper(`UPDATE audit_logs SET action = 'create' WHERE id = 'n2'`);

      store = await tamper(`UPDATE audit_logs SET message = ? WHERE id = 'n1'`, ["�hacked�"]);
      const result = await store.verifyAuditChain();
      expect(result).toMatchObject({ ok: false, rowsChecked: 2, unverifiable: [{ id: "n1" }] });
    }, 60_000);

    it("U+FFFD in metadata_json or in id, outcome, actor_type gets no exception", async () => {
      const store0 = await fresh();
      await store0.writeAuditLog(entry("m1", { metadata: { a: 1 } }));
      let store = await tamper(`UPDATE audit_logs SET metadata_json = ? WHERE id = 'm1'`, ['{"a":"��"}']);
      expect(await store.verifyAuditChain()).toMatchObject({ ok: false, firstBrokenAt: { id: "m1" } });
      expect((await store.verifyAuditChain()).unverifiable).toBeUndefined();
      store = await tamper(`UPDATE audit_logs SET metadata_json = '{"a":1}', actor_type = ? WHERE id = 'm1'`, ["user��"]);
      expect(await store.verifyAuditChain()).toMatchObject({ ok: false, firstBrokenAt: { id: "m1" } });
    }, 60_000);

    if (kind === "postgres") {
      it("created_at is stored to the millisecond, and a sub-millisecond edit breaks the chain", async () => {
        const store0 = await fresh();
        await store0.writeAuditLog(entry("c1", { createdAt: "2026-03-01T00:00:00.123456Z" }));
        await store0.writeAuditLog(entry("c2"));
        expect(await store0.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 2 });
        let micros: unknown;
        await raw(async (exec) => {
          micros = (await exec(`SELECT (extract(microseconds FROM created_at)::bigint % 1000000)::text AS us FROM audit_logs WHERE id = 'c1'`))[0]?.us;
        });
        expect(micros).toBe("123000");
        expect((await store0.listAuditLogs()).items.find((item) => item.id === "c1")?.createdAt).toBe("2026-03-01T00:00:00.123Z");
        const store = await tamper(`UPDATE audit_logs SET created_at = created_at + interval '1 microsecond' WHERE id = 'c1'`);
        expect(await store.verifyAuditChain()).toMatchObject({ ok: false, rowsChecked: 0, firstBrokenAt: { id: "c1" } });
      }, 60_000);
    }
  });
}
