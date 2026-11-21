// Run with: node --test scripts/ci/changed-areas.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { classify, MAX_LISTED_FILES } from "./changed-areas.mjs";

const everything = { docs_only: false, api_postgres: true, web_e2e: true };

test("docs-only changes skip every suite", () => {
  assert.deepEqual(classify(["apps/docs/docs/guide/intro.md", "docs/index.html", "README.md", "CHANGELOG.md"]), {
    docs_only: true,
    api_postgres: false,
    web_e2e: false
  });
});

test("an empty or oversized file list runs everything", () => {
  assert.deepEqual(classify([]), everything);
  assert.deepEqual(classify(["", "  "]), everything);
  const many = Array.from({ length: MAX_LISTED_FILES }, (_, i) => `apps/docs/docs/page-${i}.md`);
  assert.deepEqual(classify(many), everything);
});

test("API, shared package and dependency changes run both suites", () => {
  for (const file of [
    "apps/api/src/app.ts",
    "apps/api/src/db/migrations.ts",
    "apps/api/package.json",
    "packages/shared/src/index.ts",
    "packages/workflow-engine/src/executor.ts",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    ".github/workflows/ci.yml",
    "samples/workflows/hello.json",
    ".env.example",
    "scripts/e2e-prepare.mjs",
    "apps/docs/README.md\nsomething-new/file.ts"
  ]) {
    assert.deepEqual(classify(file.split("\n")), everything, file);
  }
});

test("a web-only change runs the end-to-end suites but not the API on Postgres", () => {
  assert.deepEqual(classify(["apps/web/src/App.tsx", "apps/web/e2e/canvas-flow.spec.ts", "docs/index.html"]), {
    docs_only: false,
    api_postgres: false,
    web_e2e: true
  });
});

test("the web app's public folder is read by the API tests", () => {
  assert.equal(classify(["apps/web/public/favicon.svg"]).api_postgres, true);
});

test("unit-test-only changes skip the end-to-end suites", () => {
  assert.deepEqual(classify(["apps/api/src/routes/foo.test.ts", "apps/api/src/test-support/test-store.ts", "apps/web/src/lib/api.test.ts"]), {
    docs_only: false,
    api_postgres: true,
    web_e2e: false
  });
  assert.deepEqual(classify(["packages/guard-sdk/src/detectors.test.ts", "apps/web/src/Canvas.test.tsx"]), {
    docs_only: false,
    api_postgres: false,
    web_e2e: false
  });
});

test("an end-to-end spec is never treated as a unit test", () => {
  assert.equal(classify(["apps/web/e2e/helpers.test.ts"]).web_e2e, true);
});

test("tooling for other jobs skips both suites; this workflow does not", () => {
  assert.deepEqual(classify([".github/workflows/pages.yml", ".github/dependabot.yml", "apps/vscode-l2m-agent/src/extension.ts", "apps/ner/app.py"]), {
    docs_only: false,
    api_postgres: false,
    web_e2e: false
  });
  assert.deepEqual(classify([".github/workflows/ci.yml"]), everything);
  assert.deepEqual(classify([".github/actions/setup/action.yml"]), everything);
});

test("deployment files skip the end-to-end suites only", () => {
  assert.deepEqual(classify(["ops/helm/l2m/values.yaml", "scripts/release/smoke-api.sh", "docker-compose.prod.yml", "apps/api/Dockerfile"]), {
    docs_only: false,
    api_postgres: true,
    web_e2e: false
  });
});

test("the command line prints key=value lines for GITHUB_OUTPUT", () => {
  const script = fileURLToPath(new URL("./changed-areas.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [script], { input: "apps/web/src/App.tsx\n", encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "docs_only=false\napi_postgres=false\nweb_e2e=true\n");
});

test("docs files that tests read are not docs-only", () => {
  assert.deepEqual(classify(["docs/install.sh"]), { docs_only: false, api_postgres: true, web_e2e: true });
  assert.deepEqual(classify(["apps/docs/docs/getting-started/quickstart.md"]), { docs_only: false, api_postgres: true, web_e2e: true });
  assert.equal(classify(["apps/web/e2e-demo/helpers.test.ts"]).web_e2e, true);
});
