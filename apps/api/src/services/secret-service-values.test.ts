import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Store } from "../db/store.js";
import { openTestStore } from "../test-support/test-store.js";
import { SecretService } from "./secret-service.js";

/** `onSecretValue`: scrubbers that must not miss a new or rotated value learn it the moment it is stored or read. */

const opened: Array<{ store: Store; dir: string }> = [];
afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.store.close();
    fs.rmSync(entry.dir, { recursive: true, force: true });
  }
});

async function service() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-secret-values-"));
  const store = await openTestStore(path.join(dir, "orchestrator.db"));
  opened.push({ store, dir });
  return new SecretService(store, crypto.randomBytes(32).toString("base64"));
}

describe("SecretService.onSecretValue", () => {
  it("reports values as they are stored and read, with a JSON document's credential fields", async () => {
    const secrets = await service();
    const seen: string[][] = [];
    const stop = secrets.onSecretValue((values) => seen.push(values));
    const plain = await secrets.createSecret({ name: "a", provider: "openai", value: "plain-value-123456" });
    expect(seen.flat()).toContain("plain-value-123456");
    seen.length = 0;
    expect(await secrets.resolveSecret(plain)).toBe("plain-value-123456");
    expect(seen.flat()).toContain("plain-value-123456");
    await secrets.createSecret({ name: "b", provider: "custom", value: JSON.stringify({ access_token: "tok-abcdef-998877", token_type: "Bearer" }) });
    expect(seen.flat()).toContain("tok-abcdef-998877");
    expect(seen.flat()).not.toContain("Bearer");
    stop();
    seen.length = 0;
    await secrets.resolveSecret(plain);
    expect(seen).toEqual([]);
  });

  it("keeps working when a listener throws, and costs nothing without listeners", async () => {
    const secrets = await service();
    secrets.onSecretValue(() => {
      throw new Error("listener broke");
    });
    const ref = await secrets.createSecret({ name: "a", provider: "openai", value: "value-abcdef-1" });
    expect(await secrets.resolveSecret(ref)).toBe("value-abcdef-1");
  });
});
