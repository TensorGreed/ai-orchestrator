/**
 * Phase 3.1 Tier 1 connector executors.
 *
 * Each exported function implements a single action node. They receive:
 *  - `config`: the node's resolved config (templateData-rendered values should be
 *    passed in by the dispatcher when string templates are expected).
 *  - `ctx`: runtime context with a `resolveSecret(ref)` function and helpers.
 *
 * All functions throw `WorkflowError` on expected errors so the executor retry
 * machinery and error taxonomy can kick in.
 */
import { ErrorCategory, WorkflowError } from "@ai-orchestrator/shared";
import type { SecretReference } from "@ai-orchestrator/shared";
import { renderTemplate } from "../template";

export interface Tier1Context {
  templateData: Record<string, unknown>;
  resolveSecret: (ref?: SecretReference) => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  /** Optional overrides for client factories — used by tests to inject mocks. */
  clients?: Tier1ClientFactories;
}

export interface Tier1ClientFactories {
  createNodemailerTransport?: (opts: unknown) => {
    sendMail: (message: unknown) => Promise<unknown>;
    close?: () => void | Promise<void>;
  };
  createPgClient?: (opts: unknown) => {
    connect: () => Promise<void>;
    query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;
    end: () => Promise<void>;
  };
  createMysqlConnection?: (opts: unknown) => Promise<{
    execute: (sql: string, params?: unknown[]) => Promise<[unknown[], unknown]>;
    end: () => Promise<void>;
  }>;
  createMongoClient?: (uri: string, opts?: unknown) => {
    connect: () => Promise<void>;
    db: (name: string) => {
      collection: (name: string) => {
        find: (q?: unknown) => { toArray: () => Promise<unknown[]> };
        insertOne: (doc: unknown) => Promise<unknown>;
        insertMany: (docs: unknown[]) => Promise<unknown>;
        updateOne: (q: unknown, u: unknown) => Promise<unknown>;
        updateMany: (q: unknown, u: unknown) => Promise<unknown>;
        aggregate: (pipeline: unknown[]) => { toArray: () => Promise<unknown[]> };
      };
    };
    close: () => Promise<void>;
  };
  createRedisClient?: (url: string, opts?: unknown) => {
    call: (cmd: string, ...args: unknown[]) => Promise<unknown>;
    blpop?: (key: string, timeout: number) => Promise<unknown>;
    subscribe?: (channel: string) => Promise<unknown>;
    quit: () => Promise<unknown>;
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getString(config: Record<string, unknown>, key: string, fallback = ""): string {
  const v = config[key];
  return typeof v === "string" ? v : fallback;
}

function getNumber(config: Record<string, unknown>, key: string, fallback: number): number {
  const v = config[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function getBool(config: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = config[key];
  return typeof v === "boolean" ? v : fallback;
}

function requireString(config: Record<string, unknown>, key: string, nodeLabel: string): string {
  const v = config[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new WorkflowError(
      `${nodeLabel} requires config field '${key}'.`,
      ErrorCategory.NODE_CONFIG,
      false
    );
  }
  return v;
}

async function resolveSecretOptional(
  ctx: Tier1Context,
  config: Record<string, unknown>,
  key = "secretRef"
): Promise<string | undefined> {
  const ref = asRecord(config[key]);
  if (typeof ref.secretId !== "string" || !ref.secretId.trim()) return undefined;
  const resolved = await ctx.resolveSecret({ secretId: ref.secretId.trim() });
  return resolved;
}

function renderIfString(value: unknown, data: Record<string, unknown>): unknown {
  if (typeof value === "string") return renderTemplate(value, data);
  return value;
}

function renderDeep(value: unknown, data: Record<string, unknown>): unknown {
  if (typeof value === "string") return renderTemplate(value, data);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, data));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = renderDeep(v, data);
    }
    return out;
  }
  return value;
}

function getFetch(ctx: Tier1Context): typeof fetch {
  return ctx.fetchImpl ?? (globalThis.fetch as typeof fetch);
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

export async function executeSlackSendMessage(
  config: Record<string, unknown>,
  ctx: Tier1Context
): Promise<unknown> {
  const authType = getString(config, "authType", "webhook");
  const text = renderTemplate(getString(config, "text"), ctx.templateData);
  const channel = renderTemplate(getString(config, "channel"), ctx.templateData);
  const threadTs = getString(config, "threadTs") || undefined;
  const blocksRaw = getString(config, "blocks");
  let blocks: unknown;
  if (blocksRaw.trim()) {
    try {
      blocks = JSON.parse(renderTemplate(blocksRaw, ctx.templateData));
    } catch {
      throw new WorkflowError(
        "slack_send_message: 'blocks' must be valid JSON",
        ErrorCategory.NODE_CONFIG,
        false
      );
    }
  }

  const fetchFn = getFetch(ctx);

  if (authType === "webhook") {
    const url = renderTemplate(getString(config, "webhookUrl"), ctx.templateData);
    if (!url.trim()) {
      throw new WorkflowError(
        "slack_send_message: webhookUrl is required when authType=webhook",
        ErrorCategory.NODE_CONFIG,
        false
      );
    }
    const body: Record<string, unknown> = { text };
    if (channel) body.channel = channel;
    if (blocks) body.blocks = blocks;
    if (threadTs) body.thread_ts = threadTs;
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const responseText = await res.text();
    if (!res.ok) {
      throw new WorkflowError(
        `slack_send_message webhook failed: ${res.status} ${responseText}`,
        res.status >= 500 ? ErrorCategory.CONNECTOR_TRANSIENT : ErrorCategory.PROVIDER_AUTH,
        res.status >= 500
      );
    }
    return { ok: true, status: res.status, body: responseText };
  }

  // bot token
  const token = await resolveSecretOptional(ctx, config);
  if (!token) {
    throw new WorkflowError(
      "slack_send_message: bot token secretRef is required when authType=bot",
      ErrorCategory.NODE_CONFIG,
      false
    );
  }
  if (!channel) {
    throw new WorkflowError(
      "slack_send_message: channel is required when authType=bot",
      ErrorCategory.NODE_CONFIG,
      false
    );
  }
  const body: Record<string, unknown> = { channel, text };
  if (blocks) body.blocks = blocks;
  if (threadTs) body.thread_ts = threadTs;
  const res = await fetchFn("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || json.ok === false) {
    const msg = typeof json.error === "string" ? json.error : res.statusText;
    throw new WorkflowError(
      `slack_send_message API call failed: ${msg}`,
      res.status >= 500 ? ErrorCategory.CONNECTOR_TRANSIENT : ErrorCategory.PROVIDER_AUTH,
      res.status >= 500
    );
  }
  return { ok: true, response: json };
}

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------

export async function executeSmtpSendEmail(
  config: Record<string, unknown>,
  ctx: Tier1Context
): Promise<unknown> {
  const host = requireString(config, "host", "smtp_send_email");
  const port = getNumber(config, "port", 587);
  const secure = getBool(config, "secure", port === 465);
  const user = getString(config, "user");
  const password = await resolveSecretOptional(ctx, config);

  const from = renderTemplate(requireString(config, "from", "smtp_send_email"), ctx.templateData);
  const to = renderTemplate(requireString(config, "to", "smtp_send_email"), ctx.templateData);
  const subject = renderTemplate(requireString(config, "subject", "smtp_send_email"), ctx.templateData);
  const text = renderTemplate(getString(config, "text"), ctx.templateData);
  const html = getString(config, "html") ? renderTemplate(getString(config, "html"), ctx.templateData) : undefined;
  const attachments = Array.isArray(config.attachments) ? config.attachments : undefined;

  let create = ctx.clients?.createNodemailerTransport;
  if (!create) {
    try {
      const mod = (await import("nodemailer")) as unknown as {
        default?: { createTransport: (opts: unknown) => unknown };
        createTransport?: (opts: unknown) => unknown;
      };
      const createTransport = mod.default?.createTransport ?? mod.createTransport;
      if (!createTransport) {
        throw new Error("nodemailer.createTransport not found");
      }
      create = (opts) => createTransport(opts) as ReturnType<NonNullable<Tier1ClientFactories["createNodemailerTransport"]>>;
    } catch (err) {
      throw new WorkflowError(
        `smtp_send_email: nodemailer not available (${(err as Error).message})`,
        ErrorCategory.CONFIGURATION,
        false
      );
    }
  }

  const transport = create({
    host,
    port,
    secure,
    auth: user ? { user, pass: password ?? "" } : undefined
  });
  try {
    const info = await transport.sendMail({
      from,
      to,
      subject,
      text,
      html,
      attachments
    });
    return { ok: true, info };
  } catch (err) {
    throw new WorkflowError(
      `smtp_send_email failed: ${(err as Error).message}`,
      ErrorCategory.CONNECTOR_TRANSIENT,
      true
    );
  } finally {
    try {
      await transport.close?.();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// IMAP trigger (stubbed — imapflow is optional)
// ---------------------------------------------------------------------------

export async function executeImapEmailTrigger(
  config: Record<string, unknown>,
  _ctx: Tier1Context
): Promise<unknown> {
  // Prefer a graceful NOT_IMPLEMENTED error so UI can show a clear message.
  // If imapflow is installed, replace this with a polling implementation.
  try {
    // attempt dynamic import to detect if imapflow is present (feature-flag style).
    // Wrapped in a specifier-builder so TypeScript doesn't try to resolve the type.
    const specifier = "imapflow";
    await import(/* @vite-ignore */ specifier);
  } catch {
    throw new WorkflowError(
      "imap_email_trigger: 'imapflow' is not installed. Install it in apps/api or packages/workflow-engine to enable IMAP polling.",
      ErrorCategory.NOT_IMPLEMENTED,
      false,
      { host: getString(config, "host") }
    );
  }
  // If we get here imapflow is available — still stub (full implementation deferred).
  throw new WorkflowError(
    "imap_email_trigger: not yet implemented.",
    ErrorCategory.NOT_IMPLEMENTED,
    false
  );
}

// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------

async function googleSheetsAuth(
  config: Record<string, unknown>,
  ctx: Tier1Context
): Promise<{ urlSuffix: string; headers: Record<string, string> }> {
  const authType = getString(config, "authType", "accessToken");
  const secret = await resolveSecretOptional(ctx, config);
  if (!secret) {
    throw new WorkflowError(
      "google_sheets: secretRef (access token or API key) is required",
      ErrorCategory.NODE_CONFIG,
      false
    );
  }
  if (authType === "apiKey") {
    return { urlSuffix: `?key=${encodeURIComponent(secret)}`, headers: {} };
  }
  return { urlSuffix: "", headers: { authorization: `Bearer ${secret}` } };
}

export async function executeGoogleSheetsRead(
  config: Record<string, unknown>,
  ctx: Tier1Context
): Promise<unknown> {
  const spreadsheetId = requireString(config, "spreadsheetId", "google_sheets_read");
  const range = requireString(config, "range", "google_sheets_read");
  const { urlSuffix, headers } = await googleSheetsAuth(config, ctx);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
    spreadsheetId
  )}/values/${encodeURIComponent(range)}${urlSuffix}`;
  const fetchFn = getFetch(ctx);
  const res = await fetchFn(url, { headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new WorkflowError(
      `google_sheets_read failed: ${res.status} ${JSON.stringify(json)}`,
      res.status >= 500 ? ErrorCategory.CONNECTOR_TRANSIENT : ErrorCategory.PROVIDER_AUTH,
      res.status >= 500
    );
  }
  return json;
}

export async function executeGoogleSheetsAppend(
  config: Record<string, unknown>,
  ctx: Tier1Context
): Promise<unknown> {
  const spreadsheetId = requireString(config, "spreadsheetId", "google_sheets_append");
  const range = requireString(config, "range", "google_sheets_append");
  const valueInputOption = getString(config, "valueInputOption", "USER_ENTERED");
  const values = config.values;
  const { urlSuffix, headers } = await googleSheetsAuth(config, ctx);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
    spreadsheetId
  )}/values/${encodeURIComponent(range)}:append`;
  const qs = urlSuffix
    ? `${urlSuffix}&valueInputOption=${valueInputOption}`
    : `?valueInputOption=${valueInputOption}`;
  const body = { values: renderDeep(values, ctx.templateData) };
  const fetchFn = getFetch(ctx);
  const res = await fetchFn(`${base}${qs}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new WorkflowError(
      `google_sheets_append failed: ${res.status} ${JSON.stringify(json)}`,
      res.status >= 500 ? ErrorCategory.CONNECTOR_TRANSIENT : ErrorCategory.PROVIDER_AUTH,
      res.status >= 500
    );
  }
  return json;
}

export async function executeGoogleSheetsUpdate(
  config: Record<string, unknown>,
  ctx: Tier1Context
): Promise<unknown> {
  const spreadsheetId = requireString(config, "spreadsheetId", "google_sheets_update");
  const range = requireString(config, "range", "google_sheets_update");
  const valueInputOption = getString(config, "valueInputOption", "USER_ENTERED");
  const values = renderDeep(config.values, ctx.templateData);
  const { urlSuffix, headers } = await googleSheetsAuth(config, ctx);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
    spreadsheetId
  )}/values/${encodeURIComponent(range)}`;
  const qs = urlSuffix
    ? `${urlSuffix}&valueInputOption=${valueInputOption}`
    : `?valueInputOption=${valueInputOption}`;
  const fetchFn = getFetch(ctx);
  const res = await fetchFn(`${base}${qs}`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ values })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new WorkflowError(
      `google_sheets_update failed: ${res.status} ${JSON.stringify(json)}`,
      res.status >= 500 ? ErrorCategory.CONNECTOR_TRANSIENT : ErrorCategory.PROVIDER_AUTH,
      res.status >= 500
    );
  }
  return json;
}

export async function executeGoogleSheetsTrigger(
  config: Record<string, unknown>,
  ctx: Tier1Context
): Promise<unknown> {
  // Delegate to read; the scheduler is expected to diff rows against a stored watermark.
  const result = (await executeGoogleSheetsRead(config, ctx)) as Record<string, unknown>;
  const rows = Array.isArray(result.values) ? (result.values as unknown[][]) : [];
  return {
    triggered: true,
    range: result.range,
    newRowCount: rows.length,
    rows
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

async function loadPg(): Promise<{ Client: new (opts: unknown) => {
  connect: () => Promise<void>;
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;
  end: () => Promise<void>;
} }> {
  try {
    const mod = (await import("pg")) as unknown as {
      default?: { Client: new (opts: unknown) => never };
      Client?: new (opts: unknown) => never;
    };
    const Client = mod.Client ?? mod.default?.Client;
    if (!Client) throw new Error("pg.Client not found");
    return { Client: Client as never };
  } catch (err) {
    throw new WorkflowError(
      `postgres: 'pg' module not available (${(err as Error).message})`,
      ErrorCategory.CONFIGURATION,
      false
    );
  }
}

export async function executePostgresQuery(
  config: Record<string, unknown>,
  ctx: Tier1Context
): Promise<unknown> {
  const host = requireString(config, "host", "postgres_query");
  const port = getNumber(config, "port", 5432);
  const database = requireString(config, "database", "postgres_query");
  const user = requireString(config, "user", "postgres_query");
  const ssl = getBool(config, "ssl", false);
  const query = requireString(config, "query", "postgres_query");
  const params = Array.isArray(config.params) ? (config.params as unknown[]) : undefined;
  const password = await resolveSecretOptional(ctx, config);

  let factory = ctx.clients?.createPgClient;
  if (!factory) {
    const { Client } = await loadPg();
    factory = (opts: unknown) => new Client(opts);
  }
  const client = factory({ host, port, database, user, password, ssl });
  await client.connect();
  try {
    const result = await client.query(query, params);
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  } catch (err) {
    throw new WorkflowError(
      `postgres_query failed: ${(err as Error).message}`,
      ErrorCategory.CONNECTOR_TRANSIENT,
      true
    );
  } finally {
    await client.end().catch(() => {
      /* ignore */
    });
  }
}

export async function executePostgresTrigger(
  config: Record<string, unknown>,
  ctx: Tier1Context
): Promise<unknown> {
  const result = (await executePostgresQuery(config, ctx)) as { rows: unknown[]; rowCount: number };
  return {
    triggered: true,
    newRowCount: result.rowCount,
    rows: result.rows
  };
}

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

export async function executeMysqlQuery(
  config: Record<string, unknown>,
  ctx: Tier1Context
): Promise<unknown> {
  const host = requireString(config, "host", "mysql_query");
  const port = getNumber(config, "port", 3306);
  const database = requireString(config, "database", "mysql_query");
  const user = requireString(config, "user", "mysql_query");
  const ssl = getBool(config, "ssl", false);
  const query = requireString(config, "query", "mysql_query");
  const params = Array.isArray(config.params) ? (config.params as unknown[]) : undefined;
  const password = await resolveSecretOptional(ctx, config);

  let factory = ctx.clients?.createMysqlConnection;
  if (!factory) {
    try {
      const mod = (await import("mysql2/promise")) as unknown as {
        createConnection: (opts: unknown) => Promise<never>;
        default?: { createConnection: (opts: unknown) => Promise<never> };
      };
      const createConnection = mod.createConnection ?? mod.default?.createConnection;
      if (!createConnection) throw new Error("mysql2.createConnection not found");
      factory = (opts) => createConnection(opts) as never;
    } catch (err) {
      throw new WorkflowError(
        `mysql_query: 'mysql2' module not available (${(err as Error).message})`,
        ErrorCategory.CONFIGURATION,
        false
      );
    }
  }

  const conn = await factory({ host, port, database, user, password, ssl: ssl ? {} : undefined });
  try {
    const [rows] = await conn.execute(query, params);
    return { rows, rowCount: Array.isArray(rows) ? (rows as unknown[]).length : undefined };
  } catch (err) {
    throw new WorkflowError(
      `mysql_query failed: ${(err as Error).message}`,
      ErrorCategory.CONNECTOR_TRANSIENT,
      true
    );
  } finally {
    await conn.end().catch(() => {
      /* ignore */
    });
  }
}

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

export async function executeMongoOperation(
  config: Record<string, unknown>,
  ctx: Tier1Context
): Promise<unknown> {
  const uriFromConfig = getString(config, "uri");
  const uriFromSecret = await resolveSecretOptional(ctx, config);
  const uri = uriFromSecret || uriFromConfig;
  if (!uri) {
    throw new WorkflowError(
      "mongo_operation: uri (or secretRef) is required",
      ErrorCategory.NODE_CONFIG,
      false
    );
  }
  const database = requireString(config, "database", "mongo_operation");
  const collectionName = requireString(config, "collection", "mongo_operation");
  const operation = requireString(config, "operation", "mongo_operation");

  let factory = ctx.clients?.createMongoClient;
  if (!factory) {
    try {
      const mod = (await import("mongodb")) as unknown as {
        MongoClient: new (uri: string, opts?: unknown) => never;
        default?: { MongoClient: new (uri: string, opts?: unknown) => never };
      };
      const MongoClient = mod.MongoClient ?? mod.default?.MongoClient;
      if (!MongoClient) throw new Error("MongoClient not found");
      factory = (u, o) => new MongoClient(u, o) as never;
    } catch (err) {
      throw new WorkflowError(
        `mongo_operation: 'mongodb' module not available (${(err as Error).message})`,
        ErrorCategory.CONFIGURATION,
        false
      );
    }
  }

  const client = factory(uri);
  await client.connect();
  try {
    const col = client.db(database).collection(collectionName);
    switch (operation) {
      case "find": {
        const query = (config.query as unknown) ?? {};
        const docs = await col.find(query).toArray();
        return { docs };
      }
      case "insert": {
        const doc = config.document as unknown;
        if (Array.isArray(doc)) {
          const result = await col.insertMany(doc);
          return { result };
        }
        const result = await col.insertOne(doc ?? {});
        return { result };
      }
      case "update": {
        const query = (config.query as unknown) ?? {};
        const update = (config.update as unknown) ?? {};
        const many = getBool(config, "many", false);
        const result = many
          ? await col.updateMany(query, update)
          : await col.updateOne(query, update);
        return { result };
      }
      case "aggregate": {
        const pipeline = Array.isArray(config.pipeline) ? (config.pipeline as unknown[]) : [];
        const docs = await col.aggregate(pipeline).toArray();
        return { docs };
      }
      default:
        throw new WorkflowError(
          `mongo_operation: unknown operation '${operation}'`,
          ErrorCategory.NODE_CONFIG,
          false
        );
    }
  } catch (err) {
    if (err instanceof WorkflowError) throw err;
    throw new WorkflowError(
      `mongo_operation failed: ${(err as Error).message}`,
      ErrorCategory.CONNECTOR_TRANSIENT,
      true
    );
  } finally {
    await client.close().catch(() => {
      /* ignore */
    });
  }
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

async function loadRedis(): Promise<(url: string, opts?: unknown) => never> {
  try {
    const mod = (await import("ioredis")) as unknown as {
      default?: new (url: string, opts?: unknown) => never;
      Redis?: new (url: string, opts?: unknown) => never;
    };
    const Redis = mod.default ?? mod.Redis;
    if (!Redis) throw new Error("ioredis not found");
    return ((u: string, o?: unknown) => new Redis(u, o)) as never;
  } catch (err) {
    throw new WorkflowError(
      `redis: 'ioredis' module not available (${(err as Error).message})`,
      ErrorCategory.CONFIGURATION,
      false
    );
  }
}

export async function executeRedisCommand(
  config: Record<string, unknown>,
  ctx: Tier1Context
): Promise<unknown> {
  const url = getString(config, "url", "redis://localhost:6379");
  const command = requireString(config, "command", "redis_command").toUpperCase();
  const rawArgs = Array.isArray(config.args) ? (config.args as unknown[]) : [];
  const args = rawArgs.map((value) => renderIfString(value, ctx.templateData));

  let factory = ctx.clients?.createRedisClient;
  if (!factory) {
    const create = await loadRedis();
    factory = (u, o) => (create as unknown as (u: string, o?: unknown) => never)(u, o) as never;
  }
  const client = factory(url);
  try {
    const result = await client.call(command, ...args);
    return { command, result };
  } catch (err) {
    throw new WorkflowError(
      `redis_command failed: ${(err as Error).message}`,
      ErrorCategory.CONNECTOR_TRANSIENT,
      true
    );
  } finally {
    await client.quit().catch(() => {
      /* ignore */
    });
  }
}

export async function executeRedisTrigger(
  config: Record<string, unknown>,
  ctx: Tier1Context
): Promise<unknown> {
  const mode = getString(config, "mode", "blpop");
  if (mode === "blpop") {
    const url = getString(config, "url", "redis://localhost:6379");
    const key = requireString(config, "key", "redis_trigger");
    const timeout = getNumber(config, "timeoutSeconds", 5);
    let factory = ctx.clients?.createRedisClient;
    if (!factory) {
      const create = await loadRedis();
      factory = (u, o) => (create as unknown as (u: string, o?: unknown) => never)(u, o) as never;
    }
    const client = factory(url);
    try {
      const result = client.blpop
        ? await client.blpop(key, timeout)
        : await client.call("BLPOP", key, String(timeout));
      return { triggered: !!result, result };
    } finally {
      await client.quit().catch(() => {
        /* ignore */
      });
    }
  }
  // subscribe mode isn't a one-shot — the scheduler framework would run this long-lived.
  throw new WorkflowError(
    "redis_trigger: 'subscribe' mode must be run by the long-lived trigger scheduler, not the executor.",
    ErrorCategory.NOT_IMPLEMENTED,
    false
  );
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export async function executeGitHubAction(
  config: Record<string, unknown>,
  ctx: Tier1Context
): Promise<unknown> {
  const owner = requireString(config, "owner", "github_action");
  const repo = requireString(config, "repo", "github_action");
  const operation = requireString(config, "operation", "github_action");
  const token = await resolveSecretOptional(ctx, config);
  if (!token) {
    throw new WorkflowError(
      "github_action: secretRef (personal access token) is required",
      ErrorCategory.NODE_CONFIG,
      false
    );
  }
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "ai-orchestrator"
  };
  const fetchFn = getFetch(ctx);

  const td = ctx.templateData;
  const render = (v: unknown) => (typeof v === "string" ? renderTemplate(v, td) : v);

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const init: RequestInit = {
      method,
      headers: { ...headers, ...(body != null ? { "content-type": "application/json" } : {}) }
    };
    if (body != null) init.body = JSON.stringify(body);
    const res = await fetchFn(`${base}${path}`, init);
    const text = await res.text();
    let json: unknown = text;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    if (!res.ok) {
      throw new WorkflowError(
        `github_action ${operation} failed: ${res.status} ${text}`,
        res.status >= 500 ? ErrorCategory.CONNECTOR_TRANSIENT : ErrorCategory.PROVIDER_AUTH,
        res.status >= 500 || res.status === 429
      );
    }
    return json;
  }

  switch (operation) {
    case "createIssue": {
      const title = render(config.title) as string;
      const body = render(config.body) as string | undefined;
      return call("POST", "/issues", { title, body });
    }
    case "commentIssue": {
      const num = getNumber(config, "issueNumber", 0);
      if (!num) throw new WorkflowError("github_action.commentIssue: issueNumber required", ErrorCategory.NODE_CONFIG, false);
      return call("POST", `/issues/${num}/comments`, { body: render(config.body) });
    }
    case "closeIssue": {
      const num = getNumber(config, "issueNumber", 0);
      if (!num) throw new WorkflowError("github_action.closeIssue: issueNumber required", ErrorCategory.NODE_CONFIG, false);
      return call("PATCH", `/issues/${num}`, { state: "closed" });
    }
    case "createPr": {
      return call("POST", "/pulls", {
        title: render(config.title),
        body: render(config.body),
        head: render(config.head),
        base: render(config.base) ?? "main"
      });
    }
    case "listIssues": {
      return call("GET", "/issues?state=open");
    }
    case "getFile": {
      const path = render(config.path) as string;
      return call("GET", `/contents/${encodeURIComponent(path)}`);
    }
    case "createOrUpdateFile": {
      const path = render(config.path) as string;
      const message = render(config.commitMessage) as string;
      const content = render(config.content) as string;
      const sha = getString(config, "sha") || undefined;
      const branch = getString(config, "branch") || undefined;
      const encoded = Buffer.from(String(content ?? ""), "utf8").toString("base64");
      return call("PUT", `/contents/${encodeURIComponent(path)}`, {
        message,
        content: encoded,
        sha,
        branch
      });
    }
    case "listCommits": {
      return call("GET", "/commits");
    }
    default:
      throw new WorkflowError(
        `github_action: unknown operation '${operation}'`,
        ErrorCategory.NODE_CONFIG,
        false
      );
  }
}

// ---------------------------------------------------------------------------
// Slack/GitHub/IMAP triggers (informational placeholders for executor)
// ---------------------------------------------------------------------------

export function executeSlackTrigger(config: Record<string, unknown>): unknown {
  // The actual signature validation happens in the API layer (apps/api).
  // When the workflow is invoked via the slack webhook endpoint this node
  // simply forwards the parsed payload.
  return {
    triggered: true,
    path: getString(config, "path"),
    note: "Slack signing-secret validation handled in API webhook layer."
  };
}

export function executeGitHubWebhookTrigger(config: Record<string, unknown>): unknown {
  return {
    triggered: true,
    path: getString(config, "path"),
    note: "GitHub X-Hub-Signature-256 validation handled in API webhook layer."
  };
}
