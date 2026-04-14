/**
 * Phase 3.5 — Trigger System Expansion.
 *
 * Long-lived framework that activates trigger nodes which can't fire inside
 * a single DAG run:
 *   - file_trigger: polling filesystem scan
 *   - rss_trigger:  polling RSS/Atom fetch with GUID dedupe
 *   - sse_trigger:  persistent SSE consumer with reconnect
 *   - kafka/rabbitmq/mqtt triggers: optional-dep stubs (NOT_IMPLEMENTED)
 *
 * Webhook-style triggers (manual_trigger, form_trigger, chat_trigger,
 * mcp_server_trigger) are activated by HTTP endpoints in `apps/api/src/app.ts`
 * and don't need background activity from this service.
 */
import fs from "node:fs";
import path from "node:path";
import type { Workflow, WorkflowNode, WorkflowNodeType } from "@ai-orchestrator/shared";
import { isExecutionEdge } from "@ai-orchestrator/workflow-engine";
import { SqliteStore } from "../db/database";

export interface TriggerExecutionInput {
  workflow: Workflow;
  node: WorkflowNode;
  triggerType: string;
  input: Record<string, unknown>;
}

type TriggerExecutionHandler = (input: TriggerExecutionInput) => Promise<void>;
type SecretResolver = (secretRef?: { secretId: string }) => Promise<string | undefined>;
type Logger = (level: "info" | "warn" | "error", message: string, metadata?: unknown) => void;

type PollingTriggerType = "file_trigger" | "rss_trigger";
type LongLivedTriggerType = "sse_trigger" | "kafka_trigger" | "rabbitmq_trigger" | "mqtt_trigger";
type ManagedTriggerType = PollingTriggerType | LongLivedTriggerType;

const MANAGED_TRIGGER_TYPES: ReadonlySet<ManagedTriggerType> = new Set<ManagedTriggerType>([
  "file_trigger",
  "rss_trigger",
  "sse_trigger",
  "kafka_trigger",
  "rabbitmq_trigger",
  "mqtt_trigger"
]);

interface ActiveTrigger {
  workflowId: string;
  nodeId: string;
  type: ManagedTriggerType;
  dispose: () => void | Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isManaged(node: WorkflowNode): node is WorkflowNode {
  return MANAGED_TRIGGER_TYPES.has(node.type as ManagedTriggerType);
}

function isActive(node: WorkflowNode): boolean {
  const config = asRecord(node.config);
  return config.active !== false;
}

function isConnectedEntrypoint(workflow: Workflow, nodeId: string): boolean {
  let incoming = 0;
  let outgoing = 0;
  for (const edge of workflow.edges.filter(isExecutionEdge)) {
    if (edge.target === nodeId) incoming += 1;
    if (edge.source === nodeId) outgoing += 1;
  }
  return incoming === 0 && outgoing > 0;
}

function globPatternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

async function listFilesRecursive(root: string, recursive: boolean): Promise<Array<{ path: string; mtimeMs: number }>> {
  const out: Array<{ path: string; mtimeMs: number }> = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) stack.push(full);
        continue;
      }
      try {
        const stat = await fs.promises.stat(full);
        out.push({ path: full, mtimeMs: stat.mtimeMs });
      } catch {
        /* file deleted between readdir and stat */
      }
    }
  }
  return out;
}

interface RssItem {
  id: string;
  title: string;
  link: string;
  pubDate: string;
  raw: string;
}

function parseFeed(xml: string): RssItem[] {
  const items: RssItem[] = [];
  // Support both RSS <item> and Atom <entry> with a hand-rolled scan — avoids
  // pulling an XML dep into a trigger polling loop.
  const entryRegex = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[0]!;
    const guidMatch =
      /<guid[^>]*>([\s\S]*?)<\/guid>/i.exec(block) ??
      /<id>([\s\S]*?)<\/id>/i.exec(block);
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(block);
    const linkMatchRss = /<link>([^<]+)<\/link>/i.exec(block);
    const linkMatchAtom = /<link[^>]*href="([^"]+)"/i.exec(block);
    const pubMatch =
      /<pubDate>([\s\S]*?)<\/pubDate>/i.exec(block) ??
      /<published>([\s\S]*?)<\/published>/i.exec(block) ??
      /<updated>([\s\S]*?)<\/updated>/i.exec(block);
    const link = linkMatchRss?.[1]?.trim() ?? linkMatchAtom?.[1]?.trim() ?? "";
    const id = guidMatch?.[1]?.trim() || link || titleMatch?.[1]?.trim() || "";
    if (!id) continue;
    items.push({
      id,
      title: (titleMatch?.[1] ?? "").trim(),
      link,
      pubDate: (pubMatch?.[1] ?? "").trim(),
      raw: block
    });
  }
  return items;
}

export class TriggerService {
  private readonly active = new Map<string, ActiveTrigger>();
  private executeHandler: TriggerExecutionHandler | null = null;
  private resolveSecret: SecretResolver = async () => undefined;

  constructor(
    private readonly store: SqliteStore,
    private readonly logger: Logger = (level, message, metadata) => {
      const suffix = metadata === undefined ? "" : ` ${JSON.stringify(metadata)}`;
      // eslint-disable-next-line no-console
      console[level](`[triggers] ${message}${suffix}`);
    },
    private readonly fetchImpl: typeof fetch = globalThis.fetch
  ) {}

  setExecutionHandler(handler: TriggerExecutionHandler): void {
    this.executeHandler = handler;
  }

  setSecretResolver(resolver: SecretResolver): void {
    this.resolveSecret = resolver;
  }

  initialize(): void {
    this.reloadAllWorkflows();
  }

  reloadAllWorkflows(): void {
    this.stopAll();
    for (const summary of this.store.listWorkflows()) {
      const workflow = this.store.getWorkflow(summary.id);
      if (workflow) this.registerWorkflow(workflow);
    }
  }

  reloadWorkflow(workflowId: string): void {
    this.unregisterWorkflow(workflowId);
    const workflow = this.store.getWorkflow(workflowId);
    if (workflow) this.registerWorkflow(workflow);
  }

  removeWorkflow(workflowId: string): void {
    this.unregisterWorkflow(workflowId);
    this.store.deleteTriggerStatesForWorkflow(workflowId);
  }

  async stop(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.active.values()).map(async (trigger) => {
        try {
          await trigger.dispose();
        } catch {
          /* best effort */
        }
      })
    );
    this.active.clear();
  }

  private stopAll(): void {
    for (const trigger of this.active.values()) {
      try {
        void trigger.dispose();
      } catch {
        /* best effort */
      }
    }
    this.active.clear();
  }

  private unregisterWorkflow(workflowId: string): void {
    for (const [key, trigger] of this.active.entries()) {
      if (trigger.workflowId !== workflowId) continue;
      try {
        void trigger.dispose();
      } catch {
        /* best effort */
      }
      this.active.delete(key);
    }
  }

  private registerWorkflow(workflow: Workflow): void {
    for (const node of workflow.nodes) {
      if (!isManaged(node) || !isActive(node)) continue;
      if (!isConnectedEntrypoint(workflow, node.id)) {
        this.logger("warn", "Skipped trigger node that is not a connected entrypoint", {
          workflowId: workflow.id,
          nodeId: node.id,
          nodeType: node.type
        });
        continue;
      }
      this.registerNode(workflow, node, node.type as ManagedTriggerType);
    }
  }

  private registerNode(workflow: Workflow, node: WorkflowNode, type: ManagedTriggerType): void {
    const key = this.key(workflow.id, node.id);
    if (this.active.has(key)) return;
    try {
      let dispose: () => void | Promise<void>;
      switch (type) {
        case "file_trigger":
          dispose = this.startFileTrigger(workflow, node);
          break;
        case "rss_trigger":
          dispose = this.startRssTrigger(workflow, node);
          break;
        case "sse_trigger":
          dispose = this.startSseTrigger(workflow, node);
          break;
        case "kafka_trigger":
        case "rabbitmq_trigger":
        case "mqtt_trigger":
          dispose = this.startMqTrigger(workflow, node, type);
          break;
      }
      this.active.set(key, { workflowId: workflow.id, nodeId: node.id, type, dispose });
      this.logger("info", "Registered trigger", {
        workflowId: workflow.id,
        nodeId: node.id,
        type
      });
    } catch (error) {
      this.logger("error", "Failed to register trigger", {
        workflowId: workflow.id,
        nodeId: node.id,
        type,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private key(workflowId: string, nodeId: string): string {
    return `${workflowId}::${nodeId}`;
  }

  // ---- file_trigger -------------------------------------------------------

  private startFileTrigger(workflow: Workflow, node: WorkflowNode): () => void {
    const config = asRecord(node.config);
    const watchPath = String(config.watchPath ?? "").trim();
    if (!watchPath) {
      throw new Error("file_trigger requires watchPath");
    }
    const recursive = config.recursive === true;
    const events = new Set(
      Array.isArray(config.events) && config.events.length
        ? (config.events as unknown[]).map((v) => String(v))
        : ["created", "modified"]
    );
    const patternRaw = typeof config.pattern === "string" ? config.pattern.trim() : "";
    const pattern = patternRaw ? globPatternToRegex(patternRaw) : null;
    const intervalSec = Math.max(1, Number(config.pollIntervalSeconds) || 30);

    const tick = async () => {
      try {
        const current = await listFilesRecursive(watchPath, recursive);
        const currentMap = new Map(current.map((f) => [f.path, f.mtimeMs]));
        const prev = (this.store.getTriggerState(workflow.id, node.id) ?? {}) as Record<string, number>;
        const prevMap = new Map<string, number>(
          Object.entries(prev).filter(([, v]) => typeof v === "number") as Array<[string, number]>
        );

        const matches: Array<{ path: string; event: string; mtimeMs: number }> = [];
        for (const [p, mtime] of currentMap) {
          if (pattern && !pattern.test(path.basename(p))) continue;
          const prevMtime = prevMap.get(p);
          if (prevMtime === undefined && events.has("created")) {
            matches.push({ path: p, event: "created", mtimeMs: mtime });
          } else if (prevMtime !== undefined && prevMtime !== mtime && events.has("modified")) {
            matches.push({ path: p, event: "modified", mtimeMs: mtime });
          }
        }
        if (events.has("deleted")) {
          for (const [p, mtime] of prevMap) {
            if (pattern && !pattern.test(path.basename(p))) continue;
            if (!currentMap.has(p)) {
              matches.push({ path: p, event: "deleted", mtimeMs: mtime });
            }
          }
        }

        // Save latest snapshot
        const newState: Record<string, number> = {};
        for (const [p, m] of currentMap) newState[p] = m;
        this.store.saveTriggerState({
          workflowId: workflow.id,
          nodeId: node.id,
          triggerType: "file_trigger",
          state: newState
        });

        // First run (no previous state) = establish baseline, skip firing
        if (prevMap.size === 0) return;
        if (matches.length === 0) return;

        await this.fire({
          workflow,
          node,
          triggerType: "file",
          input: {
            watch_path: watchPath,
            file_events: matches
          }
        });
      } catch (err) {
        this.logger("error", "file_trigger tick failed", {
          workflowId: workflow.id,
          nodeId: node.id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), intervalSec * 1000);
    return () => clearInterval(timer);
  }

  // ---- rss_trigger --------------------------------------------------------

  private startRssTrigger(workflow: Workflow, node: WorkflowNode): () => void {
    const config = asRecord(node.config);
    const feedUrl = String(config.feedUrl ?? "").trim();
    if (!feedUrl) throw new Error("rss_trigger requires feedUrl");
    const intervalSec = Math.max(30, Number(config.pollIntervalSeconds) || 300);
    const maxItems = Math.max(1, Number(config.maxItemsPerTick) || 20);
    const extraHeaders = asRecord(config.headers) as Record<string, string>;

    const tick = async () => {
      try {
        const res = await this.fetchImpl(feedUrl, { headers: extraHeaders });
        if (!res.ok) {
          this.logger("warn", "rss_trigger fetch non-ok", {
            workflowId: workflow.id,
            nodeId: node.id,
            status: res.status
          });
          return;
        }
        const xml = await res.text();
        const items = parseFeed(xml).slice(0, maxItems * 10);
        const prevState = (this.store.getTriggerState(workflow.id, node.id) ?? {}) as { seen?: string[] };
        const seen = new Set<string>(Array.isArray(prevState.seen) ? prevState.seen : []);
        const fresh = items.filter((it) => !seen.has(it.id)).slice(0, maxItems);

        // Update state with current feed window (trimmed)
        const mergedSeen = Array.from(new Set([...seen, ...items.map((it) => it.id)])).slice(-500);
        this.store.saveTriggerState({
          workflowId: workflow.id,
          nodeId: node.id,
          triggerType: "rss_trigger",
          state: { seen: mergedSeen }
        });

        if (seen.size === 0) return; // baseline run
        if (fresh.length === 0) return;

        await this.fire({
          workflow,
          node,
          triggerType: "rss",
          input: {
            feed_url: feedUrl,
            rss_items: fresh
          }
        });
      } catch (err) {
        this.logger("error", "rss_trigger tick failed", {
          workflowId: workflow.id,
          nodeId: node.id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), intervalSec * 1000);
    return () => clearInterval(timer);
  }

  // ---- sse_trigger --------------------------------------------------------

  private startSseTrigger(workflow: Workflow, node: WorkflowNode): () => void {
    const config = asRecord(node.config);
    const url = String(config.url ?? "").trim();
    if (!url) throw new Error("sse_trigger requires url");
    const reconnectMs = Math.max(1, Number(config.reconnectDelaySeconds) || 5) * 1000;
    const maxEpm = Math.max(1, Number(config.maxEventsPerMinute) || 120);
    const eventFilter = String(config.eventName ?? "").trim();
    const authMode = String(config.authMode ?? "none");
    const secretRef = asRecord(config.secretRef);

    let stopped = false;
    let controller: AbortController | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;

    const rateWindow: number[] = [];

    const loop = async () => {
      while (!stopped) {
        try {
          const headers: Record<string, string> = { accept: "text/event-stream" };
          if (authMode === "bearer" && typeof secretRef.secretId === "string") {
            const token = await this.resolveSecret({ secretId: secretRef.secretId });
            if (token) headers.authorization = `Bearer ${token}`;
          }
          controller = new AbortController();
          const res = await this.fetchImpl(url, { headers, signal: controller.signal });
          if (!res.ok || !res.body) {
            throw new Error(`status=${res.status}`);
          }
          const reader = (res.body as ReadableStream<Uint8Array>).getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (!stopped) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop() ?? "";
            for (const raw of events) {
              const parsed = parseSseEvent(raw);
              if (!parsed) continue;
              if (eventFilter && parsed.event !== eventFilter) continue;
              const now = Date.now();
              while (rateWindow.length && now - rateWindow[0]! > 60_000) rateWindow.shift();
              if (rateWindow.length >= maxEpm) continue;
              rateWindow.push(now);
              await this.fire({
                workflow,
                node,
                triggerType: "sse",
                input: { sse_url: url, sse_event: parsed }
              });
            }
          }
        } catch (err) {
          if (!stopped) {
            this.logger("warn", "sse_trigger connection dropped, will reconnect", {
              workflowId: workflow.id,
              nodeId: node.id,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        }
        if (stopped) break;
        await new Promise<void>((resolve) => {
          reconnectTimer = setTimeout(resolve, reconnectMs);
        });
      }
    };

    void loop();
    return () => {
      stopped = true;
      controller?.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }

  // ---- MQ triggers (optional-dep stubs) ----------------------------------

  private startMqTrigger(
    workflow: Workflow,
    node: WorkflowNode,
    type: "kafka_trigger" | "rabbitmq_trigger" | "mqtt_trigger"
  ): () => void {
    const depMap = {
      kafka_trigger: "kafkajs",
      rabbitmq_trigger: "amqplib",
      mqtt_trigger: "mqtt"
    } as const;
    let stopped = false;

    void (async () => {
      try {
        // Feature-flag style — detect if the optional dep is available.
        // Wrapped so TS doesn't try to resolve the type.
        const specifier = depMap[type];
        await import(/* @vite-ignore */ specifier);
        // Full long-lived consumer wiring for each broker is deferred.
        this.logger("warn", `${type}: dependency detected but long-lived consumer is not yet implemented in this build`, {
          workflowId: workflow.id,
          nodeId: node.id
        });
      } catch {
        this.logger("warn", `${type}: optional dependency '${depMap[type]}' is not installed — trigger is inactive`, {
          workflowId: workflow.id,
          nodeId: node.id
        });
      }
      if (stopped) return;
    })();

    return () => {
      stopped = true;
    };
  }

  private async fire(input: TriggerExecutionInput): Promise<void> {
    if (!this.executeHandler) {
      this.logger("warn", "Trigger fired before execution handler was configured", {
        workflowId: input.workflow.id,
        nodeId: input.node.id
      });
      return;
    }
    try {
      await this.executeHandler(input);
    } catch (err) {
      this.logger("error", "Trigger execution handler threw", {
        workflowId: input.workflow.id,
        nodeId: input.node.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
}

export function isManagedTriggerType(type: string): type is ManagedTriggerType {
  return MANAGED_TRIGGER_TYPES.has(type as ManagedTriggerType);
}

export const MANAGED_TRIGGER_NODE_TYPES: ReadonlySet<WorkflowNodeType> = MANAGED_TRIGGER_TYPES as ReadonlySet<WorkflowNodeType>;

interface ParsedSseEvent {
  id?: string;
  event: string;
  data: unknown;
  raw: string;
}

function parseSseEvent(raw: string): ParsedSseEvent | null {
  const lines = raw.split(/\r?\n/).filter((l) => l && !l.startsWith(":"));
  if (!lines.length) return null;
  let event = "message";
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") dataLines.push(value);
  }
  const dataStr = dataLines.join("\n");
  let data: unknown = dataStr;
  if (dataStr.startsWith("{") || dataStr.startsWith("[")) {
    try {
      data = JSON.parse(dataStr);
    } catch {
      /* keep as string */
    }
  }
  return { id, event, data, raw };
}
