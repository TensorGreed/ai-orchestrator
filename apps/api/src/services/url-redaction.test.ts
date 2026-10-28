import { describe, expect, it } from "vitest";
import { redactSensitiveUrl } from "./url-redaction.js";

describe("redactSensitiveUrl", () => {
  it("redacts code, state and token parameters on the OIDC and MCP OAuth callbacks", () => {
    const oidc = redactSensitiveUrl("/api/auth/oidc/callback?code=abc123&state=xyz&session_state=s1&iss=https%3A%2F%2Fidp");
    expect(oidc).not.toMatch(/abc123|xyz|s1/);
    expect(new URLSearchParams(oidc.split("?")[1]).get("code")).toBe("REDACTED");
    expect(new URLSearchParams(oidc.split("?")[1]).get("iss")).toBe("https://idp");

    const mcp = redactSensitiveUrl("/api/mcp/oauth/callback?state=st&code=cd&error_description=nope");
    expect(mcp).not.toMatch(/=st&|=cd/);
    expect(mcp).toContain("error_description=nope");

    const repeated = redactSensitiveUrl("/api/auth/oidc/callback?code=one&code=two&ID_TOKEN=tok");
    expect(repeated).not.toMatch(/one|two|tok/);
  });

  it("leaves other URLs and callbacks without secrets unchanged", () => {
    expect(redactSensitiveUrl("/api/workflows?code=keep")).toBe("/api/workflows?code=keep");
    expect(redactSensitiveUrl("/api/auth/oidc/callback")).toBe("/api/auth/oidc/callback");
    expect(redactSensitiveUrl("/api/auth/oidc/callback?error=access_denied")).toBe("/api/auth/oidc/callback?error=access_denied");
  });
});
