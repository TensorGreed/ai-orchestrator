import { z } from "zod";
import { secretReferenceSchema } from "./schemas";
import { PROVENANCE_LABELS, GATEWAY_GUARD_CUSTOM_DATA_KEY, dataClassNameSchema } from "./data-labels";

/**
 * Phase 12.1 — the workflow contract for content rules: the `guard` DAG node,
 * the `guard_protection` provider node, the `guard` and `protection`
 * attachment ports, profile bindings and the shapes the API returns for
 * stored profiles and guard events. The profile document itself is
 * validated by `@ai-orchestrator/guard-sdk`.
 */

export const GUARD_NODE_TYPE = "guard";
export const GUARD_PROTECTION_NODE_TYPE = "guard_protection";
/** Phase 12 coverage — the Reveal node: turns protection tokens back into values, as the rule set's reveal rules allow. */
export const GUARD_REVEAL_NODE_TYPE = "guard_reveal";

/** Output handles of a guard node on DAG edges. */
export const GUARD_OUTPUT_HANDLES = ["pass", "blocked", "review"] as const;
export type GuardOutputHandle = (typeof GUARD_OUTPUT_HANDLES)[number];

/** Agent / Supervisor attachment port that takes one guard node (0..1). */
export const GUARD_ATTACHMENT_HANDLE = "guard";
/** Guard node attachment port that takes protection provider nodes (0..N). */
export const PROTECTION_ATTACHMENT_HANDLE = "protection";

/** Profile reference meaning "the run's effective profile" (bindings, then the built-in default). */
export const GUARD_EFFECTIVE_PROFILE_REF = "effective";
/** Id of the built-in, read-only default profile. */
export const GUARD_BUILTIN_PROFILE_ID = "default";

export const GUARD_CHANNEL_VALUES = ["prompt", "model_output", "tool_arguments", "tool_result", "final_output"] as const;
export type GuardChannelValue = (typeof GUARD_CHANNEL_VALUES)[number];

/**
 * Phase 16 — channels a guard profile may configure: the Guard node's
 * channels plus `egress` (outbound HTTP, connectors and senders), which the
 * engine checks itself and a Content Rules node never evaluates. Phase 12 coverage
 * adds `response` (what an external caller receives) and `trigger_input` (an
 * incoming webhook payload, checked at the route); a node never offers them.
 */
export const GUARD_PROFILE_CHANNEL_VALUES = [...GUARD_CHANNEL_VALUES, "egress", "response", "trigger_input"] as const;
export type GuardProfileChannelValue = (typeof GUARD_PROFILE_CHANNEL_VALUES)[number];

/**
 * Where a rule event was recorded. `node`: a Content Rules node; `agent`: an
 * agent hook or delegated worker; `gateway`: the MCP or `/v1` gateway.
 * Phase 12 coverage: `response` (the run-end check of what an external caller
 * receives), `retrieval` (untrusted pieces and documents at the model
 * boundary) and `reveal` (tokens turned back into values).
 */
/**
 * Phase 12 coverage — checks the Output Guardrail node offers. `matches_schema`
 * validates against the node's `schema` (only parses JSON without one);
 * `topic`, `safety` and `grounding` run the output checks of the content rules.
 */
export const OUTPUT_GUARDRAIL_CHECK_VALUES = ["no_pii", "no_profanity", "must_contain_json", "matches_schema", "topic", "safety", "grounding"] as const;
export type OutputGuardrailCheckValue = (typeof OUTPUT_GUARDRAIL_CHECK_VALUES)[number];

/** Phase 12 coverage — content safety categories (the `output.safety` check). */
export const CONTENT_SAFETY_CATEGORY_VALUES = ["self_harm", "violence", "sexual", "sexual_minors", "hate"] as const;
export type ContentSafetyCategoryValue = (typeof CONTENT_SAFETY_CATEGORY_VALUES)[number];

export const GUARD_PLACEMENT_VALUES = ["node", "agent", "gateway", "response", "retrieval", "reveal"] as const;
export type GuardPlacementValue = (typeof GUARD_PLACEMENT_VALUES)[number];

/** A stored placement read back; unknown values read as `node`, as before. */
export function parseGuardPlacement(value: unknown): GuardPlacementValue {
  return typeof value === "string" && (GUARD_PLACEMENT_VALUES as readonly string[]).includes(value) ? (value as GuardPlacementValue) : "node";
}

export const GUARD_ACTION_VALUES = ["allow", "block", "redact", "mask", "protect", "transform", "require_approval", "review"] as const;
export type GuardActionValue = (typeof GUARD_ACTION_VALUES)[number];

/**
 * Phase 12 coverage — actions a rule event can carry: every rule action plus `reveal` (a Reveal node turned tokens
 * back into values). `reveal` is never a rule action a rule set author picks; only the Reveal node records it.
 */
export const GUARD_EVENT_ACTION_VALUES = [...GUARD_ACTION_VALUES, "reveal"] as const;
export type GuardEventActionValue = (typeof GUARD_EVENT_ACTION_VALUES)[number];

/** Phase 12 coverage — channels a rule event can carry: the rule set channels plus `reveal` (a Reveal node's events). */
export const GUARD_EVENT_CHANNEL_VALUES = [...GUARD_PROFILE_CHANNEL_VALUES, "reveal"] as const;
export type GuardEventChannelValue = (typeof GUARD_EVENT_CHANNEL_VALUES)[number];

/** Phase 15.6: the list lives in data-labels.ts. */
export const GUARD_PROVENANCE_VALUES = PROVENANCE_LABELS;

export const PROTECTION_PROVIDER_IDS = ["mask", "keyed_hash", "aes_gcm", "token_vault", "surrogate"] as const;
export type ProtectionProviderIdValue = (typeof PROTECTION_PROVIDER_IDS)[number];

/** Phase 16 — protection providers whose tokens cannot be turned back into the value. */
export const ONE_WAY_PROTECTION_PROVIDER_IDS: ReadonlySet<ProtectionProviderIdValue> = new Set(["mask", "keyed_hash", "surrogate"]);

/** Phase 16 — what a request to reveal a surrogate answers (400). */
export const SURROGATE_REVEAL_REFUSED_MESSAGE = "Surrogates are one-way; use the token vault if you need the original back";

/** Provenance a guard node assumes when it is not told: prompt text is user input, tool results are external. */
export function defaultGuardLabels(channel: GuardChannelValue): Array<(typeof GUARD_PROVENANCE_VALUES)[number]> {
  if (channel === "tool_result") return ["untrusted_external"];
  if (channel === "prompt") return ["user"];
  return [];
}

export const guardNodeConfigSchema = z.object({
  /** A stored profile id, or `effective` for the run's effective profile. */
  profileId: z.string().min(1).default(GUARD_EFFECTIVE_PROFILE_REF),
  /**
   * Inline override merged onto the referenced profile (channels, shadow, latency budget, protection). Reveal rules
   * are refused here: only a stored rule set may carry them.
   */
  profileOverride: z
    .record(z.string(), z.unknown())
    .refine((value) => !Object.prototype.hasOwnProperty.call(value, "reveal"), {
      message: "Reveal rules can only be set on a stored rule set, not in a node's inline override"
    })
    .optional(),
  /** Channel the content is evaluated as. */
  channel: z.enum(GUARD_CHANNEL_VALUES).default("prompt"),
  /** Dot path of the field to inspect in the incoming item (falls back to run inputs such as `user_prompt`). */
  inputField: z.string().min(1).default("user_prompt"),
  /** Provenance labels; defaults by channel. */
  labels: z.array(z.enum(GUARD_PROVENANCE_VALUES)).optional(),
  /** Shown to the approver when a verdict requires approval. */
  approvalMessage: z.string().optional(),
  /** Phase 11.2 — enforced: an undecided hand-off is rejected after this long (default one day). */
  timeoutMinutes: z.number().int().positive().max(10_080).default(1_440)
});
export type GuardNodeConfig = z.output<typeof guardNodeConfigSchema>;

export const guardProtectionNodeConfigSchema = z
  .object({
    providerId: z.enum(PROTECTION_PROVIDER_IDS),
    /** Data classes the provider covers, or `*`. */
    dataClasses: z.union([z.literal("*"), z.array(z.string().min(1)).min(1)]),
    /** Key for keyed hashing, encryption and deterministic tokens; resolved through the secret store. */
    keySecretRef: secretReferenceSchema.optional(),
    deterministic: z.boolean().optional(),
    formatPreserving: z.boolean().optional(),
    /** Tokenise these classes wherever the profile would allow, mask or redact them. Never loosens a block. */
    protectMatches: z.boolean().default(true)
  })
  .superRefine((value, ctx) => {
    const needsKey = value.providerId === "keyed_hash" || value.providerId === "aes_gcm" || (value.providerId === "token_vault" && value.deterministic === true);
    if (needsKey && !value.keySecretRef) {
      ctx.addIssue({ code: "custom", path: ["keySecretRef"], message: `${value.providerId}${value.deterministic ? " (deterministic)" : ""} needs a key secret` });
    }
  });
export type GuardProtectionNodeConfig = z.output<typeof guardProtectionNodeConfigSchema>;

export const guardBindingModeSchema = z.enum(["inherit", "override", "enforced"]);
export type GuardBindingMode = z.output<typeof guardBindingModeSchema>;

const requireProfileForMode = (value: { mode: string; profileId?: string | null }, ctx: z.RefinementCtx) => {
  if (value.mode !== "inherit" && !value.profileId) {
    ctx.addIssue({ code: "custom", path: ["profileId"], message: `Mode '${value.mode}' needs a rule set` });
  }
};

export const guardProjectBindingInputSchema = z
  .object({ mode: guardBindingModeSchema, profileId: z.string().min(1).nullish() })
  .superRefine(requireProfileForMode);

export const guardWorkflowBindingInputSchema = z
  .object({ mode: z.enum(["inherit", "override"]), profileId: z.string().min(1).nullish() })
  .superRefine(requireProfileForMode);

/**
 * 12.6 — a gateway toolset's or MCP client's Guard binding: `inherit` (none) or `override` with a profile. Admin-only;
 * a toolset or client can never enforce (its toolset's project enforces).
 */
export const guardGatewayBindingInputSchema = z
  .object({ mode: z.enum(["inherit", "override"]), profileId: z.string().min(1).nullish() })
  .superRefine(requireProfileForMode);

/** 12.6 — the gateway scopes a Guard binding can name. */
export const GUARD_GATEWAY_BINDING_SCOPES = ["toolset", "mcp_client"] as const;
export type GuardGatewayBindingScope = (typeof GUARD_GATEWAY_BINDING_SCOPES)[number];

/**
 * 12.6 — one profile of a gateway Guard stack, pinned to the version that applied (the toolset's project enforced
 * profile, the toolset's, the client's). A workflow tool's run carries these, tighten-only on top of its own profiles,
 * and records them, so a retry or replay of that run applies the same versions.
 */
export interface GatewayGuardProfileRef {
  profileId: string;
  version: number;
  level: "project" | "toolset" | "mcp_client";
}

/** 12.6 — the gateway Guard stack a workflow tool's run started with (recorded on the run). */
export interface GatewayGuardStack {
  toolsetId: string;
  clientId: string;
  profiles: GatewayGuardProfileRef[];
}

/** 12.6 — reads a recorded gateway Guard stack; null when it is missing or malformed. */
export function parseGatewayGuardStack(value: unknown): GatewayGuardStack | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.toolsetId !== "string" || typeof record.clientId !== "string" || !Array.isArray(record.profiles)) return null;
  const profiles: GatewayGuardProfileRef[] = [];
  for (const entry of record.profiles.slice(0, 8)) {
    if (!entry || typeof entry !== "object") return null;
    const ref = entry as Record<string, unknown>;
    const level = ref.level;
    if (typeof ref.profileId !== "string" || !ref.profileId || typeof ref.version !== "number" || !Number.isInteger(ref.version) || ref.version < 1) return null;
    if (level !== "project" && level !== "toolset" && level !== "mcp_client") return null;
    profiles.push({ profileId: ref.profileId, version: ref.version, level });
  }
  if (profiles.length === 0) return null;
  return { toolsetId: record.toolsetId, clientId: record.clientId, profiles };
}

/** 12.6 — `{ gatewayGuard }` for a stored value that is a valid gateway Guard stack, `{}` otherwise (for spreading). */
export function gatewayGuardField(value: unknown): { gatewayGuard?: GatewayGuardStack } {
  const gatewayGuard = parseGatewayGuardStack(value);
  return gatewayGuard ? { gatewayGuard } : {};
}

export const guardProfileCreateSchema = z.object({
  /** Stable id (lowercase letters, digits, dashes and underscores). Taken from the document when omitted. */
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{1,62}$/, "Use 2–63 lowercase letters, digits, dashes or underscores")
    .optional(),
  document: z.record(z.string(), z.unknown()),
  note: z.string().max(500).optional()
});

export const guardProfileUpdateSchema = z.object({
  document: z.record(z.string(), z.unknown()),
  note: z.string().max(500).optional()
});

export interface GuardProfileSummary {
  id: string;
  name: string;
  description?: string;
  builtIn: boolean;
  /** Phase 15.6 — a project enforces this profile (only admins may change or simulate it). */
  enforced?: boolean;
  latestVersion: number;
  hash: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string | null;
}

export interface GuardProfileVersionView {
  profileId: string;
  version: number;
  hash: string;
  document: Record<string, unknown>;
  author?: string | null;
  note?: string | null;
  createdAt: string;
}

/** One level of the binding chain, as the UI and run traces show it. */
export interface GuardBindingLevel {
  /** `candidate` (Phase 15.3): a replay's guard profile override. `destinations` (Phase 16): the deployment's destination rules. */
  level: "project" | "workflow" | "instance" | "port" | "candidate" | "destinations" | "toolset" | "mcp_client" | "gateway";
  mode: GuardBindingMode | "auto" | "off";
  profileId?: string | null;
  version?: number | null;
}

export interface GuardProfileRef {
  profileId: string;
  version: number;
  hash: string;
  name?: string;
}

/** The profiles applied to agent traffic for a workflow run, in evaluation order. */
export interface GuardResolutionView {
  /** Where the effective profile came from. */
  source: "enforced" | "workflow" | "project" | "instance" | "candidate" | "toolset" | "mcp_client" | "none";
  enforced?: GuardProfileRef | null;
  /** Profiles evaluated in order; the enforced one always first. */
  stack: GuardProfileRef[];
  chain: GuardBindingLevel[];
}

export interface GuardFindingView {
  detectorId: string;
  category: string;
  dataClass?: string;
  score: number;
  evidence: string;
  spans: Array<{ start: number; end: number }>;
  message: string;
}

export interface GuardEventView {
  /** Rows of one verdict share this id (one row per applied action; one row for a clean verdict). */
  verdictId: string;
  id: string;
  executionId: string;
  workflowId?: string | null;
  projectId?: string | null;
  nodeId: string;
  /** Agent loop iteration, when the verdict came from an agent's guard port or automatic profile. */
  iteration?: number | null;
  /** Phase 16: `egress` for the outbound checkpoint (HTTP, connectors, senders). Phase 12 coverage: `reveal` for a Reveal node's events. */
  channel: GuardEventChannelValue;
  /**
   * Where the guard sat: a DAG guard node, an agent hook, or a delegated worker. 12.6 — `gateway`: a server tool called
   * through the MCP gateway (`executionId` is the call's `mcpgw_*` id, `nodeId` the tool name, no workflow).
   * Phase 12 coverage — `response`, `retrieval` and `reveal` (see `GUARD_PLACEMENT_VALUES`).
   */
  placement: GuardPlacementValue;
  toolName?: string | null;
  detectorId?: string | null;
  category?: string | null;
  dataClass?: string | null;
  score?: number | null;
  /** Phase 12 coverage — `reveal` on a Reveal node's events (a refused reveal records `block` as its effective action). */
  requestedAction: GuardEventActionValue;
  effectiveAction: GuardEventActionValue;
  /** The verdict's overall action this event belongs to. */
  verdictAction: GuardEventActionValue;
  shadow: boolean;
  evidence: GuardFindingView[];
  profileId: string;
  profileVersion: number;
  profileHash: string;
  latencyMs: number;
  budgetExceeded: boolean;
  skippedDetectors: string[];
  createdAt: string;
  /** 12.7 — `eval`: recorded by an eval run or a replay job (left out of the Security page unless asked for). */
  runSource?: "eval";
}

/**
 * Phase 12 coverage — reveal rules (user decision 2026-11-10).
 *
 * - Authorship: only an admin may save (create, import or update) a rule set whose document carries reveal rules.
 * - Matching: a rule's `roles` and `users` match only runs started by a signed-in person (subject source `user`).
 *   Webhook, chat, schedule and other unattended runs act as the workflow owner (source `owner`), so a role or user
 *   rule never matches them. `serviceAccounts` match the named service account explicitly, whatever started the run.
 * - `workflows`, when set, limits the rule to those workflows. Data classes must match exactly.
 * The rule set schema itself (`revealRuleSchema`) lives in `@ai-orchestrator/guard-sdk`.
 */

/** What a builder sees when saving a rule set with reveal rules (403). */
export const REVEAL_RULES_ADMIN_ONLY_MESSAGE = "Only an admin can save a rule set with reveal rules";

/** True when a rule set document (as submitted, before validation) carries at least one reveal rule. */
export function guardDocumentHasRevealRules(document: unknown): boolean {
  if (!document || typeof document !== "object" || Array.isArray(document)) return false;
  const reveal = (document as Record<string, unknown>).reveal;
  if (!reveal || typeof reveal !== "object" || Array.isArray(reveal)) return false;
  const rules = (reveal as Record<string, unknown>).rules;
  return Array.isArray(rules) && rules.length > 0;
}

/** The subject a reveal is judged for: the run subject, plus the service account a run acts as, when it has one. */
export interface RevealSubject {
  /** `user`: a signed-in person started the run. Anything else is unattended (owner, fallback, client, ...). */
  source: string;
  role?: string;
  userId?: string | null;
  serviceAccountId?: string | null;
}

/** The parts of a reveal rule the match reads (structurally the guard-sdk `RevealRule`). */
export interface RevealRuleLike {
  dataClasses: readonly string[];
  subjects: { roles?: readonly string[]; users?: readonly string[]; serviceAccounts?: readonly string[] };
  workflows?: readonly string[];
}

/** Whether a reveal rule names this subject: role and user only for runs a signed-in person started; service accounts explicitly. */
export function revealRuleMatchesSubject(rule: RevealRuleLike, subject: RevealSubject | null | undefined): boolean {
  if (!subject) return false;
  if (subject.serviceAccountId && (rule.subjects.serviceAccounts ?? []).includes(subject.serviceAccountId)) return true;
  if (subject.source !== "user") return false;
  if (subject.userId && (rule.subjects.users ?? []).includes(subject.userId)) return true;
  return Boolean(subject.role && (rule.subjects.roles ?? []).includes(subject.role));
}

/** Whether a reveal rule allows revealing this data class for this subject in this workflow. */
export function revealRuleAllows(rule: RevealRuleLike, request: { subject: RevealSubject | null | undefined; dataClass: string; workflowId?: string | null }): boolean {
  if (!rule.dataClasses.includes(request.dataClass)) return false;
  if (rule.workflows && rule.workflows.length > 0 && !(request.workflowId && rule.workflows.includes(request.workflowId))) return false;
  return revealRuleMatchesSubject(rule, request.subject);
}

/** The first rule that allows the reveal, or undefined: reveal is denied unless a rule matches. */
export function findRevealRule<T extends RevealRuleLike>(rules: readonly T[], request: { subject: RevealSubject | null | undefined; dataClass: string; workflowId?: string | null }): T | undefined {
  return rules.find((rule) => revealRuleAllows(rule, request));
}

/**
 * Phase 12 coverage — the reveal subject of a run: who started it, as the reveal rules see it. `serviceAccountId`
 * marks a run a service account started; such a run matches only rules that name the service account, never a role
 * or user rule.
 */
export function revealSubjectOf(
  subject: { source: string; role?: string; userId?: string; email?: string; serviceAccountId?: string } | null | undefined
): RevealSubject | undefined {
  if (!subject) return undefined;
  if (subject.serviceAccountId) return { source: "service_account", serviceAccountId: subject.serviceAccountId };
  // A service account's sign-in address is `…@service.invalid`: such a subject is a service account even when the
  // id was not carried over (a run paused before the subject recorded it), so it never matches a role or user rule.
  if (subject.email && /@service\.invalid$/i.test(subject.email.trim())) {
    return subject.userId ? { source: "service_account", serviceAccountId: subject.userId } : { source: "service_account" };
  }
  return { source: subject.source, ...(subject.role ? { role: subject.role } : {}), ...(subject.userId ? { userId: subject.userId } : {}) };
}

/** Phase 12 coverage — a signed-in admin started the run: only such a run may reveal tokens issued before tokens were scoped to a project. */
export function revealSubjectIsAdmin(subject: RevealSubject | null | undefined): boolean {
  return Boolean(subject && subject.source === "user" && subject.role === "admin" && !subject.serviceAccountId);
}

/** Phase 12 coverage — the detector id and category a Reveal node's rule events carry. */
export const REVEAL_EVENT_DETECTOR_ID = "reveal";

/**
 * Phase 12 coverage — the Reveal node (a DAG step). It reads one field of the incoming item and turns the protection
 * tokens in it back into values, for the data classes a reveal rule allows the run's subject. Reveal is denied unless
 * a rule matches. Revealed values carry the `sensitive` label and their data class again, so destination rules and
 * outbound checks decide where they may go next.
 */
export const guardRevealNodeConfigSchema = z.object({
  /** The stored rule set whose reveal rules apply, or `effective` for the run's rule sets (enforced and bound). */
  profileId: z.string().min(1).default(GUARD_EFFECTIVE_PROFILE_REF),
  /** Dot path of the field to reveal in the incoming item (falls back to run inputs). */
  inputField: z.string().min(1).default("text"),
  /**
   * Keys (secret ids) of encrypted values (`enc:` tokens) this node may decrypt. Empty: encrypted values stay as they
   * are. Token vault tokens need no key.
   */
  keySecretRefs: z.array(secretReferenceSchema).max(10).default([]),
  /**
   * Data classes whose format-preserving vault tokens (they look like real values, such as a Luhn-valid card number)
   * are looked for. Empty: only `tok_` tokens are found.
   */
  formatPreservingClasses: z.array(dataClassNameSchema).max(20).default([]),
  /** A token the rules do not allow: `keep` leaves it in place (default), `fail` fails the node. */
  onRefused: z.enum(["keep", "fail"]).default("keep"),
  /** Shown to the approver when a matching rule asks for approval. */
  approvalMessage: z.string().max(2000).optional(),
  /** An undecided approval is rejected after this long (default one day). */
  timeoutMinutes: z.number().int().positive().max(10_080).default(1_440)
});
export type GuardRevealNodeConfig = z.output<typeof guardRevealNodeConfigSchema>;

/** Phase 12 coverage — why a token was not revealed. */
export const REVEAL_REFUSAL_REASONS = ["no_rule", "other_project", "unscoped_token", "unknown_token", "key_not_allowed", "not_decryptable"] as const;
export type RevealRefusalReason = (typeof REVEAL_REFUSAL_REASONS)[number];

/** Phase 12 coverage — what a Reveal node reports per data class (counts and token hashes, never values). */
export interface RevealClassSummary {
  /** Absent when the class could not be told (an encrypted value no allowed class opens, or an unknown token). */
  dataClass?: string;
  count: number;
  /** First 16 hex characters of the sha256 of each token, at most 50. */
  tokenHashes: string[];
  /** Set on refused entries. */
  reason?: RevealRefusalReason;
  /** The rule set and rule that allowed it, on revealed entries. */
  rule?: { profileId: string; version: number; index: number; name?: string };
}

/** Phase 12 coverage — the `reveal` field of a Reveal node's output. */
export interface RevealNodeSummary {
  field: string;
  revealed: RevealClassSummary[];
  refused: RevealClassSummary[];
  /** A replay, eval run or rule simulation: nothing was revealed and the input passed through. */
  skipped?: "replay";
  /** A person approved this reveal (a matching rule asked for approval). */
  approved?: boolean;
}
