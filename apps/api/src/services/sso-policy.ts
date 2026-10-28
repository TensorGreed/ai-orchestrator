/**
 * Phase 13.2 — rules shared by the OIDC and SAML sign-in paths: the optional email-domain / group allow-lists, the
 * IdP-asserted MFA check behind SSO_MFA, and the role an SSO login ends up with. Pure functions, no I/O, so both
 * providers apply exactly the same semantics and the rules are unit-tested in one place.
 */
import type { SsoMfaSettings } from "../config.js";
import type { UserRole } from "./auth-service.js";

/** The domain of an email address, lower-cased; undefined when there is none. */
export function emailDomainOf(email: string | undefined | null): string | undefined {
  if (!email) return undefined;
  const at = email.lastIndexOf("@");
  return at > 0 && at < email.length - 1 ? email.slice(at + 1).toLowerCase() : undefined;
}

export interface SsoAllowListInput {
  /** Lower-cased domains; empty = no domain restriction. */
  allowedEmailDomains: readonly string[];
  /** Exact group names; empty = no group restriction. */
  allowedGroups: readonly string[];
  /** An email the provider trusts (OIDC: verified, or any when verification is not required; SAML: the asserted one). */
  trustedEmail?: string;
  groups: readonly string[];
}

/**
 * Applies the optional allow-lists, both checked when both are set (exact, case-insensitive domain match; at least one
 * listed group). Returns which list refused the login, or null when it is allowed (always when both lists are empty).
 */
export function checkSsoAllowLists(input: SsoAllowListInput): "email_domains" | "groups" | null {
  if (input.allowedEmailDomains.length > 0) {
    const domain = emailDomainOf(input.trustedEmail);
    if (!domain || !input.allowedEmailDomains.includes(domain)) return "email_domains";
  }
  if (input.allowedGroups.length > 0 && !input.groups.some((group) => input.allowedGroups.includes(group))) {
    return "groups";
  }
  return null;
}

/** Which IdP claim satisfied MFA (for the audit trail; claim values only, never a token or assertion). */
export interface SsoMfaEvidence {
  claim: "amr" | "acr" | "authn_context";
  value: string;
}

/** OIDC: one of the ID token's `amr` values, or its `acr`, is in the configured lists. */
export function evaluateOidcMfa(
  claims: { amr?: readonly string[]; acr?: string },
  settings: Pick<SsoMfaSettings, "oidcAmr" | "oidcAcr">
): SsoMfaEvidence | null {
  const amr = (claims.amr ?? []).find((value) => settings.oidcAmr.includes(value));
  if (amr !== undefined) return { claim: "amr", value: amr };
  if (claims.acr !== undefined && settings.oidcAcr.includes(claims.acr)) return { claim: "acr", value: claims.acr };
  return null;
}

/** SAML: one of the assertion's AuthnContextClassRef values is in the configured list. */
export function evaluateSamlMfa(
  authnContexts: readonly string[],
  settings: Pick<SsoMfaSettings, "samlAuthnContexts">
): SsoMfaEvidence | null {
  const match = authnContexts.find((value) => settings.samlAuthnContexts.includes(value));
  return match === undefined ? null : { claim: "authn_context", value: match };
}

const ROLE_PRIORITY: Record<UserRole, number> = { viewer: 1, operator: 2, builder: 3, admin: 4 };

/**
 * The global role an SSO login leaves the user with: a new user gets the mapped role (viewer without a mapping); an
 * existing user is raised to a mapped role but never lowered by a mapping.
 */
export function projectSsoRole(existingRole: UserRole | null, mappedRole: UserRole | null): UserRole {
  if (existingRole === null) return mappedRole ?? "viewer";
  if (mappedRole && ROLE_PRIORITY[mappedRole] >= ROLE_PRIORITY[existingRole]) return mappedRole;
  return existingRole;
}

export type SsoMfaDecision =
  /** SSO_MFA is off, or the IdP asserted MFA: sign in now. */
  | { kind: "allow"; evidence: SsoMfaEvidence | null }
  /** idp_or_local, no IdP MFA, the user has local TOTP: the existing TOTP challenge, no session until the code passes. */
  | { kind: "local_totp" }
  /** idp_or_local, no IdP MFA, no TOTP, MFA_ENFORCE applies (admin): a session flagged for enrolment, as for passwords. */
  | { kind: "enroll" }
  /** No acceptable MFA: refuse with `sso_mfa_required`. */
  | { kind: "refuse" };

/**
 * The SSO_MFA rule. `localTotp` is whether the account the login resolves to has local TOTP enabled (false for a user
 * that does not exist yet); `mfaEnforcedForRole` is MFA_ENFORCE applied to the role the login ends up with, the same
 * rule the password login uses.
 */
export function decideSsoMfa(input: {
  mode: SsoMfaSettings["mode"];
  evidence: SsoMfaEvidence | null;
  localTotp: boolean;
  mfaEnforcedForRole: boolean;
}): SsoMfaDecision {
  if (input.mode === "off") return { kind: "allow", evidence: null };
  if (input.evidence) return { kind: "allow", evidence: input.evidence };
  if (input.mode === "idp") return { kind: "refuse" };
  if (input.localTotp) return { kind: "local_totp" };
  if (input.mfaEnforcedForRole) return { kind: "enroll" };
  return { kind: "refuse" };
}
