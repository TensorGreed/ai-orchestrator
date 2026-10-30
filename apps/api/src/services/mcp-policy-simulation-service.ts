/**
 * Phase 12.4 — simulate a draft MCP tool rule set against recorded tool calls, and count shadow rule hits.
 *
 * Simulation reads the calls recorded in the last 7 or 30 days (`mcp_tool_calls`, newest first, page by page, up to
 * a cap) and, for each, compares the current rules' enforced outcome with the draft's, from the call's recorded
 * principals and argument SUMMARY (packages/mcp-sdk/src/tool-policy-simulation.ts). Nothing is replayed and nothing
 * is written. A call the summary cannot decide is counted as undetermined, never as allowed or denied; a call
 * without a summary (summaries were off, or it predates them) is counted as not summarised.
 *
 * Read: workflow calls and gateway server-tool calls. Left out: playground calls (an admin trying a tool, checked
 * without its arguments) and the gateway's own rows for workflow tools (the run's calls are recorded separately).
 *
 * Responses carry tool, time, workflow / client, role and the stored summary only; never raw arguments, never the
 * summary hash key.
 */
import {
  MCP_POLICY_SIMULATION_MAX_EXAMPLES,
  emptyMcpPolicySimulationCounts,
  type McpPolicyDraftRule,
  type McpPolicyShadowHitGroup,
  type McpPolicyShadowHitRow,
  type McpPolicyShadowHits,
  type McpPolicySimulationBucketName,
  type McpPolicySimulationExample,
  type McpPolicySimulationGroup,
  type McpPolicySimulationResult,
  type McpPolicySimulationRuleRow,
  type McpPolicySimulationWindowDays,
  type McpToolAnnotations,
  type McpToolClassificationOverride,
  type McpToolPolicyRule
} from "@ai-orchestrator/shared";
import { decidePolicyOutcome, policyRuleMode, simulatePolicyTransition, type PolicySimulationCall } from "@ai-orchestrator/mcp-sdk";
import type { McpToolCallRecord } from "../db/database.js";
import type { Store } from "../db/store.js";

/** The gateway's own telemetry rows for workflow tools use this adapter id (mcp-gateway-routes.ts). */
export const GATEWAY_WORKFLOW_TOOL_ADAPTER_ID = "workflow";

/** Most calls one simulation or shadow-hit count reads. */
export const MCP_POLICY_SCAN_CAP = 50_000;
/** Calls read per page. */
export const MCP_POLICY_SCAN_PAGE = 1_000;
/** Most workflow / client groups listed in a simulation result. */
export const MCP_POLICY_SIMULATION_MAX_GROUPS = 100;
/**
 * Most evaluation work one simulation may do: per call, the readings tried (2^undecided rules) times the rules in
 * the call's scope, summed. 50,000 calls with a few rules each use well under a tenth of it; a draft built to make
 * every call try 256 readings of hundreds of rules stops early instead of holding the event loop.
 */
export const MCP_POLICY_SIMULATION_WORK_BUDGET = 20_000_000;

const DAY_MS = 24 * 60 * 60 * 1000;

export class McpPolicySimulationError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
    this.name = "McpPolicySimulationError";
  }
}

/** A draft rule as the evaluator reads it (the shape `createMcpToolPolicy` stores). */
export function draftToPolicyRule(draft: McpPolicyDraftRule, id: string): McpToolPolicyRule {
  return {
    id,
    name: draft.name?.trim() || null,
    description: draft.description?.trim() || null,
    effect: draft.effect,
    projectId: draft.projectId ?? null,
    roles: [...new Set(draft.roles ?? [])],
    serverId: draft.serverId ?? null,
    toolPattern: draft.toolPattern ?? "*",
    annotationHint: draft.annotationHint ?? null,
    kind: draft.kind ?? "tool",
    enabled: draft.enabled !== false,
    conditions: draft.conditions ?? null,
    mode: draft.mode ?? "enforce",
    workflowIds: [...new Set(draft.workflowIds ?? [])],
    clientIds: [...new Set(draft.clientIds ?? [])]
  };
}

export interface McpPolicySimulationInput {
  windowDays: McpPolicySimulationWindowDays;
  rules?: Array<McpPolicyDraftRule | { keep: string }>;
  addRule?: McpPolicyDraftRule;
  filters?: { workflowId?: string; clientId?: string; serverId?: string; toolName?: string };
  examples?: number;
}

/** What a page scan read; `stopped` when the visitor ended it early. */
interface ScanOutcome {
  scanned: number;
  capped: boolean;
  stopped: boolean;
  oldestScannedAt: string | null;
}

/**
 * The annotations and admin mark a call's annotation-hint rules read, from today's snapshot: unknown (`{}`) when the
 * snapshot was captured, or the mark set, after the call, since they may differ from what the call ran under.
 */
export function annotationsAtCall(
  snapshot: { capturedAt: string; annotations: McpToolAnnotations | null },
  mark: Pick<McpToolClassificationOverride, "readOnly" | "setAt"> | null,
  startedAt: string
): { annotations?: McpToolAnnotations | null; manualReadOnly?: boolean | null } {
  if (laterThan(snapshot.capturedAt, startedAt)) return {};
  if (mark && laterThan(mark.setAt, startedAt)) return {};
  return { annotations: snapshot.annotations, manualReadOnly: mark ? mark.readOnly : null };
}

/** A visitor returns false to stop the scan. */
type ScanVisitor = (call: McpToolCallRecord) => boolean | void;

function laterThan(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right) && left > right;
}

type ToolAnnotationLookup = (call: McpToolCallRecord) => { annotations?: McpToolAnnotations | null; manualReadOnly?: boolean | null };

export class McpPolicySimulationService {
  private readonly store: Store;
  private readonly hashKey: Uint8Array;
  private readonly now: () => Date;
  private readonly scanCap: number;
  private readonly pageSize: number;

  private readonly workBudget: number;

  constructor(options: { store: Store; hashKey: Uint8Array; now?: () => Date; scanCap?: number; pageSize?: number; workBudget?: number }) {
    this.store = options.store;
    this.hashKey = options.hashKey;
    this.now = options.now ?? (() => new Date());
    this.scanCap = options.scanCap ?? MCP_POLICY_SCAN_CAP;
    this.pageSize = options.pageSize ?? MCP_POLICY_SCAN_PAGE;
    this.workBudget = options.workBudget ?? MCP_POLICY_SIMULATION_WORK_BUDGET;
  }

  /** The most calls one scan reads. */
  get cap(): number {
    return this.scanCap;
  }

  /** Reads the window newest first, page by page, until it ends, the cap is reached or the visitor returns false. */
  async scan(filter: Omit<Parameters<Store["scanMcpToolCalls"]>[0], "before" | "limit">, visit: ScanVisitor): Promise<ScanOutcome> {
    let before: { startedAt: string; id: string } | null = null;
    let scanned = 0;
    let oldest: string | null = null;
    for (;;) {
      const page = await this.store.scanMcpToolCalls({ ...filter, before, limit: this.pageSize });
      for (const call of page) {
        if (scanned >= this.scanCap) return { scanned, capped: true, stopped: false, oldestScannedAt: oldest };
        scanned += 1;
        oldest = call.startedAt;
        if (visit(call) === false) return { scanned, capped: true, stopped: true, oldestScannedAt: oldest };
      }
      if (page.length < this.pageSize) return { scanned, capped: false, stopped: false, oldestScannedAt: oldest };
      const last = page[page.length - 1]!;
      before = { startedAt: last.startedAt, id: last.id };
      if (scanned >= this.scanCap) {
        const more = await this.store.scanMcpToolCalls({ ...filter, before, limit: 1 });
        return { scanned, capped: more.length > 0, stopped: false, oldestScannedAt: oldest };
      }
    }
  }

  /** The current rules and the draft, both in evaluation order. */
  private async ruleSets(input: McpPolicySimulationInput): Promise<{ current: McpToolPolicyRule[]; draft: McpToolPolicyRule[] }> {
    const current = await this.store.listMcpToolPolicies();
    if (input.addRule) {
      // One added rule is simulated as enforced: the question is what it would do.
      return { current, draft: [...current, { ...draftToPolicyRule(input.addRule, "draft"), mode: "enforce" }] };
    }
    const byId = new Map(current.map((rule) => [rule.id, rule]));
    const seen = new Set<string>();
    const draft = (input.rules ?? []).map((entry, index) => {
      if ("keep" in entry) {
        const kept = byId.get(entry.keep);
        if (!kept) throw new McpPolicySimulationError(`Rule '${entry.keep}' does not exist`);
        if (seen.has(kept.id)) throw new McpPolicySimulationError(`Rule '${kept.id}' is listed twice`);
        seen.add(kept.id);
        return kept;
      }
      const id = entry.id ?? `draft_${index + 1}`;
      if (seen.has(id)) throw new McpPolicySimulationError(`Rule '${id}' is listed twice`);
      seen.add(id);
      return draftToPolicyRule(entry, id);
    });
    return { current, draft };
  }

  /** The tool annotations and admin marks rules with an annotation hint need, from the current tool snapshots. */
  private async annotationLookup(rules: readonly McpToolPolicyRule[]): Promise<ToolAnnotationLookup | null> {
    if (!rules.some((rule) => rule.enabled && rule.annotationHint)) return null;
    const classifications: McpToolClassificationOverride[] = await this.store.listMcpToolClassifications();
    const servers = new Map((await this.store.listMcpServers()).map((server) => [server.id, server]));
    const snapshots = new Map<string, { capturedAt: string; tools: Map<string, McpToolAnnotations | null> } | null>();
    for (const server of servers.values()) {
      const snapshot = server.currentSnapshotId ? await this.store.getMcpToolSnapshot(server.currentSnapshotId) : null;
      snapshots.set(
        server.id,
        snapshot ? { capturedAt: snapshot.createdAt, tools: new Map(snapshot.tools.map((tool) => [tool.name, tool.annotations ?? null])) } : null
      );
    }
    return (call) => {
      if (!call.registryServerId) return {};
      const snapshot = snapshots.get(call.registryServerId);
      if (!snapshot || !snapshot.tools.has(call.toolName)) return {};
      const mark = classifications.find((entry) => entry.registryServerId === call.registryServerId && entry.toolName === call.toolName);
      return annotationsAtCall({ capturedAt: snapshot.capturedAt, annotations: snapshot.tools.get(call.toolName) ?? null }, mark ?? null, call.startedAt);
    };
  }

  async simulate(input: McpPolicySimulationInput): Promise<McpPolicySimulationResult> {
    const { current, draft } = await this.ruleSets(input);
    const until = this.now();
    const since = new Date(until.getTime() - input.windowDays * DAY_MS);
    const maxExamples = Math.min(input.examples ?? MCP_POLICY_SIMULATION_MAX_EXAMPLES, MCP_POLICY_SIMULATION_MAX_EXAMPLES);
    const lookup = await this.annotationLookup([...current, ...draft]);
    const context = { hashKey: this.hashKey };

    const counts = emptyMcpPolicySimulationCounts();
    const examples = Object.fromEntries(Object.keys(counts).map((bucket) => [bucket, [] as McpPolicySimulationExample[]])) as McpPolicySimulationResult["examples"];
    const groups = new Map<string, McpPolicySimulationGroup>();
    const currentIds = new Set(current.map((rule) => rule.id));
    const draftIds = new Set(draft.map((rule) => rule.id));
    const rows = new Map<string, McpPolicySimulationRuleRow>();
    const rowFor = (rule: McpToolPolicyRule, presence: McpPolicySimulationRuleRow["presence"]) => {
      const row: McpPolicySimulationRuleRow = {
        ruleId: rule.id,
        name: rule.name,
        effect: rule.effect,
        mode: policyRuleMode(rule),
        presence,
        matched: 0,
        undetermined: 0,
        newlyDenied: 0,
        newlyNeedsApproval: 0,
        noLongerDenied: 0,
        noLongerNeedsApproval: 0
      };
      rows.set(rule.id, row);
      return row;
    };
    const draftRows = draft.map((rule) => rowFor(rule, currentIds.has(rule.id) ? "both" : "draft"));
    for (const rule of current) if (!draftIds.has(rule.id)) rowFor(rule, "current");

    // Examples are collected first and named once the scan is done.
    const pending: Array<{ bucket: McpPolicySimulationBucketName; example: Omit<McpPolicySimulationExample, "workflowName" | "clientName" | "serverName"> }> = [];
    const collected = emptyMcpPolicySimulationCounts();
    let work = 0;
    const outcome = await this.scan(
      {
        since: since.toISOString(),
        until: until.toISOString(),
        sources: ["workflow", "gateway"],
        excludeAdapterId: GATEWAY_WORKFLOW_TOOL_ADAPTER_ID,
        ...(input.filters?.workflowId ? { workflowId: input.filters.workflowId } : {}),
        ...(input.filters?.clientId ? { clientId: input.filters.clientId } : {}),
        ...(input.filters?.serverId ? { serverId: input.filters.serverId } : {}),
        ...(input.filters?.toolName ? { toolName: input.filters.toolName } : {})
      },
      (call) => {
        if (work >= this.workBudget) return false;
        const gateway = call.source === "gateway";
        let bucket: McpPolicySimulationBucketName;
        let currentEffect: McpPolicySimulationExample["currentEffect"] = null;
        let draftEffect: McpPolicySimulationExample["draftEffect"] = null;
        let currentRuleId: string | null = null;
        let draftRuleId: string | null = null;
        let reason: string | null = null;
        if (!call.argsSummary) {
          bucket = "not_summarised";
          reason = "The call has no argument summary (summaries were off, or it was recorded before they existed).";
        } else {
          const recorded: PolicySimulationCall = {
            role: call.subjectRole ?? null,
            projectId: call.projectId ?? null,
            workflowId: gateway ? null : call.workflowId || null,
            // A run a gateway client started evaluated its rules with the client, which the run's rows do not record.
            clientId: gateway ? call.clientId : call.subjectSource === "client" ? undefined : null,
            adapterId: call.adapterId,
            registryServerId: call.registryServerId,
            toolName: call.toolName,
            ...(lookup ? lookup(call) : {}),
            labels: gateway ? "none" : "unknown",
            summary: call.argsSummary
          };
          const transition = simulatePolicyTransition(current, draft, recorded, context);
          work += transition.work;
          bucket = transition.bucket;
          currentEffect = transition.current.effect;
          draftEffect = transition.draft.effect;
          currentRuleId = transition.current.ruleId ?? null;
          draftRuleId = transition.draft.ruleId ?? null;
          reason = transition.reason ?? null;
          transition.draftStates.forEach((state, index) => {
            if (state.state === "match") draftRows[index]!.matched += 1;
            else if (state.state === "unknown") draftRows[index]!.undetermined += 1;
          });
          const credit = (ruleId: string | null, field: "newlyDenied" | "newlyNeedsApproval" | "noLongerDenied" | "noLongerNeedsApproval") => {
            const row = ruleId ? rows.get(ruleId) : undefined;
            if (row) row[field] += 1;
          };
          if (bucket === "newly_denied") credit(draftRuleId, "newlyDenied");
          else if (bucket === "newly_needs_approval") credit(draftRuleId, "newlyNeedsApproval");
          else if (bucket === "no_longer_denied") credit(currentRuleId, "noLongerDenied");
          else if (bucket === "no_longer_needs_approval") credit(currentRuleId, "noLongerNeedsApproval");
        }
        counts[bucket] += 1;
        const groupKind = gateway ? "client" : "workflow";
        const groupId = gateway ? call.clientId ?? "" : call.workflowId;
        if (groupId) {
          const key = `${groupKind}:${groupId}`;
          let group = groups.get(key);
          if (!group) {
            group = { kind: groupKind, id: groupId, name: null, counts: emptyMcpPolicySimulationCounts() };
            groups.set(key, group);
          }
          group.counts[bucket] += 1;
        }
        if (collected[bucket] < maxExamples) {
          collected[bucket] += 1;
          pending.push({
            bucket,
            example: {
              callId: call.id,
              startedAt: call.startedAt,
              toolName: call.toolName,
              serverId: call.registryServerId ?? call.adapterId,
              source: gateway ? "gateway" : "workflow",
              workflowId: gateway ? null : call.workflowId || null,
              clientId: call.clientId,
              role: call.subjectRole ?? null,
              currentEffect,
              draftEffect,
              currentRuleId,
              draftRuleId,
              reason,
              summary: call.argsSummary ?? null
            }
          });
        }
      }
    );

    const names = await this.names();
    for (const { bucket, example } of pending) {
      examples[bucket].push({
        ...example,
        serverName: names.servers.get(example.serverId) ?? null,
        workflowName: example.workflowId ? names.workflows.get(example.workflowId) ?? null : null,
        clientName: example.clientId ? names.clients.get(example.clientId) ?? null : null
      });
    }

    const changes = (group: McpPolicySimulationGroup) =>
      group.counts.newly_denied + group.counts.newly_needs_approval + group.counts.no_longer_denied + group.counts.no_longer_needs_approval;
    const sortedGroups = [...groups.values()].sort(
      (a, b) => changes(b) - changes(a) || b.counts.undetermined - a.counts.undetermined || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    const listed = sortedGroups.slice(0, MCP_POLICY_SIMULATION_MAX_GROUPS).map((group) => ({
      ...group,
      name: (group.kind === "workflow" ? names.workflows.get(group.id) : names.clients.get(group.id)) ?? null
    }));

    return {
      windowDays: input.windowDays,
      since: since.toISOString(),
      until: until.toISOString(),
      scanned: outcome.scanned,
      capped: outcome.capped,
      ...(outcome.capped ? { cappedReason: outcome.stopped ? ("work_budget" as const) : ("scan_cap" as const) } : {}),
      scanCap: this.scanCap,
      oldestScannedAt: outcome.oldestScannedAt,
      counts,
      rules: [...rows.values()],
      groups: listed,
      groupsCapped: sortedGroups.length > listed.length,
      examples
    };
  }

  private async names(): Promise<{ workflows: Map<string, string>; clients: Map<string, string>; servers: Map<string, string> }> {
    const [workflows, clients, servers] = await Promise.all([this.store.listWorkflows(), this.store.listMcpClients(), this.store.listMcpServers()]);
    return {
      workflows: new Map(workflows.map((workflow) => [workflow.id, workflow.name])),
      clients: new Map(clients.map((client) => [client.id, client.name])),
      servers: new Map(servers.map((server) => [server.id, server.name]))
    };
  }

  /**
   * Shadow rule hits over the last `days` days, from the decisions recorded on tool calls (`policy_decision_json`).
   * For each current shadow rule: how often it matched, and how often the outcome would have changed had THIS rule
   * alone been enforced next to the rules enforced now ("if you enforce just this rule"). For each accepted
   * suggestion with rules still in shadow: the same with all of those rules enforced together. Every shadow rule is
   * listed, with zeros when it saw nothing. Rules are read as they are now; a matched rule since deleted is left out.
   */
  async shadowHits(days: number): Promise<McpPolicyShadowHits> {
    const until = this.now();
    const since = new Date(until.getTime() - days * DAY_MS);
    const rules = await this.store.listMcpToolPolicies();
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    const isShadow = (rule: McpToolPolicyRule) => policyRuleMode(rule) === "shadow";
    const isEnforced = (rule: McpToolPolicyRule) => rule.enabled && policyRuleMode(rule) === "enforce";
    const hits = new Map<string, McpPolicyShadowHitRow>();
    for (const rule of rules) {
      if (isShadow(rule)) hits.set(rule.id, { ruleId: rule.id, matched: 0, wouldChange: 0, lastMatchedAt: null, lastWouldChangeAt: null });
    }
    const accepted = hits.size > 0 ? await this.store.listMcpPolicySuggestions({ status: "accepted" }) : [];
    const groups: Array<McpPolicyShadowHitGroup & { members: Set<string> }> = [];
    for (const suggestion of accepted) {
      const ruleIds = suggestion.acceptedRuleIds.filter((id) => hits.has(id));
      if (ruleIds.length > 0) groups.push({ suggestionId: suggestion.id, ruleIds, matched: 0, wouldChange: 0, lastWouldChangeAt: null, members: new Set(ruleIds) });
    }
    const later = (a: string | null, b: string) => (a === null || b > a ? b : a);
    const outcome =
      hits.size === 0
        ? { scanned: 0, capped: false }
        : await this.scan(
            { since: since.toISOString(), until: until.toISOString(), sources: ["workflow", "gateway", "playground"], withPolicyDecision: true },
            (call) => {
              const decision = call.policyDecision;
              if (!decision) return;
              const matched = [...new Set(decision.matched.map((entry) => entry.ruleId))]
                .map((id) => byId.get(id))
                .filter((rule): rule is McpToolPolicyRule => rule !== undefined);
              const matchedShadow = matched.filter((rule) => hits.has(rule.id));
              if (matchedShadow.length === 0) return;
              const enforcedNow = matched.filter(isEnforced);
              const base = decidePolicyOutcome(enforcedNow).effect;
              for (const rule of matchedShadow) {
                const row = hits.get(rule.id)!;
                row.matched += 1;
                row.lastMatchedAt = later(row.lastMatchedAt, call.startedAt);
                if (rule.enabled && decidePolicyOutcome([...enforcedNow, rule]).effect !== base) {
                  row.wouldChange += 1;
                  row.lastWouldChangeAt = later(row.lastWouldChangeAt, call.startedAt);
                }
              }
              for (const group of groups) {
                const members = matchedShadow.filter((rule) => group.members.has(rule.id) && rule.enabled);
                if (!matchedShadow.some((rule) => group.members.has(rule.id))) continue;
                group.matched += 1;
                if (members.length > 0 && decidePolicyOutcome([...enforcedNow, ...members]).effect !== base) {
                  group.wouldChange += 1;
                  group.lastWouldChangeAt = later(group.lastWouldChangeAt, call.startedAt);
                }
              }
            }
          );
    return {
      days,
      since: since.toISOString(),
      scanned: outcome.scanned,
      capped: outcome.capped,
      rules: [...hits.values()],
      groups: groups.map((group) => ({
        suggestionId: group.suggestionId,
        ruleIds: group.ruleIds,
        matched: group.matched,
        wouldChange: group.wouldChange,
        lastWouldChangeAt: group.lastWouldChangeAt
      }))
    };
  }
}
