/**
 * The persistence contract every store implements (SQLite today, Postgres as it catches up).
 *
 * App code types against `Store` only: routes, services, the scheduler, the queue, seeding and the CLI scripts.
 * Every method is async so that a store backed by a network database can implement it; the SQLite store runs
 * each method's statements synchronously inside the call (one better-sqlite3 call or transaction per method), so a
 * sequence that must not interleave with another request belongs in ONE store method, never across two awaits.
 *
 * Methods are grouped by domain. Records and filters are the types the SQLite store defines (`./database.js`) or
 * the shared workflow contract (`@ai-orchestrator/shared`).
 */
import type {
  ChatMessage,
  DataDestinationRow,
  DataLabels,
  Folder,
  McpCassette,
  McpCassetteBadge,
  McpCassetteRecord,
  McpCassetteSource,
  McpCassetteSummary,
  McpClient,
  McpCredentialMode,
  McpDelegatedFallback,
  McpElicitationStatus,
  McpPolicyRole,
  McpSamplingSettings,
  McpSandboxSettings,
  McpSandboxStatus,
  McpServerCatalog,
  McpToolClassificationOverride,
  McpToolPolicyRule,
  McpToolset,
  McpToolsetMemberSpec,
  Project,
  ReplayGoldenBadge,
  ReplayRecordingSummary,
  Workflow,
  WorkflowListItem
} from "@ai-orchestrator/shared";
import type {
  ApprovalReadScope,
  ApprovalRequestInsert,
  ApprovalRequestRecord,
  AuditSigningKeyRecord,
  BudgetRecord,
  DataDestinationWrite,
  EvalDatasetRecord,
  EvalFixtureRecord,
  EvalResultRecord,
  EvalRunRecord,
  ExecutionManifestRecord,
  GateCaseRequestRecord,
  GoldenSetSnapshot,
  GuardBindingRecord,
  GuardBindingScope,
  GuardEventFilters,
  GuardEventInsert,
  GuardEventRecord,
  GuardEventStats,
  GuardProfileRecord,
  GuardProfileVersionRecord,
  GuardSimulationRecord,
  GuardVaultRow,
  KnowledgeBaseChunkRecord,
  KnowledgeBaseRecord,
  LogStreamDestinationRecord,
  McpClientSecretRecord,
  McpClientUsageRow,
  McpElicitationRecord,
  McpOAuthConnectionRecord,
  McpServerCatalogRecord,
  McpServerProbeRecord,
  McpServerRecord,
  McpServerStatus,
  McpToolCallRecord,
  McpToolCallWrite,
  McpToolSnapshotRecord,
  McpUserOAuthConnectionRecord,
  ReleaseApprovalRequestRecord,
  ReleaseGateRecord,
  ReplayCaptureSettingsRecord,
  ReplayRecordingInsert,
  ReplayRecordingRecord,
  SecretRow,
  SubjectStoreKind,
  SubjectTextRow,
  WorkflowReleaseRecord
} from "./database.js";

/** The decision `decideApprovalRequest` records. */
export type ApprovalDecisionInput = Parameters<Store["decideApprovalRequest"]>[0];
/** The decision `decideReleaseApprovalRequest` records. */
export type ReleaseApprovalDecisionInput = Parameters<Store["decideReleaseApprovalRequest"]>[0];
/** The decision `decideGateCaseRequest` records. */
export type GateCaseDecisionRecordInput = Parameters<Store["decideGateCaseRequest"]>[0];

/** Golden-run limits a save is checked against inside its transaction (the REPLAY_RECORDINGS_* settings). */
export interface ReplayRecordingLimits {
  maxPerWorkflow: number;
  maxBytesPerWorkflow: number;
  maxTotalBytes: number;
}

/** Why a golden-run save was refused inside its transaction; `used` is what the limit counted before the save. */
export type ReplayRecordingRefusal =
  | { refused: "duplicate"; existingId: string }
  | { refused: "count" | "workflow_bytes" | "total_bytes"; used: number; bytes: number };

/** A change to an enforced release gate's cases, applied in one transaction (see `updateReleaseGateCases`). */
export interface ReleaseGateCasesChange {
  workflowId: string;
  /** The admitted cases as the caller read them; the change is refused ("changed") when they differ now. Omitted: not checked. */
  expectedAdmittedFixtureIds?: string[] | null;
  /** The admitted cases to store. Omitted: left as they are. */
  admittedFixtureIds?: string[] | null;
  /** Cases that leave their golden sets (their golden runs are kept). */
  deleteFixtureIds?: string[];
  required?: { fixtureId: string; required: boolean };
  /** A pending gate case request this change decides; refused ("decided") when it is no longer pending. */
  decideRequest?: GateCaseDecisionRecordInput;
  updatedAt: string;
  updatedBy: string | null;
}

/** What `cancelExecution` did; `canceledRequestIds` are the pending requests it canceled in its own transaction. */
export interface CancelExecutionResult {
  outcome: "canceled" | "missing" | "not_cancelable" | "decided";
  canceledRequestIds: string[];
}

export interface Store {
  // ---- Store lifecycle

  /** Phase 10.7 — where the database lives (a file path, or ":memory:"); names this deployment's sandbox containers. */
  storageLocation(): Promise<string>;
  close(): Promise<void>;
  /** Phase 11.2 — when a schema marker was first written (see `schema_markers`). */
  getSchemaMarker(name: string): Promise<string | null>;

  // ---- Releases, publishing and gate admission

  /** The version production traffic runs, or null when nothing is published (the draft runs everywhere). */
  getPublishedVersion(workflowId: string): Promise<number | null>;
  isWorkflowVersionPinned(workflowId: string, version: number): Promise<boolean>;
  getReleaseGate(workflowId: string): Promise<ReleaseGateRecord | null>;
  upsertReleaseGate(record: ReleaseGateRecord): Promise<ReleaseGateRecord>;
  listWorkflowReleases(workflowId: string, limit?: number): Promise<WorkflowReleaseRecord[]>;
  /** Whether `version` was published before (by any release, a rollback included). */
  hasReleasedVersion(workflowId: string, version: number): Promise<boolean>;
  /** Every completed replay job that tested exactly this workflow hash, newest first. */
  listReplayRunIdsForHash(workflowId: string, workflowHash: string): Promise<string[]>;
  /** Phase 15.4 — the per-set snapshot a replay job was queued against (set id -> hash). */
  setEvalRunSetSnapshot(runId: string, snapshot: Record<string, GoldenSetSnapshot>): Promise<void>;
  /** Each set's hash and, for jobs queued since gate admission, its cases' fingerprints (older jobs stored the hash alone). */
  getEvalRunSetSnapshot(runId: string): Promise<Record<string, GoldenSetSnapshot> | null>;
  /** Phase 15.4 — the channel and published version a finished run ran on (null version: the draft). */
  setExecutionRelease(executionId: string, channel: "production" | "draft", version: number | null): Promise<void>;
  getExecutionRelease(executionId: string): Promise<{ channel: "production" | "draft"; version: number | null } | null>;
  /** The hashes `version` had when it was released (any release, rollbacks included). */
  listReleasedVersionHashes(workflowId: string, version: number): Promise<string[]>;
  /** The release gates that are switched on. */
  listEnabledReleaseGateWorkflowIds(): Promise<string[]>;
  /**
   * Closes every pending release request whose time ran out, so the inbox's
   * pending and decided filters (and their limits) agree with the clock.
   * Returns the requests it closed.
   */
  timeOutExpiredReleaseApprovalRequests(nowIso: string): Promise<ReleaseApprovalRequestRecord[]>;
  /** Pending requests for this version and hash, newest first. */
  listPendingReleaseApprovalRequests(workflowId: string, version: number, workflowHash: string): Promise<ReleaseApprovalRequestRecord[]>;
  insertReleaseApprovalRequest(record: ReleaseApprovalRequestRecord): Promise<ReleaseApprovalRequestRecord>;
  getReleaseApprovalRequest(id: string): Promise<ReleaseApprovalRequestRecord | null>;
  listReleaseApprovalRequests(filter: { status: "pending" | "decided" | "all"; workflowId?: string; limit?: number; scope?: ApprovalReadScope; now?: string }): Promise<ReleaseApprovalRequestRecord[]>;
  /** Records a decision on a pending request; false when it was no longer pending. */
  decideReleaseApprovalRequest(input: {
    id: string;
    status: "approved" | "rejected" | "canceled" | "timed_out";
    decidedByUserId?: string | null;
    decidedBy?: string | null;
    decisionReason?: string | null;
    releaseId?: string | null;
  }): Promise<boolean>;
  /** Migration 36 — the cases an enforced gate counts (null: not enforced). Leaves the gate's `updated_at` alone. */
  setReleaseGateAdmission(workflowId: string, admittedFixtureIds: string[] | null, updatedAt: string, updatedBy: string | null): Promise<void>;
  insertGateCaseRequest(record: GateCaseRequestRecord): Promise<GateCaseRequestRecord>;
  getGateCaseRequest(id: string): Promise<GateCaseRequestRecord | null>;
  /** Pending gate case requests of one workflow, newest first. */
  listPendingGateCaseRequests(workflowId: string): Promise<GateCaseRequestRecord[]>;
  listGateCaseRequests(filter: { status: "pending" | "decided" | "all"; workflowId?: string; limit?: number; scope?: ApprovalReadScope; now?: string }): Promise<GateCaseRequestRecord[]>;
  /** Closes every pending gate case request whose time ran out; returns those it closed. */
  timeOutExpiredGateCaseRequests(nowIso: string): Promise<GateCaseRequestRecord[]>;
  /** Records a decision on a pending gate case request; false when it was no longer pending. */
  decideGateCaseRequest(input: {
    id: string;
    status: "approved" | "rejected" | "canceled" | "timed_out";
    decidedByUserId?: string | null;
    decidedBy?: string | null;
    decisionReason?: string | null;
  }): Promise<boolean>;
  /**
   * Release gate admission — runs whose evidence was removed after they ran
   * (a data-subject delete took some of their case results): never release
   * proof again. The reason joins the candidate's release-ineligible reasons.
   * Returns the ids changed.
   */
  markEvalRunsReleaseIneligible(runIds: readonly string[], reason: string): Promise<string[]>;

  // ---- Guard simulations

  insertGuardSimulation(input: Omit<GuardSimulationRecord, "error" | "finishedAt"> & { error?: string | null; finishedAt?: string | null }): Promise<GuardSimulationRecord>;
  /** Updates a simulation; `onlyFrom` limits it to rows still in one of those statuses. Returns whether a row changed. */
  updateGuardSimulation(input: { id: string; status?: string; jobIds?: string[]; detail?: Record<string, unknown>; error?: string | null; finishedAt?: string | null; onlyFrom?: string[] }): Promise<boolean>;
  getGuardSimulation(id: string): Promise<GuardSimulationRecord | null>;
  listGuardSimulations(options: { profileId: string; limit?: number; offset?: number }): Promise<GuardSimulationRecord[]>;
  /** Simulations still running (a stopped server left them so). */
  listRunningGuardSimulations(): Promise<GuardSimulationRecord[]>;
  /** Deletes simulations created before `before`, with their replay jobs and case results. Returns how many simulations were deleted. */
  pruneGuardSimulations(input: { before: string }): Promise<number>;

  // ---- MCP cassettes

  saveMcpCassette(input: {
    id: string;
    executionId: string | null;
    workflowId: string | null;
    workflowName: string | null;
    projectId: string | null;
    source: McpCassetteSource;
    evalRunId?: string | null;
    fixtureId?: string | null;
    cassette: McpCassette;
    createdBy: string | null;
  }): Promise<McpCassetteSummary>;
  getMcpCassetteSummary(id: string): Promise<McpCassetteSummary | null>;
  getMcpCassette(id: string): Promise<McpCassetteRecord | null>;
  /** The newest cassette recorded for an execution. */
  getMcpCassetteForExecution(executionId: string): Promise<McpCassetteRecord | null>;
  /** Cassettes an eval run recorded, keyed by fixture id. */
  listMcpCassettesForEvalRun(evalRunId: string): Promise<McpCassetteSummary[]>;
  listMcpCassettes(options?: { workflowId?: string; projectId?: string; evalRunId?: string; workflowIds?: string[]; limit?: number; offset?: number }): Promise<{
    items: McpCassetteSummary[];
    total: number;
  }>;
  /** Runs-page badges: the newest cassette per execution id. */
  mcpCassetteBadgesForExecutions(executionIds: string[]): Promise<Map<string, McpCassetteBadge>>;
  deleteMcpCassette(id: string): Promise<boolean>;

  // ---- MCP registry, probes, telemetry, OAuth, elicitations, policies, toolsets and clients

  createMcpServer(input: {
    id: string;
    name: string;
    description?: string | null;
    adapterId: string;
    connection?: Record<string, unknown>;
    secretId?: string | null;
    owner?: string | null;
    projectId?: string | null;
    probeEnabled?: boolean;
    probeIntervalMs?: number | null;
    blockOnBreakingChange?: boolean;
    sampling?: Partial<McpSamplingSettings> | null;
    sandbox?: McpSandboxSettings | null;
    /** Normalized (defaults filled in) before it is stored. */
    limits?: object | null;
    credentialMode?: McpCredentialMode;
    delegatedFallback?: McpDelegatedFallback;
    createdBy?: string | null;
  }): Promise<void>;
  updateMcpServer(id: string, patch: {
    name?: string;
    description?: string | null;
    adapterId?: string;
    connection?: Record<string, unknown>;
    secretId?: string | null;
    owner?: string | null;
    projectId?: string | null;
    probeEnabled?: boolean;
    probeIntervalMs?: number | null;
    blockOnBreakingChange?: boolean;
    sampling?: Partial<McpSamplingSettings> | null;
    sandbox?: McpSandboxSettings | null;
    /** Normalized (defaults filled in) before it is stored. */
    limits?: object | null;
    credentialMode?: McpCredentialMode;
    delegatedFallback?: McpDelegatedFallback;
  }): Promise<boolean>;
  deleteMcpServer(id: string): Promise<boolean>;
  /** Phase 10.7 — what the last probe found out about the server's sandbox. */
  setMcpServerSandboxStatus(id: string, status: McpSandboxStatus | null): Promise<void>;
  getMcpServer(id: string): Promise<McpServerRecord | null>;
  /** With a projectId: that project's servers plus deployment-wide ones (no project). */
  listMcpServers(filter?: { projectId?: string }): Promise<McpServerRecord[]>;
  /**
   * Record one probe and fold it into the server row. When the probe saw a new
   * tool schema, `snapshot` is stored and becomes the current one; a breaking
   * snapshot also becomes the pending one until someone accepts it.
   * `keepProbes` bounds the history kept per server.
   */
  recordMcpServerProbe(input: {
    probe: McpServerProbeRecord;
    status: McpServerStatus;
    snapshot?: Omit<McpToolSnapshotRecord, "acknowledgedAt" | "acknowledgedBy">;
    keepProbes: number;
  }): Promise<void>;
  listMcpServerProbes(serverId: string, limit?: number): Promise<McpServerProbeRecord[]>;
  getMcpToolSnapshot(id: string): Promise<McpToolSnapshotRecord | null>;
  listMcpToolSnapshots(serverId: string, limit?: number): Promise<McpToolSnapshotRecord[]>;
  /** Accept the pending breaking change: unblocks runs until the next breaking diff. */
  acknowledgeMcpBreakingChange(serverId: string, acknowledgedBy: string): Promise<McpToolSnapshotRecord | null>;
  /**
   * Replace the tool-call rows of one execution. Idempotent, so persisting the
   * same execution twice (for example after an approval resume) never
   * double-counts its calls.
   */
  replaceMcpToolCallsForExecution(executionId: string, calls: McpToolCallWrite[]): Promise<void>;
  /** Phase 10.4 — one gateway call, recorded as it finishes. */
  insertMcpToolCall(call: McpToolCallWrite): Promise<void>;
  /** Phase 10.4 — gateway calls one client made since `since`. */
  listMcpToolCallsForClient(clientId: string, since: string): Promise<McpToolCallRecord[]>;
  /** Phase 10.4 — calls, errors and last call per client since `since`. */
  summarizeMcpClientUsage(since: string): Promise<McpClientUsageRow[]>;
  /**
   * Tool calls started at or after `since`. `registryServerId: null` selects
   * calls to inline-configured servers; a string selects one registry entry.
   */
  listMcpToolCalls(filter: { registryServerId: string | null; since: string }): Promise<McpToolCallRecord[]>;
  getMcpOAuthConnection(serverId: string): Promise<McpOAuthConnectionRecord | null>;
  upsertMcpOAuthConnection(record: Omit<McpOAuthConnectionRecord, "updatedAt">): Promise<McpOAuthConnectionRecord>;
  getMcpUserOAuthConnection(serverId: string, userId: string): Promise<McpUserOAuthConnectionRecord | null>;
  listMcpUserOAuthConnections(filter?: { serverId?: string; userId?: string }): Promise<McpUserOAuthConnectionRecord[]>;
  upsertMcpUserOAuthConnection(record: Omit<McpUserOAuthConnectionRecord, "updatedAt">): Promise<McpUserOAuthConnectionRecord>;
  deleteMcpUserOAuthConnection(serverId: string, userId: string): Promise<boolean>;
  deleteMcpOAuthConnection(serverId: string): Promise<boolean>;
  getMcpServerCatalog(serverId: string): Promise<McpServerCatalogRecord | null>;
  upsertMcpServerCatalog(serverId: string, catalog: Omit<McpServerCatalog, "updatedAt">): Promise<McpServerCatalogRecord>;
  createMcpElicitation(input: Omit<McpElicitationRecord, "status" | "createdAt" | "answeredAt" | "answeredBy" | "reason">): Promise<McpElicitationRecord>;
  getMcpElicitation(id: string): Promise<McpElicitationRecord | null>;
  listMcpElicitations(filter?: { status?: McpElicitationStatus; executionId?: string; limit?: number }): Promise<McpElicitationRecord[]>;
  /** Settle an elicitation; returns false when it was already settled (first answer wins). */
  settleMcpElicitation(id: string, outcome: { status: Exclude<McpElicitationStatus, "pending">; answeredBy?: string | null; reason?: string | null }): Promise<boolean>;
  /** Mark every pending elicitation of an execution as expired (the run ended or the API restarted). */
  expireMcpElicitationsForExecution(executionId: string, reason: string): Promise<number>;
  /** Pending elicitations whose deadline passed; the elicitation service expires them. */
  listExpiredMcpElicitations(now: string): Promise<McpElicitationRecord[]>;
  /** Rules in evaluation order: oldest first. */
  listMcpToolPolicies(): Promise<McpToolPolicyRule[]>;
  getMcpToolPolicy(id: string): Promise<McpToolPolicyRule | null>;
  createMcpToolPolicy(input: Omit<McpToolPolicyRule, "createdAt" | "updatedAt">): Promise<McpToolPolicyRule>;
  updateMcpToolPolicy(id: string, patch: Partial<
      Pick<McpToolPolicyRule, "name" | "description" | "effect" | "projectId" | "roles" | "serverId" | "toolPattern" | "annotationHint" | "kind" | "enabled">
    >): Promise<McpToolPolicyRule | null>;
  deleteMcpToolPolicy(id: string): Promise<boolean>;
  /** Admin read-only overrides; all of them, or one registry server's. */
  listMcpToolClassifications(registryServerId?: string): Promise<McpToolClassificationOverride[]>;
  /** `readOnly: null` removes the override, so annotations decide again. */
  setMcpToolClassification(input: {
    registryServerId: string;
    toolName: string;
    readOnly: boolean | null;
    setBy: string | null;
  }): Promise<McpToolClassificationOverride | null>;
  listMcpToolsets(): Promise<McpToolset[]>;
  getMcpToolset(id: string): Promise<McpToolset | null>;
  getMcpToolsetBySlug(slug: string): Promise<McpToolset | null>;
  createMcpToolset(input: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    projectId: string | null;
    enabled: boolean;
    createdBy: string | null;
    members: McpToolsetMemberSpec[];
  }): Promise<McpToolset>;
  updateMcpToolset(id: string, patch: {
      slug?: string;
      name?: string;
      description?: string | null;
      projectId?: string | null;
      enabled?: boolean;
      members?: Array<McpToolsetMemberSpec & { id?: string }>;
    }): Promise<McpToolset | null>;
  /** Deletes the toolset and its members, and drops it from every client's scope. */
  deleteMcpToolset(id: string): Promise<boolean>;
  createMcpClient(input: {
    id: string;
    name: string;
    tokenPrefix: string;
    tokenHash: string;
    toolsetIds: string[];
    role: McpPolicyRole;
    createdBy: string | null;
    createdByEmail: string | null;
    expiresAt: string | null;
  }): Promise<McpClient>;
  /** Without the token hash. */
  getMcpClient(id: string): Promise<McpClient | null>;
  /** With the token hash; for the credential check only. */
  findMcpClientByTokenPrefix(prefix: string): Promise<McpClientSecretRecord | null>;
  listMcpClients(): Promise<McpClient[]>;
  revokeMcpClient(id: string): Promise<McpClient | null>;
  touchMcpClient(id: string, at: string): Promise<void>;
  /** MCP tool-call telemetry rows of one execution, oldest first. */
  listMcpToolCallsForExecution(executionId: string): Promise<McpToolCallRecord[]>;

  // ---- Guard profiles, bindings, events and vault

  listGuardProfiles(): Promise<GuardProfileRecord[]>;
  getGuardProfile(id: string): Promise<GuardProfileRecord | null>;
  /**
   * Phase 16 — the guard profile revision: a counter in the database that
   * triggers bump on every write to `guard_profiles` or
   * `guard_profile_versions`, whichever connection or process made it. Caches
   * of profile contents key on it, read once per use (one primary-key read),
   * so a profile saved by another instance is seen by the next run here.
   */
  guardProfileRevision(): Promise<number | undefined>;
  /**
   * Phase 16 — whether any stored version of any guard profile asks for
   * propagated labels, has destination rules or an egress channel (all of
   * which make a run track labels), read from the stored JSON with SQLite's
   * JSON functions (key order and formatting do not matter). Cached per guard
   * profile revision (read from the database each call), so a run checks it
   * with one primary-key read and a profile written by any instance is seen
   * at once.
   */
  anyGuardProfileUsesLabels(): Promise<boolean>;
  /**
   * Phase 16 — observed destination verdicts that would have stopped content:
   * verdicts since `since` with a shadow destination-rule finding of this
   * profile whose action blocks, waits for review or for approval. One per
   * verdict (a verdict with several such findings counts once). Replays,
   * release-gate cases and eval runs are not traffic: they are left out.
   */
  countObservedDestinationBlocks(profileId: string, since: string): Promise<number>;
  /** One version of a profile; the latest when `version` is omitted. */
  getGuardProfileVersion(profileId: string, version?: number): Promise<GuardProfileVersionRecord | null>;
  listGuardProfileVersions(profileId: string): Promise<GuardProfileVersionRecord[]>;
  /** Creates a profile with its first version. */
  insertGuardProfile(input: {
    id: string;
    name: string;
    description?: string | null;
    builtIn?: boolean;
    document: Record<string, unknown>;
    hash: string;
    note?: string | null;
    createdBy: string | null;
  }): Promise<GuardProfileRecord>;
  /** Appends an immutable version and makes it the latest (one transaction: the next number is read and taken together). */
  addGuardProfileVersion(input: {
    profileId: string;
    name: string;
    description?: string | null;
    document: Record<string, unknown>;
    hash: string;
    note?: string | null;
    createdBy: string | null;
  }): Promise<GuardProfileVersionRecord>;
  deleteGuardProfile(id: string): Promise<boolean>;
  getGuardBinding(scope: GuardBindingScope, scopeId: string): Promise<GuardBindingRecord | null>;
  listGuardBindingsForProfile(profileId: string): Promise<GuardBindingRecord[]>;
  setGuardBinding(input: { scope: GuardBindingScope; scopeId: string; mode: string; profileId: string | null; updatedBy: string | null }): Promise<GuardBindingRecord>;
  insertGuardEvents(rows: GuardEventInsert[]): Promise<void>;
  listGuardEvents(filters?: GuardEventFilters & { limit?: number; offset?: number }): Promise<{ events: GuardEventRecord[]; total: number }>;
  /** Events of one execution in the order they were recorded. */
  listGuardEventsForExecution(executionId: string): Promise<GuardEventRecord[]>;
  /** Grouped counts for the Security page. */
  guardEventStats(filters?: GuardEventFilters): Promise<GuardEventStats>;
  getGuardVaultByToken(token: string): Promise<GuardVaultRow | null>;
  getGuardVaultByHash(valueHash: string): Promise<GuardVaultRow | null>;
  /** Stores a token; a concurrent deterministic insert for the same value keeps the first one. */
  putGuardVault(input: { token: string; dataClass: string; valueHash: string | null; valueSealed: string; createdAt: string }): Promise<void>;

  // ---- Data destinations

  /**
   * Every workflow's draft JSON and, when one is published, the published
   * version's JSON, in one query (the "not classified yet" list reads both).
   */
  listWorkflowConfigsForDestinations(): Promise<Array<{ id: string; name: string; draftJson: string; publishedJson: string | null }>>;
  listDataDestinations(): Promise<DataDestinationRow[]>;
  getDataDestination(id: string): Promise<DataDestinationRow | null>;
  /** The row with exactly this match (kind, target id, host), if any. */
  findDataDestinationByMatch(kind: string, targetId: string | null, host: string | null): Promise<DataDestinationRow | null>;
  insertDataDestination(input: DataDestinationWrite & { id: string; actor: string | null; at?: string }): Promise<DataDestinationRow>;
  /** Replaces a row's fields; null when it does not exist. */
  updateDataDestination(id: string, input: DataDestinationWrite & { actor: string | null; at?: string }): Promise<DataDestinationRow | null>;
  deleteDataDestination(id: string): Promise<boolean>;

  // ---- Knowledge bases

  createKnowledgeBase(input: {
    id: string;
    name: string;
    description?: string | null;
    projectId?: string | null;
    embedderId: string;
    embedderConfig?: Record<string, unknown>;
    dimensions?: number;
    createdBy?: string | null;
  }): Promise<void>;
  updateKnowledgeBase(id: string, patch: {
    name?: string;
    description?: string | null;
    embedderConfig?: Record<string, unknown>;
    dimensions?: number;
  }): Promise<boolean>;
  deleteKnowledgeBase(id: string): Promise<boolean>;
  getKnowledgeBase(id: string): Promise<KnowledgeBaseRecord | null>;
  listKnowledgeBases(filter?: { projectId?: string }): Promise<KnowledgeBaseRecord[]>;
  /**
   * Bulk insert chunks. Caller pre-embeds; we store the vector as JSON.
   * dimensions is locked on the first insert if it's still 0 — subsequent
   * inserts must match.
   */
  addKnowledgeBaseChunks(input: {
    knowledgeBaseId: string;
    chunks: Array<{
      id?: string;
      sourceId?: string | null;
      chunkIndex: number;
      content: string;
      metadata?: Record<string, unknown> | null;
      vector: number[];
    }>;
  }): Promise<{ inserted: number; dimensions: number }>;
  /**
   * Pull every chunk for a KB. For Phase 9.1's hand-rolled cosine search
   * we score in JS — fine up to ~10k chunks per KB. Larger fleets should
   * push to pgvector or sqlite-vec (follow-up).
   */
  listKnowledgeBaseChunks(knowledgeBaseId: string): Promise<KnowledgeBaseChunkRecord[]>;
  /**
   * Phase 9.3 — BM25 search via the FTS5 virtual table. Returns chunks with
   * a normalized score (higher = better, 0..1 after normalization). FTS5's
   * native bm25() returns negative values where 0 is best — we flip the sign
   * and rank-normalize so the result composes with cosine similarity in RRF.
   *
   * The user query is tokenized + each token wrapped as a phrase to escape
   * FTS5 special characters. Words shorter than 2 chars are dropped (FTS5's
   * default tokenizer indexes single characters but they hurt recall).
   */
  bm25SearchKnowledgeBase(input: {
    knowledgeBaseId: string;
    query: string;
    topK: number;
  }): Promise<Array<{
    id: string;
    sourceId: string | null;
    chunkIndex: number;
    content: string;
    metadata: Record<string, unknown> | null;
    score: number;
  }>>;
  /** Preview chunks for the UI — content + metadata, no vectors. */
  listKnowledgeBaseChunkPreviews(input: { knowledgeBaseId: string; limit?: number; sourceId?: string }): Promise<Array<{
    id: string; sourceId: string | null; chunkIndex: number; content: string;
    metadata: Record<string, unknown> | null; createdAt: string;
  }>>;
  deleteKnowledgeBaseChunksBySource(input: { knowledgeBaseId: string; sourceId: string }): Promise<number>;
  /**
   * Distinct source IDs in a KB with chunk counts. Powers the "Sources"
   * panel in the ingestion UI (Phase 9.2).
   */
  listKnowledgeBaseSources(knowledgeBaseId: string): Promise<Array<{ sourceId: string; chunkCount: number }>>;

  // ---- Evals (datasets, fixtures, runs, results)

  createEvalDataset(input: {
    id: string;
    name: string;
    description?: string;
    projectId?: string;
    workflowId?: string;
    createdBy?: string;
  }): Promise<void>;
  listEvalDatasets(options?: { projectId?: string; workflowId?: string; id?: string }): Promise<EvalDatasetRecord[]>;
  getEvalDataset(id: string): Promise<EvalDatasetRecord | null>;
  deleteEvalDataset(id: string): Promise<boolean>;
  createEvalFixture(input: {
    id: string; datasetId: string; name: string;
    input: unknown; expected?: unknown;
    scorers?: Array<Record<string, unknown>>;
    recordingId?: string;
  }): Promise<void>;
  listEvalFixtures(datasetId: string): Promise<EvalFixtureRecord[]>;
  getEvalFixture(id: string): Promise<EvalFixtureRecord | null>;
  /** Phase 15.2 — whether a golden set already holds this golden run. */
  findEvalFixtureByRecording(datasetId: string, recordingId: string): Promise<EvalFixtureRecord | null>;
  getEvalFixtureDatasetId(id: string): Promise<string | null>;
  deleteEvalFixture(id: string): Promise<boolean>;
  /** Migration 36 — marks a case required (or not); false when it does not exist. */
  setEvalFixtureRequired(id: string, required: boolean): Promise<boolean>;
  createEvalRun(input: {
    id: string; datasetId: string; workflowId: string; workflowName?: string;
    triggeredBy?: string; triggeredByUserId?: string; scorers?: Array<Record<string, unknown>>;
    /** Phase 15.2 */
    kind?: "eval" | "replay";
    status?: string;
    datasetIds?: string[];
    candidate?: Record<string, unknown>;
    workflowHash?: string;
    workflowVersion?: number | null;
    options?: Record<string, unknown>;
    progress?: Record<string, unknown>;
  }): Promise<void>;
  /**
   * Phase 15.2 — a queued run starts, or a running run reports progress.
   * Only a run still queued or running is touched, so a late heartbeat never
   * revives a run another process finished, canceled or interrupted.
   */
  updateEvalRunProgress(input: { id: string; status?: string; progress: Record<string, unknown> }): Promise<void>;
  /**
   * Phase 15.2 — deletes finished eval runs and replay jobs (with their case
   * results) that started before `before`. The newest run of every dataset
   * or golden set, and its newest finished one, are always kept, so a set
   * never loses its last verdict. Returns how many runs were deleted.
   */
  pruneEvalRuns(input: { before: string }): Promise<number>;
  finalizeEvalRun(input: {
    id: string;
    status: "completed" | "errored" | "failed" | "canceled" | "interrupted";
    summary?: Record<string, unknown>;
    progress?: Record<string, unknown>;
    error?: string;
    /** Only finish a run that is still in one of these statuses (a canceled run stays canceled). */
    onlyFrom?: string[];
  }): Promise<boolean>;
  /** Phase 15.2 — the summary of a run that already finished (a canceled run's last cases). */
  updateEvalRunSummary(id: string, summary: Record<string, unknown>, progress: Record<string, unknown>): Promise<void>;
  listEvalRuns(options?: { datasetId?: string; workflowId?: string; workflowIds?: string[]; kind?: "eval" | "replay"; statuses?: string[]; id?: string; limit?: number; offset?: number; excludeSimulations?: boolean }): Promise<EvalRunRecord[]>;
  getEvalRun(id: string): Promise<EvalRunRecord | null>;
  recordEvalResult(input: {
    id: string; runId: string; fixtureId: string; fixtureName?: string;
    status: "pass" | "fail" | "error" | "skipped";
    executionId?: string;
    score?: Record<string, unknown>;
    output?: unknown;
    error?: string;
    durationMs?: number;
    tokenInput?: number;
    tokenOutput?: number;
    tokenTotal?: number;
    /** Phase 15.2 */
    recordingId?: string;
    verdict?: string;
    diff?: unknown;
    costUsd?: number | null;
  }): Promise<void>;
  listEvalResults(runId: string): Promise<EvalResultRecord[]>;
  /** Phase 15.2 — one case with its run diff. */
  getEvalResult(runId: string, resultId: string): Promise<EvalResultRecord | null>;
  /** Golden-set cases that replay a recording. */
  evalFixtureIdsForRecording(recordingId: string): Promise<string[]>;
  /** The runs holding a result of one of these cases, or one of these results. */
  evalRunIdsForResults(input: { fixtureIds?: readonly string[]; resultIds?: readonly string[] }): Promise<string[]>;
  /** Golden-set cases made from a recording (their input is a copy of the recording's). */
  deleteEvalFixturesForRecording(recordingId: string): Promise<number>;

  // ---- Replay recordings, capture and subject rows

  hasWebhookReplayKey(replayKey: string): Promise<boolean>;
  /** Records a webhook replay fingerprint; false when it was already there (the request is a replay). */
  saveWebhookReplayKey(input: { replayKey: string; endpointKey: string; expiresAt: string }): Promise<boolean>;
  saveReplayRecording(input: ReplayRecordingInsert): Promise<ReplayRecordingSummary>;
  getReplayRecordingSummary(id: string): Promise<ReplayRecordingSummary | null>;
  getReplayRecording(id: string): Promise<ReplayRecordingRecord | null>;
  listReplayRecordings(options?: { workflowId?: string; workflowIds?: string[]; status?: "candidate" | "golden"; limit?: number; offset?: number }): Promise<{ items: ReplayRecordingSummary[]; total: number }>;
  /** Bytes one workflow's golden runs use (each row's `bytes`, cassette included). Candidates have their own count cap. */
  sumReplayRecordingBytesForWorkflow(workflowId: string): Promise<number>;
  /** Bytes every golden run in the deployment uses, cassettes included. */
  sumReplayRecordingBytes(): Promise<number>;
  /** The golden run already saved from an execution, if any (captured candidates do not count). */
  findReplayRecordingIdForExecution(executionId: string, status?: "candidate" | "golden"): Promise<string | null>;
  /** Recordings of a workflow with this status (golden by default: the golden cap counts golden runs only). */
  countReplayRecordingsForWorkflow(workflowId: string, status?: "candidate" | "golden"): Promise<number>;
  /** Captured runs in a workflow's inbox (candidates), newest first. */
  listReplayCaptures(options: {
    workflowId: string;
    runStatus?: string;
    trigger?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: ReplayRecordingSummary[]; total: number }>;
  /** Runs captured for a workflow since `since` (ISO), promoted or not: the daily limit counts these. */
  countReplayCapturesSince(workflowId: string, since: string): Promise<number>;
  /** The oldest `count` candidates of a workflow (eviction order). */
  oldestReplayCaptureIds(workflowId: string, count: number): Promise<string[]>;
  /** Deletes candidates captured before `before` (retention). Golden runs are never touched. */
  pruneReplayCaptures(before: string): Promise<number>;
  /** Promote: the candidate becomes golden with its re-scrubbed content. Returns false when it is no longer a candidate. */
  promoteReplayCapture(id: string, input: Pick<ReplayRecordingInsert, "name" | "capturedWorkflowJson" | "inputJson" | "nodeOutputsJson" | "factsJson" | "mcpCassetteJson" | "modelTapeJson" | "memorySeedJson" | "bytes" | "workflowHash"> & {
      createdBy: string | null;
    }): Promise<boolean>;
  getReplayCaptureSettings(workflowId: string): Promise<ReplayCaptureSettingsRecord | null>;
  saveReplayCaptureSettings(input: Omit<ReplayCaptureSettingsRecord, "updatedAt"> & { updatedAt?: string }): Promise<ReplayCaptureSettingsRecord>;
  /** Notes the last sampled run capture dropped for a workflow (the settings row only; nothing when there is none). */
  recordReplayCaptureDrop(workflowId: string, outcome: string, at: string): Promise<void>;
  /** A page of one store's searchable text, in rowid order after `afterRowid`, for the data-subject lookup. */
  subjectTextPage(kind: SubjectStoreKind, afterRowid: number, limit: number): Promise<{ rows: SubjectTextRow[]; lastRowid: number | null }>;
  /** One row's searchable text (null when it is gone or not in the searched set). */
  subjectTextRow(kind: SubjectStoreKind, id: string): Promise<SubjectTextRow | null>;
  /** Rows the data-subject lookup searches, per store. */
  countSubjectRows(kind: SubjectStoreKind): Promise<number>;
  /**
   * Deletes one row the data-subject lookup found. A golden run takes the
   * golden-set cases made from it, and the results of those cases, with it.
   */
  deleteSubjectRow(kind: SubjectStoreKind, id: string): Promise<{ deleted: boolean; cascaded: Array<{ kind: SubjectStoreKind; id: string }> }>;
  /** Bytes one workflow's captured candidates use (REPLAY_CAPTURES_MAX_BYTES_PER_WORKFLOW). */
  sumReplayCaptureBytesForWorkflow(workflowId: string): Promise<number>;
  /** The oldest candidates of a workflow with their sizes, oldest first (byte-budget eviction). */
  oldestReplayCaptures(workflowId: string, limit: number): Promise<Array<{ id: string; bytes: number }>>;
  /** Runs-page badges: how many golden runs were saved from each execution. */
  replayGoldenBadgesForExecutions(executionIds: string[]): Promise<Map<string, ReplayGoldenBadge>>;
  deleteReplayRecording(id: string): Promise<boolean>;

  // ---- Workflow versions

  listWorkflowVersions(workflowId: string, limit?: number): Promise<Array<{
    id: string;
    workflowId: string;
    version: number;
    createdBy: string | null;
    changeNote: string | null;
    createdAt: string;
  }>>;
  getWorkflowVersion(workflowId: string, version: number): Promise<{
    id: string;
    workflowId: string;
    version: number;
    workflowJson: string;
    createdBy: string | null;
    changeNote: string | null;
    createdAt: string;
  } | null>;
  writeWorkflowVersion(entry: {
    id: string;
    workflowId: string;
    version: number;
    workflowJson: string;
    createdBy?: string | null;
    changeNote?: string | null;
  }): Promise<void>;
  /**
   * Keeps the newest `keep` versions. Phase 15.4: pinned versions (published
   * now or released before) are never pruned and do not count against `keep`.
   */
  pruneWorkflowVersions(workflowId: string, keep: number): Promise<number>;
  maxWorkflowVersionNumber(workflowId: string): Promise<number>;
  /**
   * Appends a version under the next number for the workflow and prunes past `retention` (0 keeps every version),
   * in one transaction: the number is read and taken together, and an existing (workflow_id, version) row is never
   * overwritten, so two concurrent saves get two numbers. `writeWorkflowVersion` stays for writing a known number.
   * Postgres contract (q3a): rely on the UNIQUE (workflow_id, version) index with a plain INSERT of
   * `COALESCE(MAX(version), 0) + 1`. A unique violation (23505) aborts the whole transaction on Postgres, so either
   * `ROLLBACK` and retry the whole transaction, or wrap the INSERT in a `SAVEPOINT` and `ROLLBACK TO SAVEPOINT`
   * before retrying it. Or take `SELECT … FOR UPDATE` on the workflow row first. Prune on the same client in the
   * same transaction.
   */
  appendWorkflowVersion(input: {
    id: string;
    workflowId: string;
    workflowJson: string;
    createdBy?: string | null;
    changeNote?: string | null;
    retention: number;
  }): Promise<{ id: string; version: number; createdAt: string }>;
  /**
   * Moves the published version and records the release, in one transaction:
   * the version is pinned (exempt from retention). Refused (null) when the
   * published version is no longer `expectedPrevious` (another publish got
   * there first) or the version row is gone.
   */
  publishWorkflowVersion(release: Omit<WorkflowReleaseRecord, "previousVersion">, expectedPrevious: number | null): Promise<WorkflowReleaseRecord | null>;

  // ---- RBAC: project roles, custom roles, SSO group mappings

  countProjectMemberships(): Promise<number>;
  listProjectMembers(projectId: string): Promise<Array<{
    userId: string;
    projectId: string;
    role: string;
    customRoleId: string | null;
    createdAt: string;
    updatedAt: string;
  }>>;
  listUserProjectRoles(userId: string): Promise<Array<{
    userId: string;
    projectId: string;
    role: string;
    customRoleId: string | null;
  }>>;
  getProjectRole(userId: string, projectId: string): Promise<{
    userId: string;
    projectId: string;
    role: string;
    customRoleId: string | null;
  } | null>;
  upsertProjectRole(input: {
    userId: string;
    projectId: string;
    role: string;
    customRoleId?: string | null;
  }): Promise<void>;
  removeProjectRole(userId: string, projectId: string): Promise<boolean>;
  listCustomRoles(projectId?: string | null): Promise<Array<{
    id: string;
    projectId: string | null;
    name: string;
    description: string | null;
    permissions: string[];
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  }>>;
  getCustomRole(id: string): Promise<{
    id: string;
    projectId: string | null;
    name: string;
    description: string | null;
    permissions: string[];
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  } | null>;
  upsertCustomRole(input: {
    id: string;
    projectId?: string | null;
    name: string;
    description?: string | null;
    permissions: string[];
    createdBy?: string | null;
  }): Promise<void>;
  deleteCustomRole(id: string): Promise<boolean>;
  listSsoGroupMappings(provider?: string): Promise<Array<{
    id: string;
    provider: string;
    groupName: string;
    projectId: string | null;
    role: string;
    customRoleId: string | null;
    createdAt: string;
    updatedAt: string;
  }>>;
  upsertSsoGroupMapping(input: {
    id: string;
    provider: string;
    groupName: string;
    projectId?: string | null;
    role: string;
    customRoleId?: string | null;
  }): Promise<void>;
  deleteSsoGroupMapping(id: string): Promise<boolean>;

  // ---- Workflow and secret shares

  listWorkflowShares(workflowId: string): Promise<Array<{
    workflowId: string;
    projectId: string;
    accessLevel: string;
    sharedBy: string | null;
    createdAt: string;
  }>>;
  listWorkflowsSharedToProject(projectId: string): Promise<Array<{
    workflowId: string;
    projectId: string;
    accessLevel: string;
  }>>;
  upsertWorkflowShare(input: {
    workflowId: string;
    projectId: string;
    accessLevel: "read" | "execute";
    sharedBy?: string | null;
  }): Promise<void>;
  removeWorkflowShare(workflowId: string, projectId: string): Promise<boolean>;
  listSecretShares(secretId: string): Promise<Array<{
    secretId: string;
    projectId: string;
    sharedBy: string | null;
    createdAt: string;
  }>>;
  listSecretsSharedToProject(projectId: string): Promise<string[]>;
  upsertSecretShare(input: { secretId: string; projectId: string; sharedBy?: string | null }): Promise<void>;
  removeSecretShare(secretId: string, projectId: string): Promise<boolean>;

  // ---- Workflows and templates

  listWorkflows(options?: {
    projectId?: string;
    folderId?: string | null;
    tag?: string;
    search?: string;
  }): Promise<WorkflowListItem[]>;
  getWorkflow(id: string): Promise<Workflow | null>;
  /**
   * `options.createdBy` (a user id) is stored only when the row is first
   * inserted; later saves never change who created a workflow.
   */
  upsertWorkflow(workflow: Workflow, options?: { createdBy?: string | null }): Promise<Workflow>;
  /** Phase 10.2 — user id of the workflow's creator, or null when unknown. */
  getWorkflowCreatedBy(id: string): Promise<string | null>;
  deleteWorkflow(id: string): Promise<boolean>;
  countWorkflows(): Promise<number>;
  listTemplates(filters?: { category?: string; search?: string }): Promise<Array<{
    id: string; name: string; description: string; category: string;
    tags: string[]; author: string; nodeCount: number;
    createdAt: string; updatedAt: string;
  }>>;
  getTemplate(id: string): Promise<{
    id: string; name: string; description: string; category: string;
    tags: string[]; author: string; workflowJson: string; nodeCount: number;
    createdAt: string; updatedAt: string;
  } | undefined>;
  upsertTemplate(input: {
    id: string; name: string; description: string; category: string;
    tags: string[]; author: string; workflowJson: string; nodeCount: number;
  }): Promise<void>;
  deleteTemplate(id: string): Promise<boolean>;
  countTemplates(): Promise<number>;

  // ---- Projects and folders

  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  upsertProject(input: {
    id: string;
    name: string;
    description?: string;
    createdBy?: string;
  }): Promise<Project>;
  deleteProject(id: string): Promise<boolean>;
  listFolders(projectId?: string): Promise<Folder[]>;
  getFolder(id: string): Promise<Folder | null>;
  upsertFolder(input: {
    id: string;
    name: string;
    parentId?: string;
    projectId: string;
  }): Promise<Folder>;
  deleteFolder(id: string): Promise<boolean>;
  /**
   * Backfill helper invoked at startup. Idempotent.
   * Creates the default project if missing, and moves any rows with
   * NULL project_id (shouldn't exist post-migration, but safe) back to default.
   */
  ensureDefaultProject(): Promise<Project>;

  // ---- Users, sessions, API keys, MFA and SSO identities

  countUsers(): Promise<number>;
  getUserByEmail(email: string): Promise<{
    id: string;
    email: string;
    passwordHash: string;
    role: string;
    createdAt: string;
    updatedAt: string;
  } | null>;
  getUserById(id: string): Promise<{
    id: string;
    email: string;
    passwordHash: string;
    role: string;
    createdAt: string;
    updatedAt: string;
  } | null>;
  saveUser(input: {
    id: string;
    email: string;
    passwordHash: string;
    role: string;
  }): Promise<{
    id: string;
    email: string;
    role: string;
    createdAt: string;
    updatedAt: string;
  }>;
  listUsers(): Promise<Array<{
    id: string;
    email: string;
    role: string;
    createdAt: string;
    updatedAt: string;
  }>>;
  updateUserRole(id: string, role: string): Promise<boolean>;
  deleteUser(id: string): Promise<boolean>;
  getSession(sessionId: string): Promise<{
    id: string;
    userId: string;
    expiresAt: string;
    createdAt: string;
    lastSeenAt: string;
    revokedAt: string | null;
  } | null>;
  saveSession(input: {
    id: string;
    userId: string;
    expiresAt: string;
  }): Promise<{
    id: string;
    userId: string;
    expiresAt: string;
    createdAt: string;
    lastSeenAt: string;
  }>;
  touchSession(sessionId: string): Promise<void>;
  revokeSession(sessionId: string): Promise<void>;
  revokeExpiredSessions(): Promise<void>;
  saveApiKey(input: {
    id: string;
    userId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes?: string[];
    expiresAt?: string | null;
  }): Promise<void>;
  listApiKeys(userId?: string): Promise<Array<{
    id: string;
    userId: string;
    name: string;
    keyPrefix: string;
    scopes: string[];
    lastUsedAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  }>>;
  findApiKeyByPrefix(prefix: string): Promise<{
    id: string;
    userId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes: string[];
    lastUsedAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  } | null>;
  touchApiKey(id: string): Promise<void>;
  revokeApiKey(id: string, userId?: string): Promise<boolean>;
  getMfaSecret(userId: string): Promise<{
    userId: string;
    secretIv: string;
    secretAuthTag: string;
    secretCiphertext: string;
    backupCodes: string[];
    enabled: boolean;
    activatedAt: string | null;
    createdAt: string;
    updatedAt: string;
  } | null>;
  upsertMfaSecret(input: {
    userId: string;
    secretIv: string;
    secretAuthTag: string;
    secretCiphertext: string;
    backupCodes: string[];
    enabled: boolean;
    activatedAt: string | null;
  }): Promise<void>;
  /**
   * Swaps a user's backup codes when they are still exactly `expected`
   * (compare-and-set): false when another sign-in used one meanwhile, so a
   * backup code works once even when two sign-ins race.
   */
  replaceMfaBackupCodes(input: { userId: string; expected: readonly string[]; next: readonly string[] }): Promise<boolean>;
  deleteMfaSecret(userId: string): Promise<boolean>;
  findSsoIdentity(provider: string, subject: string): Promise<{
    id: string;
    userId: string;
    provider: string;
    subject: string;
    email: string | null;
    attributes: unknown;
    createdAt: string;
    updatedAt: string;
  } | null>;
  upsertSsoIdentity(input: {
    id: string;
    userId: string;
    provider: string;
    subject: string;
    email?: string | null;
    attributes?: unknown;
  }): Promise<void>;

  // ---- Secrets and external secret providers

  listSecrets(options?: { projectId?: string }): Promise<Array<
    Pick<SecretRow, "id" | "name" | "provider" | "created_at"> & {
      projectId: string;
      source: "local" | "external";
      externalProviderId: string | null;
      externalKey: string | null;
    }
  >>;
  getSecret(id: string): Promise<(SecretRow & {
    projectId: string;
    source: "local" | "external";
    externalProviderId: string | null;
    externalKey: string | null;
  }) | null>;
  saveSecret(input: {
    id: string;
    name: string;
    provider: string;
    iv: string;
    authTag: string;
    ciphertext: string;
    projectId?: string;
    source?: "local" | "external";
    externalProviderId?: string | null;
    externalKey?: string | null;
  }): Promise<void>;
  deleteSecret(id: string): Promise<boolean>;
  listExternalSecretProviders(): Promise<Array<{
    id: string;
    name: string;
    type: string;
    config: Record<string, unknown>;
    credentialsSecretId: string | null;
    cacheTtlMs: number;
    enabled: boolean;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  }>>;
  getExternalSecretProvider(id: string): Promise<{
    id: string;
    name: string;
    type: string;
    config: Record<string, unknown>;
    credentialsSecretId: string | null;
    cacheTtlMs: number;
    enabled: boolean;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  } | null>;
  upsertExternalSecretProvider(input: {
    id: string;
    name: string;
    type: string;
    config: Record<string, unknown>;
    credentialsSecretId?: string | null;
    cacheTtlMs?: number;
    enabled?: boolean;
    createdBy?: string | null;
  }): Promise<void>;
  deleteExternalSecretProvider(id: string): Promise<boolean>;
  countSecretsUsingExternalProvider(providerId: string): Promise<number>;
  getExternalSecretCacheEntry(secretId: string): Promise<{
    secretId: string;
    iv: string;
    authTag: string;
    ciphertext: string;
    fetchedAt: string;
    expiresAt: string;
  } | null>;
  upsertExternalSecretCacheEntry(input: {
    secretId: string;
    iv: string;
    authTag: string;
    ciphertext: string;
    expiresAt: string;
  }): Promise<void>;
  deleteExternalSecretCacheEntry(secretId: string): Promise<void>;

  // ---- Session memory, tool cache and artifacts

  loadSessionMemory(namespace: string, sessionId: string): Promise<ChatMessage[]>;
  /** Migration 37 — the labels stored with a session's memory; null when none were recorded. */
  loadSessionMemoryLabels(namespace: string, sessionId: string): Promise<DataLabels | null>;
  /**
   * Saves a session's memory. `labels` (Phase 16) are given only while the
   * run tracks labels and are merged with the labels already stored; a save
   * without them (an untracked run) keeps the stored labels and adds
   * `untrusted_external` (it re-saves the old messages with a turn of unknown
   * origin); a row with no labels stays without.
   */
  saveSessionMemory(namespace: string, sessionId: string, messages: ChatMessage[], labels?: DataLabels): Promise<void>;
  saveSessionToolCall(input: {
    namespace: string;
    sessionId: string;
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
    output: unknown;
    error?: string;
    summary?: unknown;
    /** Phase 16 — given only while the run tracks labels. */
    labels?: DataLabels;
  }): Promise<{
    id: string;
    namespace: string;
    sessionId: string;
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
    output: unknown;
    error?: string;
    summary?: unknown;
    labels?: DataLabels | null;
    createdAt: string;
  }>;
  listSessionToolCalls(input: {
    namespace: string;
    sessionId: string;
    toolName?: string;
    limit?: number;
  }): Promise<Array<{
    id: string;
    namespace: string;
    sessionId: string;
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
    error?: string;
    summary?: unknown;
    labels?: DataLabels | null;
    createdAt: string;
  }>>;
  getSessionToolCall(input: {
    namespace: string;
    sessionId: string;
    id: string;
  }): Promise<{
    id: string;
    namespace: string;
    sessionId: string;
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
    output: unknown;
    error?: string;
    summary?: unknown;
    labels?: DataLabels | null;
    createdAt: string;
  } | null>;
  /**
   * Saves a session artifact. `labels` (Phase 16) are given only while the
   * run tracks labels and replace the stored ones with the value; a save
   * without them (an untracked run) keeps the stored labels and adds
   * `untrusted_external` (the value may carry the old one forward); a row
   * with no labels stays without.
   */
  saveSessionArtifact(input: {
    namespace: string;
    sessionId: string;
    artifactKey: string;
    value: unknown;
    labels?: DataLabels;
  }): Promise<{
    namespace: string;
    sessionId: string;
    artifactKey: string;
    value: unknown;
    labels?: DataLabels | null;
    createdAt: string;
    updatedAt: string;
  }>;
  loadSessionArtifact(input: {
    namespace: string;
    sessionId: string;
    artifactKey: string;
  }): Promise<{
    namespace: string;
    sessionId: string;
    artifactKey: string;
    value: unknown;
    labels?: DataLabels | null;
    createdAt: string;
    updatedAt: string;
  } | null>;

  // ---- Webhook replay and idempotency

  clearExpiredWebhookSecurityState(nowIso?: string): Promise<void>;
  getWebhookIdempotency(input: { endpointKey: string; idempotencyKey: string }): Promise<{
    endpointKey: string;
    idempotencyKey: string;
    requestHash: string;
    status: string;
    result: unknown;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
  } | null>;
  /** Inserts the pending row for a key; throws when the key is already taken (the caller reads it back). */
  saveWebhookIdempotencyPending(input: {
    endpointKey: string;
    idempotencyKey: string;
    requestHash: string;
    expiresAt: string;
  }): Promise<void>;
  saveWebhookIdempotencyResult(input: {
    endpointKey: string;
    idempotencyKey: string;
    status: "success" | "error" | "partial" | "waiting_approval" | "canceled";
    result: unknown;
  }): Promise<void>;

  // ---- Execution history and paused executions

  /** Returns whether the record was written: false when `unlessFinished` or `unlessCanceled` refused it. */
  saveExecutionHistory(input: {
    id: string;
    workflowId: string;
    workflowName?: string;
    status: string;
    startedAt: string;
    completedAt?: string;
    durationMs?: number;
    triggerType?: string;
    triggeredBy?: string;
    inputJson?: unknown;
    outputJson?: unknown;
    nodeResultsJson?: unknown;
    customData?: unknown;
    error?: string;
  }, options?: {
    /**
     * A progress write: refused (nothing changes) when the run's record is already finished, i.e. `success`,
     * `error`, `canceled`, or `partial` with a completed_at. Postgres contract (q3a): the same condition as the
     * `WHERE` of `ON CONFLICT (id) DO UPDATE`, so a late-committing progress write cannot reopen a finished run.
     */
    unlessFinished?: boolean;
    /**
     * A run's final write: refused when the stored record is `canceled` and this record is not, so a cancel that
     * commits between the run's own abort check and this write keeps the run canceled. A `canceled` record (the
     * stopped run's own final write, with its node results) still replaces it. Postgres contract (implemented):
     * `WHERE execution_history.status <> 'canceled' OR EXCLUDED.status = 'canceled'` on `ON CONFLICT (id) DO UPDATE`.
     */
    unlessCanceled?: boolean;
  }): Promise<boolean>;
  listExecutionHistory(input: {
    page?: number;
    pageSize?: number;
    status?: string;
    workflowId?: string;
    /** Only runs of these workflows; an empty list matches nothing. */
    workflowIds?: string[];
    triggerType?: string;
    startedFrom?: string;
    startedTo?: string;
  }): Promise<{
    total: number;
    page: number;
    pageSize: number;
    items: Array<{
      id: string;
      workflowId: string;
      workflowName: string | null;
      status: string;
      startedAt: string;
      completedAt: string | null;
      durationMs: number | null;
      triggerType: string | null;
      triggeredBy: string | null;
      customData: unknown;
      error: string | null;
      createdAt: string;
    }>;
  }>;
  getExecutionHistory(id: string): Promise<{
    id: string;
    workflowId: string;
    workflowName: string | null;
    status: string;
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
    triggerType: string | null;
    triggeredBy: string | null;
    input: unknown;
    output: unknown;
    nodeResults: unknown;
    customData: unknown;
    error: string | null;
    createdAt: string;
  } | null>;
  /**
   * Cancels a run that is still cancelable, as one conditional write: the history leaves `onlyFrom` for
   * `canceled` (a `partial` run only while it has no completed_at), so a run that finished or resumed meanwhile is
   * not overwritten. With `deletePausedState` the paused state is removed in the same transaction, and the cancel
   * is refused with "decided" when a decision has already claimed that state (its status is no longer
   * `waiting_approval`); the state is then left for the resume. With `cancelClaimed` as well (the caller is
   * aborting that resume, which runs in its own process) a claimed state is deleted too and the run canceled.
   * With `deletePausedState`, every request of the run still `pending` is canceled in the same transaction (status
   * `canceled`, `reason` = `error`), so a request backfilled after the caller's own request cancel cannot outlive
   * the run. `canceledRequestIds` lists those requests (empty unless the outcome is "canceled"), so the caller can
   * audit them.
   * "missing": no such run. "not_cancelable": its status is not one of `onlyFrom` any more.
   * Postgres contract (implemented): one client, `BEGIN`; `SELECT … FROM execution_history WHERE id = $1 FOR
   * UPDATE`; when deleting the paused state `SELECT status FROM workflow_executions WHERE id = $1 FOR UPDATE`, its
   * `DELETE` and `UPDATE approval_requests SET status = 'canceled' … WHERE execution_id = $1 AND status =
   * 'pending' RETURNING id`; `UPDATE execution_history … WHERE id = $1`; `COMMIT` (`ROLLBACK` on any refusal).
   */
  cancelExecution(input: {
    id: string;
    onlyFrom: readonly string[];
    completedAt?: string;
    error?: string;
    deletePausedState?: boolean;
    cancelClaimed?: boolean;
  }): Promise<CancelExecutionResult>;
  pruneExecutionHistory(input: { before: string }): Promise<number>;
  saveWorkflowExecutionState(input: {
    id: string;
    workflowId: string;
    workflowName?: string;
    status: string;
    waitingNodeId: string;
    approvalMessage?: string;
    timeoutMinutes?: number;
    triggerType?: string;
    triggeredBy?: string;
    startedAt: string;
    state: unknown;
  }): Promise<void>;
  getWorkflowExecutionState(id: string): Promise<{
    id: string;
    workflowId: string;
    workflowName: string | null;
    status: string;
    waitingNodeId: string;
    approvalMessage: string | null;
    timeoutMinutes: number | null;
    triggerType: string | null;
    triggeredBy: string | null;
    startedAt: string;
    state: unknown;
    createdAt: string;
    updatedAt: string;
  } | null>;
  listPendingApprovals(): Promise<Array<{
    id: string;
    workflowId: string;
    workflowName: string | null;
    waitingNodeId: string;
    approvalMessage: string | null;
    timeoutMinutes: number | null;
    triggerType: string | null;
    triggeredBy: string | null;
    startedAt: string;
    createdAt: string;
    updatedAt: string;
  }>>;
  deleteWorkflowExecution(id: string): Promise<boolean>;
  /**
   * Phase 11.2 — move a paused run to `resuming` once, so two decisions (two
   * approvers, or an approver and the timeout sweeper) cannot both resume it.
   */
  claimWorkflowExecutionForResume(id: string): Promise<boolean>;
  /** Phase 11.2 — paused runs a decision was taken for but whose resume did not finish (the process stopped). */
  listResumingWorkflowExecutionIds(): Promise<string[]>;
  /** Phase 11.2 — paused runs in `resuming` whose claim is older than `before`, with the claim time. */
  listResumingWorkflowExecutions(before?: string): Promise<Array<{ id: string; claimedAt: string }>>;
  /** Phase 11.2 — hand a claimed run back to the waiting state (the resume could not start). False when it was not claimed. */
  releaseWorkflowExecutionClaim(id: string): Promise<boolean>;

  // ---- Approval requests

  insertApprovalRequest(input: ApprovalRequestInsert): Promise<ApprovalRequestRecord>;
  getApprovalRequest(id: string): Promise<ApprovalRequestRecord | null>;
  /** The newest pending request of a paused run. */
  getPendingApprovalRequestForExecution(executionId: string): Promise<ApprovalRequestRecord | null>;
  listApprovalRequestsForExecution(executionId: string): Promise<ApprovalRequestRecord[]>;
  listApprovalRequests(filter: { status: "pending" | "decided" | "all"; workflowId?: string; executionId?: string; limit?: number; scope?: ApprovalReadScope }): Promise<ApprovalRequestRecord[]>;
  /** Pending requests past their expiry, oldest first. */
  listExpiredApprovalRequests(now: string, limit?: number): Promise<ApprovalRequestRecord[]>;
  /** Records a decision once: false when the request was no longer pending. */
  decideApprovalRequest(input: {
    id: string;
    status: "approved" | "rejected" | "timed_out" | "canceled";
    decidedByUserId?: string | null;
    decidedBy?: string | null;
    reason?: string | null;
    edits?: Record<string, unknown> | null;
    editedFields?: string[];
    decidedAt?: string;
  }): Promise<boolean>;
  /**
   * Phase 11.2 — puts a decided request back to pending (its resume could not
   * run), clearing the decision. Its expiry is unchanged. False when it was
   * not in a decided state.
   */
  reopenApprovalRequest(id: string): Promise<boolean>;
  /** Cancels every pending request of a run (the run was canceled or its workflow deleted). */
  cancelPendingApprovalRequests(filter: { executionId?: string; workflowId?: string }, reason: string): Promise<number>;

  // ---- Execution queue

  /** Phase 11.2 — whether a queue item with this id, or one that extends it (`<id>:…`), is still waiting or running. */
  hasActiveQueueItem(id: string): Promise<boolean>;
  enqueueExecution(input: {
    id: string;
    workflowId: string;
    workflowName?: string;
    payload: Record<string, unknown>;
    priority?: number;
    maxAttempts?: number;
    scheduledAt?: string;
  }): Promise<void>;
  /** Claims up to `limit` due pending items for this process: an item is handed to one caller only. */
  dequeueNext(limit?: number): Promise<Array<{
    id: string;
    workflowId: string;
    workflowName: string | null;
    payload: Record<string, unknown>;
    attempts: number;
    maxAttempts: number;
    scheduledAt: string;
  }>>;
  markQueueItemRunning(id: string): Promise<void>;
  markQueueItemCompleted(id: string): Promise<void>;
  /** Retries with backoff until max attempts; `retryable: false` moves the job to the DLQ now. */
  markQueueItemFailed(id: string, error: string, options?: { retryable?: boolean }): Promise<void>;
  requeueStuckItems(stuckAfterMs?: number, excludeIds?: string[], marginMs?: number): Promise<number>;
  /**
   * Marks runs still recorded as running that no live process owns as errors. Runs the queue still
   * owns (pending/running queue rows) and runs paused for approval are left alone.
   */
  reconcileOrphanedExecutions(input: { error: string; startedBefore?: string }): Promise<Array<{ id: string; workflowId: string }>>;
  getQueueDepth(): Promise<{ pending: number; running: number; dlq: number }>;
  listDlqItems(limit?: number, workflowIds?: string[]): Promise<Array<{
    id: string;
    originalId: string;
    workflowId: string;
    workflowName: string | null;
    attempts: number;
    finalError: string;
    failedAt: string;
  }>>;

  // ---- Triggers, git sync and leases

  getTriggerState(workflowId: string, nodeId: string): Promise<Record<string, unknown> | null>;
  saveTriggerState(input: {
    workflowId: string;
    nodeId: string;
    triggerType: string;
    state: Record<string, unknown>;
  }): Promise<void>;
  deleteTriggerStatesForWorkflow(workflowId: string): Promise<void>;
  getGitConfig(): Promise<{
    id: string;
    repoUrl: string;
    defaultBranch: string;
    authSecretId: string | null;
    workflowsDir: string;
    variablesFile: string;
    userName: string;
    userEmail: string;
    enabled: boolean;
    lastPushAt: string | null;
    lastPullAt: string | null;
    lastError: string | null;
    updatedAt: string;
  } | null>;
  upsertGitConfig(input: {
    repoUrl: string;
    defaultBranch?: string;
    authSecretId?: string | null;
    workflowsDir?: string;
    variablesFile?: string;
    userName?: string;
    userEmail?: string;
    enabled?: boolean;
  }): Promise<void>;
  deleteGitConfig(): Promise<boolean>;
  recordGitSync(input: { kind: "push" | "pull"; error?: string | null }): Promise<void>;
  getLease(leaseName: string): Promise<{
    leaseName: string;
    holderId: string;
    expiresAt: string;
    acquiredAt: string;
    renewedAt: string;
  } | null>;
  /**
   * Atomic compare-and-set lease acquisition. Returns true if this holder
   * now owns the lease, false if another non-expired holder owns it.
   */
  tryAcquireLease(input: { leaseName: string; holderId: string; ttlMs: number }): Promise<boolean>;
  releaseLease(leaseName: string, holderId: string): Promise<boolean>;
  listLeases(): Promise<Array<{
    leaseName: string;
    holderId: string;
    expiresAt: string;
    acquiredAt: string;
    renewedAt: string;
  }>>;

  // ---- Audit log, log streaming, audit export, signing keys and execution manifests

  writeAuditLog(entry: {
    id: string;
    eventType: string;
    category: string;
    action: string;
    outcome: "success" | "failure" | "denied";
    actorUserId?: string | null;
    actorEmail?: string | null;
    actorType?: "user" | "api_key" | "system";
    resourceType?: string | null;
    resourceId?: string | null;
    projectId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    metadata?: unknown;
    message?: string | null;
    createdAt?: string;
  }): Promise<void>;
  /**
   * Walk the chain in insertion order and verify every recomputed entry_hash
   * matches what's stored. Returns details of the first broken link, or
   * `{ ok: true }` when the chain is intact.
   *
   * Rows persisted before Phase 8.4 (where entry_hash IS NULL) are skipped —
   * we can only attest the chain from the first hash onwards.
   */
  verifyAuditChain(): Promise<{
    ok: boolean;
    rowsChecked: number;
    firstBrokenAt?: { id: string; createdAt: string; expected: string; stored: string };
  }>;
  listAuditLogs(filter?: {
    category?: string;
    eventType?: string;
    outcome?: string;
    actorUserId?: string;
    resourceType?: string;
    resourceId?: string;
    projectId?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{
    items: Array<{
      id: string;
      eventType: string;
      category: string;
      action: string;
      outcome: string;
      actorUserId: string | null;
      actorEmail: string | null;
      actorType: string;
      resourceType: string | null;
      resourceId: string | null;
      projectId: string | null;
      ipAddress: string | null;
      userAgent: string | null;
      metadata: unknown;
      message: string | null;
      createdAt: string;
    }>;
    total: number;
    page: number;
    pageSize: number;
  }>;
  pruneAuditLogs(options: { before: string }): Promise<number>;
  listLogStreamDestinations(): Promise<LogStreamDestinationRecord[]>;
  getLogStreamDestination(id: string): Promise<LogStreamDestinationRecord | null>;
  upsertLogStreamDestination(input: {
    id: string;
    name: string;
    type: string;
    enabled?: boolean;
    categories?: string[];
    minLevel?: string;
    configIv?: string | null;
    configAuthTag?: string | null;
    configCiphertext?: string | null;
    createdBy?: string | null;
  }): Promise<void>;
  deleteLogStreamDestination(id: string): Promise<boolean>;
  recordLogStreamDispatch(input: {
    destinationId: string;
    success: boolean;
    error?: string | null;
    at?: string;
  }): Promise<void>;
  writeLogStreamEvent(entry: {
    id: string;
    destinationId: string;
    category: string;
    eventType: string;
    level: string;
    status: "sent" | "failed" | "pending";
    attempts?: number;
    error?: string | null;
    payload?: unknown;
    createdAt?: string;
  }): Promise<void>;
  listLogStreamEvents(filter?: {
    destinationId?: string;
    status?: string;
    limit?: number;
  }): Promise<Array<{
    id: string;
    destinationId: string;
    category: string;
    eventType: string;
    level: string;
    status: string;
    attempts: number;
    error: string | null;
    payload: unknown;
    createdAt: string;
  }>>;
  pruneLogStreamEvents(options: { before: string }): Promise<number>;
  createAuditExportDestination(input: {
    id: string;
    name: string;
    kind: "http" | "file";
    config: Record<string, unknown>;
    intervalSeconds?: number;
    enabled?: boolean;
    createdBy?: string | null;
  }): Promise<void>;
  updateAuditExportDestination(id: string, patch: {
    name?: string;
    config?: Record<string, unknown>;
    intervalSeconds?: number;
    enabled?: boolean;
  }): Promise<boolean>;
  deleteAuditExportDestination(id: string): Promise<boolean>;
  listAuditExportDestinations(): Promise<Array<{
    id: string; name: string; kind: string; config: Record<string, unknown>;
    intervalSeconds: number; enabled: boolean;
    lastExportId: string | null; lastExportAt: string | null;
    lastStatus: string | null; lastError: string | null;
    createdBy: string | null; createdAt: string; updatedAt: string;
  }>>;
  getAuditExportDestination(id: string): Promise<{ id: string; name: string; kind: string; config: Record<string, unknown>; intervalSeconds: number; enabled: boolean; lastExportId: string | null; lastExportAt: string | null; lastStatus: string | null; lastError: string | null; createdBy: string | null; createdAt: string; updatedAt: string; } | null>;
  /**
   * Pull audit_logs strictly newer than `cursor.id` (or all rows when cursor
   * is null). Used by AuditExportService to ship batches incrementally.
   * Ordered by (created_at, id) ASC so cursor-based pagination is stable
   * across concurrent inserts.
   */
  listAuditLogsAfter(input: { afterId: string | null; limit: number }): Promise<Array<{
    id: string; eventType: string; category: string; action: string; outcome: string;
    actorUserId: string | null; actorEmail: string | null; actorType: string;
    resourceType: string | null; resourceId: string | null; projectId: string | null;
    ipAddress: string | null; userAgent: string | null; metadata: unknown;
    message: string | null; createdAt: string; entryHash: string | null;
  }>>;
  recordAuditExportRun(input: {
    id: string;
    destinationId: string;
    startedAt: string;
    completedAt: string;
    status: "success" | "failure" | "partial";
    rowsExported: number;
    firstId?: string | null;
    lastId?: string | null;
    error?: string | null;
  }): Promise<void>;
  listAuditExportRuns(destinationId: string, limit?: number): Promise<Array<{
    id: string; destinationId: string; startedAt: string; completedAt: string | null;
    status: string; rowsExported: number; firstId: string | null; lastId: string | null;
    error: string | null;
  }>>;
  getExecutionManifest(executionId: string): Promise<ExecutionManifestRecord | null>;
  /**
   * Records what a finished run used. A later write (an approval resume
   * finishing the same execution) replaces the context, but never once the
   * manifest has been generated: a manifest is immutable.
   */
  saveExecutionRunContext(executionId: string, runContext: unknown, createdAt: string): Promise<void>;
  /**
   * Stores a generated manifest once. Returns the stored record, which is
   * the first one written if two requests raced to generate it.
   */
  saveExecutionManifest(input: {
    executionId: string;
    manifestJson: string;
    manifestDigest: string;
    keyId: string;
    signature: string;
    signedAt: string;
  }): Promise<ExecutionManifestRecord>;
  /**
   * Audit-log entries about this execution: rows whose metadata `executionId`
   * is this execution, or whose resource is this execution. No IP address or
   * user agent; the actor's current role comes from the users table.
   */
  listAuditLogsForExecution(executionId: string): Promise<Array<{
    eventType: string;
    action: string;
    outcome: string;
    actorUserId: string | null;
    actorRole: string | null;
    actorEmail: string | null;
    actorType: string;
    message: string | null;
    createdAt: string;
  }>>;
  /**
   * Cached manifests are pruned only once both are true: older than the
   * audit-log retention (AUDIT_LOG_RETENTION_DAYS) and their execution's
   * history row is gone. While a run's history is kept its manifest is kept,
   * so it is never regenerated with a new signing time, key or workflow.
   */
  pruneExecutionManifests(options: { before: string }): Promise<number>;
  listAuditSigningKeys(): Promise<AuditSigningKeyRecord[]>;
  getAuditSigningKey(keyId: string): Promise<AuditSigningKeyRecord | null>;
  getActiveAuditSigningKey(): Promise<AuditSigningKeyRecord | null>;
  /**
   * Makes `key` the active key and retires the previous one in one
   * transaction. A key id seen before (an env key put back) is re-activated.
   * Returns false when another writer activated a different key first.
   */
  activateAuditSigningKey(key: Omit<AuditSigningKeyRecord, "status" | "retiredAt">, expectedActiveKeyId: string | null): Promise<boolean>;

  // ---- Variables

  listVariables(projectId?: string): Promise<Array<{
    id: string;
    projectId: string;
    key: string;
    value: string;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  }>>;
  getVariable(id: string): Promise<{
    id: string;
    projectId: string;
    key: string;
    value: string;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
  } | null>;
  upsertVariable(input: {
    id: string;
    projectId: string;
    key: string;
    value: string;
    createdBy?: string | null;
  }): Promise<void>;
  deleteVariable(id: string): Promise<boolean>;
  findVariableByKey(projectId: string, key: string): Promise<{ id: string; key: string; value: string } | null>;

  // ---- Notification configs

  listNotificationConfigs(): Promise<Array<{
    id: string; channel: string; enabled: boolean;
    config: Record<string, unknown>; events: string[];
    createdAt: string; updatedAt: string;
  }>>;
  upsertNotificationConfig(input: {
    id: string; channel: string; enabled: boolean;
    config: Record<string, unknown>; events: string[];
  }): Promise<void>;
  deleteNotificationConfig(id: string): Promise<boolean>;

  // ---- Usage and budgets

  writeUsageEvent(input: {
    id: string;
    executionId: string;
    workflowId: string;
    workflowName?: string | null;
    userId?: string | null;
    userEmail?: string | null;
    projectId?: string | null;
    triggerType?: string | null;
    status: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    costUsd: number;
    llmCallCount: number;
    durationMs: number;
    providers: Array<{ providerId: string; model: string; calls: number }>;
    createdAt?: string;
  }): Promise<void>;
  /**
   * Aggregate usage over a time window. `groupBy` switches between time-series
   * buckets (`day` / `hour`) and dimensional rollups (`workflow` / `user` /
   * `project` / `provider`). Returns rows with summed tokens + cost.
   */
  queryUsageRollup(input: {
    from: string;
    to: string;
    groupBy: "day" | "hour" | "workflow" | "user" | "project" | "provider";
    workflowId?: string;
    userId?: string;
    projectId?: string;
    limit?: number;
  }): Promise<Array<{
    bucket: string;
    workflowId?: string | null;
    workflowName?: string | null;
    userId?: string | null;
    userEmail?: string | null;
    projectId?: string | null;
    providerId?: string | null;
    model?: string | null;
    executions: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    costUsd: number;
    llmCallCount: number;
    avgDurationMs: number;
  }>>;
  /**
   * Single-row totals for the dashboard KPI cards.
   * `userKey` matches either `user_id` OR `user_email` so user-scope budgets
   * can be expressed by either identifier (Phase 8.3).
   */
  queryUsageTotals(input: {
    from: string;
    to: string;
    workflowId?: string;
    userId?: string;
    userKey?: string;
    projectId?: string;
  }): Promise<{
    executions: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    costUsd: number;
    llmCallCount: number;
    avgDurationMs: number;
  }>;
  /**
   * Recent usage events (with cost), most-recent first. Powers the FinOps
   * "recent runs" panel.
   */
  listUsageEvents(input?: { limit?: number; workflowId?: string; userId?: string; projectId?: string }): Promise<Array<{
    id: string; executionId: string; workflowId: string; workflowName: string | null;
    userId: string | null; userEmail: string | null; projectId: string | null;
    triggerType: string | null; status: string;
    inputTokens: number; outputTokens: number; cachedInputTokens: number;
    totalTokens: number; costUsd: number; llmCallCount: number; durationMs: number;
    providers: Array<{ providerId: string; model: string; calls: number }>;
    createdAt: string;
  }>>;
  createBudget(input: {
    id: string;
    name: string;
    scopeType: "global" | "project" | "workflow" | "user";
    scopeId?: string | null;
    period: "day" | "week" | "month";
    limitType: "usd" | "tokens";
    limitValue: number;
    warnThresholdPct?: number;
    action: "warn" | "block";
    notifyChannel?: string | null;
    enabled?: boolean;
    createdBy?: string | null;
  }): Promise<void>;
  updateBudget(id: string, patch: {
    name?: string;
    limitValue?: number;
    warnThresholdPct?: number;
    action?: "warn" | "block";
    notifyChannel?: string | null;
    enabled?: boolean;
  }): Promise<boolean>;
  deleteBudget(id: string): Promise<boolean>;
  getBudget(id: string): Promise<BudgetRecord | null>;
  listBudgets(filter?: { enabledOnly?: boolean; scopeType?: string; scopeId?: string }): Promise<BudgetRecord[]>;
  recordBudgetAlert(input: {
    id: string;
    budgetId: string;
    periodStart: string;
    severity: "warn" | "block";
    usageValue: number;
    limitValue: number;
    workflowId?: string | null;
    executionId?: string | null;
    message?: string;
  }): Promise<void>;
  /**
   * Most recent alert for a (budget, period) pair. Used to debounce — we
   * only fire one warn / one block per period+budget combination so users
   * don't get spammed across every execution after a threshold is crossed.
   */
  getLatestBudgetAlert(budgetId: string, periodStart: string, severity: "warn" | "block"): Promise<{ id: string; firedAt: string } | null>;
  listBudgetAlerts(filter?: { budgetId?: string; limit?: number }): Promise<Array<{
    id: string; budgetId: string; periodStart: string;
    severity: string; usageValue: number; limitValue: number;
    workflowId: string | null; executionId: string | null;
    message: string | null; firedAt: string;
  }>>;
  // ---- Atomic multi-step operations (each runs in one transaction)

  /**
   * Claims a paused run for resume and records the approval decision together: both commit or neither does.
   * False (nothing changed) when the run was not waiting or the request was no longer pending.
   */
  claimExecutionAndDecideApproval(executionId: string, decision: ApprovalDecisionInput): Promise<boolean>;
  /**
   * Hands a claimed run back to waiting and its decided request back to pending, together. False (nothing
   * changed) when the run is no longer claimed.
   */
  releaseExecutionClaimAndReopenApproval(executionId: string, requestId: string): Promise<boolean>;
  /**
   * Saves a release gate's settings (`gate`; null keeps the stored row) and its admitted cases (omitted: left
   * alone) together, only if the gate is still as `expected` (null: there was none). Null when it changed meanwhile.
   */
  saveReleaseGate(input: {
    gate: ReleaseGateRecord | null;
    admittedFixtureIds?: string[] | null;
    expected: ReleaseGateRecord | null;
    updatedAt: string;
    updatedBy: string | null;
  }): Promise<ReleaseGateRecord | null>;
  /** Applies a change to an enforced gate's cases (see `ReleaseGateCasesChange`); "ok" when it was applied. */
  updateReleaseGateCases(change: ReleaseGateCasesChange): Promise<"ok" | "decided" | "changed">;
  /**
   * Approves a pending release request and publishes its version together (`publishWorkflowVersion` with
   * `expectedPrevious`). Refused, with nothing changed, when the request was no longer pending ("decided") or
   * another version was published meanwhile ("conflict").
   */
  approveReleaseRequestAndPublish(
    decision: ReleaseApprovalDecisionInput,
    release: Omit<WorkflowReleaseRecord, "previousVersion">,
    expectedPrevious: number | null
  ): Promise<{ release: WorkflowReleaseRecord } | { refused: "decided" | "conflict" }>;
  /**
   * Saves a golden run after checking, in the same transaction, that the run is not saved already (when
   * `uniqueExecution`) and that the golden-run count and storage budgets still allow it (when `limits`).
   */
  saveReplayRecordingChecked(
    input: ReplayRecordingInsert,
    checks: { limits?: ReplayRecordingLimits; uniqueExecution?: boolean }
  ): Promise<{ saved: ReplayRecordingSummary } | ReplayRecordingRefusal>;
  /**
   * Promotes a capture candidate into a golden set in one transaction: the candidate becomes golden (after the
   * golden-run limits), the target set is the given one (refused "set_gone" when it was deleted) or the
   * workflow's set named `findOrCreate.name` (made when missing), and the golden run joins it as a case.
   */
  promoteReplayCaptureToGoldenSet(input: {
    recordingId: string;
    promotion: Parameters<Store["promoteReplayCapture"]>[1];
    target: { datasetId: string } | { findOrCreate: Parameters<Store["createEvalDataset"]>[0] & { workflowId: string } };
    fixture: { id: string; name?: string };
    limits: ReplayRecordingLimits;
  }): Promise<{ datasetId: string; fixtureId: string } | { refused: "not_candidate" } | { refused: "set_gone" } | ReplayRecordingRefusal>;
  /**
   * Golden-set file import: creates the set, saves each golden run (after the golden-run limits) and adds it
   * as a case, all in one transaction. A refusal leaves nothing behind.
   */
  importGoldenSet(input: {
    dataset: Parameters<Store["createEvalDataset"]>[0];
    cases: Array<{ recording: ReplayRecordingInsert; fixture: Omit<Parameters<Store["createEvalFixture"]>[0], "datasetId" | "recordingId"> }>;
    limits: ReplayRecordingLimits;
  }): Promise<{ recordingIds: string[] } | ReplayRecordingRefusal>;
}
