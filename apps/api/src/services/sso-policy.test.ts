import { describe, expect, it } from "vitest";
import { SSO_MFA_DEFAULT_OIDC_AMR, SSO_MFA_DEFAULT_SAML_AUTHN_CONTEXTS } from "../config.js";
import {
  checkSsoAllowLists,
  decideSsoMfa,
  emailDomainOf,
  evaluateOidcMfa,
  evaluateSamlMfa,
  projectSsoRole
} from "./sso-policy.js";

describe("SSO allow-lists (shared by OIDC and SAML)", () => {
  const base = { allowedEmailDomains: [] as string[], allowedGroups: [] as string[], groups: [] as string[] };

  it("allows everything when both lists are empty", () => {
    expect(checkSsoAllowLists({ ...base })).toBeNull();
    expect(checkSsoAllowLists({ ...base, trustedEmail: "x@anything.test", groups: ["g"] })).toBeNull();
  });

  it("matches the email domain exactly and case-insensitively, never a suffix", () => {
    const lists = { ...base, allowedEmailDomains: ["example.com"] };
    expect(checkSsoAllowLists({ ...lists, trustedEmail: "Ann@EXAMPLE.com" })).toBeNull();
    expect(checkSsoAllowLists({ ...lists, trustedEmail: "ann@sub.example.com" })).toBe("email_domains");
    expect(checkSsoAllowLists({ ...lists, trustedEmail: "ann@example.com.evil.test" })).toBe("email_domains");
    expect(checkSsoAllowLists({ ...lists, trustedEmail: "ann@evil.test@example.com" })).toBeNull();
    expect(checkSsoAllowLists({ ...lists })).toBe("email_domains");
    expect(checkSsoAllowLists({ ...lists, trustedEmail: "no-at-sign" })).toBe("email_domains");
  });

  it("needs at least one listed group, matched exactly", () => {
    const lists = { ...base, allowedGroups: ["l2m-users"] };
    expect(checkSsoAllowLists({ ...lists, groups: ["other", "l2m-users"] })).toBeNull();
    expect(checkSsoAllowLists({ ...lists, groups: ["L2M-users"] })).toBe("groups");
    expect(checkSsoAllowLists({ ...lists, groups: [] })).toBe("groups");
  });

  it("checks both lists when both are set (domain first)", () => {
    const lists = { allowedEmailDomains: ["example.com"], allowedGroups: ["l2m-users"] };
    expect(checkSsoAllowLists({ ...lists, trustedEmail: "a@example.com", groups: ["l2m-users"] })).toBeNull();
    expect(checkSsoAllowLists({ ...lists, trustedEmail: "a@example.com", groups: [] })).toBe("groups");
    expect(checkSsoAllowLists({ ...lists, trustedEmail: "a@other.test", groups: ["l2m-users"] })).toBe("email_domains");
  });

  it("emailDomainOf takes the part after the last @", () => {
    expect(emailDomainOf("A@B.Example")).toBe("b.example");
    expect(emailDomainOf("x@")).toBeUndefined();
    expect(emailDomainOf("@x")).toBeUndefined();
    expect(emailDomainOf(undefined)).toBeUndefined();
  });
});

describe("IdP-asserted MFA", () => {
  const settings = { oidcAmr: [...SSO_MFA_DEFAULT_OIDC_AMR], oidcAcr: [] as string[], samlAuthnContexts: [...SSO_MFA_DEFAULT_SAML_AUTHN_CONTEXTS] };

  it("OIDC: by default only amr `mfa` counts; single methods (a lone one-time code or key) do not", () => {
    expect(SSO_MFA_DEFAULT_OIDC_AMR).toEqual(["mfa"]);
    expect(evaluateOidcMfa({ amr: ["pwd", "mfa"] }, settings)).toEqual({ claim: "amr", value: "mfa" });
    for (const single of [["pwd"], ["otp"], ["sms"], ["hwk"], ["swk"], ["mca"], ["pin"], ["face"], ["fpt"], ["kba"], []]) {
      expect(evaluateOidcMfa({ amr: single }, settings)).toBeNull();
    }
    // Configured method lists still work (SSO_MFA_OIDC_AMR=mfa,otp,hwk).
    const configured = { ...settings, oidcAmr: ["mfa", "otp", "hwk"] };
    expect(evaluateOidcMfa({ amr: ["pwd", "otp"] }, configured)).toEqual({ claim: "amr", value: "otp" });
    expect(evaluateOidcMfa({ amr: ["hwk"] }, configured)).toEqual({ claim: "amr", value: "hwk" });
    expect(evaluateOidcMfa({}, settings)).toBeNull();
    expect(evaluateOidcMfa({ amr: ["MFA"] }, settings)).toBeNull();
  });

  it("OIDC: acr counts only when it is in SSO_MFA_OIDC_ACR", () => {
    expect(evaluateOidcMfa({ acr: "gold" }, settings)).toBeNull();
    const withAcr = { ...settings, oidcAcr: ["gold", "https://refeds.org/profile/mfa"] };
    expect(evaluateOidcMfa({ amr: ["pwd"], acr: "gold" }, withAcr)).toEqual({ claim: "acr", value: "gold" });
    expect(evaluateOidcMfa({ acr: "silver" }, withAcr)).toBeNull();
    // amr wins when both match (reported once).
    expect(evaluateOidcMfa({ amr: ["mfa"], acr: "gold" }, withAcr)).toEqual({ claim: "amr", value: "mfa" });
  });

  it("SAML: an AuthnContextClassRef from the list counts", () => {
    expect(evaluateSamlMfa(["http://schemas.microsoft.com/claims/multipleauthn"], settings)).toEqual({
      claim: "authn_context",
      value: "http://schemas.microsoft.com/claims/multipleauthn"
    });
    expect(evaluateSamlMfa(["https://refeds.org/profile/mfa"], settings)?.value).toBe("https://refeds.org/profile/mfa");
    expect(evaluateSamlMfa(["urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport"], settings)).toBeNull();
    expect(evaluateSamlMfa([], settings)).toBeNull();
  });
});

describe("SSO_MFA decision", () => {
  const evidence = { claim: "amr" as const, value: "mfa" };

  it("off allows without looking at anything", () => {
    expect(decideSsoMfa({ mode: "off", evidence: null, localTotp: true, mfaEnforcedForRole: true })).toEqual({ kind: "allow", evidence: null });
  });

  it("idp needs the IdP's MFA and never falls back to local TOTP", () => {
    expect(decideSsoMfa({ mode: "idp", evidence, localTotp: false, mfaEnforcedForRole: false })).toEqual({ kind: "allow", evidence });
    expect(decideSsoMfa({ mode: "idp", evidence: null, localTotp: true, mfaEnforcedForRole: true })).toEqual({ kind: "refuse" });
  });

  it("idp_or_local: IdP MFA, else local TOTP, else MFA_ENFORCE enrolment, else refuse", () => {
    expect(decideSsoMfa({ mode: "idp_or_local", evidence, localTotp: true, mfaEnforcedForRole: false })).toEqual({ kind: "allow", evidence });
    expect(decideSsoMfa({ mode: "idp_or_local", evidence: null, localTotp: true, mfaEnforcedForRole: true })).toEqual({ kind: "local_totp" });
    expect(decideSsoMfa({ mode: "idp_or_local", evidence: null, localTotp: false, mfaEnforcedForRole: true })).toEqual({ kind: "enroll" });
    expect(decideSsoMfa({ mode: "idp_or_local", evidence: null, localTotp: false, mfaEnforcedForRole: false })).toEqual({ kind: "refuse" });
  });
});

describe("SSO role projection", () => {
  it("gives a new user the mapped role or viewer, raises but never lowers an existing user", () => {
    expect(projectSsoRole(null, null)).toBe("viewer");
    expect(projectSsoRole(null, "admin")).toBe("admin");
    expect(projectSsoRole("operator", "builder")).toBe("builder");
    expect(projectSsoRole("admin", "viewer")).toBe("admin");
    expect(projectSsoRole("builder", null)).toBe("builder");
    expect(projectSsoRole("builder", "builder")).toBe("builder");
  });
});
