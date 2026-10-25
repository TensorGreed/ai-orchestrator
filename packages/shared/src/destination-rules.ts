import { z } from "zod";
import { dataDestinationInputSchema, type DestinationTier } from "./data-destinations";

/**
 * Phase 16 (p3) — the deployment's destination rules.
 *
 * Destination rules can live in any guard profile, but most deployments
 * want one set for everything: "card numbers never leave the building". The
 * Security page keeps that set in one stored profile, `destination-rules`,
 * which holds destination rules only. When it exists (and has rules) every
 * run applies it after the profiles its bindings choose, so it never
 * replaces a project's enforced profile or the built-in default. When it
 * does not exist nothing changes: no profile, no evaluation, no cost.
 *
 * The starter rule ("Keep sensitive data in-house") is created observing
 * (shadow): verdicts are recorded and nothing is stopped until an admin
 * turns enforcement on.
 */

/** Id of the stored profile that holds the deployment's destination rules. */
export const GUARD_DESTINATION_RULES_PROFILE_ID = "destination-rules";
export const GUARD_DESTINATION_RULES_PROFILE_NAME = "Destination rules";

export const STARTER_DESTINATION_RULE_NAME = "Keep sensitive data in-house";

/** The starter rule: payment cards, IBANs, SSNs, national ids and credentials stay on this machine or the private network. */
export const STARTER_DESTINATION_RULE = Object.freeze({
  name: STARTER_DESTINATION_RULE_NAME,
  when: { dataClasses: ["card_number", "iban", "us_ssn", "national_id", "credential", "private_key", "jwt"] },
  allow: { maxTier: "private" as DestinationTier },
  action: "block" as const
});

/** How many days the observing banner counts. */
export const DESTINATION_RULES_OBSERVING_DAYS = 7;

/** A destination rule as the API returns it (the guard-sdk schema validates writes). */
export interface DestinationRuleView {
  name?: string;
  when: { dataClasses?: string[]; provenance?: string[] };
  allow: { maxTier: DestinationTier; regions?: string[] };
  action: "block" | "redact" | "mask" | "protect" | "review" | "require_approval";
  shadow?: boolean;
}

/**
 * `off`: no rules; `observing`: every rule records only; `enforcing`: every
 * rule acts; `mixed`: some of each.
 */
export type DestinationRulesMode = "off" | "observing" | "enforcing" | "mixed";

export interface DestinationRulesStatus {
  /** False on Postgres (this release keeps destinations in SQLite only). */
  available: boolean;
  profileId: string;
  /** The profile's latest version; null when it does not exist yet. */
  version: number | null;
  rules: DestinationRuleView[];
  mode: DestinationRulesMode;
  hasStarter: boolean;
  /** Observed (shadow) destination verdicts that would have stopped content, over the last `days` days. Admins only (null for others). */
  observing: { wouldBlock: number; days: number } | null;
}

export function destinationRulesMode(rules: ReadonlyArray<Pick<DestinationRuleView, "shadow">>): DestinationRulesMode {
  if (rules.length === 0) return "off";
  const observing = rules.filter((rule) => rule.shadow === true).length;
  if (observing === rules.length) return "observing";
  if (observing === 0) return "enforcing";
  return "mixed";
}

/** "Observing: 3 requests would have been blocked this week" */
export function destinationRulesObservingSentence(count: number): string {
  return `Observing: ${count} ${count === 1 ? "request" : "requests"} would have been blocked this week`;
}

/** `PUT /api/guard/destination-rules`: the full rule list (validated by the guard profile schema). */
export const destinationRulesUpdateSchema = z
  .object({
    rules: z.array(z.record(z.string(), z.unknown())).max(100),
    note: z.string().trim().max(500).optional()
  })
  .strict();
export type DestinationRulesUpdate = z.infer<typeof destinationRulesUpdateSchema>;

/** `POST /api/guard/destination-rules/enforcement`: turn every rule's enforcement on or off (observing). */
export const destinationRulesEnforcementSchema = z.object({ enforce: z.boolean() }).strict();

/**
 * `POST /api/data-destinations/preview`: what destination rules would do
 * with these unsaved destination rows, on recent recorded traffic. `rows`
 * are added (or replace the stored row with the same `id`), `removedIds`
 * are left out. Validated like a save; never stored.
 */
export const destinationPreviewRequestSchema = z
  .object({
    rows: z
      .array(
        z.object({ id: z.string().trim().min(1).max(200).optional() }).passthrough().superRefine((value, ctx) => {
          const { id: _id, ...rest } = value as Record<string, unknown>;
          const parsed = dataDestinationInputSchema.safeParse(rest);
          if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, code: "custom", message: issue.message } as never);
        })
      )
      .max(200)
      .default([]),
    removedIds: z.array(z.string().trim().min(1).max(200)).max(500).default([]),
    limit: z.number().int().min(1).max(10_000).optional()
  })
  .strict();
export type DestinationPreviewRequest = z.input<typeof destinationPreviewRequestSchema>;

/** The pseudo profile id a destination preview's simulation is stored under. */
export const DESTINATION_PREVIEW_SIMULATION_PROFILE = "destinations-preview";
