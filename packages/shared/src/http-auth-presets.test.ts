import { describe, expect, it } from "vitest";
import { describeHttpSecretAuth, readHttpSecretAuth } from "./integration-catalog";
import { NODE_CONNECTED_ACCOUNT_PROVIDERS, isConnectedAccountProviderId } from "./connected-accounts";
import { nodeDefinitions } from "./definitions";

describe("HTTP Request auth presets", () => {
  it("reads the connected account preset", () => {
    expect(readHttpSecretAuth({ type: "connected" })).toEqual({ type: "connected" });
    expect(describeHttpSecretAuth({ type: "connected" })).toMatch(/connected account/);
  });

  it("reads OAuth2 client credentials with a token URL, client id, optional scope and where the credentials go", () => {
    expect(
      readHttpSecretAuth({ type: "oauth2_client_credentials", tokenUrl: " https://id.example.com/oauth/token ", clientId: "app-1", scope: "read write" })
    ).toEqual({ type: "oauth2_client_credentials", tokenUrl: "https://id.example.com/oauth/token", clientId: "app-1", scope: "read write", clientAuth: "body" });
    expect(
      readHttpSecretAuth({ type: "oauth2_client_credentials", tokenUrl: "https://id.example.com/t", clientId: "a", clientAuth: "basic" })
    ).toEqual({ type: "oauth2_client_credentials", tokenUrl: "https://id.example.com/t", clientId: "a", clientAuth: "basic" });
    expect(describeHttpSecretAuth({ type: "oauth2_client_credentials", tokenUrl: "https://id.example.com/t", clientId: "a", clientAuth: "body" })).toMatch(
      /id\.example\.com/
    );
  });

  it("refuses an OAuth2 preset without a usable token URL or client id", () => {
    expect(readHttpSecretAuth({ type: "oauth2_client_credentials", clientId: "a" })).toMatch(/tokenUrl/);
    expect(readHttpSecretAuth({ type: "oauth2_client_credentials", tokenUrl: "ftp://x", clientId: "a" })).toMatch(/http/);
    expect(readHttpSecretAuth({ type: "oauth2_client_credentials", tokenUrl: "https://u:p@id.example.com/t", clientId: "a" })).toMatch(/user name/);
    expect(readHttpSecretAuth({ type: "oauth2_client_credentials", tokenUrl: "https://id.example.com/t" })).toMatch(/clientId/);
    expect(readHttpSecretAuth({ type: "oauth2_client_credentials", tokenUrl: "https://id.example.com/t", clientId: "a", clientAuth: "jwt" })).toMatch(/clientAuth/);
  });

  it("keeps the existing presets as they were", () => {
    expect(readHttpSecretAuth({ type: "bearer" })).toEqual({ type: "bearer" });
    expect(readHttpSecretAuth({ type: "digest" })).toMatch(/must be/);
  });
});

describe("connected account nodes", () => {
  it("names only node types that exist and providers that exist", () => {
    const types = new Set(nodeDefinitions.map((definition) => definition.type));
    for (const [type, provider] of Object.entries(NODE_CONNECTED_ACCOUNT_PROVIDERS)) {
      expect(types.has(type as never), type).toBe(true);
      expect(isConnectedAccountProviderId(provider)).toBe(true);
    }
  });
});
