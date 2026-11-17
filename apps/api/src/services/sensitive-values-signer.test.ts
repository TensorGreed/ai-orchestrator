import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSensitiveValuesMarker } from "@ai-orchestrator/shared";
import { createSensitiveValuesSigner } from "./sensitive-values-signer.js";

describe("sensitive values marker signatures", () => {
  const key = crypto.randomBytes(32);
  const signer = createSensitiveValuesSigner(key)!;
  const values = [{ token: "[EMAIL_1]", value: "ana@example.org" }];

  it("verifies what this deployment signed, also after a JSON round trip and parsing", () => {
    const marker = signer.sign(values);
    expect(marker.sig).toMatch(/^v1:/);
    const parsed = parseSensitiveValuesMarker(JSON.parse(JSON.stringify(marker)))!;
    expect(parsed.complete).toBe(true);
    expect(signer.verify(parsed)).toBe(true);
  });

  it("refuses an altered entry, a reordered list, another deployment's signature and a missing one", () => {
    const marker = signer.sign([...values, { token: "[PHONE_1]", value: "+1 415 555 0134" }]);
    expect(signer.verify({ ...marker, values: [{ ...marker.values[0]!, token: "[NAME_1]" }, marker.values[1]!] })).toBe(false);
    expect(signer.verify({ ...marker, values: [...marker.values].reverse() })).toBe(false);
    expect(createSensitiveValuesSigner(crypto.randomBytes(32))!.verify(marker)).toBe(false);
    const { sig: _sig, ...unsigned } = marker;
    expect(signer.verify(unsigned)).toBe(false);
    expect(signer.verify({ ...marker, sig: "v1:" })).toBe(false);
    expect(signer.verify({ ...marker, sig: "v2:" + marker.sig!.slice(3) })).toBe(false);
  });

  it("does not exist without a 32-byte master key", () => {
    expect(createSensitiveValuesSigner(Buffer.alloc(0))).toBeUndefined();
    expect(createSensitiveValuesSigner(Buffer.alloc(16))).toBeUndefined();
  });
});
