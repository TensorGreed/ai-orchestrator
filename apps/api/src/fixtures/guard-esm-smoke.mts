// Loaded by guard-node-esm.test.ts with tsx on Node's own ESM loader, the way `pnpm start` runs the API.
import { createDefaultGuardProfile, createDefaultGuardRegistry, evaluateGuard } from "@ai-orchestrator/guard-sdk";

const verdict = await evaluateGuard(
  createDefaultGuardProfile(),
  { channel: "tool_arguments", content: { query: "SELECT * FROM users; DROP TABLE users" }, labels: [] },
  { registry: createDefaultGuardRegistry() }
);
console.log(JSON.stringify({ action: verdict.action, detectors: verdict.findings.map((finding) => finding.detectorId) }));
