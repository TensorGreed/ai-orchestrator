import { describe, expect, it } from "vitest";
import { LEAK_PATTERNS, findLeaks, literalPattern } from "./leak-patterns";

// Fake values shaped like the real thing, assembled so this file holds none verbatim.
const join = (...parts: string[]) => parts.join("");

describe("fixture leak patterns", () => {
  it("catch each kind of credential", () => {
    const samples: Record<string, string> = {
      "API key (sk-/pk-/rk-)": join("sk", "-", "a".repeat(20)),
      "GitHub token": join("gh", "p_", "A".repeat(36)),
      "Slack token": join("xo", "xb-", "1234567890-abcdef"),
      "AWS access key id": join("AK", "IA", "ABCDEFGHIJKLMNOP"),
      "JSON Web Token": join("ey", "JhbGciOi.", "eyJzdWIi.", "c2lnbmF0dXJl"),
      "PEM block": join("-----BEGIN ", "PRIVATE KEY-----"),
      "Bearer token": join("Bea", "rer ", "abcdefghijklmnop"),
      "recording password": join("Demo-Only", "-Pass"),
      "home directory path": join("/ho", "me/", "alice/", "repo"),
      "Windows user path": join("C:", "\\\\", "Users", "\\\\", "alice")
    };
    expect(Object.keys(samples).sort()).toEqual(LEAK_PATTERNS.map((entry) => entry.name).sort());
    for (const [name, sample] of Object.entries(samples)) {
      expect(findLeaks(`{"value":"${sample}"}`).map((leak) => leak.name), name).toEqual([name]);
    }
    expect(findLeaks(join("github", "_pat_", "B".repeat(30))).map((leak) => leak.name)).toEqual(["GitHub token"]);
    expect(findLeaks(join("xo", "xs-", "1234567890-x")).map((leak) => leak.name)).toEqual(["Slack token"]);
    expect(findLeaks(join("/Us", "ers/", "bob/", "Library")).map((leak) => leak.name)).toEqual(["home directory path"]);
    expect(findLeaks(join("C:", "\\", "Users", "\\", "bob")).map((leak) => leak.name)).toEqual(["Windows user path"]);
  });

  it("leave ordinary text alone", () => {
    expect(findLeaks('{"name":"Support agent","host":"models.example.com","note":"risk-free task","path":"/home","dir":"/Users/"}')).toEqual([]);
  });

  it("match machine values literally and on word boundaries", () => {
    expect(findLeaks("/srv/someone/repo/file", [{ name: "checkout", pattern: literalPattern("/srv/someone") }])).toHaveLength(1);
    expect(findLeaks("hostname build-42.", [{ name: "host", pattern: literalPattern("build-42") }])).toHaveLength(1);
    expect(findLeaks("rebuild-420", [{ name: "host", pattern: literalPattern("build-42") }])).toHaveLength(0);
  });
});
