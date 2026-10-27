import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadApiEnvFiles, resolveSettingOrigins } from "./env-files.js";

describe("env-files: one loader for the API and db:copy", () => {
  let dir: string;
  let apiRoot: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-files-"));
    apiRoot = path.join(dir, "apps", "api");
    fs.mkdirSync(apiRoot, { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (root: string | undefined, api: string | undefined) => {
    if (root !== undefined) fs.writeFileSync(path.join(dir, ".env"), root);
    if (api !== undefined) fs.writeFileSync(path.join(apiRoot, ".env"), api);
  };

  /** What index.ts did before it used the shared loader: two dotenv.config calls on process.env. */
  function legacyIndexRule(env: Record<string, string | undefined>): void {
    const processEnv = env as dotenv.DotenvPopulateInput;
    const rootEnvPath = path.join(dir, ".env");
    const apiEnvPath = path.join(apiRoot, ".env");
    if (fs.existsSync(rootEnvPath)) dotenv.config({ path: rootEnvPath, processEnv, quiet: true });
    if (fs.existsSync(apiEnvPath)) dotenv.config({ path: apiEnvPath, processEnv, override: true, quiet: true });
  }

  it("keeps the precedence: apps/api/.env beats the environment, which beats the root .env", () => {
    write("A=root\nB=root\nC=root\nD=root\n", "B=api\nC=api\n");
    const env: Record<string, string | undefined> = { C: "shell", D: "shell" };
    const loaded = loadApiEnvFiles(apiRoot, env);
    expect(loaded).toEqual([path.join(dir, ".env"), path.join(apiRoot, ".env")]);
    expect(env).toEqual({ A: "root", B: "api", C: "api", D: "shell" });
  });

  it("gives the values the API's former inline rule gave, and the origins db:copy reports", () => {
    write("A=root\nB=root\nC=root\nD=root\n", "B=api\nC=api\n");
    const start = { C: "shell", D: "shell" };
    const keys = ["A", "B", "C", "D", "E"];
    const origins = resolveSettingOrigins(apiRoot, start, keys);
    const viaLoader: Record<string, string | undefined> = { ...start };
    const viaLegacy: Record<string, string | undefined> = { ...start };
    loadApiEnvFiles(apiRoot, viaLoader);
    legacyIndexRule(viaLegacy);
    expect(viaLoader).toEqual(viaLegacy);
    for (const key of keys) expect(origins[key]!.value).toBe(viaLoader[key]);
  });

  it("works with only one of the files, or neither", () => {
    write(undefined, "X=api\n");
    const env: Record<string, string | undefined> = { X: "shell" };
    expect(loadApiEnvFiles(apiRoot, env)).toEqual([path.join(apiRoot, ".env")]);
    expect(env.X).toBe("api");
    fs.rmSync(path.join(apiRoot, ".env"));
    expect(loadApiEnvFiles(apiRoot, {})).toEqual([]);
  });

  it("index.ts loads its settings through this module and nowhere else", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "index.ts"), "utf8");
    expect(source).toContain('from "./env-files.js"');
    expect(source).toMatch(/loadApiEnvFiles\(apiRoot\)/);
    expect(source).not.toMatch(/dotenv/);
  });
});
