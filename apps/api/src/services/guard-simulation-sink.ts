/**
 * Phase 15.6 — where a guard policy simulation's verdicts and tokens go.
 *
 * A simulated replay must not touch live security data:
 *
 *   - its verdicts are collected here, per execution, instead of being
 *     written to `guard_events` (so the Security page activity and stats
 *     only ever show real traffic);
 *   - `protect` actions tokenise through a vault that lives as long as the
 *     simulation: tokens it creates stay in memory and are never written.
 *     Reads fall through to the deployment's vault (read-only), so a
 *     deterministic token comes out the same as in the recorded run.
 *
 * Verdicts are kept as checks: one evaluation of the profile stack on one
 * piece of content (the engine tags every profile's verdict of a check with
 * the same check id and the stack's combined action).
 */

import { randomUUID } from "node:crypto";
import { InMemoryTokenVaultStorage, type TokenVaultRecord, type TokenVaultStorage } from "@ai-orchestrator/guard-sdk";
import type { GuardVerdictEvent } from "@ai-orchestrator/workflow-engine";
import type { GuardProfileSubstitute } from "./guard-service.js";

/** One finding (or the clean row of a clean verdict) of one profile's verdict. */
export interface SimulatedGuardFinding {
  detectorId: string | null;
  dataClass: string | null;
  effectiveAction: string;
  shadow: boolean;
}

/** One profile's verdict inside a check. */
export interface SimulatedGuardVerdict {
  profileId: string;
  version: number;
  hash: string;
  action: string;
  findings: SimulatedGuardFinding[];
}

/** One check: the profile stack evaluated once on one piece of content, at one place. */
export interface SimulatedGuardCheck {
  id: string;
  nodeId: string | null;
  placement: string;
  channel: string;
  iteration: number | null;
  toolName: string | null;
  /** The combined action of the whole stack: what the traffic got. */
  action: string;
  verdicts: SimulatedGuardVerdict[];
}

/** The event rows `buildRunFacts` reads, so a simulated replay's facts still list its guard verdicts. */
export interface SimulatedGuardEventRow {
  verdictId: string;
  nodeId: string | null;
  placement: string;
  channel: string;
  detectorId: string | null;
  effectiveAction: string;
  shadow: boolean;
  dataClass: string | null;
}

/** Collects one simulated execution's guard verdicts in memory. */
export class GuardSimulationSink {
  readonly checks: SimulatedGuardCheck[] = [];
  readonly rows: SimulatedGuardEventRow[] = [];

  record(event: GuardVerdictEvent): void {
    const summary = event.verdict;
    const checkId = event.check?.id ?? randomUUID();
    let check = this.checks.find((entry) => entry.id === checkId);
    if (!check) {
      check = {
        id: checkId,
        nodeId: event.nodeId ?? null,
        placement: event.placement,
        channel: event.channel,
        iteration: event.iteration ?? null,
        toolName: event.toolName ?? null,
        action: event.check?.action ?? summary.action,
        verdicts: []
      };
      this.checks.push(check);
    }
    const findings: SimulatedGuardFinding[] =
      summary.actions.length === 0
        ? [{ detectorId: null, dataClass: null, effectiveAction: summary.action, shadow: false }]
        : summary.actions.map((action) => ({ detectorId: action.detectorId, dataClass: action.dataClass ?? null, effectiveAction: action.effective, shadow: action.shadow }));
    check.verdicts.push({ profileId: event.profile.profileId, version: event.profile.version, hash: event.profile.hash, action: summary.action, findings });
    const verdictId = randomUUID();
    for (const finding of findings) {
      this.rows.push({ verdictId, nodeId: event.nodeId ?? null, placement: event.placement, channel: event.channel, ...finding });
    }
  }
}

/**
 * The vault of one simulation: writes stay in memory, reads look there
 * first and then in the deployment's vault (never written).
 */
export class GuardSimulationVault implements TokenVaultStorage {
  private readonly memory = new InMemoryTokenVaultStorage();

  constructor(private readonly live?: TokenVaultStorage) {}

  async getByToken(token: string): Promise<TokenVaultRecord | undefined> {
    return (await this.memory.getByToken(token)) ?? (await this.live?.getByToken(token));
  }

  async getByValueHash(valueHash: string): Promise<TokenVaultRecord | undefined> {
    return (await this.memory.getByValueHash(valueHash)) ?? (await this.live?.getByValueHash(valueHash));
  }

  async put(record: TokenVaultRecord): Promise<void> {
    await this.memory.put(record);
  }

  /** Tokens this simulation created (in memory only). */
  get size(): number {
    return this.memory.size;
  }
}

/**
 * One simulated execution: the simulation, the profile it swaps in (null on
 * the baseline side, which runs the current profiles), and where its
 * verdicts and tokens go.
 */
export interface GuardSimulationRun {
  id: string;
  substitute: GuardProfileSubstitute | null;
  sink: GuardSimulationSink;
  vault: TokenVaultStorage;
}
