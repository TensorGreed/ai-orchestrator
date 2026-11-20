import { describe, expect, it } from "vitest";
import { connectedAccountSummary, readConnectMessage, secretOptionLabel } from "./connect-account";

describe("readConnectMessage", () => {
  const origin = "http://127.0.0.1:5531";
  it("takes only the callback's message from this origin", () => {
    expect(readConnectMessage({ origin, data: { type: "l2m:oauth-account", ok: true, providerId: "slack", secretId: "sec_1" } }, origin)).toEqual({
      ok: true,
      providerId: "slack",
      secretId: "sec_1",
      error: undefined
    });
    expect(readConnectMessage({ origin: "https://evil.example", data: { type: "l2m:oauth-account", ok: true, providerId: "slack" } }, origin)).toBeNull();
    expect(readConnectMessage({ origin, data: { type: "other" } }, origin)).toBeNull();
    expect(readConnectMessage({ origin, data: "l2m:oauth-account" }, origin)).toBeNull();
    expect(readConnectMessage({ origin, data: { type: "l2m:oauth-account", ok: false, providerId: "slack", error: "denied" } }, origin)).toMatchObject({ ok: false, error: "denied" });
  });
});

describe("connected account labels", () => {
  const view = {
    providerId: "google" as const,
    accountLabel: "ana@example.com",
    scopes: ["openid", "email"],
    status: "connected" as const,
    expiresAt: "2026-11-20T11:00:00.000Z",
    refreshable: true,
    lastError: null,
    connectedBy: "ana@example.com",
    connectedAt: "2026-11-20T10:00:00.000Z",
    lastRefreshAt: null
  };
  it("names the provider and account, and says when it needs a reconnect", () => {
    expect(secretOptionLabel({ id: "s", name: "Google · ana@example.com", provider: "oauth_account", connection: view })).toBe("Google · ana@example.com (connected account)");
    expect(secretOptionLabel({ id: "s", name: "x", provider: "oauth_account", connection: { ...view, status: "needs_reconnect" } })).toBe("x (needs reconnect)");
    expect(secretOptionLabel({ id: "s", name: "Key", provider: "openai" })).toBe("Key (openai)");
  });
  it("summarises expiry plainly", () => {
    const now = Date.parse("2026-11-20T10:30:00.000Z");
    expect(connectedAccountSummary(view, now)).toBe("Token renews automatically · expires in 30 min");
    expect(connectedAccountSummary({ ...view, refreshable: false, expiresAt: null }, now)).toBe("Token does not expire");
    expect(connectedAccountSummary({ ...view, status: "needs_reconnect", lastError: "invalid_grant" }, now)).toBe("Needs reconnect: invalid_grant");
  });
});

describe("HTTP Request Auth choice", () => {
  it("reads old configs as before: a secret alone is a bearer token, nothing is None", async () => {
    const { applyHttpAuthMode, httpAuthMode } = await import("./connect-account");
    expect(httpAuthMode({})).toBe("none");
    expect(httpAuthMode({ secretRef: { secretId: "s1" } })).toBe("bearer");
    expect(httpAuthMode({ secretRef: { secretId: "s1" }, secretAuth: { type: "header", name: "X-Key" } })).toBe("header");
    expect(applyHttpAuthMode({ secretRef: { secretId: "s1" } }, "none")).toEqual({ secretRef: undefined, secretAuth: undefined });
    expect(applyHttpAuthMode({ secretRef: { secretId: "s1" } }, "query")).toEqual({ secretRef: { secretId: "s1" }, secretAuth: { type: "query", name: "api_key" } });
    expect(applyHttpAuthMode({ secretRef: { secretId: "s1" }, secretAuth: { type: "header", name: "X-Key" } }, "query").secretAuth).toEqual({ type: "query", name: "X-Key" });
    // A typed secret is not a connected account: switching clears the pick both ways.
    expect(applyHttpAuthMode({ secretRef: { secretId: "s1" } }, "connected")).toEqual({ secretRef: undefined, secretAuth: { type: "connected" } });
    expect(applyHttpAuthMode({ secretRef: { secretId: "acct" }, secretAuth: { type: "connected" } }, "bearer").secretRef).toBeUndefined();
    expect(applyHttpAuthMode({}, "oauth2_client_credentials").secretAuth).toEqual({ type: "oauth2_client_credentials", tokenUrl: "", clientId: "", clientAuth: "body" });
  });
});
