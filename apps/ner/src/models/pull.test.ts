import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { fakeModel } from "../../test/helpers.js";
import { runNerModelsCommand } from "./cli.js";
import { nerModelFolder, type NerModel } from "./manifest.js";
import { pullNerModel } from "./pull.js";
import { verifyNerModel } from "./verify.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function emptyDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "l2m-ner-pull-"));
  dirs.push(dir);
  return dir;
}

/** A fetch that serves the given bodies by URL (no network). */
function serving(bodies: Record<string, Buffer>, options: { status?: number; finalUrl?: string; contentLength?: number; stall?: boolean } = {}): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const body = bodies[url];
    if (!body) return new Response("missing", { status: 404 });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (options.stall) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
          return;
        }
        controller.enqueue(new Uint8Array(body.subarray(0, Math.ceil(body.length / 2))));
        controller.enqueue(new Uint8Array(body.subarray(Math.ceil(body.length / 2))));
        controller.close();
      }
    });
    const response = new Response(stream, { status: options.status ?? 200, headers: { "content-length": String(options.contentLength ?? body.length) } });
    Object.defineProperty(response, "url", { value: options.finalUrl ?? url });
    return response;
  }) as typeof fetch & { calls: string[] };
  impl.calls = calls;
  return impl;
}

function bodiesOf(model: NerModel, contents: Record<string, Buffer>): Record<string, Buffer> {
  return Object.fromEntries(model.files.map((file) => [file.url, contents[file.path]!]));
}

describe("pullNerModel", () => {
  it("downloads every file, checks it and renames it into place", async () => {
    const { model, contents } = fakeModel();
    const modelsDir = emptyDir();
    const result = await pullNerModel({ modelsDir, model, fetchImpl: serving(bodiesOf(model, contents)) });
    expect(result.downloaded).toHaveLength(model.files.length);
    expect((await verifyNerModel(nerModelFolder(modelsDir, model), model)).ok).toBe(true);
    expect(readdirSync(nerModelFolder(modelsDir, model)).some((name) => name.endsWith(".part"))).toBe(false);
  });

  it("keeps files that already match and fetches nothing for them", async () => {
    const { model, contents, modelsDir } = fakeModel();
    dirs.push(modelsDir);
    const fetchImpl = serving(bodiesOf(model, contents));
    const result = await pullNerModel({ modelsDir, model, fetchImpl });
    expect(result.alreadyPresent).toHaveLength(model.files.length);
    expect(fetchImpl.calls).toEqual([]);
  });

  it("refuses a file whose checksum does not match, and keeps nothing of it", async () => {
    const { model, contents } = fakeModel();
    const modelsDir = emptyDir();
    const bodies = bodiesOf(model, contents);
    const onnx = model.files.find((file) => file.path === model.onnx)!;
    bodies[onnx.url] = Buffer.from("x".repeat(onnx.bytes));
    await expect(pullNerModel({ modelsDir, model, fetchImpl: serving(bodies) })).rejects.toThrow(/does not match the manifest/);
    const target = path.join(nerModelFolder(modelsDir, model), model.onnx);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.part`)).toBe(false);
  });

  it("stops a download larger than the manifest says", async () => {
    const { model, contents } = fakeModel();
    const bodies = bodiesOf(model, contents);
    const onnx = model.files.find((file) => file.path === model.onnx)!;
    bodies[onnx.url] = Buffer.concat([contents[model.onnx]!, Buffer.from("extra bytes")]);
    await expect(pullNerModel({ modelsDir: emptyDir(), model, fetchImpl: serving(bodies, { contentLength: undefined as unknown as number }) })).rejects.toThrow(/announced|larger/);
  });

  it("refuses an announced size that differs, an error status and a redirect away from https", async () => {
    const { model, contents } = fakeModel();
    const bodies = bodiesOf(model, contents);
    await expect(pullNerModel({ modelsDir: emptyDir(), model, fetchImpl: serving(bodies, { contentLength: 1 }) })).rejects.toThrow(/announced 1 bytes/);
    await expect(pullNerModel({ modelsDir: emptyDir(), model, fetchImpl: serving(bodies, { status: 403 }) })).rejects.toThrow(/HTTP 403/);
    await expect(pullNerModel({ modelsDir: emptyDir(), model, fetchImpl: serving(bodies, { finalUrl: "http://cdn.example.test/file" }) })).rejects.toThrow(/away from https/);
  });

  it("gives up on a download that stalls", async () => {
    const { model, contents } = fakeModel();
    await expect(pullNerModel({ modelsDir: emptyDir(), model, fetchImpl: serving(bodiesOf(model, contents), { stall: true }), idleTimeoutMs: 50 })).rejects.toThrow(/no data for/);
  });

  it("replaces a link at the target instead of writing through it", async () => {
    const { model, contents } = fakeModel();
    const modelsDir = emptyDir();
    const outside = path.join(emptyDir(), "outside.txt");
    writeFileSync(outside, "keep me");
    const folder = nerModelFolder(modelsDir, model);
    await pullNerModel({ modelsDir, model, fetchImpl: serving(bodiesOf(model, contents)) });
    const target = path.join(folder, "tokenizer.json");
    rmSync(target);
    symlinkSync(outside, target);
    await pullNerModel({ modelsDir, model, fetchImpl: serving(bodiesOf(model, contents)) });
    expect(readFileSync(outside, "utf8")).toBe("keep me");
    expect(readFileSync(target)).toEqual(contents["tokenizer.json"]);
  });
});

describe("models command", () => {
  function io(options: { tty?: boolean; answer?: string; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdout.on("data", (chunk: Buffer) => out.push(chunk.toString()));
    stderr.on("data", (chunk: Buffer) => err.push(chunk.toString()));
    const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
    stdin.isTTY = options.tty ?? false;
    if (options.answer !== undefined) stdin.end(`${options.answer}\n`);
    return { stdout, stderr, stdin, env: options.env ?? {}, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), out, err };
  }

  function manifestFile(manifest: unknown): string {
    const file = path.join(emptyDir(), "models.json");
    writeFileSync(file, JSON.stringify(manifest));
    return file;
  }

  it("refuses to pull without accepting the licence when there is no terminal", async () => {
    const { manifest, model, contents } = fakeModel();
    const fetchImpl = serving(bodiesOf(model, contents));
    const streams = io({ fetchImpl });
    const code = await runNerModelsCommand(["pull", "--manifest", manifestFile(manifest), "--dir", emptyDir()], streams);
    expect(code).toBe(2);
    expect(streams.out.join("")).toContain("Licence:       Apache-2.0");
    expect(streams.out.join("")).toContain("Training data: Synthetic test files.");
    expect(streams.err.join("")).toMatch(/--accept-licence/);
    expect(fetchImpl.calls).toEqual([]);
  });

  it("pulls with --accept-licence, or after a typed yes", async () => {
    const { manifest, model, contents } = fakeModel();
    const dir = emptyDir();
    const accepted = io({ fetchImpl: serving(bodiesOf(model, contents)) });
    expect(await runNerModelsCommand(["pull", model.id, "--manifest", manifestFile(manifest), "--dir", dir, "--accept-licence"], accepted)).toBe(0);
    expect(accepted.out.join("")).toMatch(/Every file matches the manifest/);
    const typed = io({ tty: true, answer: "yes", fetchImpl: serving(bodiesOf(model, contents)) });
    expect(await runNerModelsCommand(["pull", "--manifest", manifestFile(manifest), "--dir", emptyDir()], typed)).toBe(0);
    const declined = io({ tty: true, answer: "no", fetchImpl: serving(bodiesOf(model, contents)) });
    expect(await runNerModelsCommand(["pull", "--manifest", manifestFile(manifest), "--dir", emptyDir()], declined)).toBe(2);
  });

  it("verifies a folder and names the file that does not match", async () => {
    const good = fakeModel();
    dirs.push(good.modelsDir);
    const ok = io();
    expect(await runNerModelsCommand(["verify", "--manifest", manifestFile(good.manifest), "--dir", good.modelsDir], ok)).toBe(0);
    const bad = fakeModel({ corrupt: "tokenizer.json" });
    dirs.push(bad.modelsDir);
    const failed = io();
    expect(await runNerModelsCommand(["verify", "--manifest", manifestFile(bad.manifest), "--dir", bad.modelsDir], failed)).toBe(1);
    expect(failed.out.join("")).toContain("tokenizer.json: SHA-256 does not match the manifest");
  });

  it("lists models with their licence and whether they are pulled, using NER_MODEL_DIR", async () => {
    const { manifest, modelsDir } = fakeModel();
    dirs.push(modelsDir);
    const streams = io({ env: { NER_MODEL_DIR: modelsDir } });
    expect(await runNerModelsCommand(["list", "--manifest", manifestFile(manifest)], streams)).toBe(0);
    expect(streams.out.join("")).toContain("example/fake-gliner (default)");
    expect(streams.out.join("")).toContain("status: present");
  });

  it("refuses unknown flags, commands and models (exit 2)", async () => {
    const { manifest } = fakeModel();
    const file = manifestFile(manifest);
    expect(await runNerModelsCommand(["pull", "--url", "https://x"], io())).toBe(2);
    expect(await runNerModelsCommand(["remove"], io())).toBe(2);
    expect(await runNerModelsCommand(["pull", "nobody/nothing", "--manifest", file, "--accept-licence"], io())).toBe(2);
    expect(await runNerModelsCommand([], io())).toBe(2);
    const help = io();
    expect(await runNerModelsCommand(["--help"], help)).toBe(0);
    expect(help.out.join("")).toContain("models pull");
  });
});
