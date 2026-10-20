/**
 * Writes the external workflow import coverage table into the docs site.
 *
 *   pnpm --filter @ai-orchestrator/workflow-engine gen:import-coverage
 *
 * Output: apps/docs/docs/product/external-import-coverage.md, included by
 * apps/docs/docs/product/importing-from-another-builder.md.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderExternalImportCoverageMarkdown } from "../src/import/coverage-markdown.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.resolve(scriptDir, "..", "..", "..", "apps", "docs", "docs", "product", "external-import-coverage.md");

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, renderExternalImportCoverageMarkdown(), "utf8");
console.log(`Wrote ${path.relative(process.cwd(), outFile)}`);
