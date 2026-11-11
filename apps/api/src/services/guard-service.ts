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
  guardProfileDisplayName,
  diffGuardProfiles,
  guardProfileSchema,
  hashGuardProfile,
  profileHasDestinationRules,
  profileUsesLabels,
  serializeGuardProfile,
  outputCheckCustomEndpoints,
  outputCheckModelUses,
  outputCheckOptionIssues,
  outputCheckSecretRefs,
  unsafeDictionaryPattern,
  type GuardProfile,
  type GuardProfileChange,
  type TokenVaultRecord,
  type TokenVaultStorage
} from "@ai-orchestrator/guard-sdk";
import {
  DEFAULT_PROJECT_ID,
  DESTINATION_PREVIEW_SIMULATION_PROFILE,
  DESTINATION_RULES_OBSERVING_DAYS,
  GUARD_BUILTIN_PROFILE_ID,
  GUARD_DESTINATION_RULES_PROFILE_ID,
  GUARD_DESTINATION_RULES_PROFILE_NAME,
  STARTER_DESTINATION_RULE,
  STARTER_DESTINATION_RULE_NAME,
  destinationRulesMode,
  parseGuardPlacement,
  REVEAL_EVENT_DETECTOR_ID,
  type DataDestinationRow,
  type DestinationRuleView,
  type GatewayGuardProfileRef,
  type DestinationRulesStatus,
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
  GuardRevealEvent,
  GuardRuntimeDependencies,
  GuardVerdictEvent,
  ResolvedGuardProfile
} from "@ai-orchestrator/workflow-engine";
import type {
  GuardBindingRecord,
  GuardBindingScope,
  GuardEventFilters,
  GuardEventInsert,
  GuardEventRecord,
  GuardProfileRecord,
  GuardProfileVersionRecord
} from "../db/database.js";
import type { SecretService } from "./secret-service.js";
import type { AuditEventInput } from "./audit-service.js";
import type { Store } from "../db/store.js";
import { filterAsync, mapAsync } from "../async-array.js";

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

/** Phase 16 — profile ids no one creates or imports: the deployment's destination rules and the Preview impact pseudo profile. */
const RESERVED_GUARD_PROFILE_IDS: ReadonlySet<string> = new Set([GUARD_DESTINATION_RULES_PROFILE_ID, DESTINATION_PREVIEW_SIMULATION_PROFILE]);

export interface GuardServiceOptions {
  /** Apply the built-in default profile when nothing is bound (GUARD_AUTO_APPLY). */
  autoApply: boolean;
  /**
   * Phase 12 coverage (D13, GATEWAY_RULES_WITHOUT_BINDING) — the project's enforced rule set and the deployment's
   * destination rules check gateway calls with no toolset, route set or client binding. Default true.
   */
  gatewayRulesWithoutBinding?: boolean;
  logger?: (message: string, metadata?: Record<string, unknown>) => void;
  /** Phase 16 — the deployment's data destination rows, read when a run first needs them (once per run). */
  destinationRows?: () => Promise<DataDestinationRow[]>;
  /** Phase 16 — the deployment surrogate key (HKDF `l2m/capture-surrogate/v1`), for runtime surrogates. */
  surrogateKey?: Uint8Array;
  /** Phase 12 coverage — writes an audit log entry (a Reveal node's `content_rules.reveal`). */
  audit?: (event: AuditEventInput) => Promise<unknown>;
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
   * 12.7 — an eval run's rule set: added after everything the run would
   * apply anyway (enforced, workflow and project bindings, the auto-applied
   * default rule set) and before the deployment's destination rules. It
   * never replaces a rule set, so a looser choice cannot weaken the run.
   */
  profileAddition?: { profileId: string; version?: number };
  /**
   * 12.7 — `eval`: the run is an eval run or a replay job, so its verdicts are
   * stored with `run_source = 'eval'` and the Security page leaves them out
   * by default (the run's own trace still shows them).
   */
  runSource?: "eval";
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
  /**
   * Phase 16 — the run's issued surrogates (in memory, one set per run). The
   * caller keeps a reference so capture masking can leave them as they are.
   */
  issuedSurrogates?: Set<string>;
  /** Phase 16 — a destination preview's unsaved rows, used in place of the stored rows. Never set on production traffic. */
  destinationRows?: DataDestinationRow[];
  /**
   * 12.6 — a run an MCP gateway call started: the toolset's and client's profiles (pinned versions) that applied to
   * the call. They are added after the run's own profiles, so they only tighten. A version that no longer exists
   * fails the run's Guard resolution rather than running without it.
   */
  gatewayStack?: GatewayGuardProfileRef[];
}

/** 12.6 — what a gateway server tool call's Guard checks know about the call. */
export interface GatewayGuardContext {
  /**
   * The call's synthetic execution id (`mcpgw_*`): a server tool call's telemetry row shares it. A workflow tool's
   * run has its own id; the gateway's checks are kept apart from the run's events.
   */
  executionId: string;
  /** A workflow tool's workflow; absent for a server tool (its events have no workflow). */
  workflowId?: string;
  toolsetId: string;
  clientId: string;
  /** The toolset's project; null when it has none. */
  projectId: string | null;
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

/**
 * Phase 12 coverage — the vault scope of tokens a gateway toolset or route set without a project issues. No workflow
 * run's project matches it, so no Reveal node reveals them.
 */
export function gatewayVaultScope(toolsetId: string): string {
  return `gateway:${toolsetId}`;
}

/** Parsed guard profile versions kept per service (a version's document never changes). */
const PARSED_PROFILE_CACHE_SIZE = 256;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

/** Who saves a rule set, for the checks that depend on it (secrets a check's model may use, custom model addresses). */
export interface GuardSaveActor {
  admin: boolean;
  /** True when this user may use the secret in a run (`secret:use` in its project or a project it is shared to). */
  canUseSecret: (secretId: string) => Promise<boolean>;
}

/** Bindings that check /v1 AI gateway answers. */
const GATEWAY_ANSWER_SCOPES: ReadonlySet<string> = new Set(["ai_route_set", "mcp_client"]);
const GATEWAY_MODEL_CHECK_MESSAGE = "Checks that call a model (safety by model, topics by meaning, the grounding judge) do not run on AI gateway answers yet";

export class GuardService {
  private readonly parsedProfiles = new Map<string, GuardProfile>();
  private readonly loadedProfiles = new Map<string, { revision: number; value: ResolvedGuardProfile | undefined }>();
  /** The deployment's destination rules profile, per guard profile revision (read on every gateway call). */
  private deploymentProfileCache: { revision: number; value: ResolvedGuardProfile | undefined } | undefined;

  constructor(
    private readonly store: Store,
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
  async ensureBuiltIns(): Promise<void> {
    const shipped = createDefaultGuardProfile();
    const document = this.documentOf(shipped);
    const hash = hashGuardProfile(shipped);
    // Idempotent: several instances may boot on one database at once.
    const existing = await this.store.getGuardProfile(GUARD_BUILTIN_PROFILE_ID);
    if (!existing) {
      await this.store.insertGuardProfile({
        id: GUARD_BUILTIN_PROFILE_ID,
        name: guardProfileDisplayName(GUARD_BUILTIN_PROFILE_ID, shipped.name),
        description: shipped.description ?? null,
        builtIn: true,
        document,
        hash,
        note: "Built-in default rule set",
        createdBy: null
      }, { ifAbsent: true });
      return;
    }
    if (existing.latestHash !== hash) {
      await this.store.addGuardProfileVersion({
        profileId: GUARD_BUILTIN_PROFILE_ID,
        name: guardProfileDisplayName(GUARD_BUILTIN_PROFILE_ID, shipped.name),
        description: shipped.description ?? null,
        document,
        hash,
        note: "Built-in default rule set updated",
        createdBy: null
      }, { unlessLatestHash: true });
    }
  }

  /** Validates a profile document with the guard-sdk schema; field-level issues on failure. */
  async validateDocument(document: unknown, idOverride?: string, actor?: GuardSaveActor): Promise<GuardProfile> {
    const candidate =
      document && typeof document === "object" && !Array.isArray(document)
        ? { ...(document as Record<string, unknown>), ...(idOverride ? { id: idOverride } : {}) }
        : document;
    const result = guardProfileSchema.safeParse(candidate);
    if (!result.success) {
      throw new GuardValidationError(
        "Invalid rule set",
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
            message: "Keys cannot be written into a rule set; store the key as a secret and set keyId to its id"
          });
        }
        if (option === "keyId") {
          const secret = typeof value === "string" ? await this.store.getSecret(value) : null;
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
    // Phase 12 coverage — output checks: a schema that compiles, topics that name this rule set's dictionaries, model
    // configs that name stored secrets (never raw keys).
    issues.push(...outputCheckOptionIssues(result.data));
    // A check's model runs with the key it names whenever the rule set runs, for whoever starts the run: the person
    // saving it must be allowed to use that key (one message for missing and not allowed, so ids cannot be probed).
    for (const ref of outputCheckSecretRefs(result.data)) {
      const usable = (await this.store.getSecret(ref.secretId)) !== null && (!actor || (await actor.canUseSecret(ref.secretId)));
      if (!usable) issues.push({ path: ref.path, message: "secretId must name a stored secret you may use" });
    }
    // A custom address would receive that key: only an admin may set one.
    if (actor && !actor.admin) {
      for (const endpoint of outputCheckCustomEndpoints(result.data)) {
        issues.push({ path: endpoint.path, message: "Only an admin can send a check's model calls to a custom address; leave it out to use the provider's own endpoint" });
      }
    }
    if (issues.length > 0) throw new GuardValidationError("Invalid rule set", issues);
    return result.data;
  }

  async listProfiles(): Promise<GuardProfileSummary[]> {
    return await mapAsync(await this.store.listGuardProfiles(), (record) => this.summaryOf(record));
  }

  async getProfile(id: string): Promise<{ profile: GuardProfileSummary; latest: GuardProfileVersionView } | null> {
    const record = await this.store.getGuardProfile(id);
    const latest = record ? await this.store.getGuardProfileVersion(id) : null;
    if (!record || !latest) return null;
    return { profile: await this.summaryOf(record), latest: this.versionView(latest) };
  }

  async listVersions(id: string): Promise<GuardProfileVersionView[]> {
    return (await this.store.listGuardProfileVersions(id)).map((version) => this.versionView(version));
  }

  async getVersion(id: string, version: number): Promise<GuardProfileVersionView | null> {
    const record = await this.store.getGuardProfileVersion(id, version);
    return record ? this.versionView(record) : null;
  }

  async createProfile(
    input: { id?: string; document: Record<string, unknown>; note?: string },
    actorId: string | null,
    options: { reserved?: boolean; actor?: GuardSaveActor } = {}
  ): Promise<GuardProfileSummary> {
    const id = input.id ?? (typeof input.document.id === "string" ? input.document.id : undefined);
    if (!id || !/^[a-z0-9][a-z0-9_-]{1,62}$/.test(id)) {
      throw new GuardValidationError("Invalid rule set", [{ path: "id", message: "Use 2–63 lowercase letters, digits, dashes or underscores" }]);
    }
    // Phase 16 — reserved ids: the deployment's destination rules (made on the Security page) and the Preview impact pseudo profile.
    if (!options.reserved && RESERVED_GUARD_PROFILE_IDS.has(id)) {
      throw new GuardValidationError("Invalid rule set", [
        { path: "id", message: `'${id}' is reserved for the deployment's destination rules; set those up under Security → Data destinations` }
      ]);
    }
    if (id === GUARD_BUILTIN_PROFILE_ID || await this.store.getGuardProfile(id)) {
      throw new GuardConflictError(`A rule set with id '${id}' already exists`);
    }
    const profile = await this.validateDocument(input.document, id, options.actor);
    const record = await this.store.insertGuardProfile({
      id,
      name: profile.name,
      description: profile.description ?? null,
      document: this.documentOf(profile),
      hash: hashGuardProfile(profile),
      note: input.note ?? null,
      createdBy: actorId
    });
    return await this.summaryOf(record);
  }

  /** Appends a version. An unchanged document (same hash) returns the latest version without adding one. */
  async updateProfile(
    id: string,
    input: { document: Record<string, unknown>; note?: string },
    actorId: string | null,
    actor?: GuardSaveActor
  ): Promise<{ version: GuardProfileVersionView; changed: boolean }> {
    const record = await this.requireProfile(id);
    if (record.builtIn) throw new GuardConflictError("The built-in rule set is read-only; duplicate it to change it");
    const profile = await this.validateDocument(input.document, id, actor);
    await this.refuseModelChecksOnGateway(id, profile);
    const hash = hashGuardProfile(profile);
    if (hash === record.latestHash) {
      return { version: this.versionView((await this.store.getGuardProfileVersion(id))!), changed: false };
    }
    const version = await this.store.addGuardProfileVersion({
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

  /**
   * Phase 12 coverage — model-backed output checks do not run on /v1 AI gateway answers yet (the gateway offers no
   * model calls, so they would fail every answer): a rule set bound to an AI route set or a client cannot gain one.
   */
  private async refuseModelChecksOnGateway(id: string, profile: GuardProfile): Promise<void> {
    const uses = outputCheckModelUses(profile);
    if (uses.length === 0) return;
    const bound = await filterAsync(
      (await this.store.listGuardBindingsForProfile(id)).filter((binding) => binding.mode !== "inherit" && GATEWAY_ANSWER_SCOPES.has(binding.scope)),
      async (binding) => await this.bindingInForce(binding)
    );
    if (bound.length === 0) return;
    const where = bound.map((binding) => `${binding.scope} '${binding.scopeId}'`).join(", ");
    throw new GuardValidationError("Invalid rule set", uses.map((use) => ({ path: use.path, message: `${GATEWAY_MODEL_CHECK_MESSAGE}; the rule set is bound to ${where}` })));
  }

  async deleteProfile(id: string): Promise<void> {
    const record = await this.requireProfile(id);
    if (record.builtIn) throw new GuardConflictError("The built-in rule set cannot be deleted");
    const bindings = await filterAsync(
      (await this.store.listGuardBindingsForProfile(id)).filter((binding) => binding.mode !== "inherit"),
      async (binding) => await this.bindingInForce(binding)
    );
    if (bindings.length > 0) {
      const where = bindings.map((binding) => `${binding.scope} '${binding.scopeId}'`).join(", ");
      throw new GuardConflictError(`The rule set is bound to ${where}; change those bindings first`);
    }
    await this.store.deleteGuardProfile(id);
  }

  async diff(id: string, from: number, to: number): Promise<{ from: GuardProfileVersionView; to: GuardProfileVersionView; changes: GuardProfileChange[] } | null> {
    const before = await this.store.getGuardProfileVersion(id, from);
    const after = await this.store.getGuardProfileVersion(id, to);
    if (!before || !after) return null;
    return { from: this.versionView(before), to: this.versionView(after), changes: diffGuardProfiles(before.document, after.document) };
  }

  /** Stable JSON of one version, for policy-as-code. */
  async exportProfile(id: string, version?: number): Promise<{ fileName: string; body: string; version: number; hash: string } | null> {
    const record = await this.store.getGuardProfileVersion(id, version);
    if (!record) return null;
    const profile = guardProfileSchema.parse(displayedDocument(record.profileId, record.document));
    return { fileName: `rule-set-${id}-v${record.version}.json`, body: serializeGuardProfile(profile), version: record.version, hash: record.hash };
  }

  /** Creates the profile, or appends a version when it exists. The document's `id` names the profile. */
  async importProfile(
    input: { document: Record<string, unknown>; note?: string },
    actorId: string | null,
    actor?: GuardSaveActor
  ): Promise<{ profile: GuardProfileSummary; created: boolean; changed: boolean }> {
    const id = typeof input.document.id === "string" ? input.document.id : "";
    if (RESERVED_GUARD_PROFILE_IDS.has(id)) {
      throw new GuardValidationError("Invalid rule set", [
        { path: "id", message: `'${id}' is reserved for the deployment's destination rules; set those up under Security → Data destinations` }
      ]);
    }
    const existing = id ? await this.store.getGuardProfile(id) : null;
    if (!existing) {
      const profile = await this.createProfile({ document: input.document, ...(input.note ? { note: input.note } : {}) }, actorId, actor ? { actor } : {});
      return { profile, created: true, changed: true };
    }
    const result = await this.updateProfile(id, { document: input.document, note: input.note ?? "Imported" }, actorId, actor);
    return { profile: await this.summaryOf((await this.store.getGuardProfile(id))!), created: false, changed: result.changed };
  }

  // -------------------------------------------------------------------------
  // Bindings and resolution
  // -------------------------------------------------------------------------

  async getBinding(scope: GuardBindingScope, scopeId: string): Promise<{ mode: GuardBindingMode; profileId: string | null; updatedAt: string | null; updatedBy: string | null }> {
    const record = await this.store.getGuardBinding(scope, scopeId);
    return record
      ? { mode: record.mode as GuardBindingMode, profileId: record.profileId, updatedAt: record.updatedAt, updatedBy: record.updatedBy }
      : { mode: "inherit", profileId: null, updatedAt: null, updatedBy: null };
  }

  async setBinding(scope: GuardBindingScope, scopeId: string, input: { mode: GuardBindingMode; profileId?: string | null }, actorId: string | null): Promise<GuardBindingRecord> {
    if (scope !== "project" && input.mode === "enforced") {
      throw new GuardValidationError("Invalid binding", [{ path: "mode", message: "Only a project can enforce a rule set" }]);
    }
    // 12.6 — the deployment's destination rules already apply wherever a gateway profile applies; never bound by name.
    if ((scope === "toolset" || scope === "mcp_client" || scope === "ai_route_set") && input.profileId === GUARD_DESTINATION_RULES_PROFILE_ID) {
      throw new GuardValidationError("Invalid binding", [{ path: "profileId", message: "The deployment's destination rules apply on their own; pick another rule set" }]);
    }
    const profileId = input.mode === "inherit" ? null : input.profileId ?? null;
    if (profileId && !await this.store.getGuardProfile(profileId)) {
      throw new GuardValidationError("Invalid binding", [{ path: "profileId", message: `Rule set '${profileId}' does not exist` }]);
    }
    if (profileId && GATEWAY_ANSWER_SCOPES.has(scope)) {
      const loaded = await this.loadProfile(profileId);
      const uses = loaded ? outputCheckModelUses(loaded.profile) : [];
      if (uses.length > 0) {
        throw new GuardValidationError("Invalid binding", [{ path: "profileId", message: `${GATEWAY_MODEL_CHECK_MESSAGE} (${[...new Set(uses.map((use) => use.detectorId))].join(", ")})` }]);
      }
    }
    return await this.store.setGuardBinding({ scope, scopeId, mode: input.mode, profileId, updatedBy: actorId });
  }

  /**
   * 12.6 — a deleted toolset or a revoked client no longer has a Guard binding: an override is set back to inherit.
   * Returns the binding it replaced, or null when there was none.
   */
  async clearGatewayBinding(scope: "toolset" | "mcp_client" | "ai_route_set", scopeId: string, actorId: string | null): Promise<{ mode: GuardBindingMode; profileId: string | null } | null> {
    const current = await this.store.getGuardBinding(scope, scopeId);
    if (!current || current.mode === "inherit") return null;
    await this.store.setGuardBinding({ scope, scopeId, mode: "inherit", profileId: null, updatedBy: actorId });
    return { mode: current.mode as GuardBindingMode, profileId: current.profileId };
  }

  /** 12.6 — a gateway binding of a deleted toolset or a revoked client applies to nothing (and blocks no profile delete). */
  private async bindingInForce(binding: GuardBindingRecord): Promise<boolean> {
    if (binding.scope === "toolset") return Boolean(await this.store.getMcpToolset(binding.scopeId));
    if (binding.scope === "ai_route_set") return Boolean(await this.store.getAiGatewayRouteSet(binding.scopeId));
    if (binding.scope === "mcp_client") {
      const client = await this.store.getMcpClient(binding.scopeId);
      return Boolean(client && !client.revokedAt);
    }
    return true;
  }

  async loadProfile(profileId: string, version?: number): Promise<ResolvedGuardProfile | undefined> {
    // Phase 16 — every run that resolves its guard stack loads the same profiles: the answer is kept per guard profile
    // revision, a counter in the database bumped by triggers on every profile write from any process. It is read on
    // every load, so a profile another instance saved is what the next run here resolves (never an in-process count).
    const revision = await this.store.guardProfileRevision?.();
    const loadKey = `${profileId}\u0000${version ?? "latest"}`;
    const known = revision === undefined ? undefined : this.loadedProfiles.get(loadKey);
    if (known && known.revision === revision) return known.value;
    const value = await this.readProfile(profileId, version);
    if (revision !== undefined) {
      if (this.loadedProfiles.size >= PARSED_PROFILE_CACHE_SIZE) this.loadedProfiles.delete(this.loadedProfiles.keys().next().value!);
      this.loadedProfiles.set(loadKey, { revision, value });
    }
    return value;
  }

  private async readProfile(profileId: string, version?: number): Promise<ResolvedGuardProfile | undefined> {
    const record = await this.store.getGuardProfileVersion(profileId, version);
    const profileRecord = await this.store.getGuardProfile(profileId);
    if (!record || !profileRecord) return undefined;
    // Phase 16 — a stored version never changes: its validated document is parsed once and reused (frozen, so no
    // caller can change it for the next run). Every run resolves the built-in default; this keeps that cheap.
    const cacheKey = `${profileId}\u0000${record.version}\u0000${record.hash}`;
    let profile = this.parsedProfiles.get(cacheKey);
    if (!profile) {
      const parsed = guardProfileSchema.safeParse(record.document);
      if (!parsed.success) {
        this.options.logger?.("Stored guard profile no longer validates; it is skipped", { profileId, version: record.version });
        return undefined;
      }
      profile = deepFreeze(parsed.data);
      if (this.parsedProfiles.size >= PARSED_PROFILE_CACHE_SIZE) this.parsedProfiles.delete(this.parsedProfiles.keys().next().value!);
      this.parsedProfiles.set(cacheKey, profile);
    }
    return { profileId, version: record.version, hash: record.hash, name: guardProfileDisplayName(profileId, profileRecord.name), profile };
  }

  /**
   * Phase 16 — false when no stored profile version asks for propagated
   * labels: a run then learns it does not track labels without resolving its
   * profiles (zero-config runs pay this one cached check). Fails open: a
   * store error answers true, so the run takes the full resolution path
   * (which reports its own failures where they are used) instead of every
   * run failing at start.
   */
  async mayUseLabels(): Promise<boolean> {
    try {
      return await this.store.anyGuardProfileUsesLabels();
    } catch (error) {
      this.options.logger?.("Guard profile labels check failed; resolving the run's profiles instead", {
        error: error instanceof Error ? error.message : String(error)
      });
      return true;
    }
  }

  /**
   * Phase 12 coverage — false when no stored profile version configures this channel (`response`, `trigger_input`):
   * webhook, chat and MCP trigger runs then skip the boundary check without resolving their profiles. Fails open
   * like `mayUseLabels`: a store error answers true, and the check resolves (and fails closed if that fails too).
   */
  async mayCheckChannel(channel: "response" | "trigger_input"): Promise<boolean> {
    try {
      return await this.store.anyGuardProfileHasChannel(channel);
    } catch (error) {
      this.options.logger?.("Rule set channel check failed; resolving the run's rule sets instead", {
        channel,
        error: error instanceof Error ? error.message : String(error)
      });
      return true;
    }
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
  async profileOverrideProblem(override: { profileId: string; version?: number }): Promise<string | null> {
    const record = await this.store.getGuardProfile(override.profileId);
    if (!record) return `Rule set ${override.profileId} was not found.`;
    if (!await this.loadProfile(override.profileId, override.version)) {
      return override.version !== undefined
        ? `Version ${override.version} of rule set ${override.profileId} was not found.`
        : `Rule set ${override.profileId} has no usable version.`;
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
  async resolveProfileOverride(
    override: { profileId: string; version?: number },
    context: { workflowId: string; projectId?: string | null; isAdmin: boolean }
  ): Promise<{ ok: true; profile: { profileId: string; version: number; hash: string } } | { ok: false; problem: string; forbidden?: boolean }> {
    // Phase 16 — the deployment's destination rules are never a builder's candidate: they always run anyway (latest version).
    if (override.profileId === GUARD_DESTINATION_RULES_PROFILE_ID && !context.isAdmin) {
      return {
        ok: false,
        forbidden: true,
        problem: "The deployment's destination rules always apply to replays and release-gate cases; only an admin can choose them as the rule set under test."
      };
    }
    const problem = await this.profileOverrideProblem(override);
    if (problem) return { ok: false, problem };
    const resolved = (await this.loadProfile(override.profileId, override.version))!;
    if (!context.isAdmin) {
      const project = await this.getBinding("project", context.projectId ?? "default");
      const workflow = await this.getBinding("workflow", context.workflowId);
      const bound = [
        project.mode === "enforced" || project.mode === "override" ? { level: "project", mode: project.mode, profileId: project.profileId } : null,
        workflow.mode === "override" ? { level: "workflow", mode: workflow.mode, profileId: workflow.profileId } : null
      ].filter((entry) => entry && entry.profileId === resolved.profileId);
      const current = bound.length > 0 ? await this.loadProfile(resolved.profileId) : undefined;
      if (current && resolved.version < current.version) {
        const where = bound.map((entry) => `the ${entry!.level} binding (${entry!.mode})`).join(" and ");
        return {
          ok: false,
          problem: `Rule set ${resolved.profileId} version ${resolved.version} is older than version ${current.version}, which ${where} applies to this workflow now. Only an admin can replay under an older version of a bound rule set.`
        };
      }
    }
    return { ok: true, profile: { profileId: resolved.profileId, version: resolved.version, hash: resolved.hash } };
  }

  async resolveRun(context: {
    workflowId: string;
    projectId?: string | null;
    profileOverride?: GuardRunContext["profileOverride"];
    profileAddition?: GuardRunContext["profileAddition"];
    profileSubstitute?: GuardProfileSubstitute;
    gatewayStack?: GatewayGuardProfileRef[];
  }): Promise<GuardRunResolution> {
    const { gatewayStack, ...own } = context;
    const resolution = await this.resolveRunOwn(own);
    // 12.6 — a run a gateway call started: the toolset's and client's profiles after the run's own (tighten-only).
    if (!gatewayStack || gatewayStack.length === 0) return resolution;
    const withGateway = GuardService.withGateway(resolution, await this.loadGatewayStack(gatewayStack));
    // A simulated profile also bound at the gateway replaces those pinned entries, so the candidate is what runs.
    return context.profileSubstitute ? GuardService.substitute(withGateway, context.profileSubstitute) : withGateway;
  }

  private async resolveRunOwn(context: {
    workflowId: string;
    projectId?: string | null;
    profileOverride?: GuardRunContext["profileOverride"];
    profileAddition?: GuardRunContext["profileAddition"];
    profileSubstitute?: GuardProfileSubstitute;
  }): Promise<GuardRunResolution> {
    if (context.profileSubstitute) {
      const { profileSubstitute, ...rest } = context;
      return GuardService.substitute(await this.resolveRun(rest), profileSubstitute);
    }
    if (context.profileAddition) {
      const { profileAddition, ...rest } = context;
      return await this.withAddition(await this.resolveRunOwn(rest), profileAddition);
    }
    if (context.profileOverride) return await this.resolveOverride(context.profileOverride, context.projectId ?? "default");
    const projectId = context.projectId ?? "default";
    const project = await this.getBinding("project", projectId);
    const workflow = await this.getBinding("workflow", context.workflowId);
    const chain: GuardBindingLevel[] = [];
    const level = (entry: GuardBindingLevel, resolved?: ResolvedGuardProfile) => chain.push({ ...entry, ...(resolved ? { version: resolved.version } : {}) });

    const enforced = project.mode === "enforced" && project.profileId ? await this.loadProfile(project.profileId) : undefined;
    const projectOverride = project.mode === "override" && project.profileId ? await this.loadProfile(project.profileId) : undefined;
    const workflowOverride = workflow.mode === "override" && workflow.profileId ? await this.loadProfile(workflow.profileId) : undefined;
    level({ level: "project", mode: project.mode, profileId: project.profileId }, enforced ?? projectOverride);
    level({ level: "workflow", mode: workflow.mode, profileId: workflow.profileId }, workflowOverride);

    const chosen = workflowOverride ?? projectOverride;
    const instance = !enforced && !chosen && this.options.autoApply ? await this.loadProfile(GUARD_BUILTIN_PROFILE_ID) : undefined;
    level({ level: "instance", mode: this.options.autoApply ? "auto" : "off", profileId: this.options.autoApply ? GUARD_BUILTIN_PROFILE_ID : null }, instance);

    const stack: ResolvedGuardProfile[] = [];
    for (const entry of [enforced, chosen, instance]) {
      if (entry && !stack.some((existing) => existing.hash === entry.hash)) stack.push(entry);
    }
    const source: GuardRunResolution["source"] = enforced ? "enforced" : workflowOverride ? "workflow" : projectOverride ? "project" : instance ? "instance" : "none";
    return GuardService.withDeployment({ source, ...(enforced ? { enforced } : {}), stack, chain }, await this.deploymentProfile());
  }

  /** 12.6 — the pinned versions a gateway-triggered run carries; a missing one fails closed. */
  private async loadGatewayStack(refs: readonly GatewayGuardProfileRef[]): Promise<ResolvedGuardProfile[]> {
    const loaded: ResolvedGuardProfile[] = [];
    for (const ref of refs) {
      const profile = await this.loadProfile(ref.profileId, ref.version);
      if (!profile) {
        throw new GuardNotFoundError(
          `Rule set '${ref.profileId}' version ${ref.version}, which the MCP gateway applied to this run, no longer exists; the run cannot be checked without it.`
        );
      }
      loaded.push(profile);
    }
    return loaded;
  }

  /** 12.6 — adds a gateway stack after a resolution's own profiles and before the deployment's destination rules. */
  private static withGateway(resolution: GuardRunResolution, gateway: ResolvedGuardProfile[]): GuardRunResolution {
    const deployment = resolution.deployment;
    const last = resolution.stack[resolution.stack.length - 1];
    const tail = deployment && last === deployment ? [deployment] : [];
    const head = tail.length > 0 ? resolution.stack.slice(0, -1) : resolution.stack;
    // A profile the run's own binding also applies stays the run's own: `ownStack` (the stack without the gateway's
    // additions) is what a Guard node's effective choice reads, and the chain lists the profile at both levels.
    const seen = new Set(head.map((entry) => entry.hash));
    const added = gateway.filter((entry) => (seen.has(entry.hash) ? false : (seen.add(entry.hash), true)));
    const stack = [...head, ...added, ...tail.filter((entry) => !seen.has(entry.hash))];
    const ownStack = [...head, ...tail];
    const levels: GuardBindingLevel[] = gateway.map((entry) => ({ level: "gateway", mode: "override", profileId: entry.profileId, version: entry.version }));
    const at = resolution.chain.findIndex((level) => level.level === "destinations");
    const chain = at < 0 ? [...resolution.chain, ...levels] : [...resolution.chain.slice(0, at), ...levels, ...resolution.chain.slice(at)];
    return { ...resolution, stack, chain, gateway, ownStack };
  }

  /**
   * 12.6 — the Guard stack of a call through the MCP gateway, for a toolset and the client calling it:
   *   1. the toolset's project's enforced profile, first;
   *   2. the toolset's profile, then the client's (each `override`, admin-set);
   *   3. the built-in default when GUARD_AUTO_APPLY is on and nothing above applies (as in runs);
   *   4. the deployment's destination rules, last.
   * Stacked like a run's: the most severe action wins, so each later profile only tightens.
   *
   * With neither a toolset nor a client binding, the project's enforced rule set and the deployment's destination
   * rules still apply (Phase 12 coverage, D13: an admin who enforces a rule set on a project expects its gateways
   * covered too). With none of the four, the stack is empty and the gateway runs no content rules, exactly as before.
   * GUARD_AUTO_APPLY and the built-in rule set never apply to gateway calls. `refs`: the profiles a workflow tool's run
   * carries (pinned; the deployment's rules apply to runs anyway).
   */
  async resolveGateway(context: {
    toolsetId: string;
    clientId: string;
    projectId?: string | null;
    /** 12.6b — `ai_route_set`: `toolsetId` is an AI gateway route set, whose binding stands where a toolset's does. */
    setScope?: "toolset" | "ai_route_set";
  }): Promise<{ resolution: GuardRunResolution; refs: GatewayGuardProfileRef[] }> {
    // One read for the three bindings (toolset or route set, client, project); the deployment's destination rules are
    // kept per profile revision (D13).
    const bindings = await this.store.getGatewayGuardBindings(context.toolsetId, context.clientId, context.setScope ?? "toolset", context.projectId);
    const asBinding = (record: GuardBindingRecord | null) =>
      record ? { mode: record.mode as GuardBindingMode, profileId: record.profileId } : { mode: "inherit" as GuardBindingMode, profileId: null };
    const toolset = asBinding(bindings.toolset);
    const client = asBinding(bindings.client);
    const toolsetProfile = toolset.mode === "override" && toolset.profileId ? await this.loadProfile(toolset.profileId) : undefined;
    const clientProfile = client.mode === "override" && client.profileId ? await this.loadProfile(client.profileId) : undefined;
    const chain: GuardBindingLevel[] = [];
    const level = (entry: GuardBindingLevel, resolved?: ResolvedGuardProfile) => chain.push({ ...entry, ...(resolved ? { version: resolved.version } : {}) });
    if (!toolsetProfile && !clientProfile && this.options.gatewayRulesWithoutBinding === false) {
      level({ level: "toolset", mode: toolset.mode, profileId: toolset.profileId });
      level({ level: "mcp_client", mode: client.mode, profileId: client.profileId });
      return { resolution: { source: "none", stack: [], chain }, refs: [] };
    }
    // A toolset without a project has no project floor (its tool rules see no project either).
    const project = context.projectId ? asBinding(bindings.project) : null;
    const enforced = project?.mode === "enforced" && project.profileId ? await this.loadProfile(project.profileId) : undefined;
    const deployment = await this.deploymentProfile();
    if (!toolsetProfile && !clientProfile && !enforced && !deployment) {
      level({ level: "toolset", mode: toolset.mode, profileId: toolset.profileId });
      level({ level: "mcp_client", mode: client.mode, profileId: client.profileId });
      return { resolution: { source: "none", stack: [], chain }, refs: [] };
    }
    if (project) level({ level: "project", mode: project.mode === "enforced" ? "enforced" : "inherit", profileId: project.mode === "enforced" ? project.profileId : null }, enforced);
    level({ level: "toolset", mode: toolset.mode, profileId: toolset.profileId }, toolsetProfile);
    level({ level: "mcp_client", mode: client.mode, profileId: client.profileId }, clientProfile);
    level({ level: "instance", mode: this.options.autoApply ? "auto" : "off", profileId: this.options.autoApply ? GUARD_BUILTIN_PROFILE_ID : null });
    const stack: ResolvedGuardProfile[] = [];
    const refs: GatewayGuardProfileRef[] = [];
    for (const [entry, at] of [[enforced, "project"], [toolsetProfile, "toolset"], [clientProfile, "mcp_client"]] as const) {
      if (!entry || stack.some((existing) => existing.hash === entry.hash)) continue;
      stack.push(entry);
      refs.push({ profileId: entry.profileId, version: entry.version, level: at });
    }
    const source: GuardRunResolution["source"] = enforced ? "enforced" : toolsetProfile ? "toolset" : clientProfile ? "mcp_client" : "none";
    return { resolution: GuardService.withDeployment({ source, ...(enforced ? { enforced } : {}), stack, chain }, deployment), refs };
  }

  /** 12.6 — the engine's Guard dependencies for one gateway server tool call, for a resolution from `resolveGateway`. */
  gatewayRuntime(context: GatewayGuardContext, resolution: GuardRunResolution): GuardRuntimeDependencies {
    return {
      resolveRun: () => resolution,
      loadProfile: async (profileId) => await this.loadProfile(profileId),
      // Phase 12 coverage — a toolset or route set without a project tags its tokens with its own scope, which no
      // workflow run's project matches (a null project would read as a token issued before tokens were scoped).
      vault: this.vaultFor({ projectId: context.projectId ?? gatewayVaultScope(context.toolsetId), executionId: context.executionId }),
      onVerdict: async (event) => await this.recordVerdict(event, { executionId: context.executionId, workflowId: context.workflowId ?? "", projectId: context.projectId }),
      // A gateway server tool call runs no Reveal node; reveal stays off.
      projectId: context.projectId,
      revealDisabled: true,
      destinationRows: async () => (await this.options.destinationRows?.()) ?? [],
      ...(this.options.surrogateKey ? { surrogateKey: this.options.surrogateKey } : {}),
      issuedSurrogates: new Set<string>()
    };
  }

  /**
   * Phase 16 — the deployment's destination rules profile, when an admin set
   * one up and it has rules; undefined otherwise (nothing changes then).
   */
  async deploymentProfile(): Promise<ResolvedGuardProfile | undefined> {
    // Kept per guard profile revision (bumped by every profile write, from any process), so a gateway call with no
    // destination rules set up costs one revision read here, not a profile lookup.
    const revision = await this.store.guardProfileRevision?.();
    if (revision !== undefined && this.deploymentProfileCache?.revision === revision) return this.deploymentProfileCache.value;
    let value: ResolvedGuardProfile | undefined;
    if (await this.store.getGuardProfile(GUARD_DESTINATION_RULES_PROFILE_ID)) {
      const loaded = await this.loadProfile(GUARD_DESTINATION_RULES_PROFILE_ID);
      value = loaded && profileHasDestinationRules(loaded.profile) ? loaded : undefined;
    }
    if (revision !== undefined) this.deploymentProfileCache = { revision, value };
    return value;
  }

  /** Appends the deployment's destination rules profile after a resolution's own profiles (never replacing one). */
  private static withDeployment(resolution: GuardRunResolution, deployment: ResolvedGuardProfile | undefined): GuardRunResolution {
    if (!deployment) return resolution;
    const stack = resolution.stack.some((entry) => entry.hash === deployment.hash) ? resolution.stack : [...resolution.stack, deployment];
    const chain: GuardBindingLevel[] = [...resolution.chain, { level: "destinations", mode: "enforced", profileId: deployment.profileId, version: deployment.version }];
    return { ...resolution, stack, chain, deployment };
  }

  /**
   * 12.7 — an eval run's chosen rule set after the run's own rule sets and before the deployment's destination rules
   * (a rule set already in the stack, same hash, is not added twice). Stacked rule sets only tighten: the most severe
   * action wins.
   */
  private async withAddition(resolution: GuardRunResolution, addition: NonNullable<GuardRunContext["profileAddition"]>): Promise<GuardRunResolution> {
    const candidate = await this.loadProfile(addition.profileId, addition.version);
    if (!candidate) throw new GuardNotFoundError(await this.profileOverrideProblem(addition) ?? `Rule set '${addition.profileId}' not found`);
    const deployment = resolution.deployment;
    const last = resolution.stack[resolution.stack.length - 1];
    const tail = deployment && last === deployment ? [deployment] : [];
    const head = tail.length > 0 ? resolution.stack.slice(0, -1) : resolution.stack;
    const present = resolution.stack.some((entry) => entry.hash === candidate.hash);
    const stack = present ? resolution.stack : [...head, candidate, ...tail];
    const level: GuardBindingLevel = { level: "candidate", mode: "override", profileId: candidate.profileId, version: candidate.version };
    const at = resolution.chain.findIndex((entry) => entry.level === "destinations");
    const chain = at < 0 ? [...resolution.chain, level] : [...resolution.chain.slice(0, at), level, ...resolution.chain.slice(at)];
    return { ...resolution, source: resolution.source === "none" ? "candidate" : resolution.source, stack, chain };
  }

  /** The resolution for a candidate profile: the project's enforced floor (unless it is the same profile), then the candidate. */
  private async resolveOverride(override: NonNullable<GuardRunContext["profileOverride"]>, projectId: string): Promise<GuardRunResolution> {
    const candidate = await this.loadProfile(override.profileId, override.version);
    if (!candidate) throw new GuardNotFoundError(await this.profileOverrideProblem(override) ?? `Rule set '${override.profileId}' not found`);
    const project = await this.getBinding("project", projectId);
    const enforcedRaw = project.mode === "enforced" && project.profileId ? await this.loadProfile(project.profileId) : undefined;
    const enforced = enforcedRaw && enforcedRaw.profileId !== candidate.profileId ? enforcedRaw : undefined;
    const chain: GuardBindingLevel[] = [
      { level: "project", mode: project.mode, profileId: project.profileId, ...(enforced ? { version: enforced.version } : {}) },
      { level: "candidate", mode: "override", profileId: candidate.profileId, version: candidate.version }
    ];
    const stack = enforced && enforced.hash !== candidate.hash ? [enforced, candidate] : [candidate];
    // Phase 16 — the deployment's destination rules (latest version) apply to every candidate's replay, even when the
    // candidate is an older version of them: a candidate can add checks, never remove the deployment's.
    return GuardService.withDeployment({ source: "candidate", ...(enforced ? { enforced } : {}), stack, chain }, await this.deploymentProfile());
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
    const deployment = resolution.deployment ? swap(resolution.deployment) : undefined;
    const chain = resolution.chain.map((level) =>
      level.profileId === substitute.profileId && level.version !== undefined ? { ...level, version: substitute.version } : level
    );
    const dedupe = (entries: ResolvedGuardProfile[]) => {
      const kept = new Set<string>();
      return entries.map(swap).filter((entry) => (kept.has(entry.hash) ? false : (kept.add(entry.hash), true)));
    };
    const gateway = resolution.gateway ? dedupe(resolution.gateway) : undefined;
    const ownStack = resolution.ownStack ? dedupe(resolution.ownStack) : undefined;
    return {
      ...resolution,
      ...(enforced ? { enforced } : {}),
      ...(deployment ? { deployment } : {}),
      stack,
      chain,
      ...(gateway ? { gateway } : {}),
      ...(ownStack ? { ownStack } : {})
    };
  }

  private static substituteProfile(substitute: GuardProfileSubstitute): ResolvedGuardProfile {
    return { profileId: substitute.profileId, version: substitute.version, hash: substitute.hash, name: guardProfileDisplayName(substitute.profileId, substitute.name), profile: substitute.profile };
  }

  /**
   * Phase 15.6 — the profile a simulation runs: an unsaved document
   * (validated like a save, with the profile's id; never stored) or a saved
   * version. Throws GuardValidationError for an invalid document and
   * GuardNotFoundError for a missing profile or version.
   */
  async simulationProfile(profileId: string, source: { document: Record<string, unknown> } | { version: number }): Promise<GuardProfileSubstitute> {
    await this.requireProfile(profileId);
    if ("document" in source) {
      const profile = await this.validateDocument(source.document, profileId);
      return { profileId, version: 0, hash: hashGuardProfile(profile), name: guardProfileDisplayName(profileId, profile.name), profile, inline: true };
    }
    const loaded = await this.loadProfile(profileId, source.version);
    if (!loaded) throw new GuardNotFoundError(`Version ${source.version} of rule set '${profileId}' was not found`);
    return { profileId, version: loaded.version, hash: loaded.hash, name: guardProfileDisplayName(profileId, loaded.profile.name), profile: loaded.profile, inline: false };
  }

  resolutionView(resolution: GuardRunResolution): GuardResolutionView {
    const ref = (entry: ResolvedGuardProfile): GuardProfileRef => ({ profileId: entry.profileId, version: entry.version, hash: entry.hash, ...(entry.name ? { name: entry.name } : {}) });
    return { source: resolution.source, enforced: resolution.enforced ? ref(resolution.enforced) : null, stack: resolution.stack.map(ref), chain: resolution.chain };
  }

  /** The engine's guard dependencies for one run. */
  runtimeFor(context: GuardRunContext): GuardRuntimeDependencies {
    const override = context.profileOverride;
    const substitute = context.profileSubstitute;
    const runtime: GuardRuntimeDependencies = {
      resolveRun: async () => await this.resolveRun(context),
      // Phase 16 — a simulation's unsaved document may opt in; stored versions are checked in one cached query.
      mayUseLabels: async () => (substitute ? profileUsesLabels(substitute.profile) : false) || await this.mayUseLabels(),
      // Phase 12 coverage — the same for the response and incoming-payload channels.
      mayCheckChannel: async (channel) => (substitute ? substitute.profile.channels[channel] !== undefined : false) || await this.mayCheckChannel(channel),
      // A guard port naming the candidate's profile gets the candidate's version too (and a simulation's profile its substitute).
      loadProfile: async (profileId) =>
        substitute && substitute.profileId === profileId
          ? GuardService.substituteProfile(substitute)
          : override && override.profileId === profileId
            ? await this.loadProfile(profileId, override.version)
            : await this.loadProfile(profileId),
      vault: context.simulation?.vault ?? this.vaultFor({ projectId: context.projectId ?? null, executionId: context.executionId ?? null }),
      onVerdict: async (event) => (context.simulation ? context.simulation.sink.record(event) : await this.recordVerdict(event, context)),
      // Phase 12 coverage — a Reveal node reveals only this project's tokens, and never in a simulation, a candidate
      // rule set run (replays) or an eval run.
      projectId: context.projectId ?? null,
      ...(GuardService.revealDisabledFor(context) ? { revealDisabled: true } : { onReveal: async (event: GuardRevealEvent) => await this.recordReveal(event, context) }),
      // Phase 16 — read when a check first needs them (the engine keeps them for this run only).
      destinationRows: async () => context.destinationRows ?? (await this.options.destinationRows?.()) ?? [],
      ...(this.options.surrogateKey ? { surrogateKey: this.options.surrogateKey } : {}),
      issuedSurrogates: context.issuedSurrogates ?? new Set<string>(),
      // A simulation compares every checkpoint on both sides, clean ones included.
      ...(context.simulation ? { recordCleanOutbound: true } : {})
    };
    const runProject = context.projectId ?? DEFAULT_PROJECT_ID;
    // Phase 12 coverage — a sub-workflow in another project: its Protect steps tag its own project, and it never
    // reveals (its tokens and the run's rule sets belong to different projects). Its checks keep the run's rule sets.
    const forWorkflow = (workflow: { id: string; projectId: string | null }): GuardRuntimeDependencies => {
      const childProject = workflow.projectId ?? DEFAULT_PROJECT_ID;
      if (childProject === runProject) return runtime;
      const { onReveal: _onReveal, ...rest } = runtime;
      return {
        ...rest,
        vault: context.simulation?.vault ?? this.vaultFor({ projectId: childProject, executionId: context.executionId ?? null }),
        projectId: childProject,
        revealDisabled: true,
        forWorkflow
      };
    };
    runtime.forWorkflow = forWorkflow;
    return runtime;
  }

  // -------------------------------------------------------------------------
  // Phase 16 — the deployment's destination rules (Security page)
  // -------------------------------------------------------------------------

  /** The rules, whether they observe or enforce, and the observing count. */
  async destinationRulesStatus(): Promise<DestinationRulesStatus> {
    const record = await this.store.getGuardProfile(GUARD_DESTINATION_RULES_PROFILE_ID);
    const loaded = record ? await this.loadProfile(GUARD_DESTINATION_RULES_PROFILE_ID) : undefined;
    const rules = (loaded?.profile.destinations?.rules ?? []) as DestinationRuleView[];
    const since = new Date(Date.now() - DESTINATION_RULES_OBSERVING_DAYS * 86_400_000).toISOString();
    const wouldBlock = record ? await this.store.countObservedDestinationBlocks(GUARD_DESTINATION_RULES_PROFILE_ID, since) : 0;
    return {
      available: true,
      profileId: GUARD_DESTINATION_RULES_PROFILE_ID,
      version: loaded?.version ?? null,
      rules,
      mode: destinationRulesMode(rules),
      hasStarter: rules.some((rule) => rule.name === STARTER_DESTINATION_RULE_NAME),
      observing: { wouldBlock, days: DESTINATION_RULES_OBSERVING_DAYS }
    };
  }

  /** Saves the full rule list as a new version of the deployment's rules profile (created on first save). Throws GuardValidationError. */
  async setDestinationRules(rules: Array<Record<string, unknown>>, actorId: string | null, note?: string): Promise<DestinationRulesStatus> {
    const document: Record<string, unknown> = {
      id: GUARD_DESTINATION_RULES_PROFILE_ID,
      name: GUARD_DESTINATION_RULES_PROFILE_NAME,
      version: "1",
      description: "The deployment's destination rules, applied to every run after its own profiles. Managed on the Security page.",
      destinations: { rules }
    };
    if (await this.store.getGuardProfile(GUARD_DESTINATION_RULES_PROFILE_ID)) {
      await this.updateProfile(GUARD_DESTINATION_RULES_PROFILE_ID, { document, ...(note ? { note } : {}) }, actorId);
    } else {
      await this.createProfile({ id: GUARD_DESTINATION_RULES_PROFILE_ID, document, note: note ?? "Created from the Security page" }, actorId, { reserved: true });
    }
    return await this.destinationRulesStatus();
  }

  /** Adds the starter rule, observing (shadow); unchanged when it is already there. */
  async addStarterDestinationRule(actorId: string | null): Promise<{ status: DestinationRulesStatus; created: boolean }> {
    const current = await this.destinationRulesStatus();
    if (current.hasStarter) return { status: current, created: false };
    const starter = { ...STARTER_DESTINATION_RULE, when: { dataClasses: [...STARTER_DESTINATION_RULE.when.dataClasses] }, allow: { ...STARTER_DESTINATION_RULE.allow }, shadow: true };
    const status = await this.setDestinationRules([...(current.rules as unknown as Array<Record<string, unknown>>), starter], actorId, "Added the starter rule (observing)");
    return { status, created: true };
  }

  /** Every rule observes (enforce false) or acts (enforce true). */
  async setDestinationRulesEnforcement(enforce: boolean, actorId: string | null): Promise<DestinationRulesStatus> {
    const current = await this.destinationRulesStatus();
    if (current.rules.length === 0) throw new GuardNotFoundError("There are no destination rules to turn on yet");
    const rules = current.rules.map((rule) => {
      const { shadow: _shadow, ...rest } = rule;
      return (enforce ? rest : { ...rest, shadow: true }) as unknown as Record<string, unknown>;
    });
    return await this.setDestinationRules(rules, actorId, enforce ? "Turned on enforcement" : "Back to observing");
  }

  // -------------------------------------------------------------------------
  // Token vault
  // -------------------------------------------------------------------------

  /** Database-backed vault storage with no run scope (tokens it writes have no project); the value is sealed with the master key. */
  readonly vault: TokenVaultStorage = this.vaultFor({});

  /**
   * Phase 12 coverage — vault storage for one run: tokens it writes record the run's project and execution, and
   * reads return them, so a Reveal node can refuse another project's tokens.
   */
  vaultFor(scope: { projectId?: string | null; executionId?: string | null }): TokenVaultStorage {
    return {
      getByToken: async (token) => this.openVaultRow(await this.store.getGuardVaultByToken(token)),
      getByValueHash: async (valueHash) => this.openVaultRow(await this.store.getGuardVaultByHash(valueHash)),
      put: async (record: TokenVaultRecord) => {
        await this.store.putGuardVault({
          token: record.token,
          dataClass: record.dataClass,
          valueHash: record.valueHash ?? null,
          valueSealed: this.secrets.sealValue(VAULT_PURPOSE, record.value),
          createdAt: record.createdAt,
          projectId: scope.projectId ?? null,
          executionId: scope.executionId ?? null
        });
      }
    };
  }

  private openVaultRow(row: Awaited<ReturnType<Store["getGuardVaultByToken"]>>): TokenVaultRecord | undefined {
    if (!row) return undefined;
    try {
      return {
        token: row.token,
        dataClass: row.data_class as TokenVaultRecord["dataClass"],
        value: this.secrets.openValue(VAULT_PURPOSE, row.value_sealed),
        ...(row.value_hash ? { valueHash: row.value_hash } : {}),
        createdAt: row.created_at,
        projectId: row.project_id ?? null,
        executionId: row.execution_id ?? null
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
  async recordVerdict(event: GuardVerdictEvent, context: GuardRunContext): Promise<void> {
    const verdictId = randomUUID();
    const createdAt = new Date().toISOString();
    const summary = event.verdict;
    const base = {
      verdictId,
      executionId: event.executionId || context.executionId || "",
      // 12.6 — a gateway server tool call has no workflow.
      workflowId: event.workflowId || context.workflowId || null,
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
      createdAt,
      ...(context.runSource ? { runSource: context.runSource } : {})
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
      await this.store.insertGuardEvents(rows);
    } catch (error) {
      this.options.logger?.("Guard events could not be written", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Phase 12 coverage — runs that must never reveal: rule simulations, candidate rule set runs (replays) and eval runs. */
  static revealDisabledFor(context: Pick<GuardRunContext, "simulation" | "profileOverride" | "profileSubstitute" | "runSource">): boolean {
    return Boolean(context.simulation || context.profileOverride || context.profileSubstitute || context.runSource === "eval");
  }

  /**
   * Phase 12 coverage — a Reveal node step as rule events (placement and channel `reveal`, verdict action `reveal`): one
   * row per revealed data class (action `reveal`) and one per refused class and reason (requested `reveal`, effective
   * `block`), with token hashes as evidence, never values; then one audit log entry `content_rules.reveal`. A failed write throws, so the
   * engine reveals nothing it could not record.
   */
  async recordReveal(event: GuardRevealEvent, context: GuardRunContext): Promise<void> {
    if (event.revealed.length === 0 && event.refused.length === 0) return;
    const verdictId = randomUUID();
    const createdAt = new Date().toISOString();
    const fallback = event.profiles[0] ?? { profileId: GUARD_BUILTIN_PROFILE_ID, version: 0, hash: "" };
    const profileFor = (rule?: { profileId: string; version: number }) =>
      (rule && event.profiles.find((ref) => ref.profileId === rule.profileId && ref.version === rule.version)) || fallback;
    // The step's verdict is always `reveal`, so a refused reveal does not count as a blocked rule verdict.
    const verdictAction = "reveal";
    const row = (entry: GuardRevealEvent["revealed"][number], revealed: boolean): GuardEventInsert => {
      const profile = profileFor(entry.rule);
      const message = revealed
        ? `Revealed ${entry.count} token${entry.count === 1 ? "" : "s"}${entry.rule ? ` under reveal rule ${entry.rule.index + 1}${entry.rule.name ? ` (${entry.rule.name})` : ""}` : ""}${event.approved ? " after approval" : ""}`
        : `Refused ${entry.count} token${entry.count === 1 ? "" : "s"}: ${entry.reason ?? "no_rule"}`;
      return {
        id: randomUUID(),
        verdictId,
        executionId: event.executionId || context.executionId || "",
        workflowId: event.workflowId || context.workflowId || null,
        projectId: context.projectId ?? null,
        nodeId: event.nodeId,
        placement: "reveal",
        iteration: null,
        toolName: null,
        channel: "reveal",
        detectorId: REVEAL_EVENT_DETECTOR_ID,
        category: REVEAL_EVENT_DETECTOR_ID,
        dataClass: entry.dataClass ?? null,
        score: null,
        requestedAction: "reveal",
        effectiveAction: revealed ? "reveal" : "block",
        verdictAction,
        shadow: false,
        evidence: (entry.tokenHashes.length > 0 ? entry.tokenHashes : [""]).map((hash) => ({ evidence: hash ? `sha256:${hash}` : "", spans: [], message })),
        profileId: profile.profileId,
        profileVersion: profile.version,
        profileHash: profile.hash,
        latencyMs: 0,
        budgetExceeded: false,
        skippedDetectors: [],
        createdAt,
        ...(context.runSource ? { runSource: context.runSource } : {})
      };
    };
    // Only a person (or a service account) who started the run is the actor; webhook, schedule, chat and gateway
    // runs are the system's, with the subject in the metadata.
    const startedBy = event.subject?.serviceAccountId ?? (event.subject?.source === "user" ? event.subject.userId : undefined);
    // The audit entry first: when it cannot be written the node fails, and no event claims a reveal.
    await this.options.audit?.({
      eventType: "content_rules.reveal",
      category: "execution",
      action: "reveal",
      outcome: event.revealed.length > 0 ? "success" : "denied",
      actor: startedBy
        ? {
            type: "user",
            userId: startedBy,
            ...(event.subject?.apiKeyId ? { apiKeyId: event.subject.apiKeyId } : {}),
            ...(event.subject?.serviceAccountId ? { serviceAccount: true } : {})
          }
        : { type: "system" },
      resourceType: "workflow",
      ...(event.workflowId ? { resourceId: event.workflowId } : {}),
      projectId: context.projectId ?? null,
      metadata: {
        executionId: event.executionId,
        nodeId: event.nodeId,
        subject: event.subject,
        approved: event.approved,
        ...(event.approvedBy ? { approvedBy: event.approvedBy } : {}),
        revealed: event.revealed.map((entry) => ({ dataClass: entry.dataClass ?? null, count: entry.count, ...(entry.rule ? { rule: entry.rule } : {}) })),
        refused: event.refused.map((entry) => ({ dataClass: entry.dataClass ?? null, count: entry.count, reason: entry.reason ?? null }))
      },
      message: `Reveal node ${event.nodeId}: revealed ${event.revealed.reduce((total, entry) => total + entry.count, 0)}, refused ${event.refused.reduce((total, entry) => total + entry.count, 0)}`
    });
    await this.store.insertGuardEvents([...event.revealed.map((entry) => row(entry, true)), ...event.refused.map((entry) => row(entry, false))]);
  }

  async listEvents(filters: GuardEventFilters & { limit?: number; offset?: number }): Promise<{ events: GuardEventView[]; total: number }> {
    const { events, total } = await this.store.listGuardEvents(filters);
    return { events: events.map(toEventView), total };
  }

  async eventsForExecution(executionId: string): Promise<GuardEventView[]> {
    return (await this.store.listGuardEventsForExecution(executionId)).map(toEventView);
  }

  async stats(filters: GuardEventFilters) {
    return await this.store.guardEventStats(filters);
  }

  // -------------------------------------------------------------------------

  private async requireProfile(id: string): Promise<GuardProfileRecord> {
    const record = await this.store.getGuardProfile(id);
    if (!record) throw new GuardNotFoundError(`Rule set '${id}' not found`);
    return record;
  }

  private documentOf(profile: GuardProfile): Record<string, unknown> {
    return JSON.parse(serializeGuardProfile(profile)) as Record<string, unknown>;
  }

  private async summaryOf(record: GuardProfileRecord): Promise<GuardProfileSummary> {
    return {
      id: record.id,
      name: guardProfileDisplayName(record.id, record.name),
      ...(record.description ? { description: record.description } : {}),
      builtIn: record.builtIn,
      ...((await this.store.listGuardBindingsForProfile(record.id)).some((binding) => binding.scope === "project" && binding.mode === "enforced") ? { enforced: true } : {}),
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
      document: displayedDocument(record.profileId, record.document),
      author: record.createdBy,
      note: record.note,
      createdAt: record.createdAt
    };
  }
}

/**
 * The document as users see it. The built-in's stored name is part of its
 * pinned hash, so only the copy handed out (version views, diffs, exports)
 * carries the display name; the stored version and its hash are unchanged.
 */
function displayedDocument(profileId: string, document: Record<string, unknown>): Record<string, unknown> {
  if (typeof document.name !== "string") return document;
  const name = guardProfileDisplayName(profileId, document.name);
  return name === document.name ? document : { ...document, name };
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
    placement: parseGuardPlacement(record.placement),
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
    createdAt: record.createdAt,
    ...(record.runSource === "eval" ? { runSource: "eval" as const } : {})
  };
}
