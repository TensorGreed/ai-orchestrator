/**
 * Phase 13.1 — the db:copy round-trip fixture: realistic rows in every store domain, written through the Store
 * interface only, and the reads that must answer the same on the SQLite source and on the Postgres copy.
 *
 *   await seedAllDomains(sqliteStore);
 *   // ... db:copy the SQLite file into Postgres ...
 *   for (const { name, read } of roundTripReads()) expect(await read(postgresStore)).toEqual(await read(sqliteStore));
 *
 * Determinism: fixed ids everywhere, and fixed millisecond ISO times wherever a method takes a time. Rows whose time
 * the store stamps itself (wall clock) are written one millisecond apart (every Store call of the seed waits for a
 * new millisecond first) so no list depends on how a store breaks a same-millisecond tie (SQLite's index order is not
 * reproduced on Postgres).
 *
 * Reads are store-independent: no scores (keyword search returns hit ids only, for a plain word present verbatim, as
 * Postgres stems), no rowid / seq values (data-subject pages return ids only), no storageLocation and no
 * guardProfileRevision (a counter Postgres triggers bump while rows are copied in). Reads that would default to the
 * current time get a fixed `now`. Nothing here mutates, and verifyAuditChain is tested separately. Two reads are
 * normalised for documented store differences: execution history `createdAt` (SQLite stores `datetime('now')`,
 * "YYYY-MM-DD HH:MM:SS"; Postgres reads every timestamp back as canonical ISO) is made canonical ISO, and the guard
 * event stats groups are sorted by count then key (rows with equal counts come in either store's tie order).
 *
 * Domains with nothing to seed through the Store: schedules live in workflow JSON (the scheduler reads trigger nodes),
 * so they are covered by the workflows; leases are seeded with tryAcquireLease.
 */
import type { ChatMessage, DataLabels, McpCassette, Workflow } from "@ai-orchestrator/shared";
import type { ApprovalRequestInsert, GuardEventInsert, McpToolCallWrite, ReplayRecordingInsert } from "../db/database.js";
import type { ReplayRecordingLimits, Store } from "../db/store.js";

const BASE = Date.parse("2026-10-20T10:00:00.000Z");
/** A fixed ISO time `seconds` after 2026-10-20T10:00:00.000Z. */
const T = (seconds: number): string => new Date(BASE + seconds * 1000).toISOString();
/** A fixed "now" for reads that compare with the clock. */
const NOW = T(100_000);
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";
const ROOMY: ReplayRecordingLimits = { maxPerWorkflow: 100, maxBytesPerWorkflow: 10_000_000, maxTotalBytes: 100_000_000 };

/** Waits until the wall clock has moved to a new millisecond, so the next store-stamped time is distinct. */
async function nextMillisecond(): Promise<void> {
  const start = Date.now();
  while (Date.now() === start) await new Promise((resolve) => setTimeout(resolve, 1));
}

function workflow(id: string, overrides: Record<string, unknown> = {}): Workflow {
  return {
    id,
    name: `Workflow ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "trigger", type: "schedule_trigger", name: "Every hour", position: { x: 0, y: 0 }, config: { cron: "0 * * * *" } },
      { id: "agent", type: "agent_orchestrator", name: "Agent", position: { x: 200, y: 0 }, config: { systemPrompt: "Help with refunds." } }
    ],
    edges: [{ id: "e1", source: "trigger", target: "agent" }],
    ...overrides
  } as unknown as Workflow;
}

const LABELS_USER: DataLabels = { provenance: ["user"], dataClasses: ["email"], source: "scan" };
const LABELS_TOOL: DataLabels = { provenance: ["untrusted_external"], dataClasses: [], source: "propagated" };

function cassette(calls: number): McpCassette {
  return {
    version: 1,
    servers: [{ serverId: "mcp-search", label: "Search" }],
    entries: Array.from({ length: calls }, (_, index) => ({ serverId: "mcp-search", toolName: `tool_${index}`, args: { q: index }, result: { ok: true } })),
    bytes: 100 + calls,
    truncated: false
  } as unknown as McpCassette;
}

function recording(id: string, overrides: Partial<ReplayRecordingInsert> = {}): ReplayRecordingInsert {
  return {
    id,
    workflowId: "wf-support",
    projectId: "proj-ops",
    name: `Golden ${id}`,
    notes: "customer refund flow",
    sourceExecutionId: `exec-${id}`,
    sourceTriggerType: "manual",
    sourceStatus: "success",
    workflowHash: "hash-support-1",
    workflowSavedVersion: 2,
    capturedWorkflowJson: JSON.stringify({ id: "wf-support", nodes: [] }),
    inputJson: JSON.stringify({ question: `refund ${id}` }),
    nodeOutputsJson: JSON.stringify({ agent: { status: "success", output: { text: "ok" } } }),
    factsJson: JSON.stringify({ status: "success" }),
    mcpCassetteJson: null,
    modelTapeJson: null,
    memorySeedJson: null,
    capabilities: { mcp: "none", models: "live", memory: "empty", workflowSource: "captured" },
    bytes: 120,
    truncated: false,
    createdAt: T(400),
    createdBy: "builder@example.com",
    ...overrides
  };
}

function guardEvent(id: string, overrides: Partial<GuardEventInsert> = {}): GuardEventInsert {
  return {
    id,
    verdictId: `v-${id}`,
    executionId: "exec-1",
    workflowId: "wf-support",
    projectId: "proj-ops",
    nodeId: "agent",
    placement: "pre_tool",
    iteration: 1,
    toolName: "search",
    channel: "tool_args",
    detectorId: "email",
    category: "pii",
    dataClass: "email",
    score: 0.75,
    requestedAction: "mask",
    effectiveAction: "mask",
    verdictAction: "mask",
    shadow: false,
    evidence: [{ spans: [{ start: 1, end: 4 }], message: "an email" }] as GuardEventInsert["evidence"],
    profileId: "gp-strict",
    profileVersion: 2,
    profileHash: "gp-strict-h2",
    latencyMs: 1.5,
    budgetExceeded: false,
    skippedDetectors: ["slow"],
    createdAt: T(600),
    ...overrides
  };
}

function toolCall(id: string, overrides: Partial<McpToolCallWrite> = {}): McpToolCallWrite {
  return {
    id,
    executionId: "exec-1",
    workflowId: "wf-support",
    nodeId: "agent",
    registryServerId: "mcp-search",
    adapterId: "http-mcp",
    toolName: "search",
    startedAt: T(500),
    durationMs: 12,
    ok: true,
    error: null,
    turnInputTokens: 10,
    turnOutputTokens: 5,
    estimatedCostUsd: 0.0125,
    ...overrides
  };
}

const approvalSpec = {
  kind: "approval_gate",
  approverRoles: ["admin"],
  approverUsers: [],
  allowSelfApproval: false,
  timeoutOutcome: "reject",
  requireRejectReason: true,
  editableFields: []
} as ApprovalRequestInsert["spec"];

function approvalRequest(id: string, overrides: Partial<ApprovalRequestInsert> = {}): ApprovalRequestInsert {
  return { id, executionId: "exec-paused", workflowId: "wf-support", projectId: "proj-ops", nodeId: "gate", kind: "approval_gate", spec: approvalSpec, ...overrides };
}

/** Writes realistic rows in every store domain into a fresh store, through Store methods only. */
export async function seedAllDomains(target: Store): Promise<void> {
  // Every call starts in a new millisecond, so no two store-stamped times of the seed are equal.
  const store = new Proxy(target, {
    get(object, key, receiver) {
      const value: unknown = Reflect.get(object, key, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        await nextMillisecond();
        return (value as (...a: unknown[]) => unknown).apply(object, args);
      };
    }
  });
  // ---- Projects, folders, users and RBAC
  await store.ensureDefaultProject();
  await store.upsertProject({ id: "proj-ops", name: "Operations", description: "Support automation", createdBy: "u-admin" });
  await store.upsertProject({ id: "proj-lab", name: "lab" });
  await store.upsertFolder({ id: "fold-a", name: "Refunds", projectId: "proj-ops" });
  await store.upsertFolder({ id: "fold-b", name: "archive", projectId: "proj-ops", parentId: "fold-a" });

  await store.saveUser({ id: "u-admin", email: "Admin@Example.com", passwordHash: "hash-admin", role: "admin" });
  await store.saveUser({ id: "u-builder", email: "builder@example.com", passwordHash: "hash-builder", role: "builder" });
  await store.saveUser({ id: "u-viewer", email: "viewer@example.com", passwordHash: "hash-viewer", role: "viewer" });
  await store.saveSession({ id: "sess-1", userId: "u-admin", expiresAt: FAR_FUTURE });
  await store.saveSession({ id: "sess-2", userId: "u-builder", expiresAt: FAR_FUTURE });
  await store.revokeSession("sess-2");
  await store.saveApiKey({ id: "key-1", userId: "u-admin", name: "ci", keyPrefix: "l2m_ci01", keyHash: "khash-1", scopes: ["workflow:run"], expiresAt: FAR_FUTURE });
  await store.saveApiKey({ id: "key-2", userId: "u-builder", name: "local", keyPrefix: "l2m_lo02", keyHash: "khash-2" });
  await store.upsertMfaSecret({ userId: "u-admin", secretIv: "mfa-iv", secretAuthTag: "mfa-tag", secretCiphertext: "mfa-ct", backupCodes: ["code-a", "code-b"], enabled: true, activatedAt: T(1) });
  await store.upsertSsoIdentity({ id: "sso-1", userId: "u-builder", provider: "oidc", subject: "sub-builder", email: "builder@example.com", attributes: { groups: ["eng"] } });
  await store.upsertCustomRole({ id: "cr-runner", projectId: "proj-ops", name: "Runner", description: "runs only", permissions: ["workflow:read", "workflow:run"], createdBy: "u-admin" });
  await store.upsertCustomRole({ id: "cr-global", name: "auditor", permissions: ["audit:read"] });
  await store.upsertProjectRole({ userId: "u-builder", projectId: "proj-ops", role: "builder" });
  await store.upsertProjectRole({ userId: "u-viewer", projectId: "proj-ops", role: "viewer", customRoleId: "cr-runner" });
  await store.upsertProjectRole({ userId: "u-viewer", projectId: "proj-lab", role: "viewer" });
  await store.upsertSsoGroupMapping({ id: "map-1", provider: "okta", groupName: "eng", projectId: "proj-ops", role: "builder" });
  await store.upsertSsoGroupMapping({ id: "map-2", provider: "okta", groupName: "Admins", role: "admin", customRoleId: "cr-global" });

  // ---- Workflows, versions, shares, templates and publishing
  await store.upsertWorkflow(workflow("wf-support", { name: "Support triage", projectId: "proj-ops", folderId: "fold-a", tags: ["support", "rag"] }), { createdBy: "u-builder" });
  await store.upsertWorkflow(workflow("wf-report", { name: "Weekly report", tags: ["ops"] }), { createdBy: "u-admin" });
  await store.upsertWorkflow(workflow("wf-lab", { name: "Lab experiment", projectId: "proj-lab" }));
  for (const n of [1, 2, 3]) {
    await store.appendWorkflowVersion({ id: `wfv-support-${n}`, workflowId: "wf-support", workflowJson: JSON.stringify({ id: "wf-support", n }), createdBy: "u-builder", changeNote: `v${n}`, retention: 0 });
  }
  await store.appendWorkflowVersion({ id: "wfv-report-1", workflowId: "wf-report", workflowJson: JSON.stringify({ id: "wf-report", n: 1 }), retention: 0 });
  await store.upsertWorkflowShare({ workflowId: "wf-support", projectId: "proj-lab", accessLevel: "read", sharedBy: "u-admin" });
  await store.upsertWorkflowShare({ workflowId: "wf-report", projectId: "proj-lab", accessLevel: "execute" });
  await store.upsertTemplate({ id: "tpl-rag", name: "RAG answerer", description: "Answers from a knowledge base", category: "AI", tags: ["rag"], author: "l2m", workflowJson: JSON.stringify(workflow("tpl-rag")), nodeCount: 2 });
  await store.upsertTemplate({ id: "tpl-alert", name: "Alerting", description: "Posts failures", category: "Ops", tags: [], author: "l2m", workflowJson: "{}", nodeCount: 0 });
  await store.publishWorkflowVersion(
    { id: "rel-1", workflowId: "wf-support", version: 1, workflowHash: "hash-support-1", replayRunId: null, verdict: "ungated", reason: null, gateReasons: [], approval: null, publishedAt: T(10), publishedBy: "admin@example.com", publishedByUserId: "u-admin" },
    null
  );
  await store.publishWorkflowVersion(
    { id: "rel-2", workflowId: "wf-support", version: 2, workflowHash: "hash-support-2", replayRunId: "replay-run-1", verdict: "pass", reason: null, gateReasons: ["ok"], approval: null, publishedAt: T(20), publishedBy: "admin@example.com", publishedByUserId: "u-admin" },
    1
  );
  // An unpublished workflow: its mark (workflows.unpublished_at) and the history order of a same-millisecond pair.
  await store.publishWorkflowVersion(
    { id: "rel-r1", workflowId: "wf-report", version: 1, workflowHash: "hash-report-1", replayRunId: null, verdict: "ungated", reason: null, gateReasons: [], approval: null, publishedAt: T(30), publishedBy: "admin@example.com", publishedByUserId: "u-admin" },
    null
  );
  await store.unpublishWorkflowVersion({ id: "rel-r2", workflowId: "wf-report", reason: "bad answers", unpublishedAt: T(30), unpublishedBy: "admin@example.com", unpublishedByUserId: "u-admin" });

  // ---- Secrets, shares, external providers and their cache
  await store.saveSecret({ id: "sec-openai", name: "OpenAI key", provider: "openai", iv: "aXYtMQ==", authTag: "dGFnLTE=", ciphertext: "Y3QtMQ==", projectId: "proj-ops" });
  await store.saveSecret({ id: "sec-vault", name: "Vault token", provider: "custom", iv: "aXYtMg==", authTag: "dGFnLTI=", ciphertext: "Y3QtMg==" });
  await store.saveSecret({ id: "sec-ext", name: "DB password", provider: "custom", iv: "", authTag: "", ciphertext: "", source: "external", externalProviderId: "esp-vault", externalKey: "kv/db#password" });
  await store.upsertSecretShare({ secretId: "sec-openai", projectId: "proj-lab", sharedBy: "u-admin" });
  await store.upsertExternalSecretProvider({ id: "esp-vault", name: "Vault", type: "vault", config: { url: "https://vault.example.com" }, credentialsSecretId: "sec-vault", cacheTtlMs: 60_000, createdBy: "u-admin" });
  await store.upsertExternalSecretProvider({ id: "esp-aws", name: "AWS", type: "aws_secrets_manager", config: { region: "eu-west-1" }, enabled: false });
  await store.upsertExternalSecretCacheEntry({ secretId: "sec-ext", iv: "Y2l2", authTag: "Y3RhZw==", ciphertext: "Y2N0", expiresAt: FAR_FUTURE });

  // ---- Variables, notification configs, git config
  await store.upsertVariable({ id: "var-1", projectId: "proj-ops", key: "SUPPORT_EMAIL", value: "help@example.com", createdBy: "u-admin" });
  await store.upsertVariable({ id: "var-2", projectId: "proj-ops", key: "region", value: "eu" });
  await store.upsertVariable({ id: "var-3", projectId: "default", key: "TIMEOUT_MS", value: "30000" });
  await store.upsertNotificationConfig({ id: "notif-slack", channel: "slack", enabled: true, config: { webhookUrl: "https://hooks.example.com/x" }, events: ["execution.failure"] });
  await store.upsertNotificationConfig({ id: "notif-email", channel: "email", enabled: false, config: { to: "ops@example.com" }, events: ["execution.success", "execution.failure"] });
  await store.upsertGitConfig({ repoUrl: "https://git.example.com/flows.git", defaultBranch: "main", authSecretId: "sec-vault", userName: "l2m-bot", userEmail: "bot@example.com" });
  await store.recordGitSync({ kind: "push", error: "rejected: non-fast-forward" });

  // ---- Knowledge bases and chunks
  await store.createKnowledgeBase({ id: "kb-policies", name: "Policies", description: "Refund and shipping policies", projectId: "proj-ops", embedderId: "hash", embedderConfig: { size: 3 }, createdBy: "u-builder" });
  await store.createKnowledgeBase({ id: "kb-empty", name: "empty", embedderId: "hash" });
  await store.addKnowledgeBaseChunks({
    knowledgeBaseId: "kb-policies",
    chunks: [
      { id: "chunk-refund-1", sourceId: "doc-refunds", chunkIndex: 0, content: "Refund policy: a refund is issued within 14 days. Every refund needs a receipt.", metadata: { page: 1 }, vector: [1, 0, 0] },
      { id: "chunk-refund-2", sourceId: "doc-refunds", chunkIndex: 1, content: "Store credit is offered when no refund applies.", vector: [0.5, 0.5, 0] },
      { id: "chunk-shipping", sourceId: "doc-shipping", chunkIndex: 0, content: "Shipping takes five working days within the country.", metadata: { page: 3 }, vector: [0, 1, 0] }
    ]
  });
  await store.addKnowledgeBaseChunks({
    knowledgeBaseId: "kb-policies",
    chunks: [{ id: "chunk-office", sourceId: null, chunkIndex: 0, content: "Our office opens at nine on weekdays.", vector: [0, 0, 1] }]
  });

  // ---- Session memory, tool cache and artifacts (with data labels)
  const messages: ChatMessage[] = [
    { role: "user", content: "Where is my refund?" },
    { role: "assistant", content: "It is issued within 14 days." }
  ];
  await store.saveSessionMemory("wf-support:agent", "chat-1", messages, LABELS_USER);
  await store.saveSessionMemory("wf-support:agent", "chat-2", [{ role: "user", content: "hello" }]);
  await store.saveSessionToolCall({ namespace: "wf-support:agent", sessionId: "chat-1", toolName: "search", toolCallId: "tc-1", args: { q: "refund" }, output: { hits: 2 }, summary: "two hits", labels: LABELS_TOOL });
  await store.saveSessionToolCall({ namespace: "wf-support:agent", sessionId: "chat-1", toolName: "fetch_order", args: { orderId: 42 }, output: null, error: "timeout" });
  await store.saveSessionArtifact({ namespace: "wf-support:agent", sessionId: "chat-1", artifactKey: "summary", value: { text: "refund pending" }, labels: LABELS_USER });

  // ---- Webhook security state and trigger state
  await store.saveWebhookReplayKey({ replayKey: "replay-fp-1", endpointKey: "support-hook", expiresAt: FAR_FUTURE });
  await store.saveWebhookIdempotencyPending({ endpointKey: "support-hook", idempotencyKey: "idem-1", requestHash: "rhash-1", expiresAt: FAR_FUTURE });
  await store.saveWebhookIdempotencyResult({ endpointKey: "support-hook", idempotencyKey: "idem-1", status: "success", result: { executionId: "exec-1" } });
  await store.saveWebhookIdempotencyPending({ endpointKey: "support-hook", idempotencyKey: "idem-2", requestHash: "rhash-2", expiresAt: FAR_FUTURE });
  await store.saveTriggerState({ workflowId: "wf-report", nodeId: "trigger", triggerType: "rss", state: { lastGuid: "item-9", seen: 9 } });

  // ---- Execution history, paused runs, approvals, queue, leases
  await store.saveExecutionHistory({
    id: "exec-1", workflowId: "wf-support", workflowName: "Support triage", status: "success", startedAt: T(500), completedAt: T(502), durationMs: 2000,
    triggerType: "webhook", triggeredBy: "support-hook", inputJson: { question: "refund?" }, outputJson: { answer: "14 days" },
    nodeResultsJson: [{ nodeId: "agent", status: "success" }], customData: { ticket: "T-1" }
  });
  await store.saveExecutionHistory({ id: "exec-2", workflowId: "wf-report", workflowName: "Weekly report", status: "error", startedAt: T(510), completedAt: T(511), durationMs: 1000, triggerType: "schedule", error: "model timeout" });
  await store.saveExecutionHistory({ id: "exec-replay", workflowId: "wf-support", workflowName: "Support triage", status: "success", startedAt: T(520), triggerType: "replay", inputJson: { email: "alice@example.com" } });
  await store.saveExecutionHistory({ id: "exec-paused", workflowId: "wf-support", workflowName: "Support triage", status: "waiting_approval", startedAt: T(530), triggerType: "manual", triggeredBy: "u-builder" });
  await store.saveWorkflowExecutionState({
    id: "exec-paused", workflowId: "wf-support", workflowName: "Support triage", status: "waiting_approval", waitingNodeId: "gate",
    approvalMessage: "Approve the refund?", timeoutMinutes: 60, triggerType: "manual", triggeredBy: "u-builder", startedAt: T(530), state: { cursor: 3 }
  });
  await store.setExecutionRelease("exec-1", "production", 2);
  await store.setExecutionRelease("exec-2", "draft", null);
  await store.insertApprovalRequest(approvalRequest("apr-1", {
    workflowName: "Support triage", nodeType: "approval_gate", message: "Approve the refund?", details: { amount: 30 },
    requestedByUserId: "u-builder", requestedBy: "builder@example.com", timeoutMinutes: 60, expiresAt: T(4130), createdAt: T(531)
  }));
  await store.insertApprovalRequest(approvalRequest("apr-2", { executionId: "exec-old", createdAt: T(300) }));
  await store.decideApprovalRequest({ id: "apr-2", status: "rejected", decidedByUserId: "u-admin", decidedBy: "admin@example.com", reason: "too high", decidedAt: T(310) });
  await store.enqueueExecution({ id: "q-1", workflowId: "wf-report", workflowName: "Weekly report", payload: { week: 43 }, priority: 1, maxAttempts: 5, scheduledAt: FAR_FUTURE });
  await store.enqueueExecution({ id: "sched_wf-report:2026-10-21", workflowId: "wf-report", payload: {}, scheduledAt: FAR_FUTURE });
  await store.enqueueExecution({ id: "q-bad", workflowId: "wf-lab", workflowName: "Lab experiment", payload: { broken: true }, scheduledAt: FAR_FUTURE });
  await store.markQueueItemFailed("q-bad", "invalid input", { retryable: false });
  await store.tryAcquireLease({ leaseName: "scheduler", holderId: "instance-a", ttlMs: 86_400_000 });
  await store.tryAcquireLease({ leaseName: "Queue", holderId: "instance-b", ttlMs: 86_400_000 });

  // ---- Audit log, signing keys, manifests, export destinations, log streams
  const auditRows: Array<Parameters<Store["writeAuditLog"]>[0]> = [
    { id: "aud-01", eventType: "auth.login", category: "auth", action: "login", outcome: "success", actorUserId: "u-admin", actorEmail: "admin@example.com", ipAddress: "10.0.0.1", userAgent: "Firefox" },
    { id: "aud-02", eventType: "auth.login", category: "auth", action: "login", outcome: "failure", actorEmail: "nobody@example.com", message: "bad password" },
    { id: "aud-03", eventType: "workflow.saved", category: "workflow", action: "save", outcome: "success", actorUserId: "u-builder", resourceType: "workflow", resourceId: "wf-support", projectId: "proj-ops" },
    { id: "aud-04", eventType: "workflow.published", category: "workflow", action: "publish", outcome: "success", actorUserId: "u-admin", resourceType: "workflow", resourceId: "wf-support", projectId: "proj-ops", metadata: { version: 2 } },
    { id: "aud-05", eventType: "execution.started", category: "execution", action: "start", outcome: "success", actorType: "system", resourceType: "execution", resourceId: "exec-1" },
    { id: "aud-06", eventType: "execution.finished", category: "execution", action: "finish", outcome: "success", actorType: "system", metadata: { executionId: "exec-1", durationMs: 2000 } },
    { id: "aud-07", eventType: "secret.created", category: "secret", action: "create", outcome: "success", actorUserId: "u-admin", resourceType: "secret", resourceId: "sec-openai" },
    { id: "aud-08", eventType: "secret.read", category: "secret", action: "read", outcome: "denied", actorUserId: "u-viewer", actorType: "api_key", resourceType: "secret", resourceId: "sec-vault" },
    { id: "aud-09", eventType: "approval.decided", category: "approval", action: "reject", outcome: "success", actorUserId: "u-admin", metadata: { executionId: "exec-old", requestId: "apr-2" } },
    { id: "aud-10", eventType: "rbac.role_changed", category: "rbac", action: "update", outcome: "success", actorUserId: "u-admin", resourceType: "user", resourceId: "u-viewer", message: "viewer -> runner" },
    { id: "aud-11", eventType: "mcp.client_created", category: "mcp", action: "create", outcome: "success", actorUserId: "u-admin", resourceType: "mcp_client", resourceId: "mcp-client-1" },
    { id: "aud-12", eventType: "auth.logout", category: "auth", action: "logout", outcome: "success", actorUserId: "u-admin" }
  ];
  for (const [index, row] of auditRows.entries()) await store.writeAuditLog({ ...row, createdAt: T(700 + index) });
  await store.activateAuditSigningKey({ keyId: "sign-1", algorithm: "Ed25519", publicKey: "pub-1", source: "generated", secretId: "sec-vault", createdAt: T(30) }, null);
  await store.activateAuditSigningKey({ keyId: "sign-2", algorithm: "Ed25519", publicKey: "pub-2", source: "env", secretId: null, createdAt: T(40) }, "sign-1");
  await store.saveExecutionRunContext("exec-1", { model: "gpt-x", tools: ["search"] }, T(503));
  await store.saveExecutionManifest({ executionId: "exec-1", manifestJson: JSON.stringify({ executionId: "exec-1" }), manifestDigest: "digest-1", keyId: "sign-2", signature: "sig-1", signedAt: T(504) });
  await store.saveExecutionRunContext("exec-2", { model: "gpt-y" }, T(512));
  await store.createAuditExportDestination({ id: "axd-http", name: "SIEM", kind: "http", config: { url: "https://siem.example.com/ingest" }, intervalSeconds: 300, createdBy: "u-admin" });
  await store.createAuditExportDestination({ id: "axd-file", name: "archive", kind: "file", config: { path: "/var/l2m/audit" }, enabled: false });
  await store.recordAuditExportRun({ id: "axr-1", destinationId: "axd-http", startedAt: T(800), completedAt: T(801), status: "success", rowsExported: 6, firstId: "aud-01", lastId: "aud-06" });
  await store.recordAuditExportRun({ id: "axr-2", destinationId: "axd-http", startedAt: T(900), completedAt: T(901), status: "failure", rowsExported: 0, error: "502 from SIEM" });
  await store.upsertLogStreamDestination({ id: "lsd-splunk", name: "Splunk", type: "http", categories: ["auth", "workflow"], minLevel: "warn", configIv: "lsd-iv", configAuthTag: "lsd-tag", configCiphertext: "lsd-ct", createdBy: "u-admin" });
  await store.upsertLogStreamDestination({ id: "lsd-file", name: "File", type: "file", enabled: false });
  await store.recordLogStreamDispatch({ destinationId: "lsd-splunk", success: true, at: T(710) });
  await store.recordLogStreamDispatch({ destinationId: "lsd-splunk", success: false, error: "connection reset", at: T(711) });
  await store.writeLogStreamEvent({ id: "lse-1", destinationId: "lsd-splunk", category: "auth", eventType: "auth.login", level: "info", status: "sent", payload: { id: "aud-01" }, createdAt: T(710) });
  await store.writeLogStreamEvent({ id: "lse-2", destinationId: "lsd-splunk", category: "auth", eventType: "auth.login", level: "warn", status: "failed", attempts: 3, error: "connection reset", createdAt: T(711) });

  // ---- MCP: servers, probes, snapshots, telemetry, OAuth, catalog, elicitations, policies, toolsets, clients, cassettes
  await store.createMcpServer({
    id: "mcp-search", name: "Search", description: "Web search", adapterId: "http-mcp", connection: { url: "https://mcp.example.com/search" },
    secretId: "sec-vault", owner: "u-admin", projectId: "proj-ops", probeIntervalMs: 60_000, blockOnBreakingChange: true,
    sampling: { allow: true, maxTokens: 256 }, credentialMode: "service", createdBy: "u-admin"
  });
  await store.createMcpServer({ id: "mcp-files", name: "files", adapterId: "mock-mcp", connection: {}, probeEnabled: false });
  const snapshot = {
    id: "snap-1", serverId: "mcp-search", hash: "tools-h1", tools: [{ name: "search", inputSchema: { type: "object" } }], toolCount: 1,
    previousSnapshotId: null, changes: [], breaking: false, createdAt: T(200)
  };
  await store.recordMcpServerProbe({ probe: { id: "probe-1", serverId: "mcp-search", startedAt: T(200), ok: true, latencyMs: 30, toolCount: 1, error: null, snapshotId: "snap-1" }, status: "healthy", snapshot, keepProbes: 10 });
  await store.recordMcpServerProbe({
    probe: { id: "probe-2", serverId: "mcp-search", startedAt: T(260), ok: true, latencyMs: 25, toolCount: 2, error: null, snapshotId: "snap-2" },
    status: "healthy",
    snapshot: { ...snapshot, id: "snap-2", hash: "tools-h2", tools: [{ name: "search_v2", inputSchema: { type: "object" } }, { name: "fetch", inputSchema: {} }], toolCount: 2, previousSnapshotId: "snap-1", changes: [{ tool: "search", kind: "removed", breaking: true, detail: "renamed" }], breaking: true, createdAt: T(260) },
    keepProbes: 10
  });
  await store.recordMcpServerProbe({ probe: { id: "probe-3", serverId: "mcp-search", startedAt: T(320), ok: false, latencyMs: 0, toolCount: 0, error: "timeout", snapshotId: null }, status: "down", keepProbes: 10 });
  await store.replaceMcpToolCallsForExecution("exec-1", [
    toolCall("call-1"),
    toolCall("call-2", { startedAt: T(501), toolName: "fetch", ok: false, error: "404", durationMs: 40 }),
    toolCall("call-3", { startedAt: T(501), registryServerId: null, adapterId: "http-mcp", samplingRequests: 1, samplingInputTokens: 20, samplingOutputTokens: 8 })
  ]);
  await store.insertMcpToolCall(toolCall("call-gw-1", { executionId: "gw-1", workflowId: "wf-support", source: "gateway", clientId: "mcp-client-1", startedAt: T(900) }));
  await store.insertMcpToolCall(toolCall("call-gw-2", { executionId: "gw-2", workflowId: "wf-support", source: "gateway", clientId: "mcp-client-1", startedAt: T(901), ok: false, error: "rate limited", rejection: "rate_limited" }));
  await store.upsertMcpOAuthConnection({
    serverId: "mcp-search", secretId: "sec-vault", state: "connected", subject: "svc-account", scope: "search.read", authorizationServer: "https://auth.example.com",
    clientRegistration: "dynamic", clientId: "oauth-client-1", expiresAt: T(4000), hasRefreshToken: true, lastRefreshAt: T(210), connectedAt: T(205), connectedBy: "u-admin", lastError: null
  });
  await store.upsertMcpUserOAuthConnection({
    serverId: "mcp-search", userId: "u-builder", secretId: "sec-openai", state: "connected", subject: "builder", scope: "search.read", authorizationServer: "https://auth.example.com",
    clientRegistration: "dynamic", clientId: "oauth-client-1", expiresAt: T(5000), hasRefreshToken: false, lastRefreshAt: null, connectedAt: T(220), lastError: null
  });
  await store.upsertMcpServerCatalog("mcp-search", {
    capabilities: { resources: {}, prompts: {} } as never,
    resources: [{ uri: "search://recent", name: "Recent searches" }] as never,
    resourceTemplates: [],
    prompts: [{ name: "summarise" }] as never
  });
  await store.createMcpElicitation({
    id: "elic-1", executionId: "exec-1", workflowId: "wf-support", workflowName: "Support triage", nodeId: "agent", serverId: "mcp-search", registryServerId: "mcp-search", serverName: "Search",
    toolName: "ask_user", message: "Which order?", requestedSchema: { type: "object", properties: { orderId: { type: "string" } } }, expiresAt: T(1000), createdBy: "u-builder", triggerType: "manual"
  });
  await store.createMcpElicitation({
    id: "elic-2", executionId: "exec-1", workflowId: "wf-support", nodeId: "agent", serverId: "mcp-search", toolName: "ask_user", message: "Confirm?",
    requestedSchema: { type: "object", properties: { ok: { type: "boolean" } } }, expiresAt: T(1100), createdBy: null, triggerType: null
  });
  await store.settleMcpElicitation("elic-1", { status: "accepted", answeredBy: "u-builder" });
  for (const [id, effect] of [["pol-deny-viewers", "deny"], ["pol-allow-admins", "allow"]] as const) {
    await store.createMcpToolPolicy({ id, name: `Rule ${id}`, description: null, effect, projectId: effect === "deny" ? "proj-ops" : null, roles: effect === "deny" ? ["viewer"] : ["admin"], serverId: "mcp-search", toolPattern: "*", enabled: true, createdBy: "u-admin" });
  }
  await store.setMcpToolClassification({ registryServerId: "mcp-search", toolName: "search_v2", readOnly: true, setBy: "u-admin" });
  await store.setMcpToolClassification({ registryServerId: "mcp-search", toolName: "fetch", readOnly: false, setBy: null });
  await store.createMcpToolset({
    id: "ts-support", slug: "support", name: "Support tools", description: "Search and the triage workflow", projectId: "proj-ops", enabled: true, createdBy: "u-admin",
    members: [{ kind: "server", serverId: "mcp-search", toolGlob: "search*" }, { kind: "workflow", workflowId: "wf-support" }]
  });
  await store.createMcpToolset({ id: "ts-empty", slug: "empty", name: "empty", description: null, projectId: null, enabled: false, createdBy: null, members: [] });
  await store.createMcpClient({ id: "mcp-client-1", name: "Desktop agent", tokenPrefix: "l2mc_abc", tokenHash: "thash-1", toolsetIds: ["ts-support"], role: "builder", createdBy: "u-admin", createdByEmail: "admin@example.com", expiresAt: FAR_FUTURE });
  await store.createMcpClient({ id: "mcp-client-2", name: "Old CLI", tokenPrefix: "l2mc_old", tokenHash: "thash-2", toolsetIds: [], role: "viewer", createdBy: null, createdByEmail: null, expiresAt: null });
  await store.touchMcpClient("mcp-client-1", T(901));
  await store.revokeMcpClient("mcp-client-2");
  await store.saveMcpCassette({ id: "cas-1", executionId: "exec-1", workflowId: "wf-support", workflowName: "Support triage", projectId: "proj-ops", source: "manual", cassette: cassette(2), createdBy: "u-builder" });
  await store.saveMcpCassette({ id: "cas-2", executionId: "exec-replay", workflowId: "wf-support", workflowName: "Support triage", projectId: "proj-ops", source: "eval", evalRunId: "eval-run-1", fixtureId: "fx-1", cassette: cassette(3), createdBy: null });

  // ---- Guard profiles, versions, bindings, events, vault, simulations
  await store.insertGuardProfile({ id: "gp-strict", name: "Strict", description: "Masks PII", document: { id: "gp-strict", detectors: ["email"], labels: "off" }, hash: "gp-strict-h1", note: "first", createdBy: "admin@example.com" });
  await store.addGuardProfileVersion({ profileId: "gp-strict", name: "Strict", description: "Masks PII and blocks keys", document: { id: "gp-strict", detectors: ["email", "key"], destinations: { rules: [{ id: "no-vendors" }] } }, hash: "gp-strict-h2", note: "add key detector", createdBy: "admin@example.com" });
  await store.insertGuardProfile({ id: "gp-builtin", name: "Default", builtIn: true, document: { id: "gp-builtin" }, hash: "gp-builtin-h1", createdBy: null });
  await store.setGuardBinding({ scope: "project", scopeId: "proj-ops", mode: "enforced", profileId: "gp-strict", updatedBy: "admin@example.com" });
  await store.setGuardBinding({ scope: "workflow", scopeId: "wf-lab", mode: "override", profileId: "gp-strict", updatedBy: null });
  await store.insertGuardEvents([
    guardEvent("ge-1", { createdAt: T(600) }),
    guardEvent("ge-2", { createdAt: T(601), detectorId: null, category: null, dataClass: null, score: null, iteration: null, toolName: null, channel: "output", verdictAction: "allow", effectiveAction: "allow", requestedAction: "allow" }),
    guardEvent("ge-3", { createdAt: T(602), executionId: "exec-1", detectorId: "<destinations>", shadow: true, effectiveAction: "block", verdictAction: "block", requestedAction: "block", category: "secret", dataClass: null, budgetExceeded: true })
  ]);
  await store.putGuardVault({ token: "tok_email_1", dataClass: "email", valueHash: "vh-1", valueSealed: "sealed-1", createdAt: T(600) });
  await store.putGuardVault({ token: "tok_phone_1", dataClass: "phone", valueHash: null, valueSealed: "sealed-2", createdAt: T(601) });
  await store.insertGuardSimulation({
    id: "gsim-1", profileId: "gp-strict", sourceKind: "version", sourceVersion: 2, simulatedHash: "gp-strict-h2", baseVersion: 1, jobIds: ["replay-run-1"],
    detail: { workflows: ["wf-support"] }, status: "completed", createdAt: T(1200), createdBy: "admin@example.com", createdByUserId: "u-admin", finishedAt: T(1260)
  });

  // ---- Data destinations
  await store.insertDataDestination({ id: "dd-openai", name: "OpenAI", kind: "model_provider", targetId: null, host: "api.openai.com", tier: "vendor", region: "us", holdsDataClasses: ["email"], note: null, actor: "admin@example.com", at: T(50) });
  await store.insertDataDestination({ id: "dd-search", name: "Search MCP", kind: "mcp_server", targetId: "mcp-search", host: null, tier: "private", region: "eu", holdsDataClasses: [], note: "internal", actor: null, at: T(51) });

  // ---- Evals and replay: datasets, fixtures, runs, results, golden runs, capture
  await store.createEvalDataset({ id: "ds-faq", name: "FAQ answers", description: "Known questions", projectId: "proj-ops", workflowId: "wf-support", createdBy: "u-builder" });
  await store.createEvalDataset({ id: "ds-lab", name: "Lab", projectId: "proj-lab" });
  await store.createEvalFixture({ id: "fx-1", datasetId: "ds-faq", name: "Refund window", input: { question: "How long for a refund?" }, expected: { contains: "14 days" }, scorers: [{ type: "contains", value: "14 days" }] });
  await store.createEvalFixture({ id: "fx-2", datasetId: "ds-faq", name: "Shipping", input: { question: "How long is shipping?" } });
  await store.setEvalFixtureRequired("fx-1", true);
  await store.createEvalRun({ id: "eval-run-1", datasetId: "ds-faq", workflowId: "wf-support", workflowName: "Support triage", triggeredBy: "builder@example.com", triggeredByUserId: "u-builder", scorers: [{ type: "contains" }] });
  await store.recordEvalResult({ id: "res-1", runId: "eval-run-1", fixtureId: "fx-1", fixtureName: "Refund window", status: "pass", executionId: "exec-replay", score: { contains: 1 }, output: { text: "14 days" }, durationMs: 900, tokenInput: 30, tokenOutput: 12, tokenTotal: 42, costUsd: 0.002 });
  await store.recordEvalResult({ id: "res-2", runId: "eval-run-1", fixtureId: "fx-2", fixtureName: "Shipping", status: "fail", error: "missing days", durationMs: 700 });
  await store.finalizeEvalRun({ id: "eval-run-1", status: "completed", summary: { pass: 1, fail: 1 }, progress: { done: 2, total: 2 } });

  await store.importGoldenSet({
    dataset: { id: "gs-support", name: "Support golden set", projectId: "proj-ops", workflowId: "wf-support", createdBy: "u-builder" },
    cases: [
      { recording: recording("gr-1", { createdAt: T(400), bytes: 120 }), fixture: { id: "gfx-1", name: "Golden 1", input: { question: "refund gr-1" }, expected: { ok: true } } },
      { recording: recording("gr-2", { createdAt: T(401), bytes: 130, mcpCassetteJson: JSON.stringify(cassette(1)), modelTapeJson: JSON.stringify({ version: 1, calls: [] }) }), fixture: { id: "gfx-2", name: "Golden 2", input: { question: "refund gr-2" } } }
    ],
    limits: ROOMY
  });
  await store.saveReplayRecording(recording("cand-1", { status: "candidate", capturedAt: T(450), createdAt: T(450), sourceExecutionId: "exec-1", sourceStatus: "success", bytes: 90 }));
  await store.saveReplayRecording(recording("cand-2", { status: "candidate", capturedAt: T(460), createdAt: T(460), sourceExecutionId: "exec-cap-2", sourceTriggerType: "webhook", sourceStatus: "error", bytes: 95 }));
  await store.saveReplayRecording(recording("cand-3", { status: "candidate", capturedAt: T(470), createdAt: T(470), sourceExecutionId: "exec-cap-3", bytes: 80 }));
  await store.promoteReplayCaptureToGoldenSet({
    recordingId: "cand-3",
    promotion: { name: "Promoted capture", capturedWorkflowJson: JSON.stringify({ id: "wf-support" }), inputJson: JSON.stringify({ question: "masked" }), nodeOutputsJson: "{}", factsJson: JSON.stringify({ status: "success" }), mcpCassetteJson: null, modelTapeJson: null, memorySeedJson: null, bytes: 70, workflowHash: "hash-support-2", createdBy: "u-admin" },
    target: { datasetId: "gs-support" },
    fixture: { id: "gfx-3", name: "Promoted case" },
    limits: ROOMY
  });
  await store.saveReplayCaptureSettings({ workflowId: "wf-support", enabled: true, rate: 0.25, maxPerDay: 50, onlyStatuses: ["error", "success"], dlp: true, dlpOffReason: null, targetDatasetId: "gs-support", updatedBy: "u-admin", updatedAt: T(440) });
  await store.recordReplayCaptureDrop("wf-support", "daily_limit", T(480));
  await store.createEvalRun({
    id: "replay-run-1", datasetId: "gs-support", workflowId: "wf-support", workflowName: "Support triage", kind: "replay", status: "queued", datasetIds: ["gs-support"],
    candidate: { releaseEligible: true }, workflowHash: "hash-support-2", workflowVersion: 2, options: { concurrency: 2 }, progress: { done: 0, total: 3 }
  });
  await store.setEvalRunSetSnapshot("replay-run-1", { "gs-support": { hash: "set-h1", cases: { "gfx-1": "c1", "gfx-2": "c2", "gfx-3": "c3" } } });
  await store.updateEvalRunProgress({ id: "replay-run-1", status: "running", progress: { done: 3, total: 3 } });
  await store.recordEvalResult({ id: "rres-1", runId: "replay-run-1", fixtureId: "gfx-1", fixtureName: "Golden 1", status: "pass", recordingId: "gr-1", verdict: "same", diff: { changed: [] }, costUsd: 0.001 });
  await store.recordEvalResult({ id: "rres-2", runId: "replay-run-1", fixtureId: "gfx-2", fixtureName: "Golden 2", status: "fail", recordingId: "gr-2", verdict: "changed", diff: { changed: ["agent"] } });
  await store.finalizeEvalRun({ id: "replay-run-1", status: "completed", summary: { pass: 1, fail: 1 } });

  // ---- Release gates, release approval requests, gate case requests
  await store.upsertReleaseGate({
    workflowId: "wf-support", enabled: true, enforced: true, datasetIds: ["gs-support"], candidateOptions: { maxCases: 10 }, policy: { minPassRate: 0.9 },
    requireApproval: true, approvers: { users: ["u-admin"] }, updatedAt: T(1000), updatedBy: "admin@example.com"
  });
  await store.upsertReleaseGate({
    workflowId: "wf-report", enabled: false, enforced: false, datasetIds: [], candidateOptions: {}, policy: {}, requireApproval: false, approvers: null, updatedAt: T(1001), updatedBy: null
  });
  await store.setReleaseGateAdmission("wf-support", ["gfx-2", "gfx-1"], T(1002), "admin@example.com");
  const releaseRequestBase = {
    workflowId: "wf-support", workflowName: "Support triage", projectId: "proj-ops", version: 3, workflowHash: "hash-support-3", replayRunId: "replay-run-1",
    origin: "policy" as const, gateReasons: ["needs approval"], gateUpdatedAt: T(1000), gateChecks: [{ code: "pass_rate", measure: 0.5 }], gateAuthority: "auth-1",
    publishedVersionAtRequest: 2, spec: { approvers: ["u-admin"] }, requestReason: "ship v3", requestedByUserId: "u-builder", requestedBy: "builder@example.com",
    decidedByUserId: null, decidedBy: null, decidedAt: null, decisionReason: null, releaseId: null
  };
  await store.insertReleaseApprovalRequest({ ...releaseRequestBase, id: "rar-1", status: "pending", expiresAt: null, createdAt: T(1100), updatedAt: T(1100) });
  await store.insertReleaseApprovalRequest({ ...releaseRequestBase, id: "rar-2", status: "pending", expiresAt: T(1200), createdAt: T(1110), updatedAt: T(1110), origin: "blocked", gateChecks: null, gateAuthority: null });
  await store.decideReleaseApprovalRequest({ id: "rar-2", status: "rejected", decidedByUserId: "u-admin", decidedBy: "admin@example.com", decisionReason: "fails on refunds" });
  const caseRequestBase = {
    workflowId: "wf-support", workflowName: "Support triage", projectId: "proj-ops", spec: { approvers: ["u-admin"] }, gateAuthority: "auth-1",
    requestReason: null, requestedByUserId: "u-builder", requestedBy: "builder@example.com", decidedByUserId: null, decidedBy: null, decidedAt: null, decisionReason: null
  };
  await store.insertGateCaseRequest({ ...caseRequestBase, id: "gcr-1", action: "admit", fixtures: [{ fixtureId: "gfx-3", name: "Promoted case", datasetId: "gs-support" }], status: "pending", expiresAt: null, createdAt: T(1120), updatedAt: T(1120) });
  await store.insertGateCaseRequest({ ...caseRequestBase, id: "gcr-2", action: "remove", fixtures: [{ fixtureId: "gfx-2", name: "Golden 2", datasetId: null }], status: "pending", expiresAt: T(5000), createdAt: T(1130), updatedAt: T(1130), gateAuthority: null });
  await store.decideGateCaseRequest({ id: "gcr-2", status: "approved", decidedByUserId: "u-admin", decidedBy: "admin@example.com", decisionReason: "flaky case" });

  // ---- Usage events, budgets and alerts
  const usage = (id: string, overrides: Partial<Parameters<Store["writeUsageEvent"]>[0]> = {}): Parameters<Store["writeUsageEvent"]>[0] => ({
    id, executionId: `exec-${id}`, workflowId: "wf-support", workflowName: "Support triage", userId: "u-builder", userEmail: "builder@example.com", projectId: "proj-ops",
    triggerType: "manual", status: "success", inputTokens: 100, outputTokens: 50, cachedInputTokens: 10, totalTokens: 150, costUsd: 0.1, llmCallCount: 2, durationMs: 1000,
    providers: [{ providerId: "openai", model: "gpt-x", calls: 2 }], createdAt: T(500), ...overrides
  });
  await store.writeUsageEvent(usage("use-1"));
  await store.writeUsageEvent(usage("use-2", { createdAt: T(3600), costUsd: 0.25, totalTokens: 300, durationMs: 2001 }));
  await store.writeUsageEvent(usage("use-3", {
    createdAt: T(90_000), workflowId: "wf-report", workflowName: null, userId: null, userEmail: "anon@example.com", projectId: null, costUsd: 1.5, totalTokens: 10,
    providers: [{ providerId: "openai", model: "gpt-x", calls: 1 }, { providerId: "anthropic", model: "c-1", calls: 3 }]
  }));
  await store.createBudget({ id: "bud-global", name: "Global monthly", scopeType: "global", period: "month", limitType: "usd", limitValue: 100, action: "warn", notifyChannel: "https://hooks.example.com/b", createdBy: "u-admin" });
  await store.createBudget({ id: "bud-wf", name: "Support tokens", scopeType: "workflow", scopeId: "wf-support", period: "day", limitType: "tokens", limitValue: 100_000_001, warnThresholdPct: 0.5, action: "block", enabled: false });
  await store.recordBudgetAlert({ id: "alert-1", budgetId: "bud-global", periodStart: "2026-10-01T00:00:00.000Z", severity: "warn", usageValue: 85.5, limitValue: 100, workflowId: "wf-support", executionId: "exec-1", message: "85% used" });
  await store.recordBudgetAlert({ id: "alert-2", budgetId: "bud-wf", periodStart: "2026-10-20T00:00:00.000Z", severity: "block", usageValue: 1234.56789012, limitValue: 100_000_001 });
}

type NamedRead = { name: string; read: (store: Store) => Promise<unknown> };

/** Sorted entries of a Map (the badge reads return Maps). */
function mapEntries<V>(map: Map<string, V>): Array<[string, V]> {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

const SQLITE_DATETIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

/** An execution history row with `createdAt` as canonical ISO (SQLite stores it as `datetime('now')` text). */
function canonicalCreatedAt<T extends { createdAt: string } | null>(row: T): T {
  if (!row) return row;
  const match = SQLITE_DATETIME.exec(row.createdAt);
  return match ? { ...row, createdAt: new Date(`${match[1]}T${match[2]}Z`).toISOString() } : row;
}

/** Guard stats with each group sorted by count (desc) then key: rows of equal count come in the store's tie order. */
function sortedGuardStats(stats: Awaited<ReturnType<Store["guardEventStats"]>>): unknown {
  const byCountThenKey = (a: { key: string; count: number }, b: { key: string; count: number }) =>
    b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return {
    ...stats,
    verdicts: [...stats.verdicts].sort(byCountThenKey),
    actions: [...stats.actions].sort(byCountThenKey),
    categories: [...stats.categories].sort(byCountThenKey),
    channels: [...stats.channels].sort(byCountThenKey),
    detectors: [...stats.detectors].sort(byCountThenKey),
    daily: [...stats.daily].sort((a, b) => (a.day + a.action < b.day + b.action ? -1 : a.day + a.action > b.day + b.action ? 1 : 0))
  };
}

/** Named reads that together read back everything `seedAllDomains` wrote; each must answer the same on both stores. */
export function roundTripReads(): NamedRead[] {
  const reads: NamedRead[] = [
    // Projects, folders, users and RBAC
    { name: "listProjects", read: (s) => s.listProjects() },
    { name: "getProject", read: (s) => s.getProject("proj-ops") },
    { name: "listFolders", read: (s) => s.listFolders("proj-ops") },
    { name: "getFolder", read: (s) => s.getFolder("fold-b") },
    { name: "countUsers", read: (s) => s.countUsers() },
    { name: "listUsers", read: (s) => s.listUsers() },
    { name: "getUserByEmail", read: (s) => s.getUserByEmail("admin@example.com") },
    { name: "getUserById", read: (s) => s.getUserById("u-builder") },
    { name: "getSession", read: async (s) => [await s.getSession("sess-1"), await s.getSession("sess-2")] },
    { name: "listApiKeys", read: (s) => s.listApiKeys() },
    { name: "findApiKeyByPrefix", read: (s) => s.findApiKeyByPrefix("l2m_ci01") },
    { name: "getMfaSecret", read: (s) => s.getMfaSecret("u-admin") },
    { name: "findSsoIdentity", read: (s) => s.findSsoIdentity("oidc", "sub-builder") },
    { name: "listCustomRoles", read: (s) => s.listCustomRoles() },
    { name: "getCustomRole", read: (s) => s.getCustomRole("cr-runner") },
    { name: "countProjectMemberships", read: (s) => s.countProjectMemberships() },
    { name: "listProjectMembers", read: (s) => s.listProjectMembers("proj-ops") },
    { name: "listUserProjectRoles", read: (s) => s.listUserProjectRoles("u-viewer") },
    { name: "getProjectRole", read: (s) => s.getProjectRole("u-viewer", "proj-ops") },
    { name: "listSsoGroupMappings", read: (s) => s.listSsoGroupMappings() },

    // Workflows, versions, shares, templates and publishing
    { name: "countWorkflows", read: (s) => s.countWorkflows() },
    { name: "listWorkflows", read: (s) => s.listWorkflows() },
    { name: "listWorkflows:project", read: (s) => s.listWorkflows({ projectId: "proj-ops", tag: "rag" }) },
    { name: "getWorkflow", read: async (s) => [await s.getWorkflow("wf-support"), await s.getWorkflow("wf-report"), await s.getWorkflow("wf-lab")] },
    { name: "getWorkflowCreatedBy", read: async (s) => [await s.getWorkflowCreatedBy("wf-support"), await s.getWorkflowCreatedBy("wf-lab")] },
    { name: "listWorkflowVersions", read: async (s) => [await s.listWorkflowVersions("wf-support"), await s.listWorkflowVersions("wf-report")] },
    { name: "getWorkflowVersion", read: (s) => s.getWorkflowVersion("wf-support", 2) },
    { name: "maxWorkflowVersionNumber", read: (s) => s.maxWorkflowVersionNumber("wf-support") },
    { name: "listWorkflowShares", read: (s) => s.listWorkflowShares("wf-support") },
    { name: "listWorkflowsSharedToProject", read: (s) => s.listWorkflowsSharedToProject("proj-lab") },
    { name: "countTemplates", read: (s) => s.countTemplates() },
    { name: "listTemplates", read: (s) => s.listTemplates() },
    { name: "getTemplate", read: (s) => s.getTemplate("tpl-rag") },
    { name: "getPublishedVersion", read: (s) => s.getPublishedVersion("wf-support") },
    { name: "isWorkflowVersionPinned", read: async (s) => [await s.isWorkflowVersionPinned("wf-support", 1), await s.isWorkflowVersionPinned("wf-support", 3)] },
    { name: "listWorkflowReleases", read: async (s) => [await s.listWorkflowReleases("wf-support"), await s.listWorkflowReleases("wf-report")] },
    { name: "getPublishState", read: async (s) => [await s.getPublishState("wf-support"), await s.getPublishState("wf-report"), await s.getPublishState("wf-lab")] },
    { name: "hasReleasedVersion", read: (s) => s.hasReleasedVersion("wf-support", 1) },
    { name: "listReleasedVersionHashes", read: (s) => s.listReleasedVersionHashes("wf-support", 2) },
    { name: "listWorkflowConfigsForDestinations", read: (s) => s.listWorkflowConfigsForDestinations() },

    // Secrets
    { name: "listSecrets", read: (s) => s.listSecrets() },
    { name: "getSecret", read: async (s) => [await s.getSecret("sec-openai"), await s.getSecret("sec-ext")] },
    { name: "listSecretShares", read: (s) => s.listSecretShares("sec-openai") },
    { name: "listSecretsSharedToProject", read: (s) => s.listSecretsSharedToProject("proj-lab") },
    { name: "listExternalSecretProviders", read: (s) => s.listExternalSecretProviders() },
    { name: "getExternalSecretProvider", read: (s) => s.getExternalSecretProvider("esp-vault") },
    { name: "countSecretsUsingExternalProvider", read: (s) => s.countSecretsUsingExternalProvider("esp-vault") },
    { name: "getExternalSecretCacheEntry", read: (s) => s.getExternalSecretCacheEntry("sec-ext") },

    // Variables, notifications, git
    { name: "listVariables", read: (s) => s.listVariables() },
    { name: "getVariable", read: (s) => s.getVariable("var-1") },
    { name: "findVariableByKey", read: (s) => s.findVariableByKey("proj-ops", "region") },
    { name: "listNotificationConfigs", read: (s) => s.listNotificationConfigs() },
    { name: "getGitConfig", read: (s) => s.getGitConfig() },

    // Knowledge bases (search: hit ids in rank order only, never scores)
    { name: "listKnowledgeBases", read: (s) => s.listKnowledgeBases() },
    { name: "getKnowledgeBase", read: (s) => s.getKnowledgeBase("kb-policies") },
    { name: "listKnowledgeBaseChunks", read: (s) => s.listKnowledgeBaseChunks("kb-policies") },
    { name: "listKnowledgeBaseChunkPreviews", read: (s) => s.listKnowledgeBaseChunkPreviews({ knowledgeBaseId: "kb-policies" }) },
    { name: "listKnowledgeBaseSources", read: (s) => s.listKnowledgeBaseSources("kb-policies") },
    {
      name: "bm25SearchKnowledgeBase:ids",
      read: async (s) => (await s.bm25SearchKnowledgeBase({ knowledgeBaseId: "kb-policies", query: "refund", topK: 10 })).map((hit) => hit.id)
    },

    // Session memory, tool cache, artifacts (with labels)
    { name: "loadSessionMemory", read: async (s) => [await s.loadSessionMemory("wf-support:agent", "chat-1"), await s.loadSessionMemory("wf-support:agent", "chat-2")] },
    { name: "loadSessionMemoryLabels", read: async (s) => [await s.loadSessionMemoryLabels("wf-support:agent", "chat-1"), await s.loadSessionMemoryLabels("wf-support:agent", "chat-2")] },
    { name: "listSessionToolCalls", read: (s) => s.listSessionToolCalls({ namespace: "wf-support:agent", sessionId: "chat-1" }) },
    {
      name: "getSessionToolCall",
      read: async (s) => {
        const [call] = await s.listSessionToolCalls({ namespace: "wf-support:agent", sessionId: "chat-1", toolName: "search" });
        return call ? s.getSessionToolCall({ namespace: "wf-support:agent", sessionId: "chat-1", id: call.id }) : null;
      }
    },
    { name: "loadSessionArtifact", read: (s) => s.loadSessionArtifact({ namespace: "wf-support:agent", sessionId: "chat-1", artifactKey: "summary" }) },

    // Webhook security state, trigger state
    { name: "hasWebhookReplayKey", read: async (s) => [await s.hasWebhookReplayKey("replay-fp-1"), await s.hasWebhookReplayKey("unknown")] },
    { name: "getWebhookIdempotency", read: async (s) => [await s.getWebhookIdempotency({ endpointKey: "support-hook", idempotencyKey: "idem-1" }), await s.getWebhookIdempotency({ endpointKey: "support-hook", idempotencyKey: "idem-2" })] },
    { name: "getTriggerState", read: (s) => s.getTriggerState("wf-report", "trigger") },

    // Execution history, paused runs, approvals, queue, leases
    {
      name: "listExecutionHistory",
      read: async (s) => {
        const page = await s.listExecutionHistory({ pageSize: 50 });
        return { ...page, items: page.items.map(canonicalCreatedAt) };
      }
    },
    {
      name: "listExecutionHistory:filtered",
      read: async (s) => {
        const page = await s.listExecutionHistory({ workflowId: "wf-support", status: "success", startedFrom: T(0), startedTo: T(600) });
        return { ...page, items: page.items.map(canonicalCreatedAt) };
      }
    },
    { name: "getExecutionHistory", read: async (s) => [canonicalCreatedAt(await s.getExecutionHistory("exec-1")), canonicalCreatedAt(await s.getExecutionHistory("exec-2"))] },
    { name: "getWorkflowExecutionState", read: (s) => s.getWorkflowExecutionState("exec-paused") },
    { name: "listPendingApprovals", read: (s) => s.listPendingApprovals() },
    { name: "getExecutionRelease", read: async (s) => [await s.getExecutionRelease("exec-1"), await s.getExecutionRelease("exec-2")] },
    { name: "getApprovalRequest", read: async (s) => [await s.getApprovalRequest("apr-1"), await s.getApprovalRequest("apr-2")] },
    { name: "getPendingApprovalRequestForExecution", read: (s) => s.getPendingApprovalRequestForExecution("exec-paused") },
    { name: "listApprovalRequestsForExecution", read: (s) => s.listApprovalRequestsForExecution("exec-paused") },
    { name: "listApprovalRequests", read: (s) => s.listApprovalRequests({ status: "all" }) },
    { name: "listExpiredApprovalRequests", read: (s) => s.listExpiredApprovalRequests(NOW) },
    { name: "getQueueDepth", read: (s) => s.getQueueDepth() },
    { name: "hasActiveQueueItem", read: async (s) => [await s.hasActiveQueueItem("q-1"), await s.hasActiveQueueItem("sched_wf-report"), await s.hasActiveQueueItem("q-bad")] },
    { name: "listDlqItems", read: (s) => s.listDlqItems() },
    { name: "listLeases", read: (s) => s.listLeases() },
    { name: "getLease", read: (s) => s.getLease("scheduler") },

    // Audit, signing keys, manifests, export, log streams
    { name: "listAuditLogs", read: (s) => s.listAuditLogs({ pageSize: 500 }) },
    { name: "listAuditLogs:filtered", read: (s) => s.listAuditLogs({ category: "auth", from: T(700), to: T(720) }) },
    { name: "listAuditLogsAfter", read: (s) => s.listAuditLogsAfter({ afterId: null, limit: 100 }) },
    { name: "listAuditLogsForExecution", read: (s) => s.listAuditLogsForExecution("exec-1") },
    { name: "listAuditSigningKeys", read: (s) => s.listAuditSigningKeys() },
    { name: "getActiveAuditSigningKey", read: (s) => s.getActiveAuditSigningKey() },
    { name: "getAuditSigningKey", read: (s) => s.getAuditSigningKey("sign-1") },
    { name: "getExecutionManifest", read: async (s) => [await s.getExecutionManifest("exec-1"), await s.getExecutionManifest("exec-2")] },
    { name: "listAuditExportDestinations", read: (s) => s.listAuditExportDestinations() },
    { name: "getAuditExportDestination", read: (s) => s.getAuditExportDestination("axd-http") },
    { name: "listAuditExportRuns", read: (s) => s.listAuditExportRuns("axd-http") },
    { name: "listLogStreamDestinations", read: (s) => s.listLogStreamDestinations() },
    { name: "getLogStreamDestination", read: (s) => s.getLogStreamDestination("lsd-splunk") },
    { name: "listLogStreamEvents", read: (s) => s.listLogStreamEvents() },

    // MCP
    { name: "listMcpServers", read: (s) => s.listMcpServers() },
    { name: "getMcpServer", read: (s) => s.getMcpServer("mcp-search") },
    { name: "listMcpServerProbes", read: (s) => s.listMcpServerProbes("mcp-search") },
    { name: "listMcpToolSnapshots", read: (s) => s.listMcpToolSnapshots("mcp-search") },
    { name: "getMcpToolSnapshot", read: (s) => s.getMcpToolSnapshot("snap-2") },
    { name: "listMcpToolCallsForExecution", read: (s) => s.listMcpToolCallsForExecution("exec-1") },
    { name: "listMcpToolCalls", read: async (s) => [await s.listMcpToolCalls({ registryServerId: "mcp-search", since: T(0) }), await s.listMcpToolCalls({ registryServerId: null, since: T(0) })] },
    { name: "listMcpToolCallsForClient", read: (s) => s.listMcpToolCallsForClient("mcp-client-1", T(0)) },
    { name: "summarizeMcpClientUsage", read: (s) => s.summarizeMcpClientUsage(T(0)) },
    { name: "getMcpOAuthConnection", read: (s) => s.getMcpOAuthConnection("mcp-search") },
    { name: "listMcpUserOAuthConnections", read: (s) => s.listMcpUserOAuthConnections() },
    { name: "getMcpServerCatalog", read: (s) => s.getMcpServerCatalog("mcp-search") },
    { name: "listMcpElicitations", read: (s) => s.listMcpElicitations({ executionId: "exec-1" }) },
    { name: "getMcpElicitation", read: (s) => s.getMcpElicitation("elic-1") },
    { name: "listExpiredMcpElicitations", read: (s) => s.listExpiredMcpElicitations(NOW) },
    { name: "listMcpToolPolicies", read: (s) => s.listMcpToolPolicies() },
    { name: "listMcpToolClassifications", read: (s) => s.listMcpToolClassifications() },
    { name: "listMcpToolsets", read: (s) => s.listMcpToolsets() },
    { name: "getMcpToolsetBySlug", read: (s) => s.getMcpToolsetBySlug("support") },
    { name: "listMcpClients", read: (s) => s.listMcpClients() },
    { name: "findMcpClientByTokenPrefix", read: (s) => s.findMcpClientByTokenPrefix("l2mc_abc") },
    { name: "listMcpCassettes", read: (s) => s.listMcpCassettes() },
    { name: "getMcpCassette", read: (s) => s.getMcpCassette("cas-2") },
    { name: "getMcpCassetteForExecution", read: (s) => s.getMcpCassetteForExecution("exec-1") },
    { name: "listMcpCassettesForEvalRun", read: (s) => s.listMcpCassettesForEvalRun("eval-run-1") },
    { name: "mcpCassetteBadgesForExecutions", read: async (s) => mapEntries(await s.mcpCassetteBadgesForExecutions(["exec-1", "exec-replay", "exec-2"])) },

    // Guard
    { name: "listGuardProfiles", read: (s) => s.listGuardProfiles() },
    { name: "getGuardProfile", read: (s) => s.getGuardProfile("gp-strict") },
    { name: "listGuardProfileVersions", read: (s) => s.listGuardProfileVersions("gp-strict") },
    { name: "getGuardProfileVersion", read: (s) => s.getGuardProfileVersion("gp-strict", 1) },
    { name: "anyGuardProfileUsesLabels", read: (s) => s.anyGuardProfileUsesLabels() },
    { name: "getGuardBinding", read: (s) => s.getGuardBinding("project", "proj-ops") },
    { name: "listGuardBindingsForProfile", read: (s) => s.listGuardBindingsForProfile("gp-strict") },
    { name: "listGuardEvents", read: (s) => s.listGuardEvents() },
    { name: "listGuardEventsForExecution", read: (s) => s.listGuardEventsForExecution("exec-1") },
    { name: "guardEventStats", read: async (s) => sortedGuardStats(await s.guardEventStats()) },
    { name: "countObservedDestinationBlocks", read: (s) => s.countObservedDestinationBlocks("gp-strict", T(0)) },
    { name: "getGuardVault", read: async (s) => [await s.getGuardVaultByToken("tok_email_1"), await s.getGuardVaultByHash("vh-1"), await s.getGuardVaultByToken("tok_phone_1")] },
    { name: "listGuardSimulations", read: (s) => s.listGuardSimulations({ profileId: "gp-strict" }) },
    { name: "getGuardSimulation", read: (s) => s.getGuardSimulation("gsim-1") },

    // Data destinations
    { name: "listDataDestinations", read: (s) => s.listDataDestinations() },
    { name: "getDataDestination", read: (s) => s.getDataDestination("dd-search") },
    { name: "findDataDestinationByMatch", read: (s) => s.findDataDestinationByMatch("model_provider", null, "api.openai.com") },

    // Evals and replay
    { name: "listEvalDatasets", read: (s) => s.listEvalDatasets() },
    { name: "getEvalDataset", read: async (s) => [await s.getEvalDataset("ds-faq"), await s.getEvalDataset("gs-support")] },
    { name: "listEvalFixtures", read: async (s) => [await s.listEvalFixtures("ds-faq"), await s.listEvalFixtures("gs-support")] },
    { name: "getEvalFixture", read: (s) => s.getEvalFixture("fx-1") },
    { name: "findEvalFixtureByRecording", read: (s) => s.findEvalFixtureByRecording("gs-support", "gr-2") },
    { name: "evalFixtureIdsForRecording", read: (s) => s.evalFixtureIdsForRecording("cand-3") },
    { name: "listEvalRuns", read: (s) => s.listEvalRuns() },
    { name: "getEvalRun", read: async (s) => [await s.getEvalRun("eval-run-1"), await s.getEvalRun("replay-run-1")] },
    { name: "listEvalResults", read: async (s) => [await s.listEvalResults("eval-run-1"), await s.listEvalResults("replay-run-1")] },
    { name: "getEvalResult", read: (s) => s.getEvalResult("replay-run-1", "rres-2") },
    { name: "evalRunIdsForResults", read: async (s) => (await s.evalRunIdsForResults({ fixtureIds: ["fx-1", "gfx-1"] })).sort() },
    { name: "getEvalRunSetSnapshot", read: (s) => s.getEvalRunSetSnapshot("replay-run-1") },
    { name: "listReplayRunIdsForHash", read: (s) => s.listReplayRunIdsForHash("wf-support", "hash-support-2") },
    { name: "listReplayRecordings", read: (s) => s.listReplayRecordings() },
    { name: "getReplayRecording", read: async (s) => [await s.getReplayRecording("gr-2"), await s.getReplayRecording("cand-3")] },
    { name: "getReplayRecordingSummary", read: (s) => s.getReplayRecordingSummary("cand-1") },
    { name: "sumReplayRecordingBytes", read: async (s) => [await s.sumReplayRecordingBytes(), await s.sumReplayRecordingBytesForWorkflow("wf-support")] },
    { name: "countReplayRecordingsForWorkflow", read: async (s) => [await s.countReplayRecordingsForWorkflow("wf-support"), await s.countReplayRecordingsForWorkflow("wf-support", "candidate")] },
    { name: "findReplayRecordingIdForExecution", read: async (s) => [await s.findReplayRecordingIdForExecution("exec-gr-1"), await s.findReplayRecordingIdForExecution("exec-1", "candidate")] },
    { name: "replayGoldenBadgesForExecutions", read: async (s) => mapEntries(await s.replayGoldenBadgesForExecutions(["exec-gr-1", "exec-gr-2", "exec-cap-3"])) },
    { name: "listReplayCaptures", read: (s) => s.listReplayCaptures({ workflowId: "wf-support" }) },
    { name: "countReplayCapturesSince", read: (s) => s.countReplayCapturesSince("wf-support", T(0)) },
    { name: "oldestReplayCaptures", read: async (s) => [await s.oldestReplayCaptures("wf-support", 10), await s.oldestReplayCaptureIds("wf-support", 10)] },
    { name: "sumReplayCaptureBytesForWorkflow", read: (s) => s.sumReplayCaptureBytesForWorkflow("wf-support") },
    { name: "getReplayCaptureSettings", read: (s) => s.getReplayCaptureSettings("wf-support") },

    // Release gates and requests
    { name: "getReleaseGate", read: async (s) => [await s.getReleaseGate("wf-support"), await s.getReleaseGate("wf-report")] },
    { name: "listEnabledReleaseGateWorkflowIds", read: (s) => s.listEnabledReleaseGateWorkflowIds() },
    { name: "getReleaseApprovalRequest", read: async (s) => [await s.getReleaseApprovalRequest("rar-1"), await s.getReleaseApprovalRequest("rar-2")] },
    { name: "listPendingReleaseApprovalRequests", read: (s) => s.listPendingReleaseApprovalRequests("wf-support", 3, "hash-support-3") },
    { name: "listReleaseApprovalRequests", read: (s) => s.listReleaseApprovalRequests({ status: "all", now: NOW }) },
    { name: "getGateCaseRequest", read: async (s) => [await s.getGateCaseRequest("gcr-1"), await s.getGateCaseRequest("gcr-2")] },
    { name: "listPendingGateCaseRequests", read: (s) => s.listPendingGateCaseRequests("wf-support") },
    { name: "listGateCaseRequests", read: (s) => s.listGateCaseRequests({ status: "all", now: NOW }) },

    // Usage and budgets
    { name: "listUsageEvents", read: (s) => s.listUsageEvents() },
    { name: "queryUsageTotals", read: (s) => s.queryUsageTotals({ from: T(0), to: T(200_000) }) },
    { name: "queryUsageRollup:day", read: (s) => s.queryUsageRollup({ from: T(0), to: T(200_000), groupBy: "day" }) },
    { name: "queryUsageRollup:hour", read: (s) => s.queryUsageRollup({ from: T(0), to: T(200_000), groupBy: "hour" }) },
    { name: "queryUsageRollup:workflow", read: (s) => s.queryUsageRollup({ from: T(0), to: T(200_000), groupBy: "workflow" }) },
    { name: "queryUsageRollup:provider", read: (s) => s.queryUsageRollup({ from: T(0), to: T(200_000), groupBy: "provider" }) },
    { name: "listBudgets", read: (s) => s.listBudgets() },
    { name: "getBudget", read: (s) => s.getBudget("bud-wf") },
    { name: "listBudgetAlerts", read: (s) => s.listBudgetAlerts() },
    { name: "getLatestBudgetAlert", read: (s) => s.getLatestBudgetAlert("bud-global", "2026-10-01T00:00:00.000Z", "warn") },

    // Schema markers
    { name: "getSchemaMarker", read: (s) => s.getSchemaMarker("approval_requests") }
  ];

  // Data-subject rows: ids and text only (lastRowid is a rowid on SQLite and a seq on Postgres).
  for (const kind of ["execution", "recording", "fixture", "eval_result", "cassette"] as const) {
    reads.push({
      name: `subjectRows:${kind}`,
      read: async (s) => ({ count: await s.countSubjectRows(kind), rows: (await s.subjectTextPage(kind, 0, 1000)).rows })
    });
  }
  return reads;
}
