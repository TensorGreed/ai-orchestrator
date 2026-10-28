/**
 * Phase 13.2 — SSO_MFA and the SAML parity settings: optional, read only when SSO is on, bad values fail fast.
 */
import { describe, expect, it } from "vitest";
import {
  SSO_MFA_DEFAULT_OIDC_AMR,
  SSO_MFA_DEFAULT_SAML_AUTHN_CONTEXTS,
  parseConfig,
  resolveSamlSettings,
  resolveSsoMfaSettings
} from "./config.js";

const OIDC = {
  OIDC_ENABLED: "true",
  OIDC_ISSUER: "https://idp.example.test/realms/l2m",
  OIDC_CLIENT_ID: "l2m"
};

describe("SSO_MFA settings", () => {
  it("is off with defaults when unset, and nothing is read while SSO is off", () => {
    const plain = parseConfig({});
    expect(resolveSsoMfaSettings(plain)).toEqual({
      mode: "off",
      oidcAmr: [...SSO_MFA_DEFAULT_OIDC_AMR],
      oidcAcr: [],
      samlAuthnContexts: [...SSO_MFA_DEFAULT_SAML_AUTHN_CONTEXTS]
    });
    // Bad values are ignored while neither OIDC nor SAML is on (no new failure for deployments without SSO).
    const ignored = parseConfig({ SSO_MFA: "always", SSO_MFA_OIDC_AMR: "bad value" });
    expect(resolveSsoMfaSettings(ignored).mode).toBe("off");
    expect(resolveSsoMfaSettings(parseConfig({ ...OIDC })).mode).toBe("off");
    expect(resolveSsoMfaSettings(parseConfig({ ...OIDC, SSO_MFA: "  " })).mode).toBe("off");
  });

  it("accepts off, idp and idp_or_local (any case) with OIDC or SAML on", () => {
    expect(resolveSsoMfaSettings(parseConfig({ ...OIDC, SSO_MFA: "IDP" })).mode).toBe("idp");
    expect(resolveSsoMfaSettings(parseConfig({ SAML_ENABLED: "true", SSO_MFA: "idp_or_local" })).mode).toBe("idp_or_local");
    expect(resolveSsoMfaSettings(parseConfig({ ...OIDC, SSO_MFA: "off" })).mode).toBe("off");
  });

  it("parses the lists and keeps defaults for blank ones", () => {
    const settings = resolveSsoMfaSettings(
      parseConfig({
        ...OIDC,
        SSO_MFA: "idp",
        SSO_MFA_OIDC_AMR: "mfa, otp ,mfa",
        SSO_MFA_OIDC_ACR: "gold,https://refeds.org/profile/mfa",
        SSO_MFA_SAML_AUTHN_CONTEXTS: ""
      })
    );
    expect(settings.oidcAmr).toEqual(["mfa", "otp"]);
    expect(settings.oidcAcr).toEqual(["gold", "https://refeds.org/profile/mfa"]);
    expect(settings.samlAuthnContexts).toEqual([...SSO_MFA_DEFAULT_SAML_AUTHN_CONTEXTS]);
  });

  it("fails fast with a clear message on bad values", () => {
    expect(() => parseConfig({ ...OIDC, SSO_MFA: "required" })).toThrow(/Invalid SSO MFA configuration: SSO_MFA must be off, idp or idp_or_local/);
    expect(() => parseConfig({ ...OIDC, SSO_MFA: "idp", SSO_MFA_OIDC_AMR: "mfa,one two" })).toThrow(/SSO_MFA_OIDC_AMR/);
    expect(() => parseConfig({ ...OIDC, SSO_MFA: "idp", SSO_MFA_OIDC_ACR: "has space" })).toThrow(/SSO_MFA_OIDC_ACR/);
    expect(() => parseConfig({ SAML_ENABLED: "true", SSO_MFA: "idp", SSO_MFA_SAML_AUTHN_CONTEXTS: "not-a-uri" })).toThrow(
      /SSO_MFA_SAML_AUTHN_CONTEXTS/
    );
  });
});

describe("SAML parity settings", () => {
  it("are null while SAML is off, whatever they hold", () => {
    expect(resolveSamlSettings(parseConfig({ SAML_IDP_ISSUER: "has#hash", SAML_ALLOWED_EMAIL_DOMAINS: "not a domain" }))).toBeNull();
  });

  it("default to no pin and no allow-lists, landing on the first WEB_ORIGIN", () => {
    expect(resolveSamlSettings(parseConfig({ SAML_ENABLED: "true", WEB_ORIGIN: "https://l2m.example.com, https://other.example" }))).toEqual({
      idpIssuer: undefined,
      allowedEmailDomains: [],
      allowedGroups: [],
      postLoginUrl: "https://l2m.example.com/",
      requireInResponseTo: false
    });
  });

  it("read SAML_REQUIRE_IN_RESPONSE_TO and refuse it with a plain-http callback (its cookie is Secure)", () => {
    const on = { SAML_ENABLED: "true", SAML_REQUIRE_IN_RESPONSE_TO: "true" };
    expect(resolveSamlSettings(parseConfig({ ...on, SAML_CALLBACK_URL: "https://l2m.example.com/api/auth/saml/callback" }))?.requireInResponseTo).toBe(true);
    expect(resolveSamlSettings(parseConfig({ ...on, SAML_CALLBACK_URL: "http://localhost:4000/api/auth/saml/callback" }))?.requireInResponseTo).toBe(true);
    expect(resolveSamlSettings(parseConfig({ SAML_ENABLED: "true", SAML_REQUIRE_IN_RESPONSE_TO: "" }))?.requireInResponseTo).toBe(false);
    expect(() => parseConfig({ ...on, SAML_CALLBACK_URL: "http://l2m.example.com/api/auth/saml/callback" })).toThrow(
      /SAML_REQUIRE_IN_RESPONSE_TO needs an https SAML_CALLBACK_URL/
    );
    // Read only when SAML is on.
    expect(() => parseConfig({ SAML_REQUIRE_IN_RESPONSE_TO: "true", SAML_CALLBACK_URL: "http://l2m.example.com/cb" })).not.toThrow();
  });

  it("parse the IdP issuer pin and allow-lists like OIDC's", () => {
    expect(
      resolveSamlSettings(
        parseConfig({
          SAML_ENABLED: "true",
          SAML_IDP_ISSUER: " https://sts.windows.net/tenant/ ",
          SAML_ALLOWED_EMAIL_DOMAINS: "@Example.com, example.org",
          SAML_ALLOWED_GROUPS: "l2m-users, admins"
        })
      )
    ).toMatchObject({
      idpIssuer: "https://sts.windows.net/tenant/",
      allowedEmailDomains: ["example.com", "example.org"],
      allowedGroups: ["l2m-users", "admins"]
    });
  });

  it("refuse '#' in SAML_IDP_ISSUER and bad domains at startup", () => {
    expect(() => parseConfig({ SAML_ENABLED: "true", SAML_IDP_ISSUER: "https://idp.example/#x" })).toThrow(
      /Invalid SAML configuration: SAML_IDP_ISSUER must not contain '#'/
    );
    expect(() => parseConfig({ SAML_ENABLED: "true", SAML_ALLOWED_EMAIL_DOMAINS: "exa mple.com" })).toThrow(/SAML_ALLOWED_EMAIL_DOMAINS/);
  });
});
