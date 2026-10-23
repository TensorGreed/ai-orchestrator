/**
 * Drift guard for the live-read allow-list (Phase 15.3, `REPLAY_LIVE_READ_POLICY`).
 *
 * A replay may run a node live (`overrides.liveReadNodes`) only when its type
 * is decided `safe` (or `get_only`) in that table. This test fails when:
 *   - a node type is added to `nodeDefinitions` without a decision there, or
 *   - the set of types that may run live changes.
 *
 * A new type that may run live must be a pure read with no side effects
 * (no trigger, no browser, no raw query, no write): add it to the table and
 * to `MAY_RUN_LIVE` below in the same change, so the review sees both.
 */
import { describe, expect, it } from "vitest";
import { nodeDefinitions } from "./definitions";
import { REPLAY_LIVE_READ_POLICY, REPLAY_NODE_CLASSES, replayLiveReadRefusal } from "./replay";

const MAY_RUN_LIVE: Record<string, "safe" | "get_only"> = {
  airtable_list_records: "safe",
  aws_s3_get_object: "safe",
  aws_s3_list_objects: "safe",
  google_calendar_list_events: "safe",
  google_drive_source: "safe",
  google_sheets_read: "safe",
  hubspot_get_contact: "safe",
  http_request: "get_only",
  jira_search_issues: "safe",
  notion_query_database: "safe"
};

describe("live-read allow-list drift", () => {
  it("has a decision for every node type", () => {
    const undecided = nodeDefinitions.map((definition) => definition.type).filter((type) => !Object.prototype.hasOwnProperty.call(REPLAY_LIVE_READ_POLICY, type));
    expect(undecided, "Add a live-read decision to REPLAY_LIVE_READ_POLICY in packages/shared/src/replay.ts").toEqual([]);
    expect(Object.keys(REPLAY_LIVE_READ_POLICY).sort()).toEqual(Object.keys(REPLAY_NODE_CLASSES).sort());
  });

  it("lets exactly the reviewed types run live", () => {
    const live = Object.fromEntries(Object.entries(REPLAY_LIVE_READ_POLICY).filter(([, decision]) => decision !== "refused"));
    expect(live).toEqual(MAY_RUN_LIVE);
  });

  it("never lets a trigger, a browser, a connector source or a raw query run live", () => {
    for (const type of Object.keys(REPLAY_LIVE_READ_POLICY)) {
      if (type.endsWith("_trigger") || REPLAY_NODE_CLASSES[type as keyof typeof REPLAY_NODE_CLASSES] === "trigger") {
        expect(REPLAY_LIVE_READ_POLICY[type as keyof typeof REPLAY_LIVE_READ_POLICY], type).toBe("refused");
      }
    }
    for (const type of ["web_browse", "pdf_output", "connector_source", "postgres_query", "mysql_query", "mongo_operation", "redis_command", "salesforce_query", "code_node", "rag_retrieve"]) {
      expect(replayLiveReadRefusal({ id: "n", type }), type).not.toBeNull();
    }
    expect(replayLiveReadRefusal({ id: "rag", type: "rag_retrieve", config: { vectorStoreId: "knowledge-base" } })).not.toBeNull();
    expect(replayLiveReadRefusal({ id: "n", type: "community_node" })).toContain("not a node type");
  });
});
