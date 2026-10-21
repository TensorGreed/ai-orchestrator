import { randomBytes } from "node:crypto";
import type { AgentGuardCheck, AgentGuardDecision, AgentGuardHooks } from "@ai-orchestrator/agent-runtime";
import {
  applyProtectionBindings,
  canaryInstruction,
  createDefaultGuardProfile,
  createDefaultGuardRegistry,
  createDefaultProtectionRegistry,
  datamark,
  decodeGuardKeyMaterial,
  DEFAULT_DATAMARK,
  evaluateGuardStack,
  generateCanaryToken,
  hashGuardProfile,
  mergeGuardProfileOverride,
  PROMPT_HARDENING_TEXT,
  spotlightingSystemPrompt,
  summarizeGuardVerdict,
  wrapWithDelimiters,
  type GuardAction,
  type GuardChannel,
  type GuardInput,
  type GuardProfile,
  type GuardRegistry,
  type GuardToolContext,
  type GuardVerdictSummary,
  type ProtectionBinding,
  type ProvenanceLabel,
  type TokenVaultStorage
} from "@ai-orchestrator/guard-sdk";
import {
  GUARD_BUILTIN_PROFILE_ID,
  GUARD_EFFECTIVE_PROFILE_REF,
  defaultGuardLabels,
  guardNodeConfigSchema,
  guardProtectionNodeConfigSchema,
  type GuardBindingLevel,
  type GuardNodeConfig,
  type GuardProfileRef,
  type McpToolPolicySubject,
  type SecretReference,
  type WorkflowNode
} from "@ai-orchestrator/shared";
import { approvedHandoffKeys, type ApprovalHandoffRequest } from "./approval-handoff";

/**
 * Phase 12.1 — guard wiring in the engine. Detection lives in
 * `@ai-orchestrator/guard-sdk`; this module resolves which profiles apply,
 * folds in protection-port providers with keys from the secret store, runs
 * the evaluation, records verdicts through `onVerdict`, and translates a
 * verdict into what the guard node routes or what the agent loop does.
 */

export interface ResolvedGuardProfile extends GuardProfileRef {
  profile: GuardProfile;
}

/** Profiles that apply to a run's agent traffic, resolved by the API from project and workflow bindings. */
export interface GuardRunResolution {
  source: "enforced" | "workflow" | "project" | "instance" | "none";
  /** The project's enforced profile; always evaluated first and never replaced. */
  enforced?: ResolvedGuardProfile;
  /** Evaluated in order for agents without a guard port (enforced first when set). Empty = no automatic guard. */
  stack: ResolvedGuardProfile[];
  chain: GuardBindingLevel[];
}

export interface GuardVerdictEvent {
  executionId: string;
  workflowId: string;
  nodeId: string;
  placement: "node" | "agent";
  iteration?: number;
  channel: GuardChannel;
  toolName?: string;
  profile: GuardProfileRef;
  verdict: GuardVerdictSummary;
}

export interface GuardRuntimeDependencies {
  /** Detector registry; `createDefaultGuardRegistry()` when omitted. */
  registry?: GuardRegistry;
  resolveRun(): Promise<GuardRunResolution> | GuardRunResolution;
  /** A stored profile's latest version (the built-in `default` included). */
  loadProfile(profileId: string): Promise<ResolvedGuardProfile | undefined> | ResolvedGuardProfile | undefined;
  /** Token vault storage; persisted and encrypted by the API. */
  vault?: TokenVaultStorage;
  onVerdict?(event: GuardVerdictEvent): Promise<void> | void;
}

export interface GuardEvalScope {
  guard: GuardRuntimeDependencies;
  resolveSecret: (secretRef?: SecretReference) => Promise<string | undefined>;
  executionId: string;
  workflowId: string;
  nodeId: string;
  placement: "node" | "agent";
  subject?: McpToolPolicySubject;
  logger?: (message: string, metadata?: unknown) => void;
}

export interface GuardCheckResult {
  action: GuardAction;
  content: unknown;
  transformed: boolean;
  verdicts: Array<{ profile: GuardProfileRef; summary: GuardVerdictSummary }>;
}

export class GuardBlockedError extends Error {
  readonly verdicts: GuardCheckResult["verdicts"];
  constructor(message: string, verdicts: GuardCheckResult["verdicts"]) {
    super(message);
    this.name = "GuardBlockedError";
    this.verdicts = verdicts;
  }
}

export function isGuardBlockedError(error: unknown): error is GuardBlockedError {
  return error instanceof GuardBlockedError;
}

let defaultRegistry: GuardRegistry | undefined;
const resolutionCache = new WeakMap<GuardRuntimeDependencies, Promise<GuardRunResolution>>();

/** The run's resolution, computed once per dependencies object (one per run). */
export function resolveGuardRun(guard: GuardRuntimeDependencies): Promise<GuardRunResolution> {
  let cached = resolutionCache.get(guard);
  if (!cached) {
    cached = Promise.resolve(guard.resolveRun());
    resolutionCache.set(guard, cached);
  }
  return cached;
}

export function builtInGuardProfile(): ResolvedGuardProfile {
  const profile = createDefaultGuardProfile();
  return { profileId: GUARD_BUILTIN_PROFILE_ID, version: 1, hash: hashGuardProfile(profile), name: profile.name, profile };
}

export function guardProfileRef(resolved: ResolvedGuardProfile): GuardProfileRef {
  return { profileId: resolved.profileId, version: resolved.version, hash: resolved.hash, ...(resolved.name ? { name: resolved.name } : {}) };
}

function withProfile(base: ResolvedGuardProfile, profile: GuardProfile): ResolvedGuardProfile {
  return { ...base, profile, hash: hashGuardProfile(profile) };
}

function dedupeByHash(profiles: ResolvedGuardProfile[]): ResolvedGuardProfile[] {
  const seen = new Set<string>();
  return profiles.filter((entry) => (seen.has(entry.hash) ? false : (seen.add(entry.hash), true)));
}

async function loadProfileOrThrow(guard: GuardRuntimeDependencies, profileId: string): Promise<ResolvedGuardProfile> {
  if (profileId === GUARD_BUILTIN_PROFILE_ID) {
    return (await guard.loadProfile(profileId)) ?? builtInGuardProfile();
  }
  const loaded = await guard.loadProfile(profileId);
  if (!loaded) throw new Error(`Guard profile '${profileId}' does not exist. Pick a stored profile on the Guard node.`);
  return loaded;
}

/** Protection-port providers as profile bindings; key ids are secret ids resolved at use. */
export function protectionBindingsFromNodes(nodes: WorkflowNode[]): ProtectionBinding[] {
  const bindings: ProtectionBinding[] = [];
  for (const node of nodes) {
    if (node.type !== "guard_protection" || node.disabled === true) continue;
    const parsed = guardProtectionNodeConfigSchema.safeParse(node.config ?? {});
    if (!parsed.success) {
      throw new Error(`Protection Provider '${node.name}' is misconfigured: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    }
    const config = parsed.data;
    bindings.push({
      providerId: config.providerId,
      dataClasses: config.dataClasses,
      ...(config.keySecretRef ? { keyId: config.keySecretRef.secretId } : {}),
      options: {
        ...(config.deterministic !== undefined ? { deterministic: config.deterministic } : {}),
        ...(config.formatPreserving !== undefined ? { formatPreserving: config.formatPreserving } : {})
      },
      protectMatches: config.protectMatches
    });
  }
  return bindings;
}

export function parseGuardNodeConfig(node: WorkflowNode): GuardNodeConfig {
  const parsed = guardNodeConfigSchema.safeParse(node.config ?? {});
  if (!parsed.success) {
    throw new Error(`Guard '${node.name}' is misconfigured: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}

/**
 * The profiles a guard node evaluates. The enforced project profile always
 * comes first; the node's own profile (or the effective one), its inline
 * override and its protection providers are added after it, so a node can
 * tighten an enforced profile but never replace it.
 */
export async function resolveGuardNodeProfiles(
  guard: GuardRuntimeDependencies,
  config: Pick<GuardNodeConfig, "profileId" | "profileOverride">,
  protection: ProtectionBinding[]
): Promise<{ profiles: ResolvedGuardProfile[]; resolution: GuardRunResolution }> {
  const resolution = await resolveGuardRun(guard);
  const enforced = resolution.enforced;
  let own: ResolvedGuardProfile[];
  if (config.profileId === GUARD_EFFECTIVE_PROFILE_REF) {
    own = resolution.stack.length > 0 ? resolution.stack.filter((entry) => entry.hash !== enforced?.hash) : enforced ? [] : [await loadProfileOrThrow(guard, GUARD_BUILTIN_PROFILE_ID)];
  } else {
    own = [await loadProfileOrThrow(guard, config.profileId)];
  }
  const customise = config.profileOverride && Object.keys(config.profileOverride).length > 0;
  if ((customise || protection.length > 0) && own.length === 0 && enforced) {
    // Only the enforced profile applies: tighten a copy of it, evaluated after the original.
    own = [enforced];
  }
  own = own.map((entry) => {
    let profile = entry.profile;
    if (customise) profile = mergeGuardProfileOverride(profile, config.profileOverride);
    if (protection.length > 0) profile = applyProtectionBindings(profile, protection);
    return profile === entry.profile ? entry : withProfile(entry, profile);
  });
  const profiles = enforced ? [enforced, ...own] : own;
  return { profiles: dedupeByHash(profiles), resolution };
}

function keyResolverFor(scope: GuardEvalScope) {
  return async (keyId: string) => decodeGuardKeyMaterial(await scope.resolveSecret({ secretId: keyId }));
}

/** Evaluate content against profiles in order, record each verdict and return the combined result. */
export async function runGuardCheck(
  scope: GuardEvalScope,
  profiles: ResolvedGuardProfile[],
  input: GuardInput,
  meta: { iteration?: number; toolName?: string } = {}
): Promise<GuardCheckResult> {
  const registry = scope.guard.registry ?? (defaultRegistry ??= createDefaultGuardRegistry());
  const protection = createDefaultProtectionRegistry({ keys: keyResolverFor(scope), ...(scope.guard.vault ? { vault: scope.guard.vault } : {}) });
  const subject = scope.subject ? { role: scope.subject.role, ...(scope.subject.userId ? { userId: scope.subject.userId } : {}) } : undefined;
  const stack = await evaluateGuardStack(
    profiles.map((entry) => entry.profile),
    { ...input, ...(subject && !input.subject ? { subject } : {}) },
    { registry, protection }
  );
  const verdicts = stack.verdicts.map((verdict, index) => ({ profile: guardProfileRef(profiles[index]!), summary: summarizeGuardVerdict(verdict) }));
  for (const entry of verdicts) {
    if (!scope.guard.onVerdict || !scope.executionId) continue;
    try {
      await scope.guard.onVerdict({
        executionId: scope.executionId,
        workflowId: scope.workflowId,
        nodeId: scope.nodeId,
        placement: scope.placement,
        ...(meta.iteration !== undefined ? { iteration: meta.iteration } : {}),
        channel: input.channel,
        ...(meta.toolName ? { toolName: meta.toolName } : {}),
        profile: entry.profile,
        verdict: entry.summary
      });
    } catch (error) {
      // Recording a verdict must never change the verdict.
      scope.logger?.("Failed to record guard verdict", { nodeId: scope.nodeId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { action: stack.action, content: stack.content, transformed: stack.transformed, verdicts };
}

/** Short reason for a verdict: categories and detectors, never evidence. */
export function describeGuardVerdict(result: GuardCheckResult): string {
  const reasons = new Set<string>();
  for (const { summary } of result.verdicts) {
    for (const action of summary.actions) {
      if (action.shadow || action.effective === "allow") continue;
      reasons.add(action.reason && action.detectorId === "<engine>" ? action.reason : `${action.category}${action.dataClass ? `/${action.dataClass}` : ""} (${action.detectorId})`);
    }
  }
  const list = [...reasons].slice(0, 4).join(", ");
  return list ? `${result.action}: ${list}` : result.action;
}

/** Key a person's approval is recorded under: the node, the channel and what was found, not the exact text. */
export function guardApprovalKey(nodeId: string, channel: GuardChannel, result: GuardCheckResult): string {
  const findings = new Set<string>();
  for (const { summary } of result.verdicts) {
    for (const action of summary.actions) {
      if (!action.shadow && (action.effective === "review" || action.effective === "require_approval")) {
        findings.add(`${action.detectorId}/${action.category}/${action.dataClass ?? ""}`);
      }
    }
  }
  return `guard:${nodeId}:${channel}:${[...findings].sort().join("|")}`;
}

export function needsApproval(action: GuardAction): boolean {
  return action === "review" || action === "require_approval";
}

export interface AgentGuardTraceEntry {
  iteration: number;
  channel: GuardChannel;
  toolName?: string;
  action: GuardAction;
  approved?: boolean;
  verdicts: GuardCheckResult["verdicts"];
}

export interface AgentGuardSession {
  hooks: AgentGuardHooks;
  /** The approval request behind the last `pause` decision (this agent's or a delegated worker's). */
  takePendingApproval(): ApprovalHandoffRequest | undefined;
  /** A delegated worker paused: its request pauses this agent too. */
  setPendingApproval(request: ApprovalHandoffRequest): void;
  /** Safe trace for the node output (`_guard`). */
  trace(): {
    source: GuardRunResolution["source"] | "port";
    profiles: GuardProfileRef[];
    chain: GuardBindingLevel[];
    spotlighting?: "delimiters" | "datamark";
    canary: boolean;
    verdicts: AgentGuardTraceEntry[];
  };
}

/**
 * Guard hooks for one agent run: the port's guard node (stacked after an
 * enforced profile) or, without a port, the run's automatic profiles.
 * Returns undefined when nothing applies.
 */
export async function createAgentGuardSession(input: {
  scope: GuardEvalScope;
  globals: Record<string, unknown>;
  portGuardNode?: WorkflowNode;
  protectionNodes: WorkflowNode[];
  describeTool: (exposedName: string) => GuardToolContext | undefined;
}): Promise<AgentGuardSession | undefined> {
  const { scope } = input;
  let profiles: ResolvedGuardProfile[];
  let resolution: GuardRunResolution;
  let source: GuardRunResolution["source"] | "port";
  if (input.portGuardNode) {
    const config = parseGuardNodeConfig(input.portGuardNode);
    ({ profiles, resolution } = await resolveGuardNodeProfiles(scope.guard, config, protectionBindingsFromNodes(input.protectionNodes)));
    source = "port";
  } else {
    resolution = await resolveGuardRun(scope.guard);
    profiles = resolution.stack;
    source = resolution.source;
  }
  if (profiles.length === 0) return undefined;

  const spotlightProfile = profiles.find((entry) => entry.profile.spotlighting && entry.profile.spotlighting.mode !== "off");
  const spotlighting = spotlightProfile?.profile.spotlighting;
  const harden = profiles.some((entry) => entry.profile.spotlighting?.hardenSystemPrompt === true && entry.profile.spotlighting.mode !== "off");
  const canary = profiles.some((entry) => entry.profile.canaries?.enabled === true) ? generateCanaryToken() : undefined;
  const boundary = `DATA-${randomBytes(6).toString("hex").toUpperCase()}`;
  const verdictLog: AgentGuardTraceEntry[] = [];
  const approvals = approvedHandoffKeys(input.globals);
  let pendingApproval: ApprovalHandoffRequest | undefined;

  const systemText = (() => {
    const parts: string[] = [];
    if (spotlighting?.mode === "delimiters") parts.push(spotlightingSystemPrompt("delimiters", boundary, "tool result"));
    if (spotlighting?.mode === "datamark") parts.push(spotlightingSystemPrompt("datamark", DEFAULT_DATAMARK, "tool result"));
    if (harden) parts.push(PROMPT_HARDENING_TEXT);
    if (canary) parts.push(canaryInstruction(canary));
    return parts.join("\n");
  })();

  const hooks: AgentGuardHooks = {
    systemPromptAddition: () => systemText || undefined,
    ...(spotlighting && spotlighting.mode !== "off"
      ? {
          spotlight: (text: string) =>
            spotlighting.mode === "datamark" ? datamark(text).content : wrapWithDelimiters(text, { boundary, source: "tool result" }).content
        }
      : {}),
    check: async (check: AgentGuardCheck): Promise<AgentGuardDecision> => {
      const tool = check.tool ? input.describeTool(check.tool.name) ?? { toolName: check.tool.name, ...(check.tool.inputSchema ? { inputSchema: check.tool.inputSchema } : {}) } : undefined;
      const withCanary = canary && (check.channel === "tool_arguments" || check.channel === "final_output");
      const result = await runGuardCheck(
        scope,
        profiles,
        {
          content: check.content,
          channel: check.channel,
          labels: check.labels as ProvenanceLabel[],
          ...(tool ? { tool } : {}),
          ...(withCanary ? { canaries: [canary] } : {})
        },
        { iteration: check.iteration, ...(tool ? { toolName: tool.toolName } : {}) }
      );
      const entry: AgentGuardTraceEntry = {
        iteration: check.iteration,
        channel: check.channel,
        ...(tool ? { toolName: tool.toolName } : {}),
        action: result.action,
        verdicts: result.verdicts
      };
      verdictLog.push(entry);
      if (result.action === "block") return { outcome: "block", message: describeGuardVerdict(result) };
      if (needsApproval(result.action)) {
        const key = guardApprovalKey(scope.nodeId, check.channel, result);
        if (!approvals.has(key)) {
          const message = `Guard ${result.action === "review" ? "review" : "approval"} needed on ${check.channel.replace("_", " ")}${tool ? ` (${tool.toolName})` : ""}: ${describeGuardVerdict(result)}`;
          pendingApproval = {
            message,
            timeoutMinutes: 60,
            handoff: { kind: "rerun", source: "agent_guard", approvalKey: key },
            details: { channel: check.channel, iteration: check.iteration, verdicts: result.verdicts }
          };
          return { outcome: "pause", message };
        }
        entry.approved = true;
      }
      return result.transformed ? { outcome: "rewrite", content: result.content } : { outcome: "allow" };
    }
  };

  return {
    hooks,
    takePendingApproval: () => {
      const pending = pendingApproval;
      pendingApproval = undefined;
      return pending;
    },
    setPendingApproval: (request) => {
      pendingApproval = request;
    },
    trace: () => ({
      source,
      profiles: profiles.map(guardProfileRef),
      chain: input.portGuardNode
        ? [...resolution.chain, { level: "port", mode: "override", profileId: parseGuardNodeConfig(input.portGuardNode).profileId }]
        : resolution.chain,
      ...(spotlighting && spotlighting.mode !== "off" ? { spotlighting: spotlighting.mode } : {}),
      canary: Boolean(canary),
      verdicts: verdictLog
    })
  };
}

/** Labels a guard node evaluates with when its config names none. */
export function guardNodeLabels(config: GuardNodeConfig): ProvenanceLabel[] {
  return (config.labels ?? defaultGuardLabels(config.channel)) as ProvenanceLabel[];
}
