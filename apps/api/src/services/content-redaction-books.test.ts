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
