/**
 * v76 — a workflow run's placeholder book: sealed in content_redactions, tagged per run so text from outside the run
 * cannot name a placeholder the book hands out later, and read back by a resumed run.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLACEHOLDER_PATTERN } from "@ai-orchestrator/guard-sdk";
import { openTestStore } from "../test-support/test-store.js";
import type { Store } from "../db/store.js";
import { SecretService } from "./secret-service.js";
import { PersistedPlaceholderBook } from "./content-redaction-books.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fixture(): Promise<{ store: Store; secrets: SecretService }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-redaction-books-"));
  const store = await openTestStore(path.join(dir, "o.db"));
  cleanups.push(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, secrets: new SecretService(store, crypto.randomBytes(32).toString("base64")) };
}

const owner = { id: "run:exec-1", scope: "run" as const, clientId: null, toolsetId: null, projectId: "default", executionId: "exec-1" };

describe("a run's placeholder book", () => {
  it("issues tagged placeholders, never answers for an untagged or other run's one, and survives a resume", async () => {
    const { store, secrets } = await fixture();
    const book = new PersistedPlaceholderBook(store, secrets, owner, 60_000);
    const first = await book.assign("email", "ana@example.com");
    expect(first).toMatch(/^\[EMAIL_1\.[A-Z2-7]{6}\]$/);
    expect(first.match(PLACEHOLDER_PATTERN)).toEqual([first]);
    expect(await book.assign("email", "ana@example.com")).toBe(first);
    // What someone outside the run could type.
    expect(await book.lookup("[EMAIL_1]")).toBeUndefined();
    expect(await book.lookup("[EMAIL_1.AAAAAA]")).toBeUndefined();
    expect(await book.lookup(first)).toEqual({ dataClass: "email", value: "ana@example.com" });

    const resumed = new PersistedPlaceholderBook(store, secrets, owner, 60_000);
    expect(await resumed.lookup(first)).toEqual({ dataClass: "email", value: "ana@example.com" });
    const second = await resumed.assign("email", "bo@example.com");
    expect(second.slice(-8)).toBe(first.slice(-8));
    expect(second.startsWith("[EMAIL_2.")).toBe(true);

    const otherRun = new PersistedPlaceholderBook(store, secrets, { ...owner, id: "run:exec-2", executionId: "exec-2" }, 60_000);
    expect(await otherRun.lookup(first)).toBeUndefined();
    expect((await otherRun.assign("email", "ana@example.com")).slice(-8)).not.toBe(first.slice(-8));
  });

  it("merges two writers of one run's book: a resumed run racing the original never loses or remaps a placeholder", async () => {
    const { store, secrets } = await fixture();
    const original = new PersistedPlaceholderBook(store, secrets, owner, 60_000);
    const resumed = new PersistedPlaceholderBook(store, secrets, owner, 60_000);
    // Both read the (empty) book before either writes.
    expect(await original.lookup("[EMAIL_1]")).toBeUndefined();
    expect(await resumed.lookup("[EMAIL_1]")).toBeUndefined();
    const values = Array.from({ length: 12 }, (_, index) => `user${index}@example.com`);
    const issued = await Promise.all(values.map((value, index) => (index % 2 === 0 ? original : resumed).assign("email", value)));
    expect(new Set(issued).size).toBe(values.length);
    // Every placeholder resolves to its own value through either writer and through a fresh reader.
    const reader = new PersistedPlaceholderBook(store, secrets, owner, 60_000);
    for (const [index, placeholder] of issued.entries()) {
      for (const book of [original, resumed, reader]) expect(await book.lookup(placeholder)).toEqual({ dataClass: "email", value: values[index] });
    }
    // A value either writer already has keeps its placeholder on the other.
    expect(await resumed.assign("email", values[0]!)).toBe(issued[0]);
    expect(await original.assign("email", values[1]!)).toBe(issued[1]);
  });

  it("fails closed when the row keeps changing", async () => {
    const { store, secrets } = await fixture();
    const racing = {
      getContentRedaction: (id: string, now: string) => store.getContentRedaction(id, now),
      writeContentRedactionIfVersion: async () => null
    } as unknown as Store;
    const book = new PersistedPlaceholderBook(racing, secrets, owner, 60_000);
    await expect(book.assign("email", "ana@example.com")).rejects.toThrow(/kept changing/);
    expect(await book.lookup("[EMAIL_1]")).toBeUndefined();
  });

  it("never writes a deleted book back, and a run still in progress reveals nothing from it once it is gone", async () => {
    const { store, secrets } = await fixture();
    let now = new Date("2026-11-17T10:00:00.000Z");
    const book = new PersistedPlaceholderBook(store, secrets, owner, 3_600_000, () => now);
    const subject = await book.assign("email", "subject@example.com");
    // A data-subject deletion removes the row while the run goes on.
    expect(await store.deleteContentRedaction(owner.id)).toBe(true);
    now = new Date("2026-11-17T10:00:05.000Z");
    expect(await book.lookup(subject)).toBeUndefined();
    const next = await book.assign("email", "other@example.com");
    expect(next.startsWith("[EMAIL_1.")).toBe(true);
    expect(next.slice(-8)).not.toBe(subject.slice(-8));
    const row = await store.getContentRedaction(owner.id, now.toISOString());
    const opened = JSON.parse(secrets.openValue("content-redaction-map", row!.entriesSealed)) as { book: { entries: Array<{ value: string }> } };
    expect(opened.book.entries.map((entry) => entry.value)).toEqual(["other@example.com"]);
  });

  it("a replica still holding a deleted book's version never writes it back over the book another replica started since", async () => {
    const { store, secrets } = await fixture();
    const a = new PersistedPlaceholderBook(store, secrets, owner, 3_600_000);
    await a.assign("email", "subject@example.com");
    expect(await store.deleteContentRedaction(owner.id)).toBe(true);
    const b = new PersistedPlaceholderBook(store, secrets, owner, 3_600_000);
    const fromB = await b.assign("email", "b@example.com");
    await a.assign("email", "a-later@example.com");
    const row = await store.getContentRedaction(owner.id, new Date().toISOString());
    const opened = JSON.parse(secrets.openValue("content-redaction-map", row!.entriesSealed)) as { book: { entries: Array<{ value: string }> } };
    const values = opened.book.entries.map((entry) => entry.value);
    expect(values).not.toContain("subject@example.com");
    expect(values).toEqual(expect.arrayContaining(["b@example.com", "a-later@example.com"]));
    expect(await b.lookup(fromB)).toEqual({ dataClass: "email", value: "b@example.com" });
  });

  it("fails closed on another owner's row or a row it cannot open, without writing over it", async () => {
    const { store, secrets } = await fixture();
    await store.putContentRedaction({ ...owner, scope: "gateway", entriesSealed: "v1.x", entryCount: 0, classes: [], createdAt: "2026-11-17T10:00:00.000Z", updatedAt: "2026-11-17T10:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" });
    const foreign = new PersistedPlaceholderBook(store, secrets, owner, 60_000);
    await expect(foreign.assign("email", "ana@example.com")).rejects.toThrow(/Another owner/);
    expect(await foreign.lookup("[EMAIL_1]")).toBeUndefined();
    const other = { ...owner, id: "run:exec-7", executionId: "exec-7" };
    await store.putContentRedaction({ ...other, entriesSealed: "v1.not-a-seal", entryCount: 1, classes: ["email"], createdAt: "2026-11-17T10:00:00.000Z", updatedAt: "2026-11-17T10:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" });
    const unopenable = new PersistedPlaceholderBook(store, secrets, other, 60_000);
    await expect(unopenable.assign("email", "ana@example.com")).rejects.toThrow(/cannot be opened/);
    expect((await store.getContentRedaction(other.id, "2026-11-17T10:00:00.000Z"))?.entriesSealed).toBe("v1.not-a-seal");
  });

  it("is unreadable once expired", async () => {
    const { store, secrets } = await fixture();
    let now = new Date("2026-11-17T10:00:00.000Z");
    const book = new PersistedPlaceholderBook(store, secrets, owner, 60_000, () => now);
    const placeholder = await book.assign("phone", "+1 415 555 0134");
    now = new Date("2026-11-17T10:02:00.000Z");
    const later = new PersistedPlaceholderBook(store, secrets, owner, 60_000, () => now);
    expect(await later.lookup(placeholder)).toBeUndefined();
  });
});
