import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_MAX_DELAY_MS,
  httpErrorStatusMode,
  httpStatusFailsNode,
  nodeSetsRetries,
  parseRetryAfterMs,
  parseStatusList,
  retryDelayFor,
  statusInList
} from "./node-retry";

describe("status lists", () => {
  it("reads codes, classes and ranges, and reports what it cannot read", () => {
    expect(parseStatusList("429, 5xx 408;500-504 abc 700 504-500")).toEqual({
      ranges: [[429, 429], [500, 599], [408, 408], [500, 504]],
      invalid: ["abc", "700", "504-500"]
    });
    expect(parseStatusList([429, "503"]).ranges).toEqual([[429, 429], [503, 503]]);
    expect(parseStatusList(undefined)).toEqual({ ranges: [], invalid: [] });
  });

  it("defaults to 429 and 5xx", () => {
    for (const status of [429, 500, 502, 503, 599]) expect(statusInList(status, undefined)).toBe(true);
    for (const status of [400, 401, 404, 408, 200]) expect(statusInList(status, "")).toBe(false);
    expect(statusInList(404, "404")).toBe(true);
    expect(statusInList(503, "404")).toBe(false);
  });
});

describe("fail on HTTP error status", () => {
  it("follows the stored option", () => {
    expect(httpErrorStatusMode({ failOnHttpError: true })).toBe("all");
    expect(httpErrorStatusMode({ failOnHttpError: false, retryCount: 3 })).toBe("none");
    expect(httpStatusFailsNode(404, { failOnHttpError: true })).toBe(true);
    expect(httpStatusFailsNode(304, { failOnHttpError: true })).toBe(false);
  });

  it("keeps older nodes returning the response, except retried statuses when they ask for retries", () => {
    expect(httpErrorStatusMode({})).toBe("none");
    expect(httpErrorStatusMode({ retryCount: 0 })).toBe("none");
    expect(httpErrorStatusMode({ retryCount: 2 })).toBe("retry_list");
    expect(httpErrorStatusMode({ retry: { enabled: true } })).toBe("retry_list");
    expect(httpErrorStatusMode({}, { retryOnFail: true })).toBe("retry_list");
    expect(nodeSetsRetries({ retry: { enabled: false } })).toBe(false);
    expect(httpStatusFailsNode(503, { retryCount: 2 })).toBe(true);
    expect(httpStatusFailsNode(404, { retryCount: 2 })).toBe(false);
    expect(httpStatusFailsNode(404, { retryCount: 2, retryOnStatus: "404" })).toBe(true);
    expect(httpStatusFailsNode(500, {})).toBe(false);
  });
});

describe("retry waits", () => {
  const backoff = { delayMs: 1000, backoffMultiplier: 2, maxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS };

  it("grows exponentially, with the middle of the jitter range on the exact value", () => {
    expect([1, 2, 3, 4].map((attempt) => retryDelayFor(backoff, attempt, 0.5))).toEqual([1000, 2000, 4000, 8000]);
  });

  it("spreads each wait over ±20%", () => {
    expect(retryDelayFor(backoff, 2, 0)).toBe(1600);
    expect(retryDelayFor(backoff, 2, 0.999999)).toBe(2400);
  });

  it("never waits longer than the cap", () => {
    const capped = { ...backoff, maxDelayMs: 5000 };
    expect(retryDelayFor(capped, 10, 0.999999)).toBe(5000);
    expect(retryDelayFor(capped, 10, 0)).toBe(4000);
  });

  it("waits nothing for a zero delay", () => {
    expect(retryDelayFor({ ...backoff, delayMs: 0 }, 3, 0.7)).toBe(0);
  });
});

describe("Retry-After", () => {
  it("reads seconds and dates", () => {
    expect(parseRetryAfterMs("3", 0)).toBe(3000);
    expect(parseRetryAfterMs("0.5", 0)).toBe(500);
    expect(parseRetryAfterMs(new Date(12_000).toUTCString(), 2_000)).toBe(10_000);
    expect(parseRetryAfterMs(new Date(1_000).toUTCString(), 5_000)).toBe(0);
  });

  it("ignores a missing or unreadable header", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
  });
});

describe("errorConfig in the workflow contract", () => {
  it("is kept when a workflow is parsed (saved through the API)", async () => {
    const { workflowSchema } = await import("./schemas");
    const parsed = workflowSchema.parse({
      id: "wf",
      name: "wf",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "a", type: "http_request", name: "a", position: { x: 0, y: 0 }, config: {}, errorConfig: { retryOnFail: true, maxRetries: 2, retryIntervalMs: 500, continueOnFail: false } }
      ],
      edges: []
    });
    expect(parsed.nodes[0]!.errorConfig).toEqual({ retryOnFail: true, maxRetries: 2, retryIntervalMs: 500, continueOnFail: false });
  });
});
