import fs from "node:fs";
import path from "node:path";
import { importWorkflowFromJson } from "@ai-orchestrator/workflow-engine";
import { SqliteStore } from "../db/database";

export function seedWorkflowsIfEmpty(store: SqliteStore): void {
  if (store.countWorkflows() > 0) {
    return;
  }

  const sampleDir = path.resolve(process.cwd(), "samples", "workflows");
  if (!fs.existsSync(sampleDir)) {
    return;
  }

  const files = fs.readdirSync(sampleDir).filter((file) => file.endsWith(".json"));
  for (const fileName of files) {
    const fullPath = path.join(sampleDir, fileName);
    const raw = fs.readFileSync(fullPath, "utf8");
    const workflow = importWorkflowFromJson(raw);
    store.upsertWorkflow(workflow);
  }
}