#!/usr/bin/env node
// Moves the repository's public identifiers from "ai-orchestrator" to "l2m":
// the GitHub repo (TensorGreed/l2m), the container images (ghcr.io/tensorgreed/l2m{,-web,-ner}),
// the Helm chart (ops/helm/l2m, chart name l2m), the VS Code extension publisher (l2m) and a few
// user-visible labels. Internal identifiers stay as they are; see .github/NAMING_DECISION.md.
//
// Usage: node scripts/rename-repo-identifiers.mjs [--dry-run]
//
// Idempotent: a second run finds nothing to change. Every change is printed as
// "path:line" with the old and new text. A line containing "keep-old-name" is never changed,
// so notes that must name the old identifiers (CHANGELOG, NAMING_DECISION) survive re-runs.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const KEEP_MARKER = "keep-old-name";

const OLD_CHART_DIR = "ops/helm/ai-orchestrator";
const NEW_CHART_DIR = "ops/helm/l2m";

/** Files never rewritten: lockfile, this script, and fixtures that replay a third-party export verbatim. */
const EXCLUDED = [
  /^pnpm-lock\.yaml$/,
  /^scripts\/rename-repo-identifiers\.mjs$/,
  /^samples\/external-imports\//,
  /^packages\/workflow-engine\/src\/import\/external-builder\.test\.ts$/
];

const TEXT_EXTENSIONS = new Set([
  ".md", ".mdx", ".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs", ".json", ".yml", ".yaml", ".tpl",
  ".html", ".txt", ".sh", ".conf", ".toml", ".xml", ".css", ".vue", ".example", ".env"
]);

/**
 * Each rule: { name, files?: RegExp (path filter), find: RegExp (global) | string, replace: string }.
 * Order matters: specific prose rules run before the generic ones.
 */
const RULES = [
  // 1. GitHub repo, container images and any owner/repo slug.
  { name: "repo-slug", find: /\b(TensorGreed|tensorgreed)\/ai-orchestrator\b/g, replace: "$1/l2m" },
  { name: "example-image", find: /ghcr\.io\/your-org\/ai-orchestrator\b/g, replace: "ghcr.io/your-org/l2m" },
  // 2. Clone commands.
  { name: "clone-cd", find: /\bcd ai-orchestrator\b/g, replace: "cd l2m" },
  // 3. Helm chart path and chart contents.
  { name: "chart-path", find: /ops\/helm\/ai-orchestrator\b/g, replace: NEW_CHART_DIR },
  { name: "chart-title", files: /^ops\/helm\/l2m\//, find: "# ai-orchestrator Helm", replace: "# L2M Helm" },
  { name: "chart-helpers", files: /^ops\/helm\/l2m\//, find: /\bai-orchestrator\./g, replace: "l2m." },
  { name: "chart-name", files: /^ops\/helm\/l2m\//, find: /\bai-orchestrator\b(?!-dashboard)/g, replace: "l2m" },
  // 4. Release and scan workflows: GHCR repository names and the source SBOM name.
  {
    name: "workflow-image-repo",
    files: /^\.github\/workflows\/(release-images|image-scan)\.yml$/,
    find: /(repository: )ai-orchestrator(-web|-ner)?\b/g,
    replace: "$1l2m$2"
  },
  {
    name: "workflow-sbom-name",
    files: /^\.github\/workflows\/release-images\.yml$/,
    find: "--source-name ai-orchestrator ",
    replace: "--source-name l2m "
  },
  // 5. VS Code extension publisher (Marketplace + Open VSX namespace) and extension ids.
  {
    name: "vscode-publisher",
    files: /^apps\/vscode-l2m-agent\/package\.json$/,
    find: '"publisher": "ai-orchestrator"',
    replace: '"publisher": "l2m"'
  },
  { name: "vscode-extension-id", find: /\bai-orchestrator\.vscode-l2m-agent\b/g, replace: "l2m.vscode-l2m-agent" },
  // 6. Root workspace package name (private, never published; not a pnpm filter anyone uses).
  { name: "root-package-name", files: /^package\.json$/, find: '"name": "ai-orchestrator"', replace: '"name": "l2m"' },
  // 7. User-visible labels.
  {
    name: "node-default-text",
    files: /^(packages\/shared\/src\/definitions\.ts|apps\/docs\/docs\/nodes\/reference\/.*\.md)$/,
    find: /\b(Hello|Customer|Charge|Notification) from ai-orchestrator\b/g,
    replace: "$1 from L2M"
  },
  { name: "mfa-issuer", files: /^apps\/api\/src\/config\.ts$/, find: 'MFA_ISSUER: z.string().min(1).default("ai-orchestrator")', replace: 'MFA_ISSUER: z.string().min(1).default("L2M")' },
  { name: "mfa-issuer", files: /^apps\/api\/src\/services\/mfa-service\.ts$/, find: 'issuer: string = "ai-orchestrator"', replace: 'issuer: string = "L2M"' },
  { name: "mfa-issuer", files: /^\.env\.example$/, find: /^MFA_ISSUER=ai-orchestrator$/gm, replace: "MFA_ISSUER=L2M" },
  { name: "grafana-title", files: /^ops\/grafana\/ai-orchestrator-dashboard\.json$/, find: '"title": "ai-orchestrator",', replace: '"title": "L2M",' },
  { name: "grafana-readme", files: /^ops\/grafana\/README\.md$/, find: "# Grafana dashboard — ai-orchestrator", replace: "# Grafana dashboard — L2M" },
  { name: "prose", files: /^docker-compose\.prod\.yml$/, find: "topology for ai-orchestrator.", replace: "topology for L2M." },
  { name: "prose", files: /^ROADMAP\.md$/, find: "> ai-orchestrator already leads", replace: "> L2M already leads" },
  { name: "prose", files: /^ops\/aws\/ecs-fargate\.md$/, find: "deployment of ai-orchestrator on", replace: "deployment of L2M on" },
  { name: "prose", files: /^ops\/aws\/ecs-fargate\.md$/, find: "the built ai-orchestrator API image", replace: "the built L2M API image" },
  // 8. AWS example resource names (examples only; nothing is created by the repo).
  { name: "aws-example-names", files: /^ops\/aws\//, find: /\bai-orchestrator\b/g, replace: "l2m" }
];

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

function moveChartDir() {
  const from = path.join(repoRoot, OLD_CHART_DIR);
  const to = path.join(repoRoot, NEW_CHART_DIR);
  if (!fs.existsSync(from)) return false;
  if (fs.existsSync(to)) throw new Error(`${OLD_CHART_DIR} and ${NEW_CHART_DIR} both exist; merge them by hand first`);
  console.log(`move ${OLD_CHART_DIR}/ -> ${NEW_CHART_DIR}/`);
  if (!dryRun) {
    try {
      execFileSync("git", ["mv", OLD_CHART_DIR, NEW_CHART_DIR], { cwd: repoRoot, stdio: "ignore" });
    } catch {
      fs.renameSync(from, to);
    }
  }
  return true;
}

function applyRule(line, rule) {
  if (typeof rule.find === "string") return line.split(rule.find).join(rule.replace);
  rule.find.lastIndex = 0;
  return line.replace(rule.find, rule.replace);
}

/** Rewrites the file at `realPath`, choosing rules (and reporting) by `rulePath`, the path it ends up at. */
function rewrite(realPath, rulePath) {
  const abs = path.join(repoRoot, realPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return 0;
  const original = fs.readFileSync(abs, "utf8");
  if (!original.includes("ai-orchestrator")) return 0;
  const rules = RULES.filter((rule) => !rule.files || rule.files.test(rulePath));
  const lines = original.split("\n");
  let changes = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const before = lines[i];
    if (before.includes(KEEP_MARKER) || !before.includes("ai-orchestrator")) continue;
    let after = before;
    const fired = [];
    for (const rule of rules) {
      const next = applyRule(after, rule);
      if (next !== after) fired.push(rule.name);
      after = next;
    }
    if (after !== before) {
      changes += 1;
      lines[i] = after;
      console.log(`${rulePath}:${i + 1} [${fired.join(", ")}]\n  - ${before.trim().slice(0, 240)}\n  + ${after.trim().slice(0, 240)}`);
    }
  }
  if (changes > 0 && !dryRun) fs.writeFileSync(abs, lines.join("\n"));
  return changes;
}

moveChartDir();
let total = 0;
let touched = 0;
for (const listed of trackedFiles()) {
  // Chart files keep their old path in a dry run (nothing moved) or if git mv was unavailable.
  const rulePath = listed.startsWith(`${OLD_CHART_DIR}/`) ? NEW_CHART_DIR + listed.slice(OLD_CHART_DIR.length) : listed;
  const realPath = fs.existsSync(path.join(repoRoot, listed)) ? listed : rulePath;
  if (EXCLUDED.some((re) => re.test(rulePath))) continue;
  const base = path.basename(rulePath);
  if (!TEXT_EXTENSIONS.has(path.extname(rulePath)) && !["Dockerfile", ".env.example", "CODEOWNERS"].includes(base)) continue;
  const n = rewrite(realPath, rulePath);
  total += n;
  if (n > 0) touched += 1;
}
console.log(`\n${dryRun ? "[dry run] would change" : "changed"} ${total} line(s) in ${touched} file(s).`);
