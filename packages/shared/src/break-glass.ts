/**
 * 13.2 — break-glass sign-in: a one-time link an operator mints on the server host (`admin:break-glass`) when no admin
 * can sign in. The names here are shared by the API (alerts, `/api/auth/me`) and the studio (notification picker,
 * banner).
 */

/**
 * The notification event every stage of a break-glass sign-in raises: the link was issued, it was used, the session
 * ended. Channels set in the environment receive it by default; a channel made in the settings picks it.
 */
export const BREAK_GLASS_SIGN_IN_EVENT = "auth.break_glass_used" as const;

/** Picker entries for the break-glass sign-in alert (value and label, as the settings notification picker lists). */
export const BREAK_GLASS_NOTIFICATION_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: BREAK_GLASS_SIGN_IN_EVENT, label: "Break-glass sign-in" }
];

/** Which step of a break-glass sign-in an alert is about. */
export type BreakGlassStage = "issued" | "used" | "ended";

/** How long a minted link stays valid, in minutes. */
export const BREAK_GLASS_LINK_MINUTES = { min: 5, max: 60, default: 15 } as const;

