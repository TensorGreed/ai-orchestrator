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
    expect(composeFiles).toEqual(
      expect.arrayContaining(["docker-compose.yml", "docker-compose.prod.yml", "docker-compose.scale.yml", "docker-compose.quickstart.yml"])
    );
  });

  it.each(composeFiles)("%s parses as YAML with a services map", (name) => {
    const document = parseDocument(fs.readFileSync(path.join(root, name), "utf8"), { uniqueKeys: true });
    expect(document.errors.map((error) => error.message)).toEqual([]);
    const parsed = document.toJS({ maxAliasCount: 1000 }) as { services?: unknown };
    expect(parsed.services).toBeTypeOf("object");
    expect(Object.keys(parsed.services as object).length).toBeGreaterThan(0);
  });
});

/**
 * docker-compose.quickstart.yml and docs/install.sh are what a new user runs: they pull the published images of the
 * release they belong to. Their default version must be the release being cut (v + the root package.json version),
 * the image names must be the ones the release workflow publishes, and the API must stay behind the studio.
 */
describe("docker-compose.quickstart.yml", () => {
  type Service = { image?: string; ports?: string[]; command?: string[]; volumes?: string[]; environment?: Record<string, string> };
  const quickstart = parseDocument(fs.readFileSync(path.join(root, "docker-compose.quickstart.yml"), "utf8")).toJS() as {
    name?: string;
    services: Record<string, Service>;
    volumes?: Record<string, unknown>;
  };
  const release = `v${(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version}`;
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/release-images.yml"), "utf8");
  const installer = fs.readFileSync(path.join(root, "docs/install.sh"), "utf8");
  const startScript = path.join(root, "apps/api/scripts/quickstart-start.sh");

  it("pulls the images the release workflow publishes, at this release by default", () => {
    expect(workflow).toContain("IMAGE_REGISTRY: ghcr.io/tensorgreed");
    expect(quickstart.services.api.image).toBe(`ghcr.io/tensorgreed/l2m:\${L2M_VERSION:-${release}}`);
    expect(quickstart.services.web.image).toBe(`ghcr.io/tensorgreed/l2m-web:\${L2M_VERSION:-${release}}`);
    expect(quickstart.name).toBe("l2m");
  });

  it("keeps the API behind the studio, on this machine only by default, with its data in a volume", () => {
    expect(quickstart.services.api.ports).toBeUndefined();
    expect(quickstart.services.web.ports).toEqual(["${L2M_BIND:-127.0.0.1}:${L2M_PORT:-8080}:80"]);
    expect(quickstart.services.api.volumes).toEqual(["l2m-data:/app/apps/api/data"]);
    expect(Object.keys(quickstart.volumes ?? {})).toEqual(["l2m-data"]);
    expect(quickstart.services.api.environment?.AUTH_ALLOW_PUBLIC_REGISTER).toBe("false");
  });

  it("starts the API through the first-start script that the API image contains", () => {
    expect(quickstart.services.api.command).toEqual(["sh", "/app/apps/api/scripts/quickstart-start.sh"]);
    expect(fs.existsSync(startScript)).toBe(true);
    const dockerfile = fs.readFileSync(path.join(root, "apps/api/Dockerfile"), "utf8");
    expect(dockerfile).toContain("COPY apps/api apps/api");
    const dockerignore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8").split("\n");
    expect(dockerignore.some((line) => /^apps\/api(\/scripts)?\/?$/.test(line.trim()))).toBe(false);
  });

  it("is what docs/install.sh downloads, at the same default release", () => {
    expect(installer).toContain(`version=\${L2M_VERSION:-${release}}`);
    expect(installer).toContain("https://raw.githubusercontent.com/TensorGreed/l2m/$version/docker-compose.quickstart.yml");
    expect(installer).not.toMatch(/\bsudo\s/);
  });
});

