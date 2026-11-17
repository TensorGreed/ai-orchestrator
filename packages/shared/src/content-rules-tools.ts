import { z } from "zod";
import { dataClassNameSchema } from "./data-labels";
import type { SCAN_DOCUMENT_TOOL_NAME } from "./content-documents";

/**
 * Content rules as MCP tools on the gateway: a toolset member of kind `content_rules` (admin-added, off unless added)
 * lists three tools to the clients scoped to that toolset.
 *
 * - `detect_sensitive_data`: findings (data class, position, masked preview, score) and a risk level per input.
 * - `redact_sensitive_data`: the same input with sensitive values replaced (`placeholder`, `token`, `mask`, `hash`);
 *   reversible styles return a `redaction_id`, and the mapping stays on the server, sealed and expiring.
 * - `restore_sensitive_data`: placeholders (with their `redaction_id`) and vault tokens turned back into values, only
 *   for data classes a reveal rule allows the calling client (`subjects.gatewayClients`); default deny.
 *
 * Inputs are one of `text`, `texts` (a list, one risk level each) or `value` (any JSON value; its strings are
 * scanned). Results never carry raw values except what restore was allowed to give back.
 */

export const CONTENT_RULES_TOOL_NAMES = {
  detect: "detect_sensitive_data",
  redact: "redact_sensitive_data",
  restore: "restore_sensitive_data"
} as const;
export type ContentRulesToolName = (typeof CONTENT_RULES_TOOL_NAMES)[keyof typeof CONTENT_RULES_TOOL_NAMES];
export const CONTENT_RULES_TOOL_LIST: readonly ContentRulesToolName[] = Object.values(CONTENT_RULES_TOOL_NAMES);
/** Every tool a content rules member can list: the three above, and `scan_document` when the member turns documents on. */
export type ContentRulesGatewayToolName = ContentRulesToolName | typeof SCAN_DOCUMENT_TOOL_NAME;

/** The adapter id and server label the gateway's tool policy sees for these tools. */
export const CONTENT_RULES_TOOLS_ADAPTER_ID = "l2m-content-rules";
export const CONTENT_RULES_TOOLS_SERVER_LABEL = "Content rules";

export const REDACTION_STYLES = ["placeholder", "token", "mask", "hash"] as const;
export type RedactionStyle = (typeof REDACTION_STYLES)[number];
/** Styles whose output can be turned back (the response then carries a `redaction_id`). */
export const REVERSIBLE_REDACTION_STYLES: readonly RedactionStyle[] = ["placeholder", "token"];

/** Limits per call. */
export const CONTENT_TOOLS_MAX_TEXTS = 100;
export const CONTENT_TOOLS_MAX_CHARS = 1_000_000;
export const CONTENT_TOOLS_MAX_ALLOW_LIST = 100;
/** Shortest life a caller may give a redaction (the deployment's `CONTENT_REDACTION_TTL_SECONDS` is the longest). */
export const CONTENT_REDACTION_MIN_TTL_SECONDS = 60;

/** A redaction id as the redact tool returns it. */
export const redactionIdSchema = z.string().regex(/^red_[A-Za-z0-9_-]{16,64}$/, "Not a redaction id");

const inputShape = {
  text: z.string().max(CONTENT_TOOLS_MAX_CHARS).optional(),
  texts: z.array(z.string().max(CONTENT_TOOLS_MAX_CHARS)).max(CONTENT_TOOLS_MAX_TEXTS).optional(),
  value: z.unknown().optional()
};

function exactlyOneInput(value: { text?: unknown; texts?: unknown; value?: unknown }, ctx: z.RefinementCtx): void {
  const given = (["text", "texts", "value"] as const).filter((key) => value[key] !== undefined);
  if (given.length !== 1) ctx.addIssue({ code: "custom", path: [], message: "Give exactly one of text, texts or value" });
}

const scanShape = {
  ...inputShape,
  /** A rule set the toolset makes available (its member's rule set or one bound to the toolset, client or project). */
  rule_set_id: z.string().trim().min(1).max(63).optional(),
  /**
   * Only these data classes (names as rule sets use them). `ip_address`, `person_name`, `location` and `street_address`
   * are scanned only when named here or turned on by the rule set.
   */
  entity_types: z.array(dataClassNameSchema).max(50).optional(),
  /** Values never reported in this call, on top of the rule set's allow-list. */
  allow_list: z.array(z.string().trim().min(1).max(256)).max(CONTENT_TOOLS_MAX_ALLOW_LIST).optional()
};

export const detectSensitiveDataArgsSchema = z.object(scanShape).strict().superRefine(exactlyOneInput);
export type DetectSensitiveDataArgs = z.output<typeof detectSensitiveDataArgsSchema>;

export const redactSensitiveDataArgsSchema = z
  .object({
    ...scanShape,
    style: z.enum(REDACTION_STYLES).default("placeholder"),
    /** Seconds the redaction can be restored; at most the deployment's limit. */
    ttl_seconds: z.number().int().min(CONTENT_REDACTION_MIN_TTL_SECONDS).optional()
  })
  .strict()
  .superRefine(exactlyOneInput);
export type RedactSensitiveDataArgs = z.output<typeof redactSensitiveDataArgsSchema>;

export const restoreSensitiveDataArgsSchema = z
  .object({ ...inputShape, redaction_id: redactionIdSchema.optional() })
  .strict()
  .superRefine(exactlyOneInput);
export type RestoreSensitiveDataArgs = z.output<typeof restoreSensitiveDataArgsSchema>;

const inputJsonSchema = {
  text: { type: "string", description: "One text to process." },
  texts: { type: "array", items: { type: "string" }, maxItems: CONTENT_TOOLS_MAX_TEXTS, description: "Several texts; each gets its own result." },
  value: { description: "Any JSON value; every string in it is processed and the shape is kept." }
} as const;

const scanJsonSchema = {
  ...inputJsonSchema,
  rule_set_id: { type: "string", description: "A rule set this toolset makes available; defaults to the toolset's own." },
  entity_types: { type: "array", items: { type: "string" }, maxItems: 50, description: "Only these data classes, e.g. email, phone, card_number, iban, us_ssn, national_id, credential, private_key, jwt, ip_address. Person names, locations and street addresses (person_name, location, street_address) are found only when named here or turned on by the rule set." },
  allow_list: { type: "array", items: { type: "string" }, maxItems: CONTENT_TOOLS_MAX_ALLOW_LIST, description: "Values never reported in this call." }
} as const;

/** JSON Schemas the gateway lists for the three tools. */
export const CONTENT_RULES_TOOL_INPUT_SCHEMAS: Record<ContentRulesToolName, Record<string, unknown>> = {
  detect_sensitive_data: { type: "object", properties: scanJsonSchema, additionalProperties: false },
  redact_sensitive_data: {
    type: "object",
    properties: {
      ...scanJsonSchema,
      style: { type: "string", enum: [...REDACTION_STYLES], default: "placeholder", description: "placeholder ([EMAIL_1], reversible), token (vault token, reversible), mask, or hash (keyed, one-way)." },
      ttl_seconds: { type: "integer", minimum: CONTENT_REDACTION_MIN_TTL_SECONDS, description: "How long the redaction can be restored; at most the deployment's limit." }
    },
    additionalProperties: false
  },
  restore_sensitive_data: {
    type: "object",
    properties: {
      ...inputJsonSchema,
      redaction_id: { type: "string", description: "The redaction_id the redact tool returned." }
    },
    additionalProperties: false
  }
};

export const CONTENT_RULES_TOOL_DESCRIPTIONS: Record<ContentRulesToolName, string> = {
  detect_sensitive_data:
    "Find sensitive data (emails, phone numbers, payment cards, IBANs, national ids, credentials, keys, tokens and the rule set's own terms) in text or JSON. Returns each finding's data class, position, a masked preview and a score, and a risk level (none, low, medium, high) per input. Values are never returned.",
  redact_sensitive_data:
    "Replace sensitive data in text or JSON. Styles: placeholder ([EMAIL_1], the same value keeps its placeholder), token (vault token), mask, hash (keyed, one-way). Reversible styles return a redaction_id; the mapping stays on the server and expires.",
  restore_sensitive_data:
    "Turn placeholders (with their redaction_id) and vault tokens back into the original values, for the data classes the deployment's reveal rules allow this client. Everything else stays as it is, and the result says which classes were withheld. Every restore is audited."
};

/** One finding as the tools return it: never the value. */
export interface ContentToolFinding {
  dataClass: string;
  /** Where the string is in a JSON `value` input (`$`, `$.a[0]`); absent for `text` and `texts`. */
  path?: string;
  start: number;
  end: number;
  score: number;
  preview: string;
}

export interface ContentToolInputResult {
  index: number;
  riskLevel: "none" | "low" | "medium" | "high";
  findings: ContentToolFinding[];
  /** Findings per data class. */
  counts: Record<string, number>;
}
