import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { nerModelFilePath, type NerModel, type NerModelFile } from "./manifest.js";

export type NerFileStatus = "ok" | "missing" | "not_a_file" | "wrong_size" | "wrong_checksum";

export interface NerFileCheck {
  path: string;
  status: NerFileStatus;
  /** Bytes on disk, when the file exists. */
  bytes?: number;
}

export interface NerModelCheck {
  ok: boolean;
  files: NerFileCheck[];
}

export async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(file, signal ? { signal } : {});
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Size first (cheap), then the SHA-256 unless `sizesOnly`. */
export async function checkNerModelFile(folder: string, file: NerModelFile, options: { sizesOnly?: boolean; signal?: AbortSignal } = {}): Promise<NerFileCheck> {
  const full = nerModelFilePath(folder, file.path);
  let info;
  try {
    info = await stat(full);
  } catch {
    return { path: file.path, status: "missing" };
  }
  if (!info.isFile()) return { path: file.path, status: "not_a_file" };
  if (info.size !== file.bytes) return { path: file.path, status: "wrong_size", bytes: info.size };
  if (options.sizesOnly) return { path: file.path, status: "ok", bytes: info.size };
  const digest = await sha256File(full, options.signal);
  return { path: file.path, status: digest === file.sha256 ? "ok" : "wrong_checksum", bytes: info.size };
}

/** Checks every file of a model folder against the manifest. */
export async function verifyNerModel(folder: string, model: NerModel, options: { sizesOnly?: boolean; signal?: AbortSignal } = {}): Promise<NerModelCheck> {
  const files: NerFileCheck[] = [];
  for (const file of model.files) files.push(await checkNerModelFile(folder, file, options));
  return { ok: files.every((file) => file.status === "ok"), files };
}

export function describeFileStatus(check: NerFileCheck): string {
  switch (check.status) {
    case "ok":
      return "ok";
    case "missing":
      return "missing";
    case "not_a_file":
      return "not a regular file";
    case "wrong_size":
      return `wrong size (${check.bytes ?? "?"} bytes)`;
    case "wrong_checksum":
      return "SHA-256 does not match the manifest";
  }
}
