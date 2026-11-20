/**
 * Every Docker Compose file at the repository root must be valid YAML with a services map, so
 * `docker compose -f <file> config` (and `up`) can read it. An unquoted value containing ": " (for example in a
 * `${VAR:?message}` hint) is a YAML error that only shows up when someone follows the deployment docs.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const root = path.resolve(import.meta.dirname, "../../..");
const composeFiles = fs
  .readdirSync(root)
  .filter((name) => /^docker-compose(\.[\w-]+)?\.ya?ml$/.test(name))
  .sort();

describe("Docker Compose files", () => {
  it("finds the shipped compose files", () => {
    expect(composeFiles).toEqual(expect.arrayContaining(["docker-compose.yml", "docker-compose.prod.yml", "docker-compose.scale.yml"]));
  });

  it.each(composeFiles)("%s parses as YAML with a services map", (name) => {
    const document = parseDocument(fs.readFileSync(path.join(root, name), "utf8"), { uniqueKeys: true });
    expect(document.errors.map((error) => error.message)).toEqual([]);
    const parsed = document.toJS({ maxAliasCount: 1000 }) as { services?: unknown };
    expect(parsed.services).toBeTypeOf("object");
    expect(Object.keys(parsed.services as object).length).toBeGreaterThan(0);
  });
});
