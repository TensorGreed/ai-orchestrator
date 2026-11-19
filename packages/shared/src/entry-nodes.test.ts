import { describe, expect, it } from "vitest";
import { ENTRY_NODE_TYPES, LIVE_ENTRY_NODE_TYPES, isEntryNodeType, isLiveEntryOff, liveEntryOffMessage, nodeDefinitions } from "./definitions";

/**
 * Entry nodes whose executor reads or consumes from an external system when it runs as the first node: a worker lost
 * after one of these ran must not re-run the job silently. Every Input-category node is either flagged
 * `effectFreeEntry` or listed here, so a new entry node fails this test until it is classified.
 */
const EFFECTFUL_ENTRY_TYPES = [
  "imap_email_trigger",
  "google_sheets_trigger",
  "postgres_trigger",
  "redis_trigger",
  "kafka_trigger",
  "rabbitmq_trigger",
  "mqtt_trigger",
  "google_drive_trigger"
];

describe("effect-free entry nodes", () => {
  it("classifies every Input-category node deliberately", () => {
    const inputTypes = nodeDefinitions.filter((node) => node.category === "Input").map((node) => node.type);
    const unclassified = inputTypes.filter((type) => !ENTRY_NODE_TYPES.has(type) && !EFFECTFUL_ENTRY_TYPES.includes(type));
    expect(unclassified).toEqual([]);
    for (const type of EFFECTFUL_ENTRY_TYPES) expect(inputTypes).toContain(type);
  });

  it("are the pass-through triggers and static inputs, never a poller, query or consumer", () => {
    expect([...ENTRY_NODE_TYPES].sort()).toEqual(
      [
        "chat_trigger",
        "discord_trigger",
        "error_trigger",
        "file_trigger",
        "form_trigger",
        "github_webhook_trigger",
        "manual_trigger",
        "mcp_server_trigger",
        "rss_trigger",
        "schedule_trigger",
        "slack_trigger",
        "sse_trigger",
        "stripe_webhook_trigger",
        "sub_workflow_trigger",
        "system_prompt",
        "telegram_trigger",
        "text_input",
        "user_prompt",
        "webhook_input"
      ].sort()
    );
    for (const type of EFFECTFUL_ENTRY_TYPES) expect(isEntryNodeType(type)).toBe(false);
  });

  it("only flags Input-category nodes, and treats unknown or community types as effectful", () => {
    for (const node of nodeDefinitions) {
      if (node.effectFreeEntry) expect(node.category).toBe("Input");
    }
    for (const type of ["llm_call", "agent_orchestrator", "http_request", "mcp_tool", "code_node", "community_widget", ""]) {
      expect(isEntryNodeType(type)).toBe(false);
    }
  });
});

describe("live entry points that can be switched off", () => {
  it("covers webhooks, forms, chats, MCP triggers and schedules, each with an `active` switch; unset is on", () => {
    expect([...LIVE_ENTRY_NODE_TYPES].sort()).toEqual(["chat_trigger", "form_trigger", "mcp_server_trigger", "schedule_trigger", "webhook_input"]);
    for (const type of LIVE_ENTRY_NODE_TYPES) {
      const definition = nodeDefinitions.find((node) => node.type === type)!;
      expect((definition.configSchema as { properties: Record<string, unknown> }).properties.active, type).toEqual({ type: "boolean" });
      expect(isLiveEntryOff({ type, config: { active: false } })).toBe(true);
      expect(isLiveEntryOff({ type, config: { active: true } })).toBe(false);
      expect(isLiveEntryOff({ type, config: {} })).toBe(false);
      expect(isLiveEntryOff({ type })).toBe(false);
    }
    expect(isLiveEntryOff({ type: "manual_trigger", config: { active: false } })).toBe(false);
    expect(liveEntryOffMessage("webhook_input")).toBe("This webhook is turned off. Turn it on in the workflow editor to accept live calls.");
    expect(liveEntryOffMessage("form_trigger")).toMatch(/^This form is turned off/);
  });
});
