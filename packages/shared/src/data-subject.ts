/**
 * 13.3 — data-subject requests: subject references a workflow declares, the request an admin makes for a person's data,
 * and the export it produces.
 *
 * A subject reference names the person a run is about (a customer id in the input, the chat session id, the caller's
 * email). The API stores only a keyed hash of each value, so a later request for that person finds their runs and
 * memory by an indexed lookup instead of reading every run. References are opt-in per workflow; a workflow without them
 * behaves as before.
 */
import { z } from "zod";

/** Most subject references one workflow may declare. */
export const SUBJECT_REF_MAX = 3;

/**
 * What a subject reference may read, relative to the run: a path under the run's input, output or custom data, the
 * chat session id, or who started the run. Only plain paths (no expressions), so resolving one never runs code.
 */
export const SUBJECT_REF_ROOTS = ["input", "output", "customData", "session_id", "triggeredBy"] as const;
export type SubjectRefRoot = (typeof SUBJECT_REF_ROOTS)[number];

const SUBJECT_REF_SEGMENT = "[A-Za-z0-9_-]+";
const SUBJECT_REF_PATTERN = new RegExp(
  `^\\{\\{\\s*((?:input|output|customData)(?:\\.${SUBJECT_REF_SEGMENT})+|session_id|triggeredBy)\\s*\\}\\}$`
);

/** The path inside `{{ }}` of a valid subject reference, or null. */
export function subjectRefPath(expression: string): string | null {
  const match = SUBJECT_REF_PATTERN.exec(expression.trim());
  return match ? match[1]! : null;
}

export const subjectRefExpressionSchema = z
  .string()
  .trim()
  .max(200)
  .refine((value) => subjectRefPath(value) !== null, {
    message:
      "A subject reference is one path in {{ }}: {{input.<path>}}, {{output.<path>}}, {{customData.<path>}}, {{session_id}} or {{triggeredBy}}"
  });

/** `settings.dataProtection` of a workflow. Additive: the workflow contract stays schemaVersion 1.0.0. */
export const workflowDataProtectionSchema = z
  .object({
    subjectRefs: z
      .array(subjectRefExpressionSchema)
      .max(SUBJECT_REF_MAX, `At most ${SUBJECT_REF_MAX} subject references`)
      .refine((refs) => new Set(refs.map((ref) => subjectRefPath(ref))).size === refs.length, { message: "Each subject reference once" })
      .optional()
  })
  .strict();

export type WorkflowDataProtectionSettings = z.infer<typeof workflowDataProtectionSchema>;

/**
 * Request types. `export`: a zip of what was found, downloaded once. `delete`: what was found is shown first, and is
 * deleted (an end user) or pseudonymised (a staff member) only once a manager confirms it.
 */
export const SUBJECT_REQUEST_TYPES = ["export", "delete"] as const;
export type SubjectRequestType = (typeof SUBJECT_REQUEST_TYPES)[number];

/** `end_user`: a person whose data flows through runs. `staff`: a person who uses the product (searched by email). */
export const SUBJECT_KINDS = ["end_user", "staff"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/**
 * `searching`: the lookup is running (it resumes after a restart). `ready`: the export can be downloaded once, or a
 * deletion waits for its confirmation. `running`: a confirmed deletion is under way (it resumes after a restart).
 * `deferred_by_hold`: deleted except rows a legal hold keeps; they are deleted when the hold is released. `done`:
 * downloaded, or deleted. `expired`: not downloaded or confirmed within SUBJECT_EXPORT_TTL_HOURS. `failed`: see `error`.
 */
export const SUBJECT_REQUEST_STATUSES = ["searching", "ready", "running", "deferred_by_hold", "done", "expired", "failed"] as const;
export type SubjectRequestStatus = (typeof SUBJECT_REQUEST_STATUSES)[number];

/** The kinds of rows a request can find, each a JSON-lines file in the export. */
export const SUBJECT_ROW_KINDS = [
  "run",
  "paused_run",
  "approval",
  "memory_session",
  "memory_artifact",
  "cassette",
  "golden_run",
  "golden_set_case",
  "eval_result"
] as const;
export type SubjectRowKind = (typeof SUBJECT_ROW_KINDS)[number];

export const SUBJECT_ROW_KIND_LABELS: Record<SubjectRowKind, string> = {
  run: "Runs (input, output, node results)",
  paused_run: "Paused runs",
  approval: "Approval requests",
  memory_session: "Agent memory sessions",
  memory_artifact: "Agent artifacts",
  cassette: "MCP cassettes",
  golden_run: "Golden and captured runs",
  golden_set_case: "Golden-set cases",
  eval_result: "Eval and replay results"
};

/** Most rows one request collects; a request that finds more says so (`truncated`). */
export const SUBJECT_REQUEST_MAX_ROWS = 5_000;

export const subjectRequestCreateSchema = z
  .object({
    type: z.enum(SUBJECT_REQUEST_TYPES),
    subjectKind: z.enum(SUBJECT_KINDS).default("end_user"),
    /** The person's identifier (an email, customer id, phone number). Used for the lookup, then dropped: never stored or logged. */
    value: z.string().trim().min(1).max(320),
    /**
     * Also read stored data for the value, beyond the runs and memory that subject references point at. Slower (it
     * reads every stored run), but finds runs of workflows without references.
     */
    scan: z.boolean().default(true),
    /** Replace reversible tokens in the export with their original values (needs a recent MFA check when step-up is on). */
    revealTokens: z.boolean().default(false)
  })
  .strict()
  .refine((value) => !(value.type === "delete" && value.revealTokens), {
    path: ["revealTokens"],
    message: "Revealing tokens applies to exports only"
  });

export type SubjectRequestCreateInput = z.infer<typeof subjectRequestCreateSchema>;

/** `POST /api/data-protection/requests/:id/confirm`: confirms a deletion after its preview (no fields today). */
export const subjectRequestConfirmSchema = z.object({}).strict();

export interface SubjectRequestExportView {
  bytes: number;
  expiresAt: string;
  downloadedAt: string | null;
  downloadedBy: string | null;
  /** Whether it can still be downloaded (not downloaded yet, and not expired). */
  available: boolean;
}

export interface SubjectRequestProgress {
  /** Where the lookup is: subject references, then each stored kind in turn. */
  phase: "references" | "scan" | "export" | "finished";
  /** Stored kinds read so far out of the total (scan only). */
  kindsDone: number;
  kindsTotal: number;
  /** Rows read by the scan so far. */
  rowsSearched: number;
}

/** What a deletion request did (null before it is confirmed, and for exports). */
export interface SubjectDeletionView {
  confirmedAt: string | null;
  confirmedBy: string | null;
  /** Rows deleted per kind (with what each took: a run its tool calls, rule events, approvals, cassettes and queue jobs). */
  deleted: Partial<Record<SubjectRowKind, number>>;
  /** Usage rows of deleted runs kept with the person cleared (tokens and cost stay, so totals and budgets do not move). */
  usageRowsCleared: number;
  /** Token vault entries of the person's values deleted: their tokens can no longer be revealed anywhere. */
  vaultTokensDeleted: number;
  /** Rows a legal hold keeps; deleted when the hold is released. */
  deferred: number;
  /** Runs still in flight when the deletion reached them; deleted once they have finished (the sweep retries). */
  waitingForRuns: number;
  /** Rows gone already, or no longer holding the value, when the deletion reached them. */
  skipped: number;
  /** A staff member: the pseudonym their email was replaced with, how many rows changed, and whether the user is gone. */
  staff: {
    pseudonym: string;
    rowsPseudonymised: number;
    userDeleted: boolean;
    /** Why the person's audit-log rows stay. */
    auditLog: string;
  } | null;
  /** What a deletion cannot reach. */
  notCovered: string[];
}

/** What a deletion never reaches; the request view and the docs list it. */
export const SUBJECT_DELETION_NOT_COVERED = [
  "Logs, metrics, traces and log-streaming destinations (outside the database)",
  "Backups already written: a restore re-applies the deletion while its erasure record is kept (ERASURE_TOMBSTONE_RETENTION_DAYS)",
  "Model providers, MCP servers and other systems the runs sent data to",
  "Knowledge bases (ingested documents)",
  "Tokens that are not in the person's rows, and format-preserving tokens"
];

/** Why a staff member's audit-log rows are kept (the deletion view and the docs say so). */
export const STAFF_AUDIT_LOG_KEPT =
  "Audit-log rows are kept unchanged for security logging until AUDIT_LOG_RETENTION_DAYS removes them; rewriting them would break the audit chain.";

/** A request as the API shows it. Never the value. */
export interface SubjectRequestView {
  id: string;
  type: SubjectRequestType;
  subjectKind: SubjectKind;
  status: SubjectRequestStatus;
  scan: boolean;
  revealTokens: boolean;
  /** Rows found per kind. */
  counts: Partial<Record<SubjectRowKind, number>>;
  /** Rows found through subject references (the rest came from the scan). */
  foundByReference: number;
  /** More than SUBJECT_REQUEST_MAX_ROWS rows matched; the export holds the first ones. */
  truncated: boolean;
  progress: SubjectRequestProgress;
  dueAt: string;
  overdue: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  export: SubjectRequestExportView | null;
  /** Deletion requests: what the deletion did (null until confirmed). */
  deletion: SubjectDeletionView | null;
  /**
   * A staff deletion's preview: whether the user exists, and how many rows record them as author or decider per
   * section (the rows that will be pseudonymised). Null for other requests.
   */
  staffPreview: SubjectStaffPreview | null;
}

/** What a staff erasure will change, counted before it is confirmed. */
export interface SubjectStaffPreview {
  userFound: boolean;
  runsTriggered: number;
  workflowsCreated: number;
  approvals: number;
  evalRuns: number;
  releasesPublished: number;
  /** The person's audit-log rows: kept (STAFF_AUDIT_LOG_KEPT). */
  auditEntries: number;
}

/** POST /api/data-protection/subject-refs/preview: how the expressions resolve on a workflow's latest runs. */
export const subjectRefPreviewSchema = z
  .object({
    workflowId: z.string().trim().min(1).max(200),
    subjectRefs: z.array(subjectRefExpressionSchema).min(1).max(SUBJECT_REF_MAX)
  })
  .strict();

export interface SubjectRefPreviewView {
  /** Runs looked at (the latest ones). */
  runs: number;
  refs: Array<{
    expression: string;
    /** Runs where it resolved to a value. */
    resolved: number;
    /** The latest resolved value, masked (first and last character kept), or null. */
    sample: string | null;
  }>;
}
