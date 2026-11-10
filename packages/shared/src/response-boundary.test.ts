import { describe, expect, it } from "vitest";
import {
  CONTENT_FILTER_CODE,
  RESPONSE_WITHHELD_MESSAGE,
  contentFilterEnvelope,
  parseResponseBoundary,
  responseBoundaryForTrigger,
  responseWasWithheld,
  withheldResponseOutput
} from "./response-boundary";

describe("response boundary contract", () => {
  it("names the externally answered triggers only (D5)", () => {
    expect(responseBoundaryForTrigger("webhook")).toEqual({ surface: "webhook" });
    expect(responseBoundaryForTrigger("webhook_test")).toEqual({ surface: "webhook" });
    expect(responseBoundaryForTrigger("chat")).toEqual({ surface: "chat" });
    expect(responseBoundaryForTrigger("mcp_server")).toEqual({ surface: "mcp_invoke" });
    for (const builder of ["manual", "manual_stream", "manual_retry", "webhook_api", "cron", "mcp_gateway", "sub_workflow", "replay", "eval", "", null, undefined]) {
      expect(responseBoundaryForTrigger(builder as string | null | undefined), String(builder)).toBeUndefined();
    }
  });

  it("reads back only a known surface", () => {
    expect(parseResponseBoundary({ surface: "chat" })).toEqual({ surface: "chat" });
    expect(parseResponseBoundary({ surface: "email" })).toBeUndefined();
    expect(parseResponseBoundary("webhook")).toBeUndefined();
    expect(parseResponseBoundary(null)).toBeUndefined();
  });

  it("builds the withheld output and the 422 envelope (D7), naming no rule or value", () => {
    expect(withheldResponseOutput()).toEqual({ error: RESPONSE_WITHHELD_MESSAGE, code: CONTENT_FILTER_CODE });
    expect(contentFilterEnvelope("exec-1")).toEqual({ error: "The response was withheld by content rules.", code: "content_filter", executionId: "exec-1" });
    expect(contentFilterEnvelope(undefined).executionId).toBeNull();
    expect(responseWasWithheld({ responseCheck: { action: "block", withheld: true, transformed: false, reason: "block" } })).toBe(true);
    expect(responseWasWithheld({ responseCheck: { action: "redact", withheld: false, transformed: true, reason: "redact" } })).toBe(false);
    expect(responseWasWithheld({})).toBe(false);
    expect(responseWasWithheld(null)).toBe(false);
  });
});
