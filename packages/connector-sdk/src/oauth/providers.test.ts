import { describe, expect, it } from "vitest";
import { CONNECTED_ACCOUNT_PROVIDER_IDS } from "@ai-orchestrator/shared";
import {
  OAuthProviderError,
  buildProviderAuthorizationUrl,
  buildProviderTokenRequest,
  createDefaultOAuthProviderRegistry,
  idTokenLabel,
  isProviderUrl,
  providerUrl,
  scopesFor
} from "./providers";

const registry = createDefaultOAuthProviderRegistry();
const get = (id: string) => registry.get(id)!;

function jwt(claims: Record<string, unknown>): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

describe("OAuth provider registry", () => {
  it("has every connected-account provider, each with https endpoints on its own hosts and setup steps naming the redirect URL", () => {
    expect(registry.list().map((provider) => provider.id).sort()).toEqual([...CONNECTED_ACCOUNT_PROVIDER_IDS].sort());
    for (const provider of registry.list()) {
      const token = providerUrl(provider.tokenUrl, { tenant: "common", clientId: "c" });
      expect(isProviderUrl(provider, token), provider.id).toBe(true);
      if (provider.identityUrl) expect(isProviderUrl(provider, provider.identityUrl), provider.id).toBe(true);
      if (provider.revoke) expect(isProviderUrl(provider, providerUrl(provider.revoke.url, { clientId: "c" })), provider.id).toBe(true);
      expect(provider.authorizationUrl.startsWith("https://")).toBe(true);
      expect(provider.setupSteps.join(" ")).toContain("{redirectUrl}");
    }
  });

  it("builds the authorization URL with PKCE, state, the chosen scopes and the provider's own parameters", () => {
    const google = get("google");
    const url = new URL(
      buildProviderAuthorizationUrl(google, {
        clientId: "client-1",
        redirectUri: "https://l2m.example.com/api/connect/callback",
        state: "st",
        codeChallenge: "ch",
        scopes: scopesFor(google, ["gmail"])
      })
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")!.split(" ")).toEqual(["openid", "email", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"]);
    // Default sets when none is chosen; Slack joins with commas.
    const slack = new URL(buildProviderAuthorizationUrl(get("slack"), { clientId: "c", redirectUri: "https://x/cb", state: "s", codeChallenge: "c", scopes: scopesFor(get("slack"), []) }));
    expect(slack.searchParams.get("scope")).toBe("chat:write,chat:write.public");
    // Notion takes no scopes.
    const notion = new URL(buildProviderAuthorizationUrl(get("notion"), { clientId: "c", redirectUri: "https://x/cb", state: "s", codeChallenge: "c", scopes: scopesFor(get("notion"), []) }));
    expect(notion.searchParams.has("scope")).toBe(false);
    expect(notion.searchParams.get("owner")).toBe("user");
  });

  it("puts the Microsoft tenant in the path and refuses one that would change the URL", () => {
    const microsoft = get("microsoft");
    expect(providerUrl(microsoft.tokenUrl, {})).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(providerUrl(microsoft.tokenUrl, { tenant: "contoso.onmicrosoft.com" })).toBe("https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token");
    expect(() => providerUrl(microsoft.tokenUrl, { tenant: "evil.com/x?" })).toThrow(OAuthProviderError);
    expect(() => providerUrl(microsoft.tokenUrl, { tenant: "../x" })).toThrow(OAuthProviderError);
  });

  it("sends Notion's token request as JSON with basic auth and the others as a form", () => {
    const notion = buildProviderTokenRequest(get("notion"), {
      clientId: "id",
      clientSecret: "sec",
      grant: { type: "authorization_code", code: "c", codeVerifier: "v", redirectUri: "https://x/cb" }
    });
    expect(notion.init.headers["content-type"]).toBe("application/json");
    expect(notion.init.headers.authorization).toBe(`Basic ${Buffer.from("id:sec").toString("base64")}`);
    expect(JSON.parse(notion.init.body)).toEqual({ grant_type: "authorization_code", code: "c", code_verifier: "v", redirect_uri: "https://x/cb" });
    const github = buildProviderTokenRequest(get("github"), { clientId: "id", clientSecret: "sec", grant: { type: "refresh_token", refreshToken: "r" } });
    expect(github.init.headers.accept).toBe("application/json");
    expect(Object.fromEntries(new URLSearchParams(github.init.body))).toEqual({ grant_type: "refresh_token", refresh_token: "r", client_id: "id", client_secret: "sec" });
  });

  it("reads each provider's token response and its account label, and refuses errors sent with a 200", () => {
    expect(get("slack").parseTokenResponse({ ok: true, access_token: "xoxb-1", scope: "chat:write,chat:write.public", team: { name: "Acme" } })).toEqual({
      accessToken: "xoxb-1",
      scopes: ["chat:write", "chat:write.public"],
      accountLabel: "Acme"
    });
    expect(() => get("slack").parseTokenResponse({ ok: false, error: "invalid_code" })).toThrow(/invalid_code/);
    expect(() => get("github").parseTokenResponse({ error: "bad_verification_code", error_description: "The code is wrong" })).toThrow(/The code is wrong/);
    expect(get("notion").parseTokenResponse({ access_token: "n", workspace_name: "Team space" }).accountLabel).toBe("Team space");
    const google = get("google").parseTokenResponse({ access_token: "g", refresh_token: "r", expires_in: 3599, scope: "openid email", id_token: jwt({ email: "a@example.com" }) });
    expect(google).toEqual({ accessToken: "g", refreshToken: "r", expiresIn: 3599, scopes: ["openid", "email"], accountLabel: "a@example.com" });
    expect(() => get("microsoft").parseTokenResponse({ token_type: "Bearer" })).toThrow(/no access token/);
    expect(get("github").readIdentity!({ login: "octo" })).toBe("octo");
    expect(get("microsoft").readIdentity!({ userPrincipalName: "u@contoso.com" })).toBe("u@contoso.com");
    expect(idTokenLabel("not-a-jwt")).toBeUndefined();
  });

  it("moves every endpoint to the test base URL and allows only its host", () => {
    const test = createDefaultOAuthProviderRegistry({ testBaseUrl: "http://127.0.0.1:4532" });
    const microsoft = test.get("microsoft")!;
    expect(providerUrl(microsoft.tokenUrl, { tenant: "common" })).toBe("http://127.0.0.1:4532/microsoft/common/oauth2/v2.0/token");
    expect(microsoft.hosts).toEqual(["127.0.0.1:4532"]);
    expect(providerUrl(test.get("github")!.revoke!.url, { clientId: "abc" })).toBe("http://127.0.0.1:4532/github/applications/abc/grant");
    expect(isProviderUrl(microsoft, "http://127.0.0.1:4532/microsoft/x")).toBe(true);
    expect(isProviderUrl(get("slack"), "http://slack.com/api/x")).toBe(false);
    expect(isProviderUrl(get("slack"), "https://evil.example/api/x")).toBe(false);
    expect(isProviderUrl(get("slack"), "https://user:pw@slack.com/api/x")).toBe(false);
  });
});
