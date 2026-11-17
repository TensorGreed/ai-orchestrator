import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkSeo, competitorNameIn } from "../../../scripts/pages-seo-checks.mjs";

// The competing workflow tool's name, built from its letters so it never sits in the docs sources.
const NAME = ["n", "8", "n"].join("");

describe("competitorNameIn", () => {
  it("finds the name in prose and in code, in any case", () => {
    expect(competitorNameIn(`Import from ${NAME} today`)).toContain(NAME);
    expect(competitorNameIn(`<code>${NAME}-nodes-base.webhook</code>`)).toContain(NAME);
    expect(competitorNameIn(`"@${NAME.toUpperCase()}/x"`)).not.toBeNull();
  });

  it("ignores the letters inside a longer token and inside data: URIs", () => {
    expect(competitorNameIn(`assets/index-a1${NAME}b.js`)).toBeNull();
    expect(competitorNameIn(`<img src="data:image/png;base64,AAAA+${NAME}/BBBB=">`)).toBeNull();
    expect(competitorNameIn("plain text with no match")).toBeNull();
  });
});

describe("checkSeo: the name in built text files", () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function site(files) {
    const dir = mkdtempSync(path.join(tmpdir(), "pages-name-"));
    dirs.push(dir);
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), content);
    }
    return dir;
  }

  it("fails for a script or a code block that names it, and passes without", async () => {
    const named = await checkSeo(
      site({ "demo/assets/app.js": `const t = "${NAME}-nodes-base.webhook";`, "docs/x.html": "<pre>ok</pre>", "logo.png": NAME }),
      { baseline: { title: new Set(), description: new Set() } }
    );
    const nameFailures = named.failures.filter((message) => message.includes("names the competing workflow tool"));
    expect(nameFailures).toHaveLength(1);
    expect(nameFailures[0]).toContain("/demo/assets/app.js");

    const clean = await checkSeo(site({ "docs/x.html": "<pre>webhook</pre>", "logo.png": NAME }), {
      baseline: { title: new Set(), description: new Set() }
    });
    expect(clean.failures.some((message) => message.includes("names the competing workflow tool"))).toBe(false);
    expect(clean.passes.some((message) => message.startsWith("no text file of the site names"))).toBe(true);
  });
});
