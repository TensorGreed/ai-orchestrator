import { describe, expect, it } from "vitest";
import { nodeDefinitions } from "./definitions";
import { BESPOKE_CREDENTIAL_EDITOR_TYPES, NODE_CREDENTIAL_SPECS } from "./node-credentials";

const secretKeysOf = (schema: Record<string, unknown>): string[] =>
  Object.keys((schema.properties ?? {}) as Record<string, unknown>).filter((key) => /secretref$/i.test(key));

describe("node credential specs", () => {
  it("every node with a secret property has a credential spec or a bespoke editor", () => {
    const uncovered = nodeDefinitions
      .filter((definition) => secretKeysOf(definition.configSchema).length > 0)
      .filter((definition) => !BESPOKE_CREDENTIAL_EDITOR_TYPES.has(definition.type))
      .filter((definition) => {
        const specKeys = new Set((definition.credentials ?? []).map((spec) => spec.key));
        return secretKeysOf(definition.configSchema).some((key) => !specKeys.has(key));
      })
      .map((definition) => definition.type);
    expect(uncovered).toEqual([]);
  });

  it("spec keys reference real secret properties on known nodes", () => {
    for (const [type, specs] of Object.entries(NODE_CREDENTIAL_SPECS)) {
      const definition = nodeDefinitions.find((entry) => entry.type === type);
      expect(definition, type).toBeDefined();
      const props = (definition!.configSchema.properties ?? {}) as Record<string, unknown>;
      for (const spec of specs) {
        expect(props[spec.key], `${type}.${spec.key}`).toBeDefined();
        expect(spec.hint.length, `${type}.${spec.key} hint`).toBeGreaterThan(0);
      }
    }
  });

  it("marks required credentials in the definition's required list", () => {
    const calendar = nodeDefinitions.find((entry) => entry.type === "google_calendar_create_event")!;
    expect(calendar.configSchema.required).toContain("secretRef");
    expect(calendar.credentials?.[0]).toMatchObject({ key: "secretRef", required: true });
    const teams = nodeDefinitions.find((entry) => entry.type === "teams_send_message")!;
    expect(teams.configSchema.required ?? []).not.toContain("secretRef");
  });

  it("bespoke editor list only names real node types", () => {
    const types = new Set(nodeDefinitions.map((entry) => entry.type));
    for (const type of BESPOKE_CREDENTIAL_EDITOR_TYPES) expect(types.has(type as never), type).toBe(true);
  });
});
