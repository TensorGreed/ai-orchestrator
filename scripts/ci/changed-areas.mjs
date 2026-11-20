#!/usr/bin/env node
// Decides which CI suites a pull request needs from its changed files (one path per line on stdin).
// Prints key=value lines for $GITHUB_OUTPUT:
//   docs_only     every file is docs (apps/docs/, docs/, a Markdown file at the repo root; not the two docs files tests
//                 read): skip all test suites
//   api_postgres  run the API suite on Postgres
//   web_e2e       run the web end-to-end suites
// Each suite is skipped only when every changed file is in an area listed as unrelated to it; any other path,
// including one nobody has classified yet, runs the suite. Pushes to main do not use this script: they run everything.
//
// Run with: node scripts/ci/changed-areas.mjs < files.txt

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The GitHub files API lists at most 3000 files; anything that large counts as a change to everything.
export const MAX_LISTED_FILES = 3000;

// Docs files that tests read are not docs-only changes: docs/install.sh (the API's compose-files test) and the
// quickstart page (the first-run E2E spec walks it word for word).
const READ_BY_TESTS = /^(docs\/install\.sh|apps\/docs\/docs\/getting-started\/quickstart\.md)$/;
const DOCS = [/^apps\/docs\//, /^docs\//, /^[^/]+\.md$/].map((pattern) => ({ test: (file) => pattern.test(file) && !READ_BY_TESTS.test(file) }));

// Areas that cannot change what the other suites test.
const TOOLING_ELSEWHERE = [
  // Other workflows and repo settings (this workflow and its local actions are not in the list: a change to them
  // runs everything).
  /^\.github\/(?!workflows\/ci\.yml$|actions\/)/,
  // The VS Code extension has its own job.
  /^apps\/vscode-l2m-agent\//,
  // The NER service is a separate image with its own unit tests.
  /^apps\/ner\//
];

// A unit test file of a package other than the API: it runs in the unit test job, and nothing imports it.
const PACKAGE_UNIT_TEST = /^packages\/[^/]+\/.*\.test\.tsx?$/;

const UNRELATED_TO_API_POSTGRES = [
  ...DOCS,
  ...TOOLING_ELSEWHERE,
  // The web app, except its public folder (the API tests read files there). The API tests also read
  // apps/web/nginx.conf and .github/workflows/release-images.yml; those tests do not use the store and run on SQLite.
  /^apps\/web\/(?!public\/)/,
  PACKAGE_UNIT_TEST
];

const UNRELATED_TO_WEB_E2E = [
  ...DOCS,
  ...TOOLING_ELSEWHERE,
  // Unit tests and test-only helpers anywhere except the end-to-end specs themselves.
  /^(?!apps\/web\/e2e(-demo)?\/).*\.test\.tsx?$/,
  /^apps\/api\/src\/test-support\//,
  // The MCP conformance harness has its own job.
  /^apps\/api\/conformance\//,
  // Container images, Helm and the load test are not part of the end-to-end setup.
  /^ops\//,
  /^scripts\/release\//,
  /^docker-compose[^/]*\.yml$/,
  /(^|\/)Dockerfile[^/]*$/
];

const allMatch = (files, patterns) => files.every((file) => patterns.some((pattern) => pattern.test(file)));

/** @param {string[]} input changed file paths, relative to the repo root */
export function classify(input) {
  const files = input.map((line) => line.trim()).filter(Boolean);
  if (files.length === 0 || files.length >= MAX_LISTED_FILES) {
    return { docs_only: false, api_postgres: true, web_e2e: true };
  }
  const docsOnly = allMatch(files, DOCS);
  return {
    docs_only: docsOnly,
    api_postgres: !docsOnly && !allMatch(files, UNRELATED_TO_API_POSTGRES),
    web_e2e: !docsOnly && !allMatch(files, UNRELATED_TO_WEB_E2E)
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = readFileSync(0, "utf8").split("\n");
  const result = classify(files);
  for (const [key, value] of Object.entries(result)) process.stdout.write(`${key}=${value}\n`);
}
