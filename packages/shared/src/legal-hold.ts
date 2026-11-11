/**
 * 13.3 — legal holds. A hold keeps data that would otherwise be deleted: by age (retention), by a person (a workflow,
 * project, golden run, cassette or golden-set delete) or by a data-subject delete. It changes deletion only, never who
 * may read the data. Holds are placed and released by admins, or by a custom role with `legal_hold:manage`; they are
 * never released automatically (`endsAt` is a review date).
 */
import { z } from "zod";

/**
 * What a hold covers. `project` and `workflow` cover every row of that project or workflow; `runs` covers a list of
 * runs (execution ids) and what belongs to them; `subject` covers the rows the data-subject lookup finds for a value
 * when the hold is placed. `organization` is reserved for a later step and refused by the API.
 */
export const LEGAL_HOLD_SCOPE_TYPES = ["project", "workflow", "runs", "subject", "organization"] as const;
export type LegalHoldScopeType = (typeof LEGAL_HOLD_SCOPE_TYPES)[number];

/** The scopes the API accepts today. */
export const LEGAL_HOLD_PLACEABLE_SCOPES = ["project", "workflow", "runs", "subject"] as const;
export type LegalHoldPlaceableScope = (typeof LEGAL_HOLD_PLACEABLE_SCOPES)[number];

/**
 * The kinds of row a hold can name one by one (`legal_hold_items`). A run (`execution`) also covers its tool calls,
 * rule events, approvals, cassettes, usage rows and queue job; the others are the stores the data-subject lookup
 * searches.
 */
export const LEGAL_HOLD_ITEM_KINDS = ["execution", "recording", "fixture", "eval_result", "cassette"] as const;
export type LegalHoldItemKind = (typeof LEGAL_HOLD_ITEM_KINDS)[number];

export type LegalHoldStatus = "active" | "released";

/** Most runs one `runs` hold may name. */
export const LEGAL_HOLD_MAX_RUNS = 2_000;

/** The notification event placing or releasing a hold raises. */
export const LEGAL_HOLD_CHANGED_EVENT = "data.legal_hold_changed" as const;

/** Picker entries for the legal-hold alert (value and label, as the settings notification picker lists). */
export const LEGAL_HOLD_NOTIFICATION_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: LEGAL_HOLD_CHANGED_EVENT, label: "Legal hold placed or released" }
];

const text = (max: number) => z.string().trim().min(1).max(max);

/** `POST /api/legal-holds`: place a hold. */
export const legalHoldPlaceSchema = z
  .object({
    name: text(200),
    reason: text(2_000),
    /** A case or matter number, for the people who track the hold outside L2M. */
    matterRef: z.string().trim().max(200).optional(),
    /** A review date (ISO 8601). The hold is not released then; a reminder is the operator's. */
    endsAt: z.iso.datetime({ offset: true }).optional(),
    scopeType: z.enum(LEGAL_HOLD_PLACEABLE_SCOPES),
    /** The project or workflow id (`project`, `workflow`). */
    scopeId: z.string().trim().min(1).max(200).optional(),
    /** The runs (`runs`). */
    executionIds: z.array(z.string().trim().min(1).max(200)).min(1).max(LEGAL_HOLD_MAX_RUNS).optional(),
    /** The value to look up (`subject`), as the data-subject lookup takes it. Never stored or logged. */
    subject: z
      .object({
        value: z.string().min(3).max(1_000),
        dataClass: z.enum(["email", "phone", "card_number", "us_ssn", "iban", "national_id"]).optional(),
        country: z
          .string()
          .trim()
          .regex(/^(?:[A-Za-z]{2}|\+\d{1,3})$/)
          .optional()
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    const need = (ok: boolean, path: string, message: string) => {
      if (!ok) ctx.addIssue({ code: "custom", path: [path], message });
    };
    if (value.scopeType === "project" || value.scopeType === "workflow") need(Boolean(value.scopeId), "scopeId", `A ${value.scopeType} hold names its ${value.scopeType} (scopeId).`);
    if (value.scopeType === "runs") need(Boolean(value.executionIds?.length), "executionIds", "A runs hold names its runs (executionIds).");
    if (value.scopeType === "subject") need(Boolean(value.subject), "subject", "A subject hold names the value to look up (subject.value).");
  });
export type LegalHoldPlaceInput = z.infer<typeof legalHoldPlaceSchema>;

/** `POST /api/legal-holds/:id/release`. */
export const legalHoldReleaseSchema = z.object({ reason: text(2_000) }).strict();

/** A hold as the API returns it. */
export interface LegalHoldView {
  id: string;
  name: string;
  reason: string;
  matterRef: string | null;
  scopeType: LegalHoldScopeType;
  /** The project or workflow id; the hold's own id for `runs` and `subject` holds (their rows are its items). */
  scopeId: string;
  status: LegalHoldStatus;
  endsAt: string | null;
  createdBy: string | null;
  createdAt: string;
  releasedBy: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  /** Rows named one by one (`runs` and `subject` holds). */
  itemCount: number;
}

export interface LegalHoldItemView {
  kind: LegalHoldItemKind;
  rowId: string;
  addedAt: string;
}

/** A hold as a refusal names it (409 `legal_hold`). */
export interface LegalHoldRef {
  id: string;
  name: string;
}

/** The body of a 409 a hold causes. */
export interface LegalHoldConflictBody {
  error: string;
  code: "legal_hold";
  holds: LegalHoldRef[];
}

/** One sentence naming the holds that keep something, for refusals (`refused`: what cannot happen, "deleted" by default). */
export function legalHoldRefusalMessage(what: string, holds: readonly LegalHoldRef[], refused = "deleted"): string {
  const names = holds.slice(0, 3).map((hold) => `"${hold.name}"`).join(", ");
  const more = holds.length > 3 ? ` and ${holds.length - 3} more` : "";
  return `${what} is under legal hold (${names}${more}); it cannot be ${refused} until the hold is released.`;
}
