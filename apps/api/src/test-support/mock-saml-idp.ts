/**
 * Phase 13.2 — an in-process SAML identity provider for tests, plugged in through `samlClientFactory` (no sockets, no
 * @node-saml/node-saml). `issue(user)` plays the user at the IdP and returns an opaque SAMLResponse; the client hands
 * back the profile the library would produce for it (issuer, nameID, attributes and the xml2js-parsed assertion with
 * its ID, validity window, InResponseTo and AuthnContextClassRef). Like the library (whose default keeps no record of
 * used assertions), it accepts the same response as often as it is posted until it expires: replay protection is the
 * app's job. Anything it did not issue is refused as a bad signature.
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

export interface MockSamlIssueOptions {
  /** The AuthnRequest ID this response answers (SP-initiated); unset = IdP-initiated (no InResponseTo). */
  inResponseTo?: string;
  /** How long the assertion is valid (NotOnOrAfter); default five minutes. */
  validForMs?: number;
  /** Leaves the assertion's ID out (a malformed assertion). */
  omitAssertionId?: boolean;
}

interface IssuedResponse {
  user: MockSamlUser;
  assertionId: string | null;
  notOnOrAfter: string;
  inResponseTo?: string;
}

export class MockSamlIdp {
  readonly entityId: string;
  /** Options the app handed to the SAML library (to check RequestedAuthnContext and the request ID generator). */
  readonly clientOptions: NodeSamlOptions[] = [];
  /** AuthnRequest IDs of the logins started through `getAuthorizeUrlAsync`, newest last. */
  readonly requestIds: string[] = [];
  private readonly issued = new Map<string, IssuedResponse>();

  constructor(entityId = "https://idp.example.test/saml/metadata") {
    this.entityId = entityId;
  }

  /** The IdP authenticated `user`: returns the SAMLResponse its auto-submitting form would post. */
  issue(user: MockSamlUser, options: MockSamlIssueOptions = {}): string {
    const response = `PHNhbWxwOlJlc3BvbnNl${crypto.randomBytes(24).toString("base64")}`;
    this.issued.set(response, {
      user: { ...user },
      assertionId: options.omitAssertionId ? null : `_${crypto.randomBytes(16).toString("hex")}`,
      notOnOrAfter: new Date(Date.now() + (options.validForMs ?? 5 * 60 * 1000)).toISOString(),
      ...(options.inResponseTo ? { inResponseTo: options.inResponseTo } : {})
    });
    return response;
  }

  /** The request ID of the latest SP-initiated login (what the IdP would answer with InResponseTo). */
  latestRequestId(): string {
    const id = this.requestIds[this.requestIds.length - 1];
    if (!id) throw new Error("No SAML login was started");
    return id;
  }

  readonly factory = (options: NodeSamlOptions): NodeSamlLike => {
    this.clientOptions.push(options);
    return {
      getAuthorizeUrlAsync: async () => {
        const id = options.generateUniqueId ? options.generateUniqueId() : `_${crypto.randomBytes(8).toString("hex")}`;
        this.requestIds.push(id);
        return `${this.entityId.replace(/\/metadata$/, "")}/sso?SAMLRequest=mock-${encodeURIComponent(id)}`;
      },
      validatePostResponseAsync: async ({ SAMLResponse }) => {
        const entry = this.issued.get(SAMLResponse);
        if (!entry) throw new Error("Invalid signature");
        if (Date.parse(entry.notOnOrAfter) <= Date.now()) throw new Error("SAML assertion expired");
        const { authnContexts = ["urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport"], issuer, ...attributes } = entry.user;
        const entity = issuer === undefined ? this.entityId : issuer;
        const assertion = {
          Assertion: {
            $: entry.assertionId ? { ID: entry.assertionId, IssueInstant: new Date().toISOString() } : { IssueInstant: new Date().toISOString() },
            ...(entity ? { Issuer: [{ _: entity }] } : {}),
            Subject: [
              {
                NameID: [{ _: String(attributes.nameID) }],
                SubjectConfirmation: [
                  {
                    $: { Method: "urn:oasis:names:tc:SAML:2.0:cm:bearer" },
                    SubjectConfirmationData: [
                      { $: { NotOnOrAfter: entry.notOnOrAfter, ...(entry.inResponseTo ? { InResponseTo: entry.inResponseTo } : {}) } }
                    ]
                  }
                ]
              }
            ],
            Conditions: [{ $: { NotOnOrAfter: entry.notOnOrAfter } }],
            AuthnStatement: authnContexts.map((ref) => ({
              $: { SessionIndex: "_session" },
              AuthnContext: [{ AuthnContextClassRef: [{ _: ref }] }]
            }))
          }
        };
        const profile: Record<string, unknown> = {
          ...attributes,
          ...(entity ? { issuer: entity } : {}),
          ...(entry.inResponseTo ? { inResponseTo: entry.inResponseTo } : {}),
          getAssertion: () => assertion,
          getAssertionXml: () => `<saml:Assertion>${SAMLResponse}</saml:Assertion>`,
          getSamlResponseXml: () => `<samlp:Response>${SAMLResponse}</samlp:Response>`
        };
        return { profile };
      }
    };
  };
}
