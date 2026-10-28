/**
 * Phase 13.2 — SAML service: profile normalisation (issuer, AuthnContextClassRef, assertion ID and validity),
 * IdP-scoped identities and the one-time upgrade of legacy bare-NameID identities, allow-lists, the options handed to
 * the SAML library, the assertion replay record and the InResponseTo browser binding.
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
  SAML_ASSERTION_REPLAY_CAP_MS,
  SamlLoginError,
  SamlService,
  deriveSamlRequestKey,
  extractAssertionFacts,
  extractAuthnContextClassRefs,
  openSamlRequest,
  samlIdentitySubject,
  samlUserErrorCode,
  sealSamlRequest,
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
    expect(profile.assertionId).toMatch(/^_[0-9a-f]+$/);
    expect(profile.validUntilMs).toBeGreaterThan(Date.now());
    expect(profile.inResponseTo).toBeUndefined();
    expect(JSON.stringify(profile)).not.toContain(response);
    expect(Object.values(profile.attributes).some((value) => typeof value === "function")).toBe(false);
    // Like the library, the IdP double accepts a response again: refusing the replay is the app's job (recordAssertion).
    await expect(service.consumeAssertion(response)).resolves.toMatchObject({ assertionId: profile.assertionId });
  });

  it("reads Issuer, ID, the validity bound and InResponseTo from the parsed assertion, not from attributes", () => {
    const conditions = "2030-01-01T00:10:00.000Z";
    const confirmations = ["2030-01-01T00:05:00.000Z", "2030-01-01T00:07:00.000Z"];
    const profile = {
      issuer: "https://attribute-named-issuer.example",
      inResponseTo: "_from_attribute",
      getAssertion: () => ({
        "saml2:Assertion": {
          $: { ID: "_a1" },
          "saml2:Issuer": [{ _: IDP }],
          "saml2:Conditions": [{ $: { NotOnOrAfter: conditions } }],
          "saml2:Subject": [
            {
              "saml2:SubjectConfirmation": confirmations.map((notOnOrAfter) => ({
                "saml2:SubjectConfirmationData": [{ $: { NotOnOrAfter: notOnOrAfter, InResponseTo: "_req1" } }]
              }))
            }
          ]
        }
      })
    };
    // The earlier of Conditions and the latest bearer confirmation bounds it.
    expect(extractAssertionFacts(profile)).toEqual({
      issuer: IDP,
      assertionId: "_a1",
      validUntilMs: Date.parse("2030-01-01T00:07:00.000Z"),
      inResponseTo: "_req1"
    });
    const service = new SamlService({} as Store, BASE, new MockSamlIdp().factory);
    expect(service.normalizeProfile({ nameID: "a", ...profile })).toMatchObject({ issuer: IDP, inResponseTo: "_req1", assertionId: "_a1" });
    // Without a parsed assertion the library's own profile fields are used.
    expect(service.normalizeProfile({ nameID: "a", issuer: IDP, inResponseTo: "_req2" })).toMatchObject({ issuer: IDP, inResponseTo: "_req2" });
    expect(extractAssertionFacts({})).toEqual({});
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

  it("finds a legacy bare-NameID identity without changing it, and upgrades it in place once when asked", async () => {
    const store = await makeStore();
    await store.saveUser({ id: "u1", email: "alice@example.com", passwordHash: "h", role: "builder" });
    await store.upsertSsoIdentity({ id: "sso_legacy", userId: "u1", provider: "saml", subject: "alice", email: "alice@example.com" });
    const service = new SamlService(store, BASE, new MockSamlIdp().factory);

    const found = await service.findIdentity(IDP, "alice");
    expect(found).toEqual({ userId: "u1", identityKey: samlIdentitySubject(IDP, "alice"), legacySubject: "alice" });
    // Finding writes nothing: the row is re-keyed only once the login has passed its checks.
    expect(await store.findSsoIdentity("saml", "alice")).toMatchObject({ id: "sso_legacy" });

    expect(await service.upgradeLegacyIdentity("alice", `${IDP}#alice`)).toBe(true);
    expect(await store.findSsoIdentity("saml", "alice")).toBeNull();
    expect(await store.findSsoIdentity("saml", `${IDP}#alice`)).toMatchObject({ id: "sso_legacy", userId: "u1" });
    expect(await service.upgradeLegacyIdentity("alice", `${IDP}#alice`)).toBe(false);

    expect(await service.findIdentity(IDP, "alice")).toEqual({ userId: "u1", identityKey: `${IDP}#alice` });
  });

  it("never matches a scoped identity for the same NameID from another IdP", async () => {
    const store = await makeStore();
    await store.saveUser({ id: "u1", email: "alice@example.com", passwordHash: "h", role: "admin" });
    await store.upsertSsoIdentity({ id: "sso_a", userId: "u1", provider: "saml", subject: `${IDP}#alice` });
    const service = new SamlService(store, BASE, new MockSamlIdp().factory);
    expect(await service.findIdentity("https://other-idp.example/metadata", "alice")).toBeNull();
    expect(await service.findIdentity(IDP, "alice")).toEqual({ userId: "u1", identityKey: `${IDP}#alice` });
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

  it("asks for no RequestedAuthnContext only when SSO_MFA is on, and leaves the issuer pin to the app's own check", () => {
    const off = new MockSamlIdp();
    new SamlService({} as Store, BASE, off.factory);
    expect(off.clientOptions[0]).not.toHaveProperty("disableRequestedAuthnContext");
    expect(off.clientOptions[0]).not.toHaveProperty("idpIssuer");
    const on = new MockSamlIdp();
    new SamlService({} as Store, { ...BASE, reportActualAuthnContext: true, idpIssuer: IDP }, on.factory);
    expect(on.clientOptions[0]).toMatchObject({ disableRequestedAuthnContext: true });
    expect(on.clientOptions[0]).not.toHaveProperty("idpIssuer");
  });

  it("starts each login with a fresh AuthnRequest ID through the library's ID generator", async () => {
    const idp = new MockSamlIdp();
    const service = new SamlService({} as Store, BASE, idp.factory);
    const first = await service.buildLoginUrl();
    const second = await service.buildLoginUrl();
    expect(first.requestCookie).toBeUndefined();
    expect(idp.requestIds).toHaveLength(2);
    expect(new Set(idp.requestIds).size).toBe(2);
    for (const id of idp.requestIds) expect(id).toMatch(/^_[0-9a-f]{40}$/);
    expect(first.url).toContain(encodeURIComponent(idp.requestIds[0]!));
    expect(second.url).toContain(encodeURIComponent(idp.requestIds[1]!));
  });
});

describe("SAML assertion replay record", () => {
  it("accepts an assertion once, across service instances sharing the store, and refuses one without an ID", async () => {
    const store = await makeStore();
    const a = new SamlService(store, BASE, new MockSamlIdp().factory);
    const b = new SamlService(store, BASE, new MockSamlIdp().factory);
    const now = Date.now();
    const assertion = { issuer: IDP, assertionId: "_once", validUntilMs: now + 60_000 };
    await a.recordAssertion(assertion, now);
    await expect(b.recordAssertion(assertion, now)).rejects.toMatchObject({ code: "replayed_assertion" });
    // The same ID from another IdP is another assertion.
    await expect(b.recordAssertion({ ...assertion, issuer: "https://other-idp.example" }, now)).resolves.toBeUndefined();
    await expect(a.recordAssertion({ issuer: IDP, validUntilMs: now + 60_000 }, now)).rejects.toMatchObject({ code: "missing_assertion_id" });
  });

  it("forgets an assertion five minutes after it expires, and holds one without NotOnOrAfter for the 24-hour cap", async () => {
    const store = await makeStore();
    const service = new SamlService(store, BASE, new MockSamlIdp().factory);
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    await service.recordAssertion({ issuer: IDP, assertionId: "_short", validUntilMs: now + 60_000 }, now);
    await service.recordAssertion({ issuer: IDP, assertionId: "_unbounded" }, now);
    const later = now + 60_000 + 5 * 60_000 + 1;
    await expect(service.recordAssertion({ issuer: IDP, assertionId: "_short", validUntilMs: later + 60_000 }, later)).resolves.toBeUndefined();
    await expect(service.recordAssertion({ issuer: IDP, assertionId: "_unbounded" }, later)).rejects.toMatchObject({ code: "replayed_assertion" });
    const afterCap = now + SAML_ASSERTION_REPLAY_CAP_MS + 1;
    await expect(service.recordAssertion({ issuer: IDP, assertionId: "_unbounded" }, afterCap)).resolves.toBeUndefined();
  });
});

describe("SAML InResponseTo binding (SAML_REQUIRE_IN_RESPONSE_TO)", () => {
  const key = deriveSamlRequestKey(Buffer.alloc(32, 7).toString("base64"));

  it("seals the request ID for ten minutes and refuses a tampered, foreign-key or old cookie", () => {
    const now = Date.now();
    const sealed = sealSamlRequest("_req", key, now);
    expect(sealed).not.toContain("_req");
    expect(openSamlRequest(sealed, key, now + 60_000)).toBe("_req");
    expect(openSamlRequest(sealed, key, now + 11 * 60_000)).toBeNull();
    expect(openSamlRequest(sealed, deriveSamlRequestKey(Buffer.alloc(32, 8).toString("base64")), now)).toBeNull();
    const tampered = Buffer.from(sealed, "base64url");
    tampered[tampered.length - 1] ^= 1;
    expect(openSamlRequest(tampered.toString("base64url"), key, now)).toBeNull();
    expect(openSamlRequest(undefined, key, now)).toBeNull();
  });

  it("requires the assertion to answer the request this browser started; off by default", async () => {
    const off = new SamlService({} as Store, { ...BASE, requestCookieKey: key }, new MockSamlIdp().factory);
    expect(() => off.assertSolicited({}, undefined)).not.toThrow();

    const idp = new MockSamlIdp();
    const on = new SamlService({} as Store, { ...BASE, requireInResponseTo: true, requestCookieKey: key }, idp.factory);
    const { requestCookie } = await on.buildLoginUrl();
    expect(requestCookie).toBeTruthy();
    const requestId = idp.latestRequestId();
    expect(() => on.assertSolicited({ inResponseTo: requestId }, requestCookie)).not.toThrow();
    for (const [profile, cookie] of [
      [{ inResponseTo: requestId }, undefined],
      [{}, requestCookie],
      [{ inResponseTo: "_another_request" }, requestCookie]
    ] as const) {
      try {
        on.assertSolicited(profile, cookie);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(SamlLoginError);
        expect((error as SamlLoginError).code).toBe("unsolicited_response");
      }
    }
  });
});
