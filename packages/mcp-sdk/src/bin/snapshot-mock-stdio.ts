/**
 * Phase 10.8 — stdio entry for the snapshot mock server:
 *
 *   node --import tsx src/bin/snapshot-mock-stdio.ts --snapshot <file> [--cassette <file>] [--fixed-text <text>]
 *
 * The `l2m mcp mock` CLI command does the same in-process; this entry lets
 * tests and scripts spawn the mock without the CLI package.
 */
import fs from "node:fs";
import { parseCassette, parseSnapshotFile, SnapshotMockServer } from "../snapshot-mock";
import { serveSnapshotMockOverStdio } from "../mock-stdio-server";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const snapshotPath = flag("--snapshot");
  if (!snapshotPath) {
    process.stderr.write("Usage: snapshot-mock-stdio --snapshot <file> [--cassette <file>] [--fixed-text <text>]\n");
    process.exit(2);
  }
  const snapshot = parseSnapshotFile(JSON.parse(fs.readFileSync(snapshotPath, "utf8")));
  const cassettePath = flag("--cassette");
  const cassette = cassettePath ? parseCassette(JSON.parse(fs.readFileSync(cassettePath, "utf8"))) : undefined;
  const fixedText = flag("--fixed-text");
  const server = new SnapshotMockServer(snapshot, { ...(cassette ? { cassette } : {}), ...(fixedText ? { fixedText } : {}) });
  await serveSnapshotMockOverStdio(server, { input: process.stdin, output: process.stdout });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
