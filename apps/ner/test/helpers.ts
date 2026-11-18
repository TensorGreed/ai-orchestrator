import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseNerManifest, type NerManifest, type NerModel } from "../src/models/manifest.js";

/** A model folder of small fake files (no weights) and a manifest whose checksums match them. */
export function fakeModel(options: { id?: string; corrupt?: string } = {}): { modelsDir: string; manifest: NerManifest; model: NerModel; contents: Record<string, Buffer> } {
  const modelsDir = mkdtempSync(path.join(tmpdir(), "l2m-ner-test-"));
  const id = options.id ?? "example/fake-gliner";
  const contents: Record<string, Buffer> = {
    "onnx/model.onnx": Buffer.from("not really an onnx file"),
    "tokenizer.json": Buffer.from("{}"),
    "tokenizer_config.json": Buffer.from("{}"),
    "gliner_config.json": Buffer.from('{"max_width":12}')
  };
  const files = Object.entries(contents).map(([file, body]) => ({
    path: file,
    url: `https://models.example.test/${id}/resolve/abc123/${file}`,
    sha256: createHash("sha256").update(body).digest("hex"),
    bytes: body.length
  }));
  const manifest = parseNerManifest({
    format: "l2m.ner-models",
    version: 1,
    default: id,
    models: [
      {
        id,
        name: "Fake GLiNER",
        publisher: "Example",
        homepage: "https://models.example.test/",
        revision: "abc123",
        licence: { id: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0", trainingData: "Synthetic test files." },
        architecture: "gliner",
        files,
        onnx: "onnx/model.onnx",
        tokenizer: "tokenizer.json",
        tokenizerConfig: "tokenizer_config.json",
        glinerConfig: "gliner_config.json",
        languages: ["en"],
        prompts: [
          { prompt: "name", class: "person_name", threshold: 0.5 },
          { prompt: "location street", class: "street_address", threshold: 0.5 },
          { prompt: "location city", class: "location", addressPart: true, threshold: 0.5, joinThreshold: 0.3 },
          { prompt: "location zip", class: null, addressPart: true, threshold: 0.5 }
        ]
      }
    ]
  });
  const model = manifest.models[0]!;
  const folder = path.join(modelsDir, id.replace("/", "__"));
  for (const [file, body] of Object.entries(contents)) {
    mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
    writeFileSync(path.join(folder, file), options.corrupt === file ? Buffer.concat([body.subarray(1), Buffer.from("x")]) : body);
  }
  return { modelsDir, manifest, model, contents };
}
