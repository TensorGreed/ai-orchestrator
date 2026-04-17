import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, unlink, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { BinaryDataReference, BinaryDataStore } from "@ai-orchestrator/shared";

export class FileSystemBinaryStore implements BinaryDataStore {
  constructor(private baseDir: string) {}

  async write(
    id: string,
    data: Uint8Array,
    meta: { fileName: string; mimeType: string }
  ): Promise<BinaryDataReference> {
    const binaryId = id || randomUUID();
    const storagePath = join(binaryId.slice(0, 2), `${binaryId}.bin`);
    const fullPath = join(this.baseDir, storagePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, data);
    return {
      __binaryRef: true,
      id: binaryId,
      fileName: meta.fileName,
      mimeType: meta.mimeType,
      size: data.byteLength,
      storagePath
    };
  }

  async read(ref: BinaryDataReference): Promise<Buffer> {
    const fullPath = join(this.baseDir, ref.storagePath);
    return readFile(fullPath);
  }

  async delete(ref: BinaryDataReference): Promise<void> {
    const fullPath = join(this.baseDir, ref.storagePath);
    await unlink(fullPath).catch(() => {});
  }

  async cleanup(executionId: string): Promise<void> {
    const dir = join(this.baseDir, executionId.slice(0, 2));
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
