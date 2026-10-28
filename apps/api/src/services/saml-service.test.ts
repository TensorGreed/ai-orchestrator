/**
 * Phase 13.2 — SAML service: profile normalisation (issuer, AuthnContextClassRef), IdP-scoped identities and the
 * one-time upgrade of legacy bare-NameID identities, allow-lists, and the options handed to the SAML library.
 * Store-backed cases run on SQLite, or on Postgres with TEST_STORE=postgres.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Store } from "../db/store.js";
import { openTestStore } from "../test-support/test-store.js";
import { MockSamlIdp } from "../test-support/mock-saml-idp.js";
import {
  SamlLoginError,
  SamlService,
  extractAuthnContextClassRefs,
  samlIdentitySubject,
  samlUserErrorCode,
  type SamlConfig
} from "./saml-service.js";

const IDP = "https://idp.example.test/saml/metadata";
const BASE: SamlConfig = {
  enabled: true,
  entryPoint: "https://idp.example.test/sso",
  issuer: "l2m-sp",
  callbackUrl: "https://l2m.example.com/api/auth/saml/callback",
  idpCert: "MIIC",
  groupsAttribute: "groups"
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function makeStore(): Promise<Store> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-saml-"));
  const store = await openTestStore(path.join(dir, "orchestrator.db"));
  cleanups.push(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

describe("SAML profile normalisation", () => {
  it("reads the issuer and every AuthnContextClassRef, and drops the library's XML accessors", async () => {
    const idp = new MockSamlIdp(IDP);
    const service = new SamlService({} as Store, BASE, idp.factory);
    const response = idp.issue({
      nameID: "alice",
      email: "alice@example.com",
      groups: ["eng"],
      authnContexts: ["urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport", "http://schemas.microsoft.com/claims/multipleauthn"]
    });
    const profile = await service.consumeAssertion(response);
    expect(profile).toMatchObject({
      nameId: "alice",
      email: "alice@example.com",
      groups: ["eng"],
      issuer: IDP,
      authnContexts: ["urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport", "http://schemas.microsoft.com/claims/multipleauthn"]
    });
    expect(JSON.stringify(profile)).not.toContain(response);
    expect(Object.values(profile.attributes).some((value) => typeof value === "function")).toBe(false);
    // A response is accepted once.
    await expect(service.consumeAssertion(response)).rejects.toThrow(/Invalid signature/);
  });

  it("finds AuthnContextClassRef with or without namespace prefixes, and nothing without a parsed assertion", () => {
    const prefixed = {
      getAssertion: () => ({
        "saml2:Assertion": {
          "saml2:AuthnStatement": [{ "saml2:AuthnContext": [{ "saml2:AuthnContextClassRef": ["https://refeds.org/profile/mfa"] }] }]
        }
      })
    };
    expect(extractAuthnContextClassRefs(prefixed)).toEqual(["https://refeds.org/profile/mfa"]);
    const rootless = { getAssertion: () => ({ AuthnStatement: [{ AuthnContext: [{ AuthnContextClassRef: [{ _: " x:y " }] }] }] }) };
    expect(extractAuthnContextClassRefs(rootless)).toEqual(["x:y"]);
    // An attribute that merely names the element is not read; raw XML is never parsed.
    expect(
      extractAuthnContextClassRefs({
        AuthnContextClassRef: "https://refeds.org/profile/mfa",
        getAssertionXml: () => "<AuthnContextClassRef>https://refeds.org/profile/mfa</AuthnContextClassRef>"
      })
    ).toEqual([]);
    expect(
      extractAuthnContextClassRefs({
        getAssertion: () => {
          throw new Error("boom");
        }
      })
    ).toEqual([]);
  });
});

describe("SAML IdP binding", () => {
  it("uses the assertion Issuer, checks it against SAML_IDP_ISSUER and refuses a missing or '#' issuer", () => {
    const open = new SamlService({} as Store, BASE, new MockSamlIdp().factory);
    expect(open.resolveEntityId({ issuer: IDP })).toBe(IDP);
    expect(() => open.resolveEntityId({})).toThrow(SamlLoginError);
    expect(() => open.resolveEntityId({ issuer: "https://idp.example/#frag" })).toThrow(/contains '#'/);
    const pinned = new SamlService({} as Store, { ...BASE, idpIssuer: IDP }, new MockSamlIdp().factory);
    expect(pinned.resolveEntityId({ issuer: IDP })).toBe(IDP);
    try {
      pinned.resolveEntityId({ issuer: "https://evil.example/idp" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SamlLoginError);
      expect((error as SamlLoginError).code).toBe("issuer_mismatch");
    }
  });

  it("upgrades a legacy bare-NameID identity in place once, then finds it by the scoped key", async () => {
    const store = await makeStore();
    await store.saveUser({ id: "u1", email: "alice@example.com", passwordHash: "h", role: "builder" });
    await store.upsertSsoIdentity({ id: "sso_legacy", userId: "u1", provider: "saml", subject: "alice", email: "alice@example.com" });
    const service = new SamlService(store, BASE, new MockSamlIdp().factory);

    const first = await service.findIdentity(IDP, "alice");
    expect(first).toEqual({ userId: "u1", identityKey: samlIdentitySubject(IDP, "alice"), upgraded: true });
    expect(await store.findSsoIdentity("saml", "alice")).toBeNull();
    expect(await store.findSsoIdentity("saml", `${IDP}#alice`)).toMatchObject({ id: "sso_legacy", userId: "u1" });

    const second = await service.findIdentity(IDP, "alice");
    expect(second).toEqual({ userId: "u1", identityKey: `${IDP}#alice`, upgraded: false });
  });

  it("never matches a scoped identity for the same NameID from another IdP", async () => {
    const store = await makeStore();
    await store.saveUser({ id: "u1", email: "alice@example.com", passwordHash: "h", role: "admin" });
    await store.upsertSsoIdentity({ id: "sso_a", userId: "u1", provider: "saml", subject: `${IDP}#alice` });
    const service = new SamlService(store, BASE, new MockSamlIdp().factory);
    expect(await service.findIdentity("https://other-idp.example/metadata", "alice")).toBeNull();
    expect(await service.findIdentity(IDP, "alice")).toMatchObject({ userId: "u1", upgraded: false });
  });

  it("records the scoped key with the entity ID and NameID in attributes", async () => {
    const store = await makeStore();
    await store.saveUser({ id: "u1", email: "bob@example.com", passwordHash: "h", role: "viewer" });
    const service = new SamlService(store, BASE, new MockSamlIdp().factory);
    await service.recordIdentity("u1", { identityKey: `${IDP}#bob`, entityId: IDP, nameId: "bob", email: "bob@example.com", groups: ["eng"] });
    expect(await store.findSsoIdentity("saml", `${IDP}#bob`)).toMatchObject({
      userId: "u1",
      email: "bob@example.com",
      attributes: { issuer: IDP, nameId: "bob", groups: ["eng"] }
    });
  });
});

describe("SAML allow-lists and library options", () => {
  it("refuses with not_allowed and assertion-free audit details", () => {
    const service = new SamlService({} as Store, { ...BASE, allowedEmailDomains: ["example.com"], allowedGroups: ["l2m-users"] }, new MockSamlIdp().factory);
    expect(() => service.assertLoginAllowed({ identityKey: "k", email: "a@example.com", groups: ["l2m-users"] })).not.toThrow();
    try {
      service.assertLoginAllowed({ identityKey: "k", email: "a@evil.test", groups: ["l2m-users"] });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SamlLoginError);
      expect((error as SamlLoginError).details).toEqual({ list: "SAML_ALLOWED_EMAIL_DOMAINS", identityKey: "k", emailDomain: "evil.test" });
      expect(samlUserErrorCode(error)).toBe("saml_not_allowed");
    }
    expect(() => service.assertLoginAllowed({ identityKey: "k", email: "a@example.com", groups: [] })).toThrow(/SAML_ALLOWED_GROUPS/);
    expect(samlUserErrorCode(new Error("x"))).toBe("saml_failed");
  });

  it("asks for no RequestedAuthnContext only when SSO_MFA is on, and passes the issuer pin", () => {
    const off = new MockSamlIdp();
    new SamlService({} as Store, BASE, off.factory);
    expect(off.clientOptions[0]).not.toHaveProperty("disableRequestedAuthnContext");
    expect(off.clientOptions[0]).not.toHaveProperty("idpIssuer");
    const on = new MockSamlIdp();
    new SamlService({} as Store, { ...BASE, reportActualAuthnContext: true, idpIssuer: IDP }, on.factory);
    expect(on.clientOptions[0]).toMatchObject({ disableRequestedAuthnContext: true, idpIssuer: IDP });
  });
});
