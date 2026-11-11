import { vi } from "vitest";
import {
  ApiError,
  BACKGROUND_HEADER,
  fetchExecutions,
  getLastForegroundRequestAt,
  inBackground,
  listApprovals,
  onSessionEnded,
  revokeUserSessions,
  sessionEndMessage
} from "./api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("session policy in the API client", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(async () => jsonResponse(200, { items: [] }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const headersOf = (call: number) => new Headers((fetchMock.mock.calls[call][1] as RequestInit).headers);

  it("marks a poll call as background and leaves the idle clock alone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-11-09T10:00:00.000Z"));
    await fetchExecutions({ page: 1 });
    const foregroundAt = getLastForegroundRequestAt();
    expect(headersOf(0).has(BACKGROUND_HEADER)).toBe(false);

    vi.setSystemTime(Date.parse("2026-11-09T10:05:00.000Z"));
    await inBackground(() => listApprovals({ status: "pending" }));
    expect(headersOf(1).get(BACKGROUND_HEADER)).toBe("1");
    expect(getLastForegroundRequestAt()).toBe(foregroundAt);

    vi.setSystemTime(Date.parse("2026-11-09T10:06:00.000Z"));
    await listApprovals({ status: "pending" });
    expect(headersOf(2).has(BACKGROUND_HEADER)).toBe(false);
    expect(getLastForegroundRequestAt()).toBe(Date.parse("2026-11-09T10:06:00.000Z"));
  });

  it("tells listeners when a 401 carries a reason, and not for a plain 401", async () => {
    const listener = vi.fn();
    const stop = onSessionEnded(listener);
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "Unauthorized" }));
    await expect(listApprovals()).rejects.toBeInstanceOf(ApiError);
    expect(listener).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "Session expired or invalid", reason: "evicted" }));
    await expect(listApprovals()).rejects.toMatchObject({ status: 401 });
    expect(listener).toHaveBeenCalledWith("evicted");
    stop();
  });

  it("admin revoke sends an optional handle", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { revoked: 2 }));
    await expect(revokeUserSessions("usr_1")).resolves.toEqual({ revoked: 2 });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/users/usr_1/sessions/revoke");
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe("{}");
    await revokeUserSessions("usr_1", "h1");
    expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBe(JSON.stringify({ handle: "h1" }));
  });

  it("explains each sign-out reason", () => {
    expect(sessionEndMessage("idle")).toBe("You were signed out after a period of inactivity.");
    expect(sessionEndMessage("expired")).toBe("Your session reached its maximum length. Sign in again.");
    expect(sessionEndMessage("evicted")).toBe("You were signed out because you signed in on another device or browser.");
    expect(sessionEndMessage("admin")).toBe("An administrator ended your session.");
    expect(sessionEndMessage("logout")).toBeNull();
    expect(sessionEndMessage(null)).toBeNull();
  });
});
