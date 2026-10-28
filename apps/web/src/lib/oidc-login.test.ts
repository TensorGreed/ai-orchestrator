import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOidcLoginUrl, ssoErrorMessage } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OIDC login (Phase 13.2)", () => {
  it("offers the login URL only when the API reports OIDC enabled", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ enabled: true, loginPath: "/api/auth/oidc/login" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchOidcLoginUrl()).toBe("/api/auth/oidc/login");
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/oidc/metadata", expect.objectContaining({ credentials: "include" }));
  });

  it("returns null when OIDC is off (404) or the API is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "OIDC is not enabled" }), { status: 404 })));
    expect(await fetchOidcLoginUrl()).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("network down");
    }));
    expect(await fetchOidcLoginUrl()).toBeNull();
  });

  it("ignores a login path outside the API", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ enabled: true, loginPath: "https://evil.example/" }), { status: 200 })));
    expect(await fetchOidcLoginUrl()).toBe("/api/auth/oidc/login");
  });

  it("maps sso_error codes to messages, with a generic fallback", () => {
    expect(ssoErrorMessage("oidc_email")).toMatch(/verified email/);
    expect(ssoErrorMessage("oidc_state")).toMatch(/Try again/);
    expect(ssoErrorMessage("<script>")).toBe("Single sign-on failed. Try again or contact your administrator.");
  });
});
