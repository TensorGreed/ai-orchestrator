/**
 * Phase 13.2 — an in-process SAML identity provider for tests, plugged in through `samlClientFactory` (no sockets, no
 * @node-saml/node-saml). `issue(user)` plays the user at the IdP and returns an opaque SAMLResponse; the client hands
 * back the profile the library would produce for it (issuer, nameID, attributes and the xml2js-parsed assertion with
 * its AuthnContextClassRef), once, and refuses anything it did not issue (a forged or replayed response).
 */
import crypto from "node:crypto";
import type { NodeSamlLike, NodeSamlOptions } from "../services/saml-service.js";

export interface MockSamlUser {
  nameID: string;
  email?: string;
  groups?: string[];
  /** AuthnContextClassRef values (one AuthnStatement each). */
  authnContexts?: string[];
  /** Overrides the IdP's entity ID for this response (an assertion from another IdP). */
  issuer?: string | null;
  [attribute: string]: unknown;
}

export class MockSamlIdp {
  readonly entityId: string;
  /** Options the app handed to the SAML library (to check RequestedAuthnContext and the issuer pin). */
  readonly clientOptions: NodeSamlOptions[] = [];
  private readonly issued = new Map<string, MockSamlUser>();

  constructor(entityId = "https://idp.example.test/saml/metadata") {
    this.entityId = entityId;
  }

  /** The IdP authenticated `user`: returns the SAMLResponse its auto-submitting form would post. */
  issue(user: MockSamlUser): string {
    const response = `PHNhbWxwOlJlc3BvbnNl${crypto.randomBytes(24).toString("base64")}`;
    this.issued.set(response, { ...user });
    return response;
  }

  readonly factory = (options: NodeSamlOptions): NodeSamlLike => {
    this.clientOptions.push(options);
    return {
      generateAuthorizeUrl: () => `${this.entityId.replace(/\/metadata$/, "")}/sso?SAMLRequest=mock`,
      validatePostResponseAsync: async ({ SAMLResponse }) => {
        const user = this.issued.get(SAMLResponse);
        if (!user) throw new Error("Invalid signature");
        this.issued.delete(SAMLResponse);
        const { authnContexts = ["urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport"], issuer, ...attributes } = user;
        const entity = issuer === undefined ? this.entityId : issuer;
        const assertion = {
          Assertion: {
            $: { ID: `_${crypto.randomBytes(8).toString("hex")}` },
            ...(entity ? { Issuer: [{ _: entity }] } : {}),
            AuthnStatement: authnContexts.map((ref) => ({
              $: { SessionIndex: "_session" },
              AuthnContext: [{ AuthnContextClassRef: [{ _: ref }] }]
            }))
          }
        };
        const profile: Record<string, unknown> = {
          ...attributes,
          ...(entity ? { issuer: entity } : {}),
          getAssertion: () => assertion,
          getAssertionXml: () => `<saml:Assertion>${SAMLResponse}</saml:Assertion>`,
          getSamlResponseXml: () => `<samlp:Response>${SAMLResponse}</samlp:Response>`
        };
        return { profile };
      }
    };
  };
}
