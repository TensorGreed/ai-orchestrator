import { createHash } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { nerModelFilePath, nerModelFolder, type NerModel, type NerModelFile } from "./manifest.js";
import { checkNerModelFile } from "./verify.js";

export interface PullNerModelOptions {
  modelsDir: string;
  model: NerModel;
  /** Injected in tests; the global fetch otherwise. */
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** No bytes for this long aborts the download (default 60 s). */
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface PullNerModelResult {
  folder: string;
  downloaded: string[];
  alreadyPresent: string[];
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/**
 * Downloads a model's files from the publisher's URLs in the manifest into `<modelsDir>/<publisher>__<name>/`.
 * Files already present with the right SHA-256 are kept. Each download goes to `<file>.part` (created fresh, never
 * through an existing file or link), is hashed while it streams, stops as soon as it passes the manifest's size, and
 * is renamed into place only when size and SHA-256 both match. Nothing is executed or unpacked.
 */
export async function pullNerModel(options: PullNerModelOptions): Promise<PullNerModelResult> {
  const folder = nerModelFolder(options.modelsDir, options.model);
  await mkdir(folder, { recursive: true });
  const log = options.log ?? (() => undefined);
  const downloaded: string[] = [];
  const alreadyPresent: string[] = [];
  for (const file of options.model.files) {
    options.signal?.throwIfAborted();
    const existing = await checkNerModelFile(folder, file, options.signal ? { signal: options.signal } : {});
    if (existing.status === "ok") {
      alreadyPresent.push(file.path);
      log(`${file.path}: already present, checksum ok`);
      continue;
    }
    log(`${file.path}: downloading ${formatBytes(file.bytes)} from ${new URL(file.url).host}`);
    await downloadFile(folder, file, options);
    downloaded.push(file.path);
    log(`${file.path}: checksum ok`);
  }
  return { folder, downloaded, alreadyPresent };
}

async function downloadFile(folder: string, file: NerModelFile, options: PullNerModelOptions): Promise<void> {
  const dest = nerModelFilePath(folder, file.path);
  const part = `${dest}.part`;
  await mkdir(path.dirname(dest), { recursive: true });
  await rm(part, { force: true });
  const controller = new AbortController();
  const idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  let idleTimer: NodeJS.Timeout | undefined;
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error(`no data for ${Math.round(idleMs / 1000)} s`)), idleMs);
  };
  const onOuterAbort = () => controller.abort(options.signal?.reason ?? new Error("stopped"));
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  // "wx": fails if anything (a file or a link) appeared at the .part path since the rm above.
  const handle = await open(part, "wx", 0o644);
  let ok = false;
  try {
    touch();
    const response = await (options.fetchImpl ?? fetch)(file.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { accept: "application/octet-stream", "user-agent": "l2m-ner-models" }
    });
    if (!response.ok || !response.body) throw new Error(`${file.path}: the download answered HTTP ${response.status}`);
    if (response.url && !response.url.startsWith("https:")) throw new Error(`${file.path}: the download was redirected away from https`);
    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared !== file.bytes) throw new Error(`${file.path}: the server announced ${declared} bytes, the manifest says ${file.bytes}`);
    const hash = createHash("sha256");
    let total = 0;
    let nextReport = 0.25;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      touch();
      total += value.byteLength;
      if (total > file.bytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${file.path}: the download is larger than the manifest's ${file.bytes} bytes`);
      }
      hash.update(value);
      await handle.write(value);
      if (file.bytes > 16 * 1024 * 1024 && total / file.bytes >= nextReport) {
        options.log?.(`${file.path}: ${Math.floor((total / file.bytes) * 100)}%`);
        nextReport += 0.25;
      }
    }
    if (total !== file.bytes) throw new Error(`${file.path}: got ${total} bytes, the manifest says ${file.bytes}`);
    const digest = hash.digest("hex");
    if (digest !== file.sha256) throw new Error(`${file.path}: SHA-256 ${digest} does not match the manifest (${file.sha256}); the file was not kept`);
    await handle.sync();
    ok = true;
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof Error) {
      throw new Error(`${file.path}: download stopped (${controller.signal.reason.message})`);
    }
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", onOuterAbort);
    await handle.close();
    if (!ok) await rm(part, { force: true });
  }
  await rename(part, dest);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
