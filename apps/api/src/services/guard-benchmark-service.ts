/**
 * 12.7 — content rules benchmarks over the API.
 *
 * A benchmark runs the red-team corpus that ships with guard-sdk through a
 * rule set in-process (`runGuardBenchmarkSuites`): the rule set suite always,
 * the reference workflow suite when asked. It touches no workflow, no
 * deployment server and no model, records no content rules event, and stores only
 * ids, counts and detector names. A full benchmark of a saved version (every
 * category, both splits) is stored in `guard_benchmarks` (the newest
 * GUARD_BENCHMARK_HISTORY_PER_PROFILE per rule set); a draft's or a partial
 * run's (a category or split filter) is returned and never stored, so the
 * trend and the baselines are always full runs. Each result is compared with
 * the rule set's latest stored benchmark before it, per category. A user who
 * is not an admin stores at most one benchmark per rule set version every
 * GUARD_BENCHMARK_STORE_INTERVAL_MS (GuardBenchmarkRateLimitedError, 429), so
 * nobody can roll a rule set's history.
 *
 * One benchmark runs at a time per instance (a second gets
 * GuardBenchmarkBusyError, 409), and the runner yields to the event loop
 * between items, so other requests keep being served while it runs.
 */

import { randomUUID } from "node:crypto";
import {
  GUARD_BENCHMARK_HISTORY_PER_PROFILE,
  GUARD_BENCHMARK_SPLITS,
  guardBenchmarkHeadline,
  judgeGuardBenchmark,
  parseGuardBenchmarkReport,
  type GuardBenchmarkJudgement,
  type GuardBenchmarkListEntry,
  type GuardBenchmarkReport,
  type GuardBenchmarkRequest,
  type GuardBenchmarkResponse,
  type GuardBenchmarkSuite
} from "@ai-orchestrator/shared";
import { runGuardBenchmarkSuites } from "@ai-orchestrator/workflow-engine";
import type { GuardBenchmarkStoredRecord } from "../db/database.js";
import type { Store } from "../db/store.js";
import type { SafeUser } from "./auth-service.js";
import { GuardNotFoundError, type GuardService } from "./guard-service.js";

export class GuardBenchmarkBusyError extends Error {
  constructor() {
    super("Another content rules benchmark is running on this instance; try again when it has finished.");
    this.name = "GuardBenchmarkBusyError";
  }
}

export class GuardBenchmarkRateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(
      `This rule set version was benchmarked less than ${GUARD_BENCHMARK_STORE_INTERVAL_MS / 60_000} minutes ago; try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s), or run a category or split filter, which is not stored.`
    );
    this.name = "GuardBenchmarkRateLimitedError";
  }
}

/** How often a user who is not an admin may store a benchmark of one rule set version. */
export const GUARD_BENCHMARK_STORE_INTERVAL_MS = 10 * 60_000;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export class GuardBenchmarkService {
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly guard: GuardService,
    private readonly options: { now?: () => Date } = {}
  ) {}

  /** Benchmark a saved version (the latest by default; stored) or a draft document (returned only). */
  async run(profileId: string, request: GuardBenchmarkRequest, actor: SafeUser): Promise<GuardBenchmarkResponse> {
    if (this.running) throw new GuardBenchmarkBusyError();
    this.running = true;
    try {
      const draft = request.document !== undefined;
      let profile: Awaited<ReturnType<GuardService["simulationProfile"]>>;
      if (request.document !== undefined) {
        profile = await this.guard.simulationProfile(profileId, { document: request.document });
      } else {
        const loaded = await this.guard.loadProfile(profileId, request.version);
        if (!loaded) {
          throw new GuardNotFoundError(request.version ? `Version ${request.version} of rule set '${profileId}' was not found` : `Rule set '${profileId}' not found`);
        }
        profile = { profileId, version: loaded.version, hash: loaded.hash, name: loaded.profile.name, profile: loaded.profile, inline: false };
      }
      const suites: GuardBenchmarkSuite[] = request.suites ?? ["profile"];
      const partial = (request.categories?.length ?? 0) > 0 || (request.splits !== undefined && !GUARD_BENCHMARK_SPLITS.every((split) => request.splits!.includes(split)));
      const store = !draft && !partial;
      if (store && actor.role !== "admin") await this.checkStoreInterval(profileId, profile.version);
      const report = await runGuardBenchmarkSuites({
        profile: profile.profile,
        profileRef: { profileId, version: profile.version || 1 },
        suites,
        ...(request.splits ? { splits: request.splits } : {}),
        ...(request.categories ? { categories: request.categories } : {}),
        clock: () => this.now(),
        pause: yieldToEventLoop
      });
      // Report the stored id and version, not the document's own fields (a draft keeps its rule set's id).
      report.profile = { ...report.profile, id: profileId, version: draft ? "draft" : String(profile.version) };
      const [previous] = await this.store.listGuardBenchmarks({ profileId, limit: 1 });
      const comparison = previous ? this.compare(previous, report) : null;
      let stored: GuardBenchmarkResponse["stored"] = null;
      if (store) {
        const headline = guardBenchmarkHeadline(report);
        const record: GuardBenchmarkStoredRecord = {
          id: `gbm_${randomUUID()}`,
          profileId,
          profileVersion: profile.version,
          profileHash: profile.hash,
          corpusHash: report.corpus.hash,
          suites,
          detectionRate: headline.detectionRate,
          falsePositiveRate: headline.falsePositiveRate,
          report: report as unknown as Record<string, unknown>,
          createdBy: actor.email,
          createdByUserId: actor.id,
          createdAt: report.generatedAt
        };
        await this.store.insertGuardBenchmark(record, { keep: GUARD_BENCHMARK_HISTORY_PER_PROFILE });
        stored = { id: record.id, createdAt: record.createdAt };
      }
      return {
        report,
        comparison,
        baseline: previous ? { id: previous.id, profileVersion: previous.profileVersion, createdAt: previous.createdAt } : null,
        stored,
        draft,
        partial
      };
    } finally {
      this.running = false;
    }
  }

  private async checkStoreInterval(profileId: string, version: number): Promise<void> {
    const since = this.now().getTime() - GUARD_BENCHMARK_STORE_INTERVAL_MS;
    const recent = (await this.store.listGuardBenchmarks({ profileId, limit: GUARD_BENCHMARK_HISTORY_PER_PROFILE })).find(
      (record) => record.profileVersion === version && Date.parse(record.createdAt) > since
    );
    if (recent) throw new GuardBenchmarkRateLimitedError(Math.max(1, Math.ceil((Date.parse(recent.createdAt) - since) / 1000)));
  }

  async list(profileId: string, limit?: number): Promise<GuardBenchmarkListEntry[]> {
    return (await this.store.listGuardBenchmarks({ profileId, ...(limit !== undefined ? { limit } : {}) })).map((record) => {
      const report = this.reportOf(record);
      const splits = report ? report.totals.map((entry) => ({ split: entry.split, detectionRate: entry.detectionRate, falsePositiveRate: entry.falsePositiveRate })) : [];
      const attack = report?.workflow?.results.map((result) => result.attackSuccessRate) ?? [];
      return {
        id: record.id,
        profileId: record.profileId,
        profileVersion: record.profileVersion,
        profileHash: record.profileHash,
        corpusHash: record.corpusHash,
        suites: record.suites,
        detectionRate: record.detectionRate,
        falsePositiveRate: record.falsePositiveRate,
        splits,
        attackSuccessRate: attack.length > 0 ? Math.max(...attack) : null,
        createdBy: record.createdBy,
        createdAt: record.createdAt
      };
    });
  }

  async get(id: string): Promise<{ record: Omit<GuardBenchmarkStoredRecord, "report" | "createdByUserId">; report: GuardBenchmarkReport | null } | null> {
    const record = await this.store.getGuardBenchmark(id);
    if (!record) return null;
    const { report: _report, createdByUserId: _user, ...rest } = record;
    return { record: rest, report: this.reportOf(record) };
  }

  private compare(previous: GuardBenchmarkStoredRecord, report: GuardBenchmarkReport): GuardBenchmarkJudgement | null {
    const baseline = this.reportOf(previous);
    return baseline ? judgeGuardBenchmark(report, { baseline }) : null;
  }

  /** A stored report, or null when it no longer parses (a report format this build does not read). */
  private reportOf(record: GuardBenchmarkStoredRecord): GuardBenchmarkReport | null {
    try {
      return parseGuardBenchmarkReport(record.report);
    } catch {
      return null;
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
