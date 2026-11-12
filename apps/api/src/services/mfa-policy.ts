/**
 * 13.2 — MFA required per role, and step-up before security-admin actions. Pure rules, no I/O: the app looks up what
 * they need (the session row, whether the user enrolled TOTP) and applies the answer.
 *
 * - A user in a role listed in MFA_REQUIRED_ROLES (MFA_ENFORCE=true adds admin) whose session has not passed an MFA
 *   check is restricted, never refused: without TOTP the session can only set it up (`enrollment_required`); with TOTP
 *   it can only verify a code (`verification_required`). Either way the user is never locked out.
 * - With STEP_UP_MAX_AGE_MINUTES set, the actions in STEP_UP_ACTIONS need an MFA check on the session within that many
 *   minutes. API keys are refused on them, except a service-account key (`serviceAccount: true` in the request
 *   context) with a `role:admin` ceiling that still acts as admin (the account is an admin and the key lists no
 *   projects). A person's own key is always refused there. Even that service-account key is refused when the action
 *   targets a person (reset their MFA, sign them out, change their role, delete them): those need a person who has
 *   passed a second factor.
 * - Break-glass sessions skip both (isPolicyExempt).
 */
import type { MfaPolicySettings } from "../config.js";
import type { UserRole } from "./auth-service.js";
import { isPolicyExempt, type LoginSession, type RequestAuthContext } from "./session-service.js";

/** True when MFA is required for users with this global role. */
export function mfaRequiredFor(policy: Pick<MfaPolicySettings, "requiredRoles">, role: UserRole): boolean {
  return policy.requiredRoles.includes(role);
}

/**
 * True when this session still owes an MFA check under the role rule: the role is listed, the session is not
 * break-glass, and no MFA check has been recorded on it. Callers look up the user's enrolment only when this is true.
 */
export function sessionOwesMfa(
  policy: Pick<MfaPolicySettings, "requiredRoles">,
  role: UserRole,
  session: Pick<LoginSession, "mfaVerifiedAt" | "breakGlass">
): boolean {
  return mfaRequiredFor(policy, role) && !isPolicyExempt(session) && !session.mfaVerifiedAt;
}

/** What a session that owes MFA may still do. */
export type SessionMfaGate = "none" | "enrollment_required" | "verification_required";

export function sessionMfaGate(owesMfa: boolean, totpEnrolled: boolean): SessionMfaGate {
  if (!owesMfa) return "none";
  return totpEnrolled ? "verification_required" : "enrollment_required";
}

/** The 403 answer for a request a restricted session may not make. */
export const MFA_GATE_ERRORS: Record<Exclude<SessionMfaGate, "none">, { code: string; error: string }> = {
  enrollment_required: {
    code: "mfa_enrollment_required",
    error: "Your role requires multi-factor authentication. Set up an authenticator app to continue."
  },
  verification_required: {
    code: "mfa_verification_required",
    error: "Your role requires multi-factor authentication. Enter a code from your authenticator app to continue."
  }
};

/**
 * Whether a restricted session may call this route (`routeUrl` is the route pattern, such as `/api/auth/me`).
 * Sign-out never goes through this check.
 */
export function mfaGateAllows(gate: SessionMfaGate, method: string, routeUrl: string): boolean {
  if (gate === "none") return true;
  const verb = method.toUpperCase();
  if (verb === "GET" && routeUrl === "/api/auth/me") return true;
  if (verb === "GET" && routeUrl === "/api/auth/mfa/status") return true;
  if (gate === "enrollment_required") return routeUrl.startsWith("/api/auth/mfa/");
  return verb === "POST" && routeUrl === "/api/auth/step-up";
}

/**
 * The security-admin actions that need a fresh MFA check when step-up is on. Each guarded route names one; the
 * documentation lists the same set.
 */
export const STEP_UP_ACTIONS = {
  "user.create": "Create a user (admin registration)",
  "user.invite": "Invite a user",
  "user.role_change": "Change a user's role",
  "user.delete": "Delete a user",
  "user.mfa_reset": "Reset a user's MFA",
  "user.sessions_revoke": "Sign another user out (end their sessions)",
  "mfa.disable": "Turn your own MFA off",
  "api_key.create": "Create an API key",
  "api_key.rotate": "Rotate an API key",
  "mcp_client.create": "Create a gateway client",
  "mcp_client.rotate": "Rotate a gateway client's token",
  "secret.create": "Create a secret",
  "secret.update": "Change a secret's settings or sharing",
  "secret.delete": "Delete a secret",
  "sso_mapping.change": "Create or delete an SSO group mapping",
  "project_member.change": "Add or remove a project member",
  "custom_role.change": "Create, change or delete a custom role",
  "project_retention.change": "Change a project's data retention",
  "notification_channel.change": "Create or delete a notification channel",
  "audit_export.change": "Create, change or delete an audit export destination or log stream",
  "legal_hold.change": "Place or release a legal hold",
  "subject_request.reveal": "Make a data-subject export that reveals tokenised values",
  "subject_export.download": "Download a data-subject export",
  "subject_request.delete": "Confirm a data-subject deletion"
} as const;

export type StepUpAction = keyof typeof STEP_UP_ACTIONS;

export type StepUpDecision =
  /** Step-up is off, the check is fresh, the session is break-glass, or a service-account admin key. */
  | { kind: "allow" }
  /** A session whose last MFA check is missing or older than the window. */
  | { kind: "required" }
  /**
   * A personal API key (or a service-account key without an admin `role:admin` ceiling) on a guarded action; or any
   * service-account key on an action that targets a person (`reason: "person_target"`).
   */
  | { kind: "key_refused"; reason?: "person_target" }
  /** Nothing authenticated this request through requireRole: deny. */
  | { kind: "unauthenticated" };

export function decideStepUp(input: {
  maxAgeMinutes: number;
  context: RequestAuthContext | undefined;
  now: number;
  /** The action changes a person's account (their MFA, sessions, role, or the account itself). */
  targetsPerson?: boolean;
}): StepUpDecision {
  if (input.maxAgeMinutes <= 0) return { kind: "allow" };
  const context = input.context;
  if (!context) return { kind: "unauthenticated" };
  if (context.credential === "api_key") {
    // The parsed ceiling must be admin, and the key must still act as admin: a project list caps it at builder, and a
    // demoted service account lowers its keys (context.user.role is the role the key acts with).
    if (context.serviceAccount === true && input.targetsPerson) return { kind: "key_refused", reason: "person_target" };
    return context.serviceAccount === true && context.keyScope.roleCeiling === "admin" && context.user.role === "admin"
      ? { kind: "allow" }
      : { kind: "key_refused" };
  }
  if (isPolicyExempt(context.session)) return { kind: "allow" };
  const verifiedAt = context.session.mfaVerifiedAt ? Date.parse(context.session.mfaVerifiedAt) : Number.NaN;
  if (Number.isFinite(verifiedAt) && input.now - verifiedAt <= input.maxAgeMinutes * 60_000) return { kind: "allow" };
  return { kind: "required" };
}
