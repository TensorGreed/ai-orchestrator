import { createHash } from "node:crypto";
import { profileRevealRules, revealTokens, type RevealRule } from "@ai-orchestrator/guard-sdk";
import {
  findRevealRule,
  guardRevealNodeConfigSchema,
  revealRuleAllows,
  revealSubjectIsAdmin,
  revealSubjectOf,
  type GuardRevealNodeConfig,
  type RevealNodeSummary,
  type WorkflowNode
} from "@ai-orchestrator/shared";
import { ApprovalHandoffSignal } from "./approval-handoff";
import { labelsOf, type NodeLabelScope } from "./data-labels";
import { guardProfileRef, keyResolverFor, resolveGuardNodeProfiles, type GuardEvalScope, type ResolvedGuardProfile } from "./guard-runtime";

/**
 * Phase 12 coverage — the Reveal node on DAG edges. It reads one field of the incoming item and turns the
 * protection tokens in it back into values, for the data classes a reveal rule allows the run's subject:
 *
 * - deny by default: a token no rule allows stays as it is (or fails the node with `onRefused: "fail"`);
 * - roles and users match only runs a signed-in person started; webhook, chat, schedule and gateway runs never do;
 * - vault tokens must have been issued in the run's project (older, unscoped tokens only for an admin's run);
 * - a rule with `requireApproval` pauses the run for a person first (approval hand-off, `rerun`);
 * - every step that revealed or refused something is recorded (rule events and the audit log), never values;
 * - replays, eval runs and simulations never reveal: the input passes through.
 *
 * Revealed values carry the `sensitive` label and their data classes again, so destination rules and outbound
 * checks decide where they may go next.
 */

function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function writePath(target: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) return target;
  const root: Record<string, unknown> = { ...target };
  let cursor = root;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      cursor[segment] = value;
      return;
    }
    const next = cursor[segment];
    const copy = next && typeof next === "object" && !Array.isArray(next) ? { ...(next as Record<string, unknown>) } : {};
    cursor[segment] = copy;
    cursor = copy;
  });
  return root;
}

export function parseRevealNodeConfig(node: WorkflowNode): GuardRevealNodeConfig {
  const parsed = guardRevealNodeConfigSchema.safeParse(node.config ?? {});
  if (!parsed.success) {
    throw new Error(`Reveal node '${node.name}' is misconfigured: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}

interface RuleEntry {
  rule: RevealRule;
  profile: ResolvedGuardProfile;
  index: number;
}

/** The approval key of a reveal: the node and the exact tokens a rule asks approval for. */
export function revealApprovalKey(nodeId: string, tokenHashes: readonly string[]): string {
  const digest = createHash("sha256").update([...tokenHashes].sort().join("\u0000")).digest("hex").slice(0, 16);
  return `reveal:${nodeId}:${digest}`;
}

export async function executeRevealNodeStep(input: {
  node: WorkflowNode;
  scope: GuardEvalScope;
  merged: Record<string, unknown>;
  /** Parent node ids: their copies inside `merged` are dropped from the output so the tokenised value does not ride along. */
  parentIds: string[];
  globals: Record<string, unknown>;
  /** Approval keys granted by resumed `rerun` hand-offs. */
  approvals?: ReadonlySet<string>;
  labelScope?: NodeLabelScope;
  /** The run is a replay: nothing is revealed. */
  replay: boolean;
}): Promise<Record<string, unknown>> {
  const config = parseRevealNodeConfig(input.node);
  input.labelScope?.readPath(config.inputField);
  const fromItem = readPath(input.merged, config.inputField);
  const value = fromItem !== undefined ? fromItem : readPath(input.globals, config.inputField);
  const parentIds = new Set(input.parentIds);
  const item = Object.fromEntries(Object.entries(input.merged).filter(([key]) => !parentIds.has(key)));
  const output = (content: unknown, summary: RevealNodeSummary) => ({ ...writePath(item, config.inputField, content ?? ""), reveal: summary });

  const guard = input.scope.guard;
  if (input.replay || guard.revealDisabled) {
    return output(value, { field: config.inputField, revealed: [], refused: [], skipped: "replay" });
  }

  const { profiles } = await resolveGuardNodeProfiles(guard, { profileId: config.profileId }, []);
  const entries: RuleEntry[] = profiles.flatMap((profile) => profileRevealRules(profile.profile).map((rule, index) => ({ rule, profile, index })));
  const subject = revealSubjectOf(input.scope.subject);
  const workflowId = input.scope.workflowId;
  const allowedClasses = [...new Set(entries.flatMap((entry) => entry.rule.dataClasses.filter((dataClass) => revealRuleAllows(entry.rule, { subject, dataClass, workflowId }))))].sort();

  const result = await revealTokens(value, {
    ...(guard.vault ? { vault: guard.vault } : {}),
    keys: keyResolverFor(input.scope),
    allowedKeyIds: config.keySecretRefs.map((ref) => ref.secretId),
    allowedClasses,
    grant: (dataClass) => {
      const rules = entries.map((entry) => entry.rule);
      const rule = findRevealRule(rules, { subject, dataClass, workflowId });
      const entry = rule ? entries[rules.indexOf(rule)] : undefined;
      if (!entry) return undefined;
      return {
        rule: { profileId: entry.profile.profileId, version: entry.profile.version, index: entry.index, ...(entry.rule.name ? { name: entry.rule.name } : {}) },
        ...(entry.rule.requireApproval ? { requireApproval: true } : {})
      };
    },
    projectId: guard.projectId,
    allowUnscoped: revealSubjectIsAdmin(subject),
    formatPreservingClasses: config.formatPreservingClasses
  });

  // `onRefused: "fail"`: one refused token fails the node, and nothing is revealed.
  const failing = config.onRefused === "fail" && result.refused.length > 0;
  let approved = false;
  if (!failing && result.approvalTokenHashes.length > 0) {
    const approvalKey = revealApprovalKey(input.node.id, result.approvalTokenHashes);
    if (!input.approvals?.has(approvalKey)) {
      const counts = result.revealed.map((entry) => `${entry.count} ${entry.dataClass}`).join(", ");
      throw new ApprovalHandoffSignal({
        message: config.approvalMessage?.trim() || `Reveal node '${input.node.name}' needs approval to reveal ${counts}`,
        timeoutMinutes: config.timeoutMinutes,
        handoff: { kind: "rerun", source: "reveal_node", approvalKey },
        details: { reveal: { field: config.inputField, classes: result.revealed.map((entry) => ({ dataClass: entry.dataClass, count: entry.count })) } }
      });
    }
    approved = true;
  }

  const revealed = failing ? [] : result.revealed;
  if (revealed.length > 0 || result.refused.length > 0) {
    if (!guard.onReveal) {
      if (revealed.length > 0) throw new Error(`Reveal node '${input.node.name}' cannot reveal: this deployment records no reveal events`);
    } else {
      try {
        await guard.onReveal({
          executionId: input.scope.executionId,
          workflowId,
          nodeId: input.node.id,
          subject: subject
            ? {
                source: subject.source,
                ...(subject.role ? { role: subject.role } : {}),
                ...(subject.userId ? { userId: subject.userId } : {}),
                ...(subject.serviceAccountId ? { serviceAccountId: subject.serviceAccountId } : {})
              }
            : null,
          profiles: profiles.map(guardProfileRef),
          revealed,
          refused: result.refused,
          approved
        });
      } catch (error) {
        // Fail closed: a reveal that cannot be recorded does not happen.
        throw new Error(`Reveal node '${input.node.name}' could not record the reveal, so nothing was revealed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (failing) {
    const count = result.refused.reduce((total, entry) => total + entry.count, 0);
    const reasons = [...new Set(result.refused.map((entry) => entry.reason))].join(", ");
    throw new Error(`Reveal node '${input.node.name}' refused ${count} token${count === 1 ? "" : "s"} (${reasons})`);
  }
  const summary: RevealNodeSummary = { field: config.inputField, revealed, refused: result.refused, ...(approved ? { approved: true } : {}) };
  if (result.revealedClasses.length > 0 && input.labelScope) {
    input.labelScope.add(labelsOf(["sensitive"], result.revealedClasses));
    input.labelScope.run.record(input.node.id);
  }
  return output(result.content, summary);
}
