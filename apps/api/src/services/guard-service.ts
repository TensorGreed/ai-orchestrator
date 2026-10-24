/**
 * Phase 12.1 — Guard wiring in the API.
 *
 *   - Stored, versioned guard profiles. Every edit appends an immutable
 *     version (document, stable hash, author); runs and events record the
 *     version they used. The built-in `default` profile is seeded read-only
 *     and gains a new version only when the shipped default changes.
 *   - Bindings per project (`inherit` | `override` | `enforced`, the last
 *     admin-only) and per workflow (`inherit` | `override`). An enforced
 *     project profile is always evaluated first, so a workflow override or a
 *     guard port can only tighten it.
 *   - The run's guard dependencies for the engine: resolution, profile
 *     loading, the database-backed token vault (values sealed with the
 *     master key) and the event writer.
 *   - Guard events: one row per applied action of a verdict (one row for a
 *     clean verdict), with masked evidence only. Raw content never reaches
 *     this service: the engine passes verdict summaries.
 */

import { randomUUID } from "node:crypto";
import {
  createDefaultGuardProfile,
  diffGuardProfiles,
  guardProfileSchema,
  hashGuardProfile,
  serializeGuardProfile,
  unsafeDictionaryPattern,
  type GuardProfile,
  type GuardProfileChange,
  type TokenVaultRecord,
  type TokenVaultStorage
} from "@ai-orchestrator/guard-sdk";
import {
  GUARD_BUILTIN_PROFILE_ID,
  type GuardBindingLevel,
  type GuardBindingMode,
  type GuardEventView,
  type GuardProfileRef,
  type GuardProfileSummary,
  type GuardProfileVersionView,
  type GuardResolutionView
} from "@ai-orchestrator/shared";
import type {
  GuardRunResolution,
  GuardRuntimeDependencies,
  GuardVerdictEvent,
  ResolvedGuardProfile
} from "@ai-orchestrator/workflow-engine";
import type {
  GuardBindingRecord,
  GuardEventFilters,
  GuardEventInsert,
  GuardEventRecord,
  GuardProfileRecord,
  GuardProfileVersionRecord,
  SqliteStore
} from "../db/database.js";
import type { SecretService } from "./secret-service.js";

export interface GuardFieldIssue {
  path: string;
  message: string;
}

export class GuardValidationError extends Error {
  readonly issues: GuardFieldIssue[];
  constructor(message: string, issues: GuardFieldIssue[]) {
    super(message);
    this.name = "GuardValidationError";
    this.issues = issues;
  }
}

export class GuardConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardConflictError";
  }
}

const VAULT_PURPOSE = "guard-token-vault";
/** Option names that would carry key material inline; keys come only through `keyId` (a secret id). */
const RAW_KEY_OPTION = /^(key|keys|secret|password|value|material|keyMaterial|rawKey)$/i;

export interface GuardServiceOptions {
  /** Apply the built-in default profile when nothing is bound (GUARD_AUTO_APPLY). */
  autoApply: boolean;
  logger?: (message: string, metadata?: Record<string, unknown>) => void;
}

export interface GuardRunContext {
  executionId?: string;
  workflowId: string;
  projectId?: string | null;
  /**
   * Phase 15.3 — a replay candidate's guard profile (latest version when
   * `version` is absent), evaluated in place of the workflow's and project's
   * bindings. A project's enforced profile still runs first, unless the
   * override is a version of that same profile (then the override replaces
   * it). Verdicts record the override's profile id, version and hash.
   */
  profileOverride?: { profileId: string; version?: number };
  /**
   * Phase 15.6 — a guard policy simulation: wherever this run would apply
   * the substitute's profile (a binding, the enforced floor, a guard port
   * naming it), the substitute is applied instead. Every other profile the
   * run resolves stays as it is, so the replay shows what changing that one
   * profile would do. Never set on production traffic.
   */
  profileSubstitute?: GuardProfileSubstitute;
  /**
   * Phase 15.6 — a guard policy simulation's run: its verdicts go to the
   * simulation's sink (never to `guard_events`) and `protect` tokens to the
   * simulation's vault (never to the token vault table).
   */
  simulation?: { sink: { record(event: GuardVerdictEvent): void }; vault: TokenVaultStorage };
}

/**
 * Phase 15.6 — the profile a simulation swaps in: an unsaved document from
 * the editor (`inline`, version 0, never stored) or a saved version.
 */
export interface GuardProfileSubstitute {
  profileId: string;
  /** The saved version; 0 for an unsaved document. */
  version: number;
  hash: string;
  name: string;
  profile: GuardProfile;
  inline: boolean;
}

export class GuardService {
  constructor(
    private readonly store: SqliteStore,
    private readonly secrets: SecretService,
    private readonly options: GuardServiceOptions
  ) {}

  get autoApply(): boolean {
    return this.options.autoApply;
  }

  // -------------------------------------------------------------------------
  // Profiles
  // -------------------------------------------------------------------------

  /** Seeds the built-in default profile; appends a version when the shipped default changed. */
  ensureBuiltIns(): void {
    const shipped = createDefaultGuardProfile();
    const document = this.documentOf(shipped);
    const hash = hashGuardProfile(shipped);
    const existing = this.store.getGuardProfile(GUARD_BUILTIN_PROFILE_ID);
    if (!existing) {
      this.store.insertGuardProfile({
        id: GUARD_BUILTIN_PROFILE_ID,
        name: shipped.name,
        description: shipped.description ?? null,
        builtIn: true,
        document,
        hash,
        note: "Built-in default profile",
        createdBy: null
      });
      return;
    }
    if (existing.latestHash !== hash) {
      this.store.addGuardProfileVersion({
        profileId: GUARD_BUILTIN_PROFILE_ID,
        name: shipped.name,
        description: shipped.description ?? null,
        document,
        hash,
        note: "Built-in default profile updated",
        createdBy: null
      });
    }
  }

  /** Validates a profile document with the guard-sdk schema; field-level issues on failure. */
  validateDocument(document: unknown, idOverride?: string): GuardProfile {
    const candidate =
      document && typeof document === "object" && !Array.isArray(document)
        ? { ...(document as Record<string, unknown>), ...(idOverride ? { id: idOverride } : {}) }
        : document;
    const result = guardProfileSchema.safeParse(candidate);
    if (!result.success) {
      throw new GuardValidationError(
        "Invalid guard profile",
        result.error.issues.map((issue) => ({ path: issue.path.map(String).join(".") || "(root)", message: issue.message }))
      );
    }
    const issues: GuardFieldIssue[] = [];
    if (result.data.protection.fallback === "protect") {
      issues.push({ path: "protection.fallback", message: "The fallback cannot be 'protect'" });
    }
    for (const [dataClass, mapping] of Object.entries(result.data.protection.dataClasses)) {
      for (const [option, value] of Object.entries(mapping.options)) {
        if (RAW_KEY_OPTION.test(option)) {
          issues.push({
            path: `protection.dataClasses.${dataClass}.options.${option}`,
            message: "Keys cannot be written into a profile; store the key as a secret and set keyId to its id"
          });
        }
        if (option === "keyId") {
          const secret = typeof value === "string" ? this.store.getSecret(value) : null;
          if (!secret) {
            issues.push({ path: `protection.dataClasses.${dataClass}.options.keyId`, message: "keyId must be the id of a stored secret" });
          }
        }
      }
    }
    for (const [index, dictionary] of result.data.dictionaries.entries()) {
      for (const [patternIndex, pattern] of dictionary.patterns.entries()) {
        const unsafe = unsafeDictionaryPattern(pattern);
        if (unsafe) {
          issues.push({ path: `dictionaries.${index}.patterns.${patternIndex}`, message: unsafe });
          continue;
        }
        try {
          new RegExp(pattern, "giu");
        } catch {
          issues.push({ path: `dictionaries.${index}.patterns.${patternIndex}`, message: "Not a valid regular expression" });
        }
      }
    }
    if (issues.length > 0) throw new GuardValidationError("Invalid guard profile", issues);
    return result.data;
  }

  listProfiles(): GuardProfileSummary[] {
    return this.store.listGuardProfiles().map((record) => this.summaryOf(record));
  }

  getProfile(id: string): { profile: GuardProfileSummary; latest: GuardProfileVersionView } | null {
    const record = this.store.getGuardProfile(id);
    const latest = record ? this.store.getGuardProfileVersion(id) : null;
    if (!record || !latest) return null;
    return { profile: this.summaryOf(record), latest: this.versionView(latest) };
  }

  listVersions(id: string): GuardProfileVersionView[] {
    return this.store.listGuardProfileVersions(id).map((version) => this.versionView(version));
  }

  getVersion(id: string, version: number): GuardProfileVersionView | null {
    const record = this.store.getGuardProfileVersion(id, version);
    return record ? this.versionView(record) : null;
  }

  createProfile(input: { id?: string; document: Record<string, unknown>; note?: string }, actorId: string | null): GuardProfileSummary {
    const id = input.id ?? (typeof input.document.id === "string" ? input.document.id : undefined);
    if (!id || !/^[a-z0-9][a-z0-9_-]{1,62}$/.test(id)) {
      throw new GuardValidationError("Invalid guard profile", [{ path: "id", message: "Use 2–63 lowercase letters, digits, dashes or underscores" }]);
    }
    if (id === GUARD_BUILTIN_PROFILE_ID || this.store.getGuardProfile(id)) {
      throw new GuardConflictError(`A guard profile with id '${id}' already exists`);
    }
    const profile = this.validateDocument(input.document, id);
    const record = this.store.insertGuardProfile({
      id,
      name: profile.name,
      description: profile.description ?? null,
      document: this.documentOf(profile),
      hash: hashGuardProfile(profile),
      note: input.note ?? null,
      createdBy: actorId
    });
    return this.summaryOf(record);
  }

  /** Appends a version. An unchanged document (same hash) returns the latest version without adding one. */
  updateProfile(id: string, input: { document: Record<string, unknown>; note?: string }, actorId: string | null): { version: GuardProfileVersionView; changed: boolean } {
    const record = this.requireProfile(id);
    if (record.builtIn) throw new GuardConflictError("The built-in profile is read-only; duplicate it to change it");
    const profile = this.validateDocument(input.document, id);
    const hash = hashGuardProfile(profile);
    if (hash === record.latestHash) {
      return { version: this.versionView(this.store.getGuardProfileVersion(id)!), changed: false };
    }
    const version = this.store.addGuardProfileVersion({
      profileId: id,
      name: profile.name,
      description: profile.description ?? null,
      document: this.documentOf(profile),
      hash,
      note: input.note ?? null,
      createdBy: actorId
    });
    return { version: this.versionView(version), changed: true };
  }

  deleteProfile(id: string): void {
    const record = this.requireProfile(id);
    if (record.builtIn) throw new GuardConflictError("The built-in profile cannot be deleted");
    const bindings = this.store.listGuardBindingsForProfile(id).filter((binding) => binding.mode !== "inherit");
    if (bindings.length > 0) {
      const where = bindings.map((binding) => `${binding.scope} '${binding.scopeId}'`).join(", ");
      throw new GuardConflictError(`The profile is bound to ${where}; change those bindings first`);
    }
    this.store.deleteGuardProfile(id);
  }

  diff(id: string, from: number, to: number): { from: GuardProfileVersionView; to: GuardProfileVersionView; changes: GuardProfileChange[] } | null {
    const before = this.store.getGuardProfileVersion(id, from);
    const after = this.store.getGuardProfileVersion(id, to);
    if (!before || !after) return null;
    return { from: this.versionView(before), to: this.versionView(after), changes: diffGuardProfiles(before.document, after.document) };
  }

  /** Stable JSON of one version, for policy-as-code. */
  exportProfile(id: string, version?: number): { fileName: string; body: string; version: number; hash: string } | null {
    const record = this.store.getGuardProfileVersion(id, version);
    if (!record) return null;
    const profile = guardProfileSchema.parse(record.document);
    return { fileName: `guard-profile-${id}-v${record.version}.json`, body: serializeGuardProfile(profile), version: record.version, hash: record.hash };
  }

  /** Creates the profile, or appends a version when it exists. The document's `id` names the profile. */
  importProfile(input: { document: Record<string, unknown>; note?: string }, actorId: string | null): { profile: GuardProfileSummary; created: boolean; changed: boolean } {
    const id = typeof input.document.id === "string" ? input.document.id : "";
    const existing = id ? this.store.getGuardProfile(id) : null;
    if (!existing) {
      const profile = this.createProfile({ document: input.document, ...(input.note ? { note: input.note } : {}) }, actorId);
      return { profile, created: true, changed: true };
    }
    const result = this.updateProfile(id, { document: input.document, note: input.note ?? "Imported" }, actorId);
    return { profile: this.summaryOf(this.store.getGuardProfile(id)!), created: false, changed: result.changed };
  }

  // -------------------------------------------------------------------------
  // Bindings and resolution
  // -------------------------------------------------------------------------

  getBinding(scope: "project" | "workflow", scopeId: string): { mode: GuardBindingMode; profileId: string | null; updatedAt: string | null; updatedBy: string | null } {
    const record = this.store.getGuardBinding(scope, scopeId);
    return record
      ? { mode: record.mode as GuardBindingMode, profileId: record.profileId, updatedAt: record.updatedAt, updatedBy: record.updatedBy }
      : { mode: "inherit", profileId: null, updatedAt: null, updatedBy: null };
  }

  setBinding(scope: "project" | "workflow", scopeId: string, input: { mode: GuardBindingMode; profileId?: string | null }, actorId: string | null): GuardBindingRecord {
    if (scope === "workflow" && input.mode === "enforced") {
      throw new GuardValidationError("Invalid binding", [{ path: "mode", message: "Only a project can enforce a profile" }]);
    }
    const profileId = input.mode === "inherit" ? null : input.profileId ?? null;
    if (profileId && !this.store.getGuardProfile(profileId)) {
      throw new GuardValidationError("Invalid binding", [{ path: "profileId", message: `Guard profile '${profileId}' does not exist` }]);
    }
    return this.store.setGuardBinding({ scope, scopeId, mode: input.mode, profileId, updatedBy: actorId });
  }

  loadProfile(profileId: string, version?: number): ResolvedGuardProfile | undefined {
    const record = this.store.getGuardProfileVersion(profileId, version);
    const profileRecord = this.store.getGuardProfile(profileId);
    if (!record || !profileRecord) return undefined;
    const parsed = guardProfileSchema.safeParse(record.document);
    if (!parsed.success) {
      this.options.logger?.("Stored guard profile no longer validates; it is skipped", { profileId, version: record.version });
      return undefined;
    }
    return { profileId, version: record.version, hash: record.hash, name: profileRecord.name, profile: parsed.data };
  }

  /**
   * Resolution order for agent traffic:
   *   1. the project's enforced profile, always first;
   *   2. the workflow override, else the project override;
   *   3. otherwise the built-in default when GUARD_AUTO_APPLY is on.
   * Profiles stack: the most severe action wins and rewrites chain, so
   * anything after the enforced profile can only tighten it.
   */
  /** Phase 15.3 — why a guard profile override cannot run, or null when it can. */
  profileOverrideProblem(override: { profileId: string; version?: number }): string | null {
    const record = this.store.getGuardProfile(override.profileId);
    if (!record) return `Guard profile ${override.profileId} was not found.`;
    if (!this.loadProfile(override.profileId, override.version)) {
      return override.version !== undefined
        ? `Version ${override.version} of guard profile ${override.profileId} was not found.`
        : `Guard profile ${override.profileId} has no usable version.`;
    }
    return null;
  }

  /**
   * Phase 15.3 — a replay job's guard profile override, resolved once for
   * the whole job: the version that will run (the latest one now when the
   * override names none) and its hash. Refused when the profile or version
   * does not exist, or, for a user who is not an admin, when it is an older
   * version of a profile the workflow's project or workflow binding applies
   * now (bindings always apply the latest version): a builder cannot replay
   * under a weaker copy of the profile an admin bound.
   */
  resolveProfileOverride(
    override: { profileId: string; version?: number },
    context: { workflowId: string; projectId?: string | null; isAdmin: boolean }
  ): { ok: true; profile: { profileId: string; version: number; hash: string } } | { ok: false; problem: string } {
    const problem = this.profileOverrideProblem(override);
    if (problem) return { ok: false, problem };
    const resolved = this.loadProfile(override.profileId, override.version)!;
    if (!context.isAdmin) {
      const project = this.getBinding("project", context.projectId ?? "default");
      const workflow = this.getBinding("workflow", context.workflowId);
      const bound = [
        project.mode === "enforced" || project.mode === "override" ? { level: "project", mode: project.mode, profileId: project.profileId } : null,
        workflow.mode === "override" ? { level: "workflow", mode: workflow.mode, profileId: workflow.profileId } : null
      ].filter((entry) => entry && entry.profileId === resolved.profileId);
      const current = bound.length > 0 ? this.loadProfile(resolved.profileId) : undefined;
      if (current && resolved.version < current.version) {
        const where = bound.map((entry) => `the ${entry!.level} binding (${entry!.mode})`).join(" and ");
        return {
          ok: false,
          problem: `Guard profile ${resolved.profileId} version ${resolved.version} is older than version ${current.version}, which ${where} applies to this workflow now. Only an admin can replay under an older version of a bound profile.`
        };
      }
    }
    return { ok: true, profile: { profileId: resolved.profileId, version: resolved.version, hash: resolved.hash } };
  }

  resolveRun(context: { workflowId: string; projectId?: string | null; profileOverride?: GuardRunContext["profileOverride"]; profileSubstitute?: GuardProfileSubstitute }): GuardRunResolution {
    if (context.profileSubstitute) {
      const { profileSubstitute, ...rest } = context;
      return GuardService.substitute(this.resolveRun(rest), profileSubstitute);
    }
    if (context.profileOverride) return this.resolveOverride(context.profileOverride, context.projectId ?? "default");
    const projectId = context.projectId ?? "default";
    const project = this.getBinding("project", projectId);
    const workflow = this.getBinding("workflow", context.workflowId);
    const chain: GuardBindingLevel[] = [];
    const level = (entry: GuardBindingLevel, resolved?: ResolvedGuardProfile) => chain.push({ ...entry, ...(resolved ? { version: resolved.version } : {}) });

    const enforced = project.mode === "enforced" && project.profileId ? this.loadProfile(project.profileId) : undefined;
    const projectOverride = project.mode === "override" && project.profileId ? this.loadProfile(project.profileId) : undefined;
    const workflowOverride = workflow.mode === "override" && workflow.profileId ? this.loadProfile(workflow.profileId) : undefined;
    level({ level: "project", mode: project.mode, profileId: project.profileId }, enforced ?? projectOverride);
    level({ level: "workflow", mode: workflow.mode, profileId: workflow.profileId }, workflowOverride);

    const chosen = workflowOverride ?? projectOverride;
    const instance = !enforced && !chosen && this.options.autoApply ? this.loadProfile(GUARD_BUILTIN_PROFILE_ID) : undefined;
    level({ level: "instance", mode: this.options.autoApply ? "auto" : "off", profileId: this.options.autoApply ? GUARD_BUILTIN_PROFILE_ID : null }, instance);

    const stack: ResolvedGuardProfile[] = [];
    for (const entry of [enforced, chosen, instance]) {
      if (entry && !stack.some((existing) => existing.hash === entry.hash)) stack.push(entry);
    }
    const source: GuardRunResolution["source"] = enforced ? "enforced" : workflowOverride ? "workflow" : projectOverride ? "project" : instance ? "instance" : "none";
    return { source, ...(enforced ? { enforced } : {}), stack, chain };
  }

  /** The resolution for a candidate profile: the project's enforced floor (unless it is the same profile), then the candidate. */
  private resolveOverride(override: NonNullable<GuardRunContext["profileOverride"]>, projectId: string): GuardRunResolution {
    const candidate = this.loadProfile(override.profileId, override.version);
    if (!candidate) throw new GuardNotFoundError(this.profileOverrideProblem(override) ?? `Guard profile '${override.profileId}' not found`);
    const project = this.getBinding("project", projectId);
    const enforcedRaw = project.mode === "enforced" && project.profileId ? this.loadProfile(project.profileId) : undefined;
    const enforced = enforcedRaw && enforcedRaw.profileId !== candidate.profileId ? enforcedRaw : undefined;
    const chain: GuardBindingLevel[] = [
      { level: "project", mode: project.mode, profileId: project.profileId, ...(enforced ? { version: enforced.version } : {}) },
      { level: "candidate", mode: "override", profileId: candidate.profileId, version: candidate.version }
    ];
    const stack = enforced && enforced.hash !== candidate.hash ? [enforced, candidate] : [candidate];
    return { source: "candidate", ...(enforced ? { enforced } : {}), stack, chain };
  }

  /**
   * Phase 15.6 — a resolution with one profile swapped for a simulation's:
   * the enforced floor and every stack entry of that profile become the
   * substitute; the order, the other profiles and the source stay.
   */
  static substitute(resolution: GuardRunResolution, substitute: GuardProfileSubstitute): GuardRunResolution {
    const candidate = GuardService.substituteProfile(substitute);
    const swap = (entry: ResolvedGuardProfile) => (entry.profileId === substitute.profileId ? candidate : entry);
    const seen = new Set<string>();
    const stack = resolution.stack.map(swap).filter((entry) => (seen.has(entry.hash) ? false : (seen.add(entry.hash), true)));
    const enforced = resolution.enforced ? swap(resolution.enforced) : undefined;
    const chain = resolution.chain.map((level) =>
      level.profileId === substitute.profileId && level.version !== undefined ? { ...level, version: substitute.version } : level
    );
    return { ...resolution, ...(enforced ? { enforced } : {}), stack, chain };
  }

  private static substituteProfile(substitute: GuardProfileSubstitute): ResolvedGuardProfile {
    return { profileId: substitute.profileId, version: substitute.version, hash: substitute.hash, name: substitute.name, profile: substitute.profile };
  }

  /**
   * Phase 15.6 — the profile a simulation runs: an unsaved document
   * (validated like a save, with the profile's id; never stored) or a saved
   * version. Throws GuardValidationError for an invalid document and
   * GuardNotFoundError for a missing profile or version.
   */
  simulationProfile(profileId: string, source: { document: Record<string, unknown> } | { version: number }): GuardProfileSubstitute {
    this.requireProfile(profileId);
    if ("document" in source) {
      const profile = this.validateDocument(source.document, profileId);
      return { profileId, version: 0, hash: hashGuardProfile(profile), name: profile.name, profile, inline: true };
    }
    const loaded = this.loadProfile(profileId, source.version);
    if (!loaded) throw new GuardNotFoundError(`Version ${source.version} of guard profile '${profileId}' was not found`);
    return { profileId, version: loaded.version, hash: loaded.hash, name: loaded.profile.name, profile: loaded.profile, inline: false };
  }

  resolutionView(resolution: GuardRunResolution): GuardResolutionView {
    const ref = (entry: ResolvedGuardProfile): GuardProfileRef => ({ profileId: entry.profileId, version: entry.version, hash: entry.hash, ...(entry.name ? { name: entry.name } : {}) });
    return { source: resolution.source, enforced: resolution.enforced ? ref(resolution.enforced) : null, stack: resolution.stack.map(ref), chain: resolution.chain };
  }

  /** The engine's guard dependencies for one run. */
  runtimeFor(context: GuardRunContext): GuardRuntimeDependencies {
    const override = context.profileOverride;
    const substitute = context.profileSubstitute;
    return {
      resolveRun: () => this.resolveRun(context),
      // A guard port naming the candidate's profile gets the candidate's version too (and a simulation's profile its substitute).
      loadProfile: (profileId) =>
        substitute && substitute.profileId === profileId
          ? GuardService.substituteProfile(substitute)
          : override && override.profileId === profileId
            ? this.loadProfile(profileId, override.version)
            : this.loadProfile(profileId),
      vault: context.simulation?.vault ?? this.vault,
      onVerdict: (event) => (context.simulation ? context.simulation.sink.record(event) : this.recordVerdict(event, context))
    };
  }

  // -------------------------------------------------------------------------
  // Token vault
  // -------------------------------------------------------------------------

  /** Database-backed vault storage; the original value is sealed with the master key. */
  readonly vault: TokenVaultStorage = {
    getByToken: async (token) => this.openVaultRow(this.store.getGuardVaultByToken(token)),
    getByValueHash: async (valueHash) => this.openVaultRow(this.store.getGuardVaultByHash(valueHash)),
    put: async (record: TokenVaultRecord) => {
      this.store.putGuardVault({
        token: record.token,
        dataClass: record.dataClass,
        valueHash: record.valueHash ?? null,
        valueSealed: this.secrets.sealValue(VAULT_PURPOSE, record.value),
        createdAt: record.createdAt
      });
    }
  };

  private openVaultRow(row: ReturnType<SqliteStore["getGuardVaultByToken"]>): TokenVaultRecord | undefined {
    if (!row) return undefined;
    try {
      return {
        token: row.token,
        dataClass: row.data_class as TokenVaultRecord["dataClass"],
        value: this.secrets.openValue(VAULT_PURPOSE, row.value_sealed),
        ...(row.value_hash ? { valueHash: row.value_hash } : {}),
        createdAt: row.created_at
      };
    } catch {
      this.options.logger?.("A token vault entry could not be opened with the current master key");
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /** Writes one verdict as event rows. Only the masked summary reaches this method. */
  recordVerdict(event: GuardVerdictEvent, context: GuardRunContext): void {
    const verdictId = randomUUID();
    const createdAt = new Date().toISOString();
    const summary = event.verdict;
    const base = {
      verdictId,
      executionId: event.executionId || context.executionId || "",
      workflowId: event.workflowId || context.workflowId,
      projectId: context.projectId ?? null,
      nodeId: event.nodeId,
      placement: event.placement,
      iteration: event.iteration ?? null,
      toolName: event.toolName ?? null,
      channel: event.channel,
      verdictAction: summary.action,
      profileId: event.profile.profileId,
      profileVersion: event.profile.version,
      profileHash: event.profile.hash,
      latencyMs: summary.timings.totalMs,
      budgetExceeded: summary.budget.exceeded,
      skippedDetectors: summary.budget.skippedDetectors,
      createdAt
    };
    const rows: GuardEventInsert[] =
      summary.actions.length === 0
        ? [
            {
              ...base,
              id: randomUUID(),
              detectorId: null,
              category: null,
              dataClass: null,
              score: null,
              requestedAction: summary.action,
              effectiveAction: summary.action,
              shadow: false,
              evidence: []
            }
          ]
        : summary.actions.map((action, index) => {
            const finding = summary.findings[index];
            const matches = finding && finding.detectorId === action.detectorId;
            return {
              ...base,
              id: randomUUID(),
              detectorId: action.detectorId,
              category: action.category,
              dataClass: action.dataClass ?? null,
              score: action.score,
              requestedAction: action.requested,
              effectiveAction: action.effective,
              shadow: action.shadow,
              evidence: matches ? [{ evidence: finding.evidence, spans: finding.spans.map((span) => ({ start: span.start, end: span.end })), message: finding.message }] : []
            };
          });
    try {
      this.store.insertGuardEvents(rows);
    } catch (error) {
      this.options.logger?.("Guard events could not be written", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  listEvents(filters: GuardEventFilters & { limit?: number; offset?: number }): { events: GuardEventView[]; total: number } {
    const { events, total } = this.store.listGuardEvents(filters);
    return { events: events.map(toEventView), total };
  }

  eventsForExecution(executionId: string): GuardEventView[] {
    return this.store.listGuardEventsForExecution(executionId).map(toEventView);
  }

  stats(filters: GuardEventFilters) {
    return this.store.guardEventStats(filters);
  }

  // -------------------------------------------------------------------------

  private requireProfile(id: string): GuardProfileRecord {
    const record = this.store.getGuardProfile(id);
    if (!record) throw new GuardNotFoundError(`Guard profile '${id}' not found`);
    return record;
  }

  private documentOf(profile: GuardProfile): Record<string, unknown> {
    return JSON.parse(serializeGuardProfile(profile)) as Record<string, unknown>;
  }

  private summaryOf(record: GuardProfileRecord): GuardProfileSummary {
    return {
      id: record.id,
      name: record.name,
      ...(record.description ? { description: record.description } : {}),
      builtIn: record.builtIn,
      ...(this.store.listGuardBindingsForProfile(record.id).some((binding) => binding.scope === "project" && binding.mode === "enforced") ? { enforced: true } : {}),
      latestVersion: record.latestVersion,
      hash: record.latestHash,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      createdBy: record.createdBy
    };
  }

  private versionView(record: GuardProfileVersionRecord): GuardProfileVersionView {
    return {
      profileId: record.profileId,
      version: record.version,
      hash: record.hash,
      document: record.document,
      author: record.createdBy,
      note: record.note,
      createdAt: record.createdAt
    };
  }
}

export class GuardNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardNotFoundError";
  }
}

function toEventView(record: GuardEventRecord): GuardEventView {
  return {
    id: record.id,
    verdictId: record.verdictId,
    executionId: record.executionId,
    workflowId: record.workflowId,
    projectId: record.projectId,
    nodeId: record.nodeId,
    iteration: record.iteration,
    channel: record.channel as GuardEventView["channel"],
    placement: record.placement === "agent" ? "agent" : "node",
    toolName: record.toolName,
    detectorId: record.detectorId,
    category: record.category,
    dataClass: record.dataClass,
    score: record.score,
    requestedAction: record.requestedAction as GuardEventView["requestedAction"],
    effectiveAction: record.effectiveAction as GuardEventView["effectiveAction"],
    verdictAction: record.verdictAction as GuardEventView["verdictAction"],
    shadow: record.shadow,
    evidence: record.evidence.map((entry) => ({
      detectorId: record.detectorId ?? "",
      category: record.category ?? "",
      ...(record.dataClass ? { dataClass: record.dataClass } : {}),
      score: record.score ?? 0,
      evidence: entry.evidence,
      spans: entry.spans,
      message: entry.message
    })),
    profileId: record.profileId,
    profileVersion: record.profileVersion,
    profileHash: record.profileHash,
    latencyMs: record.latencyMs,
    budgetExceeded: record.budgetExceeded,
    skippedDetectors: record.skippedDetectors,
    createdAt: record.createdAt
  };
}
