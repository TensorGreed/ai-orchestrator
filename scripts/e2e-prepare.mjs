import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

const targets = [
  path.join(repoRoot, "apps", "api", "data", "orchestrator.db"),
  path.join(repoRoot, "apps", "api", "data", "git")
];

for (const target of targets) {
  await fs.rm(target, { recursive: true, force: true });
}

await fs.mkdir(path.join(repoRoot, "apps", "api", "data"), { recursive: true });
console.log("[e2e-prepare] reset local sqlite db and git sync workspace");
