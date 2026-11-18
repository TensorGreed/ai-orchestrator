import { describe, expect, it } from "vitest";
import { fakeModel } from "../../test/helpers.js";
import { findModelByChecksum, findNerModel, loadNerManifest, nerModelFilePath, nerModelFolderName, parseNerManifest } from "./manifest.js";

describe("the bundled model manifest", () => {
  const manifest = loadNerManifest();

  it("parses, and its default model is pinned, licensed and has floors", () => {
    const model = findNerModel(manifest, undefined);
    expect(model.id).toBe("knowledgator/gliner-pii-base-v1.0");
    expect(model.licence.id).toBe("Apache-2.0");
    expect(model.licence.trainingData).toMatch(/not disclosed/i);
    expect(model.window.words).toBeLessThanOrEqual(128);
    expect(model.window.overlap).toBeGreaterThanOrEqual(12);
    expect(model.benchmarkFloors?.person_name?.main?.precision).toBeGreaterThan(0.9);
    for (const file of model.files) {
      expect(file.url).toContain(`/resolve/${model.revision}/`);
      expect(file.url.startsWith("https://huggingface.co/knowledgator/gliner-pii-base-v1.0/")).toBe(true);
    }
  });

  it("finds a running model only by id and ONNX checksum", () => {
    const model = findNerModel(manifest, undefined);
    const onnx = model.files.find((file) => file.path === model.onnx)!;
    expect(findModelByChecksum(manifest, model.id, onnx.sha256)?.id).toBe(model.id);
    expect(findModelByChecksum(manifest, model.id, "0".repeat(64))).toBeUndefined();
    expect(findModelByChecksum(manifest, "someone/else", onnx.sha256)).toBeUndefined();
  });

  it("names an unknown model", () => {
    expect(() => findNerModel(manifest, "nobody/nothing")).toThrow(/not in the manifest/);
  });
});

describe("manifest validation", () => {
  const base = () => JSON.parse(JSON.stringify(fakeModel().manifest)) as { models: Array<Record<string, unknown> & { files: Array<Record<string, unknown>>; prompts: Array<Record<string, unknown>> }> } & Record<string, unknown>;

  it.each([
    ["a path that leaves the folder", (m: ReturnType<typeof base>) => (m.models[0]!.files[0]!.path = "../evil.onnx")],
    ["an absolute path", (m: ReturnType<typeof base>) => (m.models[0]!.files[0]!.path = "/etc/passwd")],
    ["a plain-http URL", (m: ReturnType<typeof base>) => (m.models[0]!.files[0]!.url = "http://models.example.test/x")],
    ["a URL with credentials", (m: ReturnType<typeof base>) => (m.models[0]!.files[0]!.url = "https://user:pw@models.example.test/x")],
    ["a short checksum", (m: ReturnType<typeof base>) => (m.models[0]!.files[0]!.sha256 = "abc")],
    ["an onnx file not listed", (m: ReturnType<typeof base>) => (m.models[0]!.onnx = "onnx/other.onnx")],
    ["a part-only prompt that is not an address part", (m: ReturnType<typeof base>) => m.models[0]!.prompts.push({ prompt: "zip2", class: null, threshold: 0.5 })],
    ["a join threshold on a non-part", (m: ReturnType<typeof base>) => (m.models[0]!.prompts[0]!.joinThreshold = 0.2)],
    ["an unknown key", (m: ReturnType<typeof base>) => (m.models[0]!.endpoint = "https://example.test")],
    ["a default that is not listed", (m: ReturnType<typeof base>) => (m.default = "nobody/nothing")],
    ["an overlap of half the window", (m: ReturnType<typeof base>) => (m.models[0]!.window = { words: 32, overlap: 16 })]
  ])("refuses %s", (_name, change) => {
    const manifest = base();
    change(manifest);
    expect(() => parseNerManifest(manifest)).toThrow(/not a valid model manifest/);
  });
});

describe("model folders", () => {
  it("keeps files inside the model folder", () => {
    expect(nerModelFolderName({ id: "publisher/name" })).toBe("publisher__name");
    expect(nerModelFilePath("/models/a__b", "onnx/model.onnx")).toBe("/models/a__b/onnx/model.onnx");
    expect(() => nerModelFilePath("/models/a__b", "../c")).toThrow(/leaves/);
  });
});
