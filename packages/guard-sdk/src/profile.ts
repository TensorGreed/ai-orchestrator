import { createHash } from "node:crypto";
import { z } from "zod";
import { DESTINATION_TIERS, PROVENANCE_LABELS, dataClassNameSchema, mcpPolicyRoleSchema } from "@ai-orchestrator/shared";
import { GUARD_ACTIONS, GUARD_CHANNELS, GuardProfileError, stableStringify, type GuardAction, type GuardChannel } from "./types";

/**
 * Phase 12.1 — guard profiles. A profile is a named, versioned JSON document
 * that says, per channel, which detectors run, at what threshold, and what
 * happens for each finding category or data class. It is validated with zod
 * and serialised with a stable key order and a content hash so it can be
 * stored as policy-as-code and synced through git later.
 */

export const guardActionSchema = z.enum(GUARD_ACTIONS as [GuardAction, ...GuardAction[]]);
export const guardChannelSchema = z.enum(GUARD_CHANNELS as [GuardChannel, ...GuardChannel[]]);

export const actionRuleSchema = z.object({
  action: guardActionSchema,
  /** Observe only: record what would have happened, let the content through unchanged. Overrides the profile-level flag. */
  shadow: z.boolean().optional(),
  /** For `protect`: the provider to use instead of the data-class mapping. */
  providerId: z.string().min(1).optional(),
  /**
   * Phase 12 coverage — how a streamed answer handles this rule.
   * `buffer`: the answer is generated in full and checked before any of it is
   * sent. `window`: a redact, mask or transform rule is applied to each part of
   * the stream as it is released (opt-in; ignored, and the stream buffered,
   * when the rule could apply to a finding that is not local to a stretch of
   * text, such as a key block). Absent: a rewrite rule buffers the stream; any
   * other rule follows the stream's normal mode (whole-answer checks at the end).
   */
  stream: z.enum(["buffer", "window"]).optional()
});

export const detectorEntrySchema = z.object({
  id: z.string().min(1),
  /** Findings below this score are suppressed. */
  threshold: z.number().min(0).max(1).default(0.5),
  options: z.record(z.string(), z.unknown()).default({})
});

export const channelProfileSchema = z.object({
  detectors: z.array(detectorEntrySchema).default([]),
  /** Keyed by finding category or data class. A data class key wins over its category. */
  actions: z.record(z.string(), actionRuleSchema).default({}),
  /** Applies to findings whose category and data class have no entry. */
  defaultAction: actionRuleSchema.default({ action: "block" })
});

export const dictionarySchema = z.object({
  dataClass: z.string().min(1),
  /** Literal terms, matched case-insensitively on word boundaries. */
  terms: z.array(z.string().min(1)).default([]),
  /** Regular expression sources (flags `giu` are applied). */
  patterns: z.array(z.string().min(1)).default([]),
  score: z.number().min(0).max(1).default(0.9)
});

/** Longest custom dictionary pattern a profile may carry. */
export const MAX_DICTIONARY_PATTERN_LENGTH = 256;

/** A group with a quantifier inside, quantified again: `(a+)+`, `(\\w*\\s?)*`, `(x{1,9}){2,}`. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[*+]|\{\d+,?\d*\})(?:[^()\\]|\\.)*\)(?:[*+]|\{\d+,\d*\})/;

/**
 * Why a custom dictionary pattern is refused, or undefined when it is fine:
 * too long, or shaped for catastrophic backtracking (a quantified group that
 * holds a quantifier). Profiles are written by builders, so patterns are
 * refused when saved and skipped at scan time.
 */
export function unsafeDictionaryPattern(pattern: string): string | undefined {
  if (pattern.length > MAX_DICTIONARY_PATTERN_LENGTH) return `Patterns are limited to ${MAX_DICTIONARY_PATTERN_LENGTH} characters`;
  if (NESTED_QUANTIFIER.test(pattern)) return "Nested quantifiers such as (a+)+ can backtrack catastrophically; rewrite the pattern without them";
  return undefined;
}

export const protectionMappingSchema = z.object({
  providerId: z.string().min(1),
  /** Provider-specific settings, such as the key id to use. */
  options: z.record(z.string(), z.unknown()).default({})
});

/** Phase 16 — actions a destination rule may take. `allow` and `transform` make no sense there. */
export const DESTINATION_RULE_ACTIONS = ["block", "redact", "mask", "protect", "require_approval", "review"] as const;
export type DestinationRuleAction = (typeof DESTINATION_RULE_ACTIONS)[number];

/**
 * Phase 16 — a destination rule: when outgoing data carries one of these
 * data classes or provenance labels (any match; no condition means any
 * data), it may only go to destinations within `allow`; otherwise `action`
 * applies. A destination approved to hold a class lets that class through.
 */
export const destinationRuleSchema = z.object({
  when: z
    .object({
      dataClasses: z.array(dataClassNameSchema).max(100).optional(),
      provenance: z.array(z.enum(PROVENANCE_LABELS)).max(PROVENANCE_LABELS.length).optional()
    })
    .default({}),
  allow: z.object({
    maxTier: z.enum(DESTINATION_TIERS),
    /** Region tags or prefixes (`eu` covers `eu-west-1`). Absent: any region. */
    regions: z.array(z.string().trim().min(1).max(64)).max(50).optional()
  }),
  action: z.enum(DESTINATION_RULE_ACTIONS),
  /** Observe only: record what would have happened. Overrides the profile-level shadow flag. */
  shadow: z.boolean().optional(),
  /** Shown in the editor and in verdict reasons. */
  name: z.string().trim().min(1).max(120).optional()
}).superRefine((rule, ctx) => {
  const conditions = (rule.when.dataClasses?.length ?? 0) + (rule.when.provenance?.length ?? 0);
  if (conditions === 0 && (rule.action === "redact" || rule.action === "mask" || rule.action === "protect")) {
    ctx.addIssue({ code: "custom", path: ["action"], message: "Redact, mask and protect need data classes to act on; list them under when, or choose block, review or require_approval" });
  }
});

/**
 * Phase 12 coverage — how untrusted pieces reaching a model are handled.
 * `perDocument`: retrieval nodes check each document and drop blocked ones.
 * `onBlock`: `fail` (the node fails, the default) or `withhold` (the piece is
 * replaced by a marker and the model call goes ahead).
 */
export const RETRIEVAL_ON_BLOCK_VALUES = ["fail", "withhold"] as const;
export type RetrievalOnBlock = (typeof RETRIEVAL_ON_BLOCK_VALUES)[number];

export const retrievalSettingsSchema = z.object({
  perDocument: z.boolean().optional(),
  onBlock: z.enum(RETRIEVAL_ON_BLOCK_VALUES).optional()
});

/** Text that replaces a withheld untrusted piece (`retrieval.onBlock: "withhold"`). */
export const RETRIEVAL_WITHHELD_MARKER = "[content withheld by content rules]";

const idList = z.array(z.string().trim().min(1).max(200)).max(200);

/**
 * Phase 12 coverage — a reveal rule: who may turn tokens of these data
 * classes back into values. Reveal is denied unless a rule matches, so a
 * rule must name at least one subject. `workflows` absent: any workflow.
 * `requireApproval`: a person approves each reveal first. Only an admin may
 * save a rule set with reveal rules, and `roles` / `users` match only runs a
 * signed-in person started (see `revealRuleMatchesSubject` in shared);
 * `serviceAccounts` match explicitly.
 */
export const revealRuleSchema = z
  .object({
    dataClasses: z.array(dataClassNameSchema).min(1).max(100),
    subjects: z.object({
      roles: z.array(mcpPolicyRoleSchema).max(4).optional(),
      users: idList.optional(),
      serviceAccounts: idList.optional()
    }),
    workflows: idList.optional(),
    requireApproval: z.boolean().optional(),
    /** Shown in the editor and in refusal reasons. */
    name: z.string().trim().min(1).max(120).optional()
  })
  .superRefine((rule, ctx) => {
    const subjects = (rule.subjects.roles?.length ?? 0) + (rule.subjects.users?.length ?? 0) + (rule.subjects.serviceAccounts?.length ?? 0);
    if (subjects === 0) {
      ctx.addIssue({ code: "custom", path: ["subjects"], message: "Name at least one role, user or service account; reveal is denied to everyone else" });
    }
  });

export const guardProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  channels: z.partialRecord(guardChannelSchema, channelProfileSchema).default({}),
  /** Per-action shadow mode. A rule's own `shadow` flag overrides it. */
  shadow: z.partialRecord(guardActionSchema, z.boolean()).default({}),
  latencyBudget: z
    .object({
      ms: z.number().int().positive().default(2000),
      onExceeded: z.enum(["fail_open", "fail_closed"]).default("fail_closed")
    })
    .default({ ms: 2000, onExceeded: "fail_closed" }),
  protection: z
    .object({
      /** Data class → provider. */
      dataClasses: z.record(z.string(), protectionMappingSchema).default({}),
      /** When sensitive data has no provider, or the provider fails. */
      fallback: guardActionSchema.default("block")
    })
    .default({ dataClasses: {}, fallback: "block" }),
  dictionaries: z.array(dictionarySchema).default([]),
  /**
   * Spotlighting of untrusted content inside the agent loop: tool results are
   * wrapped in delimiters or datamarked, and the matching system-prompt text
   * is added. Absent means off, so existing profiles keep their hash.
   */
  spotlighting: z
    .object({
      mode: z.enum(["off", "delimiters", "datamark"]).default("delimiters"),
      /** Also add the general prompt-hardening text to the system prompt. */
      hardenSystemPrompt: z.boolean().default(true)
    })
    .optional(),
  /** Plant a canary token in each agent's system prompt and look for it in tool arguments and the final answer. */
  canaries: z.object({ enabled: z.boolean().default(true) }).optional(),
  /**
   * Phase 16 — which provenance labels checks see. `fixed` (or absent):
   * today's labels for each checkpoint (a prompt is user input, a tool result
   * is external). `propagated`: the labels the run tracked for that content
   * (where it really came from), and runs under this profile track labels
   * (stored on node results, data classes scanned). Absent keeps the hash.
   */
  labels: z.enum(["fixed", "propagated"]).optional(),
  /**
   * Phase 16 — where data may go. Absent means no destination checks, so
   * existing profiles keep their hash and behaviour.
   */
  destinations: z.object({ rules: z.array(destinationRuleSchema).max(100).default([]) }).optional(),
  /**
   * Phase 12 coverage — untrusted pieces at the model boundary and retrieved
   * documents. Absent keeps the hash and today's behaviour (no per-document
   * checks; a blocked piece fails the node).
   */
  retrieval: retrievalSettingsSchema.optional(),
  /**
   * Phase 12 coverage — who may reveal protected tokens. Absent (or no
   * rules) means nobody: reveal is denied by default.
   */
  reveal: z.object({ rules: z.array(revealRuleSchema).max(100).default([]) }).optional()
});

export type GuardProfileInput = z.input<typeof guardProfileSchema>;
export type GuardProfile = z.output<typeof guardProfileSchema>;
export type ChannelProfile = z.output<typeof channelProfileSchema>;
export type DetectorEntry = z.output<typeof detectorEntrySchema>;
export type ActionRule = z.output<typeof actionRuleSchema>;
export type GuardDictionary = z.output<typeof dictionarySchema>;
export type DestinationRule = z.output<typeof destinationRuleSchema>;
export type RevealRule = z.output<typeof revealRuleSchema>;
export type RetrievalSettings = z.output<typeof retrievalSettingsSchema>;

/**
 * Phase 16 — the opt-in predicate: a profile that asks for propagated
 * labels, has destination rules or configures the egress channel. A run
 * tracks labels (scans node outputs for data classes, stores labels) only
 * when a profile in its resolved stack satisfies it. The built-in default
 * profile has none of them.
 */
export function profileUsesLabels(profile: Partial<Pick<GuardProfile, "labels" | "destinations" | "channels">> | null | undefined): boolean {
  if (!profile) return false;
  return profile.labels === "propagated" || (profile.destinations?.rules.length ?? 0) > 0 || profile.channels?.egress !== undefined;
}

/**
 * Phase 16 — whether a profile's existing checks see the propagated
 * provenance instead of each checkpoint's fixed labels. Only the explicit
 * switch does this: destination rules read the labels themselves and never
 * change what the other detectors see.
 */
export function profileFeedsPropagatedLabels(profile: Pick<GuardProfile, "labels"> | null | undefined): boolean {
  return profile?.labels === "propagated";
}

/** Phase 16 — the profile checks outbound requests: it configures the egress channel or has destination rules. */
export function profileChecksOutbound(profile: Partial<Pick<GuardProfile, "destinations" | "channels">> | null | undefined): boolean {
  if (!profile) return false;
  return (profile.destinations?.rules.length ?? 0) > 0 || profile.channels?.egress !== undefined;
}

/**
 * Phase 12 coverage — the profile checks what external callers receive
 * (webhook, chat and MCP invoke responses): it configures the `response`
 * channel. The built-in default profile does not.
 */
export function profileChecksResponses(profile: Partial<Pick<GuardProfile, "channels">> | null | undefined): boolean {
  return profile?.channels?.response !== undefined;
}

/** Phase 12 coverage — the profile checks incoming webhook payloads at the route, before dispatch. */
export function profileChecksTriggerInput(profile: Partial<Pick<GuardProfile, "channels">> | null | undefined): boolean {
  return profile?.channels?.trigger_input !== undefined;
}

/** Phase 12 coverage — the profile's reveal rules; empty (deny everything) when it has none. */
export function profileRevealRules(profile: Partial<Pick<GuardProfile, "reveal">> | null | undefined): RevealRule[] {
  return profile?.reveal?.rules ?? [];
}

/** Phase 12 coverage — the profile's retrieval settings with defaults filled: no per-document checks, a block fails. */
export function profileRetrievalSettings(profile: Partial<Pick<GuardProfile, "retrieval">> | null | undefined): Required<RetrievalSettings> {
  return { perDocument: profile?.retrieval?.perDocument ?? false, onBlock: profile?.retrieval?.onBlock ?? "fail" };
}

/** Phase 12 coverage — rules on this channel ask a streamed answer to be generated in full before any of it is sent. */
export function channelRequestsBufferedStream(channel: Pick<ChannelProfile, "actions" | "defaultAction"> | undefined): boolean {
  if (!channel) return false;
  return channel.defaultAction.stream === "buffer" || Object.values(channel.actions).some((rule) => rule.stream === "buffer");
}

/** Validate and fill defaults. Throws `GuardProfileError` with every issue listed. */
export function parseGuardProfile(document: unknown): GuardProfile {
  const result = guardProfileSchema.safeParse(document);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new GuardProfileError(`Invalid rule set: ${issues.join("; ")}`);
  }
  if (result.data.protection.fallback === "protect") {
    throw new GuardProfileError("Invalid rule set: protection.fallback cannot be 'protect'");
  }
  return result.data;
}

/** Stable JSON: sorted keys, two-space indent, trailing newline. Byte-identical for equal profiles. */
export function serializeGuardProfile(profile: GuardProfile): string {
  const parsed = parseGuardProfile(profile);
  return `${JSON.stringify(JSON.parse(stableStringify(parsed)), null, 2)}\n`;
}

/** SHA-256 of the stable serialisation, hex. Two profiles with the same meaning share a hash. */
export function hashGuardProfile(profile: GuardProfile): string {
  return createHash("sha256").update(serializeGuardProfile(profile)).digest("hex");
}

export function parseSerializedGuardProfile(text: string): GuardProfile {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new GuardProfileError(`Invalid rule set: not JSON (${(error as Error).message})`);
  }
  return parseGuardProfile(document);
}
