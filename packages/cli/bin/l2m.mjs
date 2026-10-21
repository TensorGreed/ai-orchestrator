#!/usr/bin/env node
// The l2m CLI runs its TypeScript sources directly, like the rest of the workspace.
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/main.ts");
process.exitCode = await main(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env
});
