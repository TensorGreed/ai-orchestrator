/**
 * The static demo's backend: answers the API client in the browser from
 * recorded fixtures. Workflows are real state (create, edit, save, duplicate,
 * delete, import), kept in memory and mirrored to localStorage when it works.
 * Runs replay a recorded event stream only when the workflow's graph is the
 * one that was recorded; nothing is computed or sent anywhere.
 */
import { workflowSchema, type Workflow, type WorkflowListItem } from "@ai-orchestrator/shared";
import type { DemoFixtures, RecordedFrame, RecordedRun, RecordedWrite } from "./fixtures";

export const NOT_IN_DEMO = "not_in_demo";
export const DEMO_STATE_STORAGE_KEY = "l2m-demo:state:v1";

export const NOT_IN_DEMO_MESSAGE = "Not available in the demo. This needs a real L2M deployment.";
export const CREDENTIALS_MESSAGE = "Not available in the demo. Sign-in, credentials, API keys and user admin need a real L2M deployment.";
export const RUN_NEEDS_DEPLOYMENT_MESSAGE = "Runs need a real deployment.";
export const APPROVAL_RESUME_MESSAGE = "On a real deployment the paused run would now resume.";

/** Something the demo banner should tell the visitor, with an optional way out. */
export type DemoNotice =
  | {
      kind: "run_not_recorded";
      message: string;
      workflowId: string;
      /** Restore this workflow to the recorded version so its recorded run replays. */
      restorable: boolean;
      similar?: { workflowId: string; name: string; executionId: string };
    }
  | {
      /** The graph was recorded, but with another input: only the recorded question has an answer. */
      kind: "input_not_recorded";
      message: string;
      workflowId: string;
      recordedInput: string;
    }
  | {
      kind: "approval_decided";
      message: string;
      executionId: string;
    }
  | {
      kind: "not_in_demo";
      message: string;
    };

export interface DemoStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface FakeBackendOptions {
  fixtures: DemoFixtures;
  /** Where the visitor's workflows and decisions persist; null or failing storage keeps them in memory. */
  storage?: DemoStorage | null;
  /** Multiplies the replay pacing; 0 replays a run without waiting. */
  pace?: number;
  delay?: (ms: number) => Promise<void>;
  now?: () => Date;
  notify?: (notice: DemoNotice) => void;
}

interface ApprovalDecision {
  status: "approved" | "rejected";
  reason: string | null;
  decidedAt: string;
}

interface PersistedState {
  recordedAt: string;
  workflows: Workflow[];
  decisions: Record<string, ApprovalDecision>;
  seq: number;
}

type Json = Record<string, unknown>;

const CREDENTIAL_PATHS: RegExp[] = [
  /^\/api\/auth\/(?!me$)/,
  /^\/api\/secrets(\/|$)/,
  /^\/api\/users(\/|$)/,
  /^\/api\/custom-roles(\/|$)/,
  /^\/api\/projects\/[^/]+\/members(\/|$)/,
  /^\/api\/external-providers(\/|$)/,
  /^\/api\/audit\/signing-keys(\/|$)/,
  /^\/api\/providers\/(test|models)$/,
  /^\/api\/connectors\/test$/,
  /^\/api\/mcp\/connections(\/|$)/,
  /^\/api\/mcp\/clients(\/|$)/,
  /^\/api\/mcp\/servers\/[^/]+\/(oauth|connections)(\/|$)/,
  /^\/api\/workflows\/[^/]+\/(share-link|shares)(\/|$)/,
  /^\/api\/git(\/|$)/
];

/** Pause before each replayed frame, in ms, so a run reads at a human pace. */
function frameDelay(frame: RecordedFrame): number {
  const data = (frame.data ?? {}) as Json;
  switch (frame.event) {
    case "execution_started":
      return 150;
    case "node_start":
      return 380;
    case "node_complete":
      return data.status === "skipped" ? 40 : 260;
    case "llm_delta":
      return 35;
    case "node_progress":
      return 120;
    case "node_activity": {
      if (data.kind === "llm_call") return data.phase === "end" ? 900 : 120;
      if (data.kind === "tool_call") return data.phase === "end" ? 650 : 200;
      return 140;
    }
    case "result":
      return 250;
    default:
      return 120;
  }
}

/**
 * A replayed frame carries the replay's wall-clock time instead of the
 * recording's, so elapsed-time displays read right; durations stay as recorded.
 */
function restamp(frame: RecordedFrame, replayStartedAt: string, at: string): unknown {
  if (!frame.data || typeof frame.data !== "object") return frame.data;
  const data = { ...(frame.data as Json) };
  if (frame.event === "result" || frame.event === "execution_started") {
    if ("startedAt" in data) data.startedAt = replayStartedAt;
    if ("completedAt" in data) data.completedAt = at;
    return data;
  }
  for (const key of ["at", "startedAt", "completedAt"]) if (typeof data[key] === "string") data[key] = at;
  return data;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Json)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** What decides a run's result: node types and configs and the edges between them. Layout and names do not. */
export function graphDigest(workflow: Pick<Workflow, "nodes" | "edges">): string {
  const nodes = [...workflow.nodes].map((node) => ({ id: node.id, type: node.type, config: node.config ?? {} })).sort((a, b) => (a.id < b.id ? -1 : 1));
  const edges = [...workflow.edges]
    .map((edge) => ({ source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle ?? null, targetHandle: edge.targetHandle ?? null }))
    .sort((a, b) => (stable(a) < stable(b) ? -1 : 1));
  return stable({ nodes, edges });
}

/** How long "Try the recorded question" waits for the run it was pressed for. */
export const ARMED_RUN_TTL_MS = 2_000;

/** Request fields of partial and debug runs, whose results no recording holds. */
const PARTIAL_RUN_FIELDS = ["startNodeId", "runMode", "sourceExecutionId"] as const;

/** Inputs compare after trimming and collapsing whitespace. */
export function normalizeRunInput(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** The input a run request carries: the prompt of a manual or chat run, or the body of a webhook run. */
export function runInputOf(body: Record<string, unknown>): string | null {
  const nested = body.input && typeof body.input === "object" ? (body.input as Record<string, unknown>) : {};
  for (const candidate of [body.user_prompt, body.message, nested.user_prompt, nested.message]) {
    if (typeof candidate === "string") return candidate;
  }
  return null;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function notInDemo(message = NOT_IN_DEMO_MESSAGE, status = 501, extra: Json = {}): Response {
  return json(status, { error: message, code: NOT_IN_DEMO, ...extra });
}

function normalizeQuery(search: string): string {
  const entries: Array<[string, string]> = [];
  new URLSearchParams(search).forEach((value, key) => {
    if (value !== "") entries.push([key, value]);
  });
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : "";
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workflow";
}

export interface FakeBackend {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  openEventSource(url: string): EventSource;
  /** Back to the recorded fixtures; the visitor's changes are dropped. */
  reset(): void;
  /** Puts one workflow back to its recorded version. */
  restoreRecorded(workflowId: string): boolean;
  /**
   * The visitor chose "Try the recorded question": the next run, if it is
   * this workflow on its current graph within ARMED_RUN_TTL_MS, runs the
   * recorded input whatever the studio sends. Any run clears it. Returns that
   * input, or null (and arms nothing) when the workflow has no recording.
   */
  armRecordedInput(workflowId: string): string | null;
  workflows(): Workflow[];
  /** Requests the demo had no answer for, as "METHOD /path", oldest first. */
  misses(): string[];
}

const ISO_INSTANT = /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)"/g;
const ISO_DAY = /"(\d{4}-\d{2}-\d{2})"/g;
const DAY_MS = 86_400_000;

/**
 * Moves every recorded instant (and day key) forward by the time since the
 * recording, so the demo reads as recorded moments ago: approvals are not
 * expired and the last-14-days views have data. `recordedAt` stays as is, to
 * key the visitor's saved state to this recording.
 */
export function shiftFixtures(fixtures: DemoFixtures, now: Date): DemoFixtures {
  const offset = now.getTime() - Date.parse(fixtures.meta.recordedAt);
  if (!Number.isFinite(offset) || offset <= 0) return fixtures;
  const days = Math.round((Date.parse(now.toISOString().slice(0, 10)) - Date.parse(fixtures.meta.recordedAt.slice(0, 10))) / DAY_MS);
  const { meta, ...rest } = fixtures;
  const text = JSON.stringify(rest)
    .replace(ISO_INSTANT, (_match, instant: string) => JSON.stringify(new Date(Date.parse(instant) + offset).toISOString()))
    .replace(ISO_DAY, (match, day: string) => {
      const parsed = Date.parse(`${day}T00:00:00Z`);
      return Number.isFinite(parsed) ? JSON.stringify(new Date(parsed + days * DAY_MS).toISOString().slice(0, 10)) : match;
    });
  return { meta, ...(JSON.parse(text) as Omit<DemoFixtures, "meta">) };
}

export function createFakeBackend(options: FakeBackendOptions): FakeBackend {
  const pace = options.pace ?? 1;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const fixtures = shiftFixtures(options.fixtures, now());
  const user = fixtures.meta.user;
  const recordedWorkflows = new Map(fixtures.workflows.workflows.map((workflow) => [workflow.id, workflow]));
  const recordedDigests = new Map<string, string>();
  for (const [id, run] of Object.entries(fixtures.runs)) {
    const workflow = recordedWorkflows.get(id);
    if (workflow && run.frames.length) recordedDigests.set(graphDigest(workflow), id);
  }

  // Recorded GET answers, by exact key, by normalised query and by path.
  const exactGets = new Map<string, unknown>();
  const byPath = new Map<string, Array<{ query: string; body: unknown }>>();
  for (const [key, recorded] of Object.entries(fixtures.responses.get)) {
    const url = key.replace(/^GET /, "");
    const [pathname, search = ""] = url.split("?");
    const query = normalizeQuery(search);
    exactGets.set(`${pathname}${query}`, recorded.body);
    const list = byPath.get(pathname!) ?? [];
    list.push({ query, body: recorded.body });
    byPath.set(pathname!, list);
  }

  const fresh = (): PersistedState => ({ recordedAt: fixtures.meta.recordedAt, workflows: clone(fixtures.workflows.workflows), decisions: {}, seq: 0 });

  const load = (): PersistedState => {
    try {
      const raw = options.storage?.getItem(DEMO_STATE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedState;
        // Fixtures recorded again: start over rather than mix two recordings.
        if (parsed.recordedAt === fixtures.meta.recordedAt && Array.isArray(parsed.workflows)) return { ...fresh(), ...parsed };
      }
    } catch {
      // Unreadable or blocked storage: the demo works from memory.
    }
    return fresh();
  };

  let state = load();
  const missed: string[] = [];
  /**
   * "Try the recorded question": the next run of this workflow, on this graph,
   * within a moment, is the recorded question. Any run clears it.
   */
  let armed: { workflowId: string; graphDigest: string; expiresAt: number } | null = null;

  const persist = () => {
    try {
      options.storage?.setItem(DEMO_STATE_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Full or blocked storage: changes last for this page only.
    }
  };

  const findWorkflow = (id: string) => state.workflows.find((workflow) => workflow.id === id);

  const putWorkflow = (workflow: Workflow) => {
    const index = state.workflows.findIndex((entry) => entry.id === workflow.id);
    if (index >= 0) state.workflows[index] = workflow;
    else state.workflows.unshift(workflow);
    persist();
    return workflow;
  };

  const nextId = (name: string) => {
    let id = "";
    do {
      state.seq += 1;
      id = `wf-${slug(name)}-${state.seq}`;
    } while (findWorkflow(id));
    return id;
  };

  const listItem = (workflow: Workflow): WorkflowListItem => {
    const record = workflow as Workflow & { createdAt?: string; updatedAt?: string; tags?: string[]; folderId?: string };
    const stamp = now().toISOString();
    return {
      id: workflow.id,
      name: workflow.name,
      schemaVersion: workflow.schemaVersion,
      workflowVersion: workflow.workflowVersion,
      createdAt: record.createdAt ?? stamp,
      updatedAt: record.updatedAt ?? stamp,
      tags: record.tags ?? [],
      projectId: workflow.projectId ?? "default",
      ...(record.folderId ? { folderId: record.folderId } : {})
    };
  };

  const parseWorkflow = (value: unknown): { workflow?: Workflow; error?: Response } => {
    const parsed = workflowSchema.safeParse(value);
    if (!parsed.success) return { error: json(400, { error: "Invalid workflow payload", details: parsed.error.issues }) };
    return { workflow: parsed.data as Workflow };
  };

  const saveFromBody = (body: unknown, id?: string): Response => {
    const { workflow, error } = parseWorkflow(id ? { ...(body as Json), id } : body);
    if (!workflow) return error!;
    const existing = findWorkflow(workflow.id) as (Workflow & { createdAt?: string }) | undefined;
    const stamp = now().toISOString();
    const saved = { ...workflow, projectId: workflow.projectId ?? "default", createdAt: existing?.createdAt ?? stamp, updatedAt: stamp } as Workflow;
    return json(200, putWorkflow(saved));
  };

  /** The recording to replay for this workflow as it is now: its own, or one of the same graph. */
  const recordingFor = (workflow: Workflow): { run: RecordedRun; workflowId: string } | null => {
    const recordedId = recordedDigests.get(graphDigest(workflow));
    return recordedId ? { run: fixtures.runs[recordedId]!, workflowId: recordedId } : null;
  };

  const similarRecording = (workflow: Workflow) => {
    const types = new Set(workflow.nodes.map((node) => node.type));
    let best: { workflowId: string; score: number } | null = null;
    for (const recordedId of recordedDigests.values()) {
      const recorded = recordedWorkflows.get(recordedId)!;
      const other = new Set(recorded.nodes.map((node) => node.type));
      const shared = [...types].filter((type) => other.has(type)).length;
      const score = shared / new Set([...types, ...other]).size;
      if (!best || score > best.score) best = { workflowId: recordedId, score };
    }
    if (!best) return undefined;
    const recorded = recordedWorkflows.get(best.workflowId)!;
    return { workflowId: best.workflowId, name: recorded.name, executionId: fixtures.runs[best.workflowId]!.executionId };
  };

  const notRecorded = (workflow: Workflow): Response => {
    const restorable = Boolean(recordedWorkflows.get(workflow.id) && fixtures.runs[workflow.id]);
    const similar = restorable ? undefined : similarRecording(workflow);
    const message = restorable
      ? `${RUN_NEEDS_DEPLOYMENT_MESSAGE} This workflow changed since its run was recorded; restore the recorded version to replay that run.`
      : similar
        ? `${RUN_NEEDS_DEPLOYMENT_MESSAGE} Here is a recorded run of a similar workflow: “${similar.name}”.`
        : RUN_NEEDS_DEPLOYMENT_MESSAGE;
    options.notify?.({ kind: "run_not_recorded", message, workflowId: workflow.id, restorable, ...(similar ? { similar } : {}) });
    return notInDemo(message, 409, { workflowId: workflow.id, restorable, ...(similar ? { similar } : {}) });
  };

  const replayStream = (run: RecordedRun): Response => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const replayStartedAt = now().toISOString();
        for (const frame of run.frames) {
          if (cancelled) return;
          const wait = frameDelay(frame) * pace;
          if (wait > 0) await delay(wait);
          if (cancelled) return;
          controller.enqueue(encoder.encode(`event: ${frame.event}\ndata: ${JSON.stringify(restamp(frame, replayStartedAt, now().toISOString()))}\n\n`));
        }
        controller.close();
      },
      cancel() {
        cancelled = true;
      }
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  const partialRun = (workflow: Workflow, field: string): Response => {
    const message = `${RUN_NEEDS_DEPLOYMENT_MESSAGE} Running part of a workflow or debugging from a node (${field}) only works against a real deployment.`;
    options.notify?.({ kind: "not_in_demo", message });
    return notInDemo(message, 409, { workflowId: workflow.id, field });
  };

  const inputNotRecorded = (workflow: Workflow, recordedInput: string): Response => {
    const message = `${RUN_NEEDS_DEPLOYMENT_MESSAGE} The recorded run of this workflow answers one question: “${recordedInput}”. Anything else needs a real model.`;
    options.notify?.({ kind: "input_not_recorded", message, workflowId: workflow.id, recordedInput });
    return notInDemo(message, 409, { workflowId: workflow.id, recordedInput });
  };

  const execute = (workflowId: string, stream: boolean, body: Json): Response => {
    // Read and clear the visitor's request first: it is for this one run, whatever happens to it.
    const arm = armed;
    armed = null;
    const workflow = findWorkflow(workflowId);
    if (!workflow) return json(404, { error: "Workflow not found" });
    const partial = PARTIAL_RUN_FIELDS.find((field) => body[field] !== undefined && body[field] !== null && body[field] !== "" && !(field === "runMode" && body[field] === "workflow"));
    if (partial) return partialRun(workflow, partial);
    const recording = recordingFor(workflow);
    if (!recording) return notRecorded(workflow);
    const armedForThis = Boolean(arm && arm.workflowId === workflowId && arm.graphDigest === graphDigest(workflow) && now().getTime() <= arm.expiresAt);
    if (!armedForThis) {
      // A recording answers its own input only, sent with the system prompt it was recorded with.
      const input = runInputOf(body);
      const systemPrompt = typeof body.system_prompt === "string" ? normalizeRunInput(body.system_prompt) : null;
      const recordedSystemPrompt = recording.run.systemPrompt ? normalizeRunInput(recording.run.systemPrompt) : null;
      if (input === null || normalizeRunInput(input) !== normalizeRunInput(recording.run.prompt) || systemPrompt !== recordedSystemPrompt) {
        return inputNotRecorded(workflow, recording.run.prompt);
      }
    }
    if (stream) return replayStream(recording.run);
    const result = [...recording.run.frames].reverse().find((frame) => frame.event === "result");
    return result ? json(200, result.data) : notRecorded(workflow);
  };

  const approvals = (search: URLSearchParams): Response => {
    const all = ((fixtures.responses.get["GET /api/approvals?status=all"]?.body as { items?: Json[] } | undefined)?.items ?? []).map((item) => {
      const decision = state.decisions[String(item.executionId)];
      if (!decision) return item;
      return { ...item, status: decision.status, decidedBy: user.email, decidedAt: decision.decidedAt, reason: decision.reason, canDecide: false, cannotDecideReason: "Already decided." };
    });
    const status = search.get("status") ?? "pending";
    const workflowId = search.get("workflowId");
    const executionId = search.get("executionId");
    const limit = Number(search.get("limit") ?? "0");
    let items = all.filter((item) => (status === "all" ? true : status === "pending" ? item.status === "pending" : item.status !== "pending"));
    if (workflowId) items = items.filter((item) => item.workflowId === workflowId);
    if (executionId) items = items.filter((item) => item.executionId === executionId);
    if (limit > 0) items = items.slice(0, limit);
    return json(200, { items });
  };

  const decide = (id: string, decision: "approve" | "reject", body: Json): Response => {
    const items = ((fixtures.responses.get["GET /api/approvals?status=all"]?.body as { items?: Json[] } | undefined)?.items ?? []);
    const item = items.find((entry) => entry.executionId === id || entry.requestId === id);
    if (!item) return json(404, { error: "Approval request not found" });
    if (item.status !== "pending" || state.decisions[String(item.executionId)]) return json(409, { error: "This request has already been decided." });
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
    if (decision === "reject" && item.requireRejectReason && !reason) return json(400, { error: "A reason is required to reject this request." });
    state.decisions[String(item.executionId)] = { status: decision === "approve" ? "approved" : "rejected", reason, decidedAt: now().toISOString() };
    persist();
    options.notify?.({
      kind: "approval_decided",
      message: `${decision === "approve" ? "Approved" : "Rejected"} on demo data. ${APPROVAL_RESUME_MESSAGE}`,
      executionId: String(item.executionId)
    });
    return json(202, { queued: true, executionId: item.executionId, requestId: item.requestId, decision });
  };

  const executions = (search: URLSearchParams): Response => {
    const recorded = Object.entries(fixtures.responses.get).find(([key]) => key.startsWith("GET /api/executions?"))?.[1]?.body as { items?: Json[] } | undefined;
    let items = recorded?.items ?? [];
    const status = search.get("status");
    const workflowId = search.get("workflowId");
    if (status) items = items.filter((item) => item.status === status);
    if (workflowId) items = items.filter((item) => item.workflowId === workflowId);
    const page = Math.max(1, Number(search.get("page") ?? "1"));
    const pageSize = Math.max(1, Number(search.get("pageSize") ?? "40"));
    return json(200, { ...(recorded ?? {}), items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize });
  };

  const recordedBody = (pathname: string, search: string): { body: unknown } | null => {
    const query = normalizeQuery(search);
    if (exactGets.has(`${pathname}${query}`)) return { body: clone(exactGets.get(`${pathname}${query}`)) };
    // Otherwise the recorded variant that agrees with every parameter it has, preferring the most specific.
    const requested = new URLSearchParams(search);
    let best: { score: number; body: unknown } | null = null;
    for (const variant of byPath.get(pathname) ?? []) {
      let score = 0;
      let agrees = true;
      new URLSearchParams(variant.query).forEach((value, key) => {
        if (requested.get(key) === value) score += 1;
        else agrees = false;
      });
      if (agrees && (!best || score > best.score)) best = { score, body: variant.body };
    }
    // A telemetry answer is for one window: another window's numbers would be wrong, so it has no answer.
    const window = requested.get("window");
    const answered = (best?.body as { window?: unknown } | undefined)?.window;
    if (best && window && typeof answered === "string" && answered !== window) return null;
    return best ? { body: clone(best.body) } : null;
  };

  const recordedGet = (pathname: string, search: string): Response | null => {
    const recorded = recordedBody(pathname, search);
    return recorded ? json(200, recorded.body) : null;
  };

  /**
   * Per-workflow reads (versions, releases, golden sets, captures, ...) of a
   * workflow the visitor made: the recorded answers of a workflow in the same
   * never-saved state, under the visitor's workflow id.
   */
  const visitorWorkflowGet = (pathname: string, searchParams: URLSearchParams): Response | null => {
    const blank = fixtures.meta.blankWorkflowId;
    const pathId = /^\/api\/workflows\/([^/]+)\//.exec(pathname)?.[1];
    const queryId = searchParams.get("workflowId");
    const visitorId = [pathId && decodeURIComponent(pathId), queryId].find((id) => id && !recordedWorkflows.has(id) && findWorkflow(id));
    if (!visitorId || !blank) return null;
    const aliasPath = pathId ? pathname.replace(`/api/workflows/${pathId}/`, `/api/workflows/${encodeURIComponent(blank)}/`) : pathname;
    const aliasParams = new URLSearchParams(searchParams);
    if (queryId === visitorId) aliasParams.set("workflowId", blank);
    const query = aliasParams.toString();
    const recorded = recordedBody(aliasPath, query ? `?${query}` : "");
    if (!recorded) return null;
    return json(200, JSON.parse(JSON.stringify(recorded.body).split(JSON.stringify(blank)).join(JSON.stringify(visitorId))));
  };

  /** Values a request leaves out take the API's defaults, or null. */
  const requestValue = (body: Json, key: string): unknown => {
    if (body[key] !== undefined) return body[key];
    if (key === "mcpMode") return "strict";
    if (key === "draft") return body.version === undefined;
    return null;
  };

  /**
   * A recorded answer to a write (a replay diff, a publish verdict) stands
   * only for the same request on the same graph; anything else would be an
   * answer the API never gave.
   */
  const recordedWrite = (recorded: RecordedWrite, body: Json): Response => {
    const workflow = findWorkflow(recorded.match.workflowId);
    const sameGraph = Boolean(workflow) && graphDigest(workflow!) === graphDigest(recorded.match.graph);
    const sameRequest = Object.entries(recorded.match.request).every(([key, value]) => stable(requestValue(body, key)) === stable(value));
    if (sameGraph && sameRequest) return json(recorded.status, clone(recorded.body));
    const message = `${RUN_NEEDS_DEPLOYMENT_MESSAGE} This answer was recorded for another version of “${workflow?.name ?? recorded.match.workflowId}” or another request.`;
    options.notify?.({ kind: "not_in_demo", message });
    return notInDemo(message, 409, { workflowId: recorded.match.workflowId });
  };

  const readBody = async (init?: RequestInit): Promise<Json> => {
    if (typeof init?.body !== "string" || !init.body) return {};
    try {
      const parsed = JSON.parse(init.body) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Json) : {};
    } catch {
      return {};
    }
  };

  const handle = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input, "https://demo.invalid");
    const method = (init?.method ?? "GET").toUpperCase();
    const { pathname, searchParams } = url;

    if (pathname === "/api/auth/me") return json(200, { user });
    if (pathname === "/health") return json(200, { ok: true, demo: true });
    if (CREDENTIAL_PATHS.some((pattern) => pattern.test(pathname))) return notInDemo(CREDENTIALS_MESSAGE, 403);

    // Workflows: the visitor's own state.
    if (pathname === "/api/workflows" && method === "GET") {
      const projectId = searchParams.get("projectId");
      const folderId = searchParams.get("folderId");
      const tag = searchParams.get("tag");
      const search = searchParams.get("search")?.toLowerCase();
      const items = state.workflows
        .map(listItem)
        .filter((item) => !projectId || item.projectId === projectId)
        .filter((item) => !folderId || (folderId === "__none__" ? !item.folderId : item.folderId === folderId))
        .filter((item) => !tag || (item.tags ?? []).includes(tag))
        .filter((item) => !search || item.name.toLowerCase().includes(search));
      return json(200, items);
    }
    if (pathname === "/api/workflows" && method === "POST") return saveFromBody(await readBody(init));
    if (pathname === "/api/workflows/import" && method === "POST") {
      const body = await readBody(init);
      let candidate: unknown = body.workflow;
      if (typeof body.json === "string") {
        try {
          candidate = JSON.parse(body.json) as unknown;
        } catch {
          return json(400, { error: "The file is not valid JSON." });
        }
      }
      const wrapped = candidate as { workflow?: Json; schemaVersion?: string; workflowVersion?: number } | undefined;
      const workflow = wrapped?.workflow ? { schemaVersion: wrapped.schemaVersion, workflowVersion: wrapped.workflowVersion, ...wrapped.workflow } : candidate;
      const { workflow: parsed, error } = parseWorkflow(workflow);
      if (!parsed) return error!;
      const id = findWorkflow(parsed.id) ? nextId(parsed.name) : parsed.id;
      return saveFromBody({ ...parsed, id });
    }
    const workflowMatch = /^\/api\/workflows\/([^/]+)(?:\/(.+))?$/.exec(pathname);
    if (workflowMatch) {
      const id = decodeURIComponent(workflowMatch[1]!);
      const action = workflowMatch[2];
      const workflow = findWorkflow(id);
      if (!action) {
        if (method === "GET") return workflow ? json(200, clone(workflow)) : json(404, { error: "Workflow not found" });
        if (method === "PUT") return workflow ? saveFromBody(await readBody(init), id) : json(404, { error: "Workflow not found" });
        if (method === "DELETE") {
          if (!workflow) return json(404, { error: "Workflow not found" });
          state.workflows = state.workflows.filter((entry) => entry.id !== id);
          persist();
          return json(200, { ok: true });
        }
      }
      if (action === "duplicate" && method === "POST") {
        if (!workflow) return json(404, { error: "Workflow not found" });
        const body = await readBody(init);
        const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : `${workflow.name} (copy)`;
        const newId = typeof body.id === "string" && body.id && !findWorkflow(body.id) ? body.id : nextId(name);
        return saveFromBody({ ...clone(workflow), id: newId, name });
      }
      if (action === "execute/stream" && method === "POST") return execute(id, true, await readBody(init));
      if (action === "execute" && method === "POST") return execute(id, false, await readBody(init));
      if (action === "variables" && method === "GET" && workflow && !recordedWorkflows.has(id)) return json(200, { workflowId: id, variables: {} });
    }

    if (pathname === "/api/templates" && method === "GET") return recordedGet(pathname, url.search) ?? json(200, { templates: [] });
    const useTemplate = /^\/api\/templates\/([^/]+)\/use$/.exec(pathname);
    if (useTemplate && method === "POST") {
      const template = fixtures.responses.get[`GET /api/templates/${useTemplate[1]}`]?.body as { name?: string; workflowJson?: string } | undefined;
      if (!template?.workflowJson) return json(404, { error: "Template not found" });
      const parsed = JSON.parse(template.workflowJson) as { schemaVersion?: string; workflowVersion?: number; workflow?: Json };
      const name = String(template.name ?? parsed.workflow?.name ?? "Workflow");
      const id = nextId(name);
      const saved = saveFromBody({ schemaVersion: parsed.schemaVersion, workflowVersion: parsed.workflowVersion, ...(parsed.workflow ?? {}), id, name, projectId: "default" });
      if (saved.status !== 200) return saved;
      return json(200, { workflowId: id, name });
    }

    if (pathname === "/api/approvals" && method === "GET") return approvals(searchParams);
    const decision = /^\/api\/approvals\/([^/]+)\/(approve|reject)$/.exec(pathname);
    if (decision && method === "POST") return decide(decodeURIComponent(decision[1]!), decision[2] as "approve" | "reject", await readBody(init));
    if (pathname === "/api/executions" && method === "GET") return executions(searchParams);

    const recorded = method === "GET" ? visitorWorkflowGet(pathname, searchParams) ?? recordedGet(pathname, url.search) : null;
    if (recorded) return recorded;
    const recordedPost = fixtures.responses.post[`${method} ${pathname}`];
    if (recordedPost) return recordedWrite(recordedPost, await readBody(init));
    missed.push(`${method} ${pathname}${url.search}`);
    return notInDemo();
  };

  return {
    fetch: (input, init) => handle(input, init),
    openEventSource: (url) => createRecordedEventSource(url, fixtures) as unknown as EventSource,
    reset() {
      state = fresh();
      try {
        options.storage?.removeItem(DEMO_STATE_STORAGE_KEY);
      } catch {
        // Blocked storage: memory was reset, which is what matters.
      }
    },
    restoreRecorded(workflowId) {
      const recorded = recordedWorkflows.get(workflowId);
      if (!recorded) return false;
      putWorkflow(clone(recorded));
      return true;
    },
    armRecordedInput(workflowId) {
      const workflow = findWorkflow(workflowId);
      const recording = workflow ? recordingFor(workflow) : null;
      armed = null;
      if (!workflow || !recording) return null;
      armed = { workflowId, graphDigest: graphDigest(workflow), expiresAt: now().getTime() + ARMED_RUN_TTL_MS };
      return recording.run.prompt;
    },
    workflows: () => clone(state.workflows),
    misses: () => [...missed]
  };
}

/**
 * `/api/eval/runs/:id/events` for a recorded eval or replay job: one `done`
 * event with the run as recorded, or an error (the client then polls, which
 * the recorded GET answers).
 */
function createRecordedEventSource(url: string, fixtures: DemoFixtures) {
  const target = new EventTarget() as EventTarget & { url: string; readyState: number; withCredentials: boolean; onerror: ((event: Event) => void) | null; close(): void };
  target.url = url;
  target.readyState = 0;
  target.withCredentials = true;
  target.onerror = null;
  let closed = false;
  target.close = () => {
    closed = true;
    target.readyState = 2;
  };
  const id = /\/api\/eval\/runs\/([^/]+)\/events/.exec(url)?.[1];
  const recorded = (id && (fixtures.responses.get[`GET /api/eval/runs/${id}`] ?? fixtures.responses.get[`GET /api/replay/runs/${id}`])?.body) as { run?: unknown } | undefined;
  setTimeout(() => {
    if (closed) return;
    if (recorded?.run) {
      target.readyState = 1;
      target.dispatchEvent(new MessageEvent("done", { data: JSON.stringify({ type: "done", run: recorded.run }) }));
    } else {
      target.onerror?.(new Event("error"));
    }
  }, 0);
  return target;
}
