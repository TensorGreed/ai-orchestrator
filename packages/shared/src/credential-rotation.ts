/**
 * 13.2 — rotating API keys and gateway client tokens, and warning before credentials expire. The names here are shared
 * by the API (routes, alerts) and the studio (rotate dialog, notification picker, expiry badges).
 *
 * Rotating issues a new secret and keeps the old one working for a grace window (24 hours unless the caller picks
 * another value, 0 ends it at once). The new key keeps the old one's name, scope and limits; nothing about it is wider.
 */
import { z } from "zod";

/** The grace window a rotation may give the old secret, in hours. */
export const KEY_ROTATION_GRACE_HOURS = { min: 0, max: 168, default: 24 } as const;

/** The body of every rotate route: how long the old secret keeps working. */
export const credentialRotateBodySchema = z
  .object({
    graceHours: z.number().int().min(KEY_ROTATION_GRACE_HOURS.min).max(KEY_ROTATION_GRACE_HOURS.max).optional()
  })
  .strict();

export type CredentialRotateBody = z.infer<typeof credentialRotateBodySchema>;

/**
 * The notification event raised for a credential that stops working soon: an API key or gateway client that expires
 * within CREDENTIAL_EXPIRY_WARNING_DAYS, or an old secret still in use while its rotation grace window runs out.
 */
export const CREDENTIAL_EXPIRING_EVENT = "credential.expiring" as const;

/** How far ahead a credential's expiry is announced, in days. */
export const CREDENTIAL_EXPIRY_WARNING_DAYS = 7;

/** An old secret still in use after a rotation is announced when its grace window ends within this many hours. */
export const ROTATION_GRACE_WARNING_HOURS = 24;

/** Which credential an expiry alert is about. */
export type CredentialKind = "api_key" | "service_account_key" | "mcp_client";

/** Why the alert was raised: the credential expires, or an old secret is still used while its grace window ends. */
export type CredentialExpiryReason = "expiry" | "rotation_grace";

/** Whole days left before `expiresAt` (0 within the last day), or null when it never expires or already has. */
export function daysUntilExpiry(expiresAt: string | null | undefined, now: number = Date.now()): number | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at) || at <= now) return null;
  return Math.floor((at - now) / 86_400_000);
}
