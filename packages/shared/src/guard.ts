import { z } from "zod";
import { secretReferenceSchema } from "./schemas";

/**
 * Phase 12.1 — the workflow contract for L2M Guard: the `guard` DAG node,
 * the `guard_protection` provider node, the `guard` and `protection`
 * attachment ports, profile bindings and the shapes the API returns for
 * stored profiles and guard events. The profile document itself is
 * validated by `@ai-orchestrator/guard-sdk`.
 */

export const GUARD_NODE_TYPE = "guard";
export const GUARD_PROTECTION_NODE_TYPE = "guard_protection";

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

export const GUARD_ACTION_VALUES = ["allow", "block", "redact", "mask", "protect", "transform", "require_approval", "review"] as const;
export type GuardActionValue = (typeof GUARD_ACTION_VALUES)[number];

export const GUARD_PROVENANCE_VALUES = ["trusted", "user", "untrusted_external", "sensitive"] as const;

export const PROTECTION_PROVIDER_IDS = ["mask", "keyed_hash", "aes_gcm", "token_vault"] as const;
export type ProtectionProviderIdValue = (typeof PROTECTION_PROVIDER_IDS)[number];

/** Provenance a guard node assumes when it is not told: prompt text is user input, tool results are external. */
export function defaultGuardLabels(channel: GuardChannelValue): Array<(typeof GUARD_PROVENANCE_VALUES)[number]> {
  if (channel === "tool_result") return ["untrusted_external"];
  if (channel === "prompt") return ["user"];
  return [];
}

export const guardNodeConfigSchema = z.object({
  /** A stored profile id, or `effective` for the run's effective profile. */
  profileId: z.string().min(1).default(GUARD_EFFECTIVE_PROFILE_REF),
  /** Inline override merged onto the referenced profile (channels, shadow, latency budget, protection). */
  profileOverride: z.record(z.string(), z.unknown()).optional(),
  /** Channel the content is evaluated as. */
  channel: z.enum(GUARD_CHANNEL_VALUES).default("prompt"),
  /** Dot path of the field to inspect in the incoming item (falls back to run inputs such as `user_prompt`). */
  inputField: z.string().min(1).default("user_prompt"),
  /** Provenance labels; defaults by channel. */
  labels: z.array(z.enum(GUARD_PROVENANCE_VALUES)).optional(),
  /** Shown to the approver when a verdict requires approval. */
  approvalMessage: z.string().optional(),
  timeoutMinutes: z.number().int().positive().max(10_080).default(60)
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
    ctx.addIssue({ code: "custom", path: ["profileId"], message: `Mode '${value.mode}' needs a profile` });
  }
};

export const guardProjectBindingInputSchema = z
  .object({ mode: guardBindingModeSchema, profileId: z.string().min(1).nullish() })
  .superRefine(requireProfileForMode);

export const guardWorkflowBindingInputSchema = z
  .object({ mode: z.enum(["inherit", "override"]), profileId: z.string().min(1).nullish() })
  .superRefine(requireProfileForMode);

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
  level: "project" | "workflow" | "instance" | "port";
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
  source: "enforced" | "workflow" | "project" | "instance" | "none";
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
  id: string;
  executionId: string;
  workflowId?: string | null;
  projectId?: string | null;
  nodeId: string;
  /** Agent loop iteration, when the verdict came from an agent's guard port or automatic profile. */
  iteration?: number | null;
  channel: GuardChannelValue;
  /** Where the guard sat: a DAG guard node, an agent hook, or a delegated worker. */
  placement: "node" | "agent";
  toolName?: string | null;
  detectorId?: string | null;
  category?: string | null;
  dataClass?: string | null;
  score?: number | null;
  requestedAction: GuardActionValue;
  effectiveAction: GuardActionValue;
  /** The verdict's overall action this event belongs to. */
  verdictAction: GuardActionValue;
  shadow: boolean;
  evidence: GuardFindingView[];
  profileId: string;
  profileVersion: number;
  profileHash: string;
  latencyMs: number;
  budgetExceeded: boolean;
  skippedDetectors: string[];
  createdAt: string;
}
