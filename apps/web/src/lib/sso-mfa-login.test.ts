import { afterEach, describe, expect, it, vi } from "vitest";
import { SSO_MFA_CHALLENGE, completeMfaLogin, isSsoMfaLanding, ssoErrorMessage, stripSsoLandingParams } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SSO MFA landing (Phase 13.2)", () => {
  it("recognises the TOTP hand-off only for sso_mfa=totp", () => {
    expect(isSsoMfaLanding("?sso_mfa=totp")).toBe(true);
    expect(isSsoMfaLanding("?x=1&sso_mfa=totp")).toBe(true);
    expect(isSsoMfaLanding("?sso_mfa=other")).toBe(false);
    expect(isSsoMfaLanding("")).toBe(false);
  });

  it("drops sso_error and sso_mfa from the URL and keeps everything else", () => {
    expect(stripSsoLandingParams("/", "?sso_mfa=totp", "")).toBe("/");
    expect(stripSsoLandingParams("/studio", "?workflow=w1&sso_error=sso_mfa_required", "#top")).toBe("/studio?workflow=w1#top");
    expect(stripSsoLandingParams("/", "?workflow=w1", "")).toBeNull();
  });

  it("sends only the code for an SSO challenge (the challenge rides in the HttpOnly cookie)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ user: { id: "u", email: "a@b.c", role: "viewer" }, expiresAt: "x" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await completeMfaLogin({ challenge: SSO_MFA_CHALLENGE, code: "123456" });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/auth/login/mfa",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ code: "123456" }), credentials: "include" })
    );
    await completeMfaLogin({ challenge: "mfa_abc", code: "654321" });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/auth/login/mfa", expect.objectContaining({ body: JSON.stringify({ challenge: "mfa_abc", code: "654321" }) }));
  });

  it("explains sso_mfa_required and the SAML codes", () => {
    expect(ssoErrorMessage("sso_mfa_required")).toMatch(/multi-factor/);
    expect(ssoErrorMessage("saml_not_allowed")).toMatch(/not allowed/);
    expect(ssoErrorMessage("saml_unavailable")).toMatch(/unavailable/);
    expect(ssoErrorMessage("saml_failed")).toBe("Single sign-on failed. Try again or contact your administrator.");
  });
});
