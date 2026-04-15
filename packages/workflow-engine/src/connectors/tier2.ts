/**
 * Phase 3.2 Tier 2 connector executors.
 *
 * Each integration is implemented with a minimal but production-shaped handler
 * that calls the vendor's public HTTPS API. Credentials flow via the standard
 * `secretRef.secretId` pattern and the optional `ctx.fetchImpl` lets tests
 * inject a mock `fetch`.
 *
 * Covers: Microsoft Teams, Notion, Airtable, Jira, Salesforce, HubSpot, Stripe,
 * AWS S3 (SigV4, hand-rolled to avoid an SDK dep), Telegram, Discord, Google
 * Drive trigger polling, Google Calendar, Twilio.
 */
import crypto from "node:crypto";
import { ErrorCategory, WorkflowError } from "@ai-orchestrator/shared";
import type { SecretReference } from "@ai-orchestrator/shared";
import { renderTemplate } from "../template";

export interface Tier2Context {
  templateData: Record<string, unknown>;
  resolveSecret: (ref?: SecretReference) => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  /** Injectable current time for deterministic signing / tests. */
  nowMs?: () => number;
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
  ctx: Tier2Context,
  config: Record<string, unknown>,
  key = "secretRef"
): Promise<string | undefined> {
  const ref = asRecord(config[key]);
  if (typeof ref.secretId !== "string" || !ref.secretId.trim()) return undefined;
  return ctx.resolveSecret({ secretId: ref.secretId.trim() });
}

async function requireSecret(
  ctx: Tier2Context,
  config: Record<string, unknown>,
  nodeLabel: string,
  key = "secretRef"
): Promise<string> {
  const value = await resolveSecretOptional(ctx, config, key);
  if (!value) {
    throw new WorkflowError(
      `${nodeLabel}: a '${key}.secretId' pointing at a valid secret is required.`,
      ErrorCategory.NODE_CONFIG,
      false
    );
  }
  return value;
}

function parseJsonField<T = unknown>(
  raw: string,
  nodeLabel: string,
  fieldName: string,
  fallback: T
): T {
  if (!raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new WorkflowError(
      `${nodeLabel}: '${fieldName}' must be valid JSON (${err instanceof Error ? err.message : "parse error"})`,
      ErrorCategory.NODE_CONFIG,
      false
    );
  }
}

function getFetch(ctx: Tier2Context): typeof fetch {
  return ctx.fetchImpl ?? (globalThis.fetch as typeof fetch);
}

function categorizeHttpError(status: number): ErrorCategory {
  if (status >= 500) return ErrorCategory.CONNECTOR_TRANSIENT;
  if (status === 429) return ErrorCategory.PROVIDER_QUOTA;
  if (status === 401 || status === 403) return ErrorCategory.PROVIDER_AUTH;
  return ErrorCategory.NODE_CONFIG;
}

function throwIfNotOk(
  nodeLabel: string,
  res: { ok: boolean; status: number; statusText?: string },
  body: string
): void {
  if (res.ok) return;
  throw new WorkflowError(
    `${nodeLabel} failed: ${res.status} ${res.statusText ?? ""} ${body.slice(0, 500)}`.trim(),
    categorizeHttpError(res.status),
    res.status >= 500 || res.status === 429
  );
}

async function parseJsonResponse(res: Response, nodeLabel: string): Promise<unknown> {
  const text = await res.text();
  throwIfNotOk(nodeLabel, res, text);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Microsoft Teams
// ---------------------------------------------------------------------------

export async function executeTeamsSendMessage(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "teams_send_message";
  let webhookUrl = getString(config, "webhookUrl").trim();
  if (!webhookUrl) {
    const fromSecret = await resolveSecretOptional(ctx, config);
    if (fromSecret) webhookUrl = fromSecret.trim();
  }
  if (!webhookUrl) {
    throw new WorkflowError(
      `${NODE}: webhookUrl (or secretRef containing the URL) is required.`,
      ErrorCategory.NODE_CONFIG,
      false
    );
  }
  webhookUrl = renderTemplate(webhookUrl, ctx.templateData);
  const text = renderTemplate(getString(config, "text"), ctx.templateData);
  const title = renderTemplate(getString(config, "title"), ctx.templateData);
  const themeColor = getString(config, "themeColor") || "0078D4";
  const cardRaw = getString(config, "cardJson");

  let payload: Record<string, unknown>;
  if (cardRaw.trim()) {
    payload = parseJsonField<Record<string, unknown>>(
      renderTemplate(cardRaw, ctx.templateData),
      NODE,
      "cardJson",
      {}
    );
  } else {
    payload = {
      "@type": "MessageCard",
      "@context": "https://schema.org/extensions",
      themeColor,
      title: title || undefined,
      text
    };
  }
  const fetchFn = getFetch(ctx);
  const res = await fetchFn(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await res.text();
  throwIfNotOk(NODE, res, body);
  return { ok: true, status: res.status };
}

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------

const NOTION_VERSION = "2022-06-28";

function markdownToBlocks(markdown: string): Array<Record<string, unknown>> {
  if (!markdown.trim()) return [];
  const lines = markdown.split(/\r?\n/);
  return lines
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) {
        const level = heading[1].length;
        const type = level === 1 ? "heading_1" : level === 2 ? "heading_2" : "heading_3";
        return {
          object: "block",
          type,
          [type]: {
            rich_text: [{ type: "text", text: { content: heading[2] } }]
          }
        } satisfies Record<string, unknown>;
      }
      return {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: line } }]
        }
      } satisfies Record<string, unknown>;
    });
}

export async function executeNotionCreatePage(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "notion_create_page";
  const token = await requireSecret(ctx, config, NODE);
  const databaseId = requireString(config, "databaseId", NODE);
  const titleProperty = getString(config, "titleProperty", "Name");
  const title = renderTemplate(getString(config, "title"), ctx.templateData);
  const propertiesRaw = renderTemplate(getString(config, "propertiesJson"), ctx.templateData);
  const propertiesInput = parseJsonField<Record<string, unknown>>(propertiesRaw, NODE, "propertiesJson", {});
  const content = renderTemplate(getString(config, "contentMarkdown"), ctx.templateData);

  const properties: Record<string, unknown> = { ...propertiesInput };
  if (title) {
    properties[titleProperty] = {
      title: [{ type: "text", text: { content: title } }]
    };
  }

  const payload: Record<string, unknown> = {
    parent: { database_id: databaseId },
    properties
  };
  const blocks = markdownToBlocks(content);
  if (blocks.length > 0) payload.children = blocks;

  const fetchFn = getFetch(ctx);
  const res = await fetchFn("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  return parseJsonResponse(res, NODE);
}

export async function executeNotionQueryDatabase(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "notion_query_database";
  const token = await requireSecret(ctx, config, NODE);
  const databaseId = requireString(config, "databaseId", NODE);
  const filter = parseJsonField<Record<string, unknown> | null>(
    renderTemplate(getString(config, "filterJson"), ctx.templateData),
    NODE,
    "filterJson",
    null
  );
  const sorts = parseJsonField<unknown[]>(
    renderTemplate(getString(config, "sortsJson"), ctx.templateData),
    NODE,
    "sortsJson",
    []
  );
  const pageSize = getNumber(config, "pageSize", 100);

  const payload: Record<string, unknown> = { page_size: Math.min(100, Math.max(1, pageSize)) };
  if (filter) payload.filter = filter;
  if (Array.isArray(sorts) && sorts.length > 0) payload.sorts = sorts;

  const fetchFn = getFetch(ctx);
  const res = await fetchFn(
    `https://api.notion.com/v1/databases/${encodeURIComponent(databaseId)}/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );
  return parseJsonResponse(res, NODE);
}

// ---------------------------------------------------------------------------
// Airtable
// ---------------------------------------------------------------------------

export async function executeAirtableCreateRecord(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "airtable_create_record";
  const token = await requireSecret(ctx, config, NODE);
  const baseId = requireString(config, "baseId", NODE);
  const table = requireString(config, "table", NODE);
  const fieldsRaw = renderTemplate(getString(config, "fieldsJson"), ctx.templateData);
  const fields = parseJsonField<Record<string, unknown> | unknown[]>(fieldsRaw, NODE, "fieldsJson", {});
  const typecast = getBool(config, "typecast");

  const body = Array.isArray(fields)
    ? { records: fields.map((f) => ({ fields: f })), typecast }
    : { fields, typecast };

  const fetchFn = getFetch(ctx);
  const res = await fetchFn(
    `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
  return parseJsonResponse(res, NODE);
}

export async function executeAirtableListRecords(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "airtable_list_records";
  const token = await requireSecret(ctx, config, NODE);
  const baseId = requireString(config, "baseId", NODE);
  const table = requireString(config, "table", NODE);
  const formula = renderTemplate(getString(config, "filterByFormula"), ctx.templateData);
  const view = getString(config, "view");
  const maxRecords = getNumber(config, "maxRecords", 100);

  const params = new URLSearchParams();
  if (formula) params.set("filterByFormula", formula);
  if (view) params.set("view", view);
  params.set("maxRecords", String(Math.min(100, Math.max(1, maxRecords))));
  const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}?${params.toString()}`;

  const fetchFn = getFetch(ctx);
  const res = await fetchFn(url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` }
  });
  return parseJsonResponse(res, NODE);
}

export async function executeAirtableUpdateRecord(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "airtable_update_record";
  const token = await requireSecret(ctx, config, NODE);
  const baseId = requireString(config, "baseId", NODE);
  const table = requireString(config, "table", NODE);
  const recordId = requireString(config, "recordId", NODE);
  const fieldsRaw = renderTemplate(getString(config, "fieldsJson"), ctx.templateData);
  const fields = parseJsonField<Record<string, unknown>>(fieldsRaw, NODE, "fieldsJson", {});

  const fetchFn = getFetch(ctx);
  const res = await fetchFn(
    `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}/${encodeURIComponent(recordId)}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ fields })
    }
  );
  return parseJsonResponse(res, NODE);
}

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

function jiraAuthHeader(email: string, token: string): string {
  const basic = Buffer.from(`${email}:${token}`, "utf8").toString("base64");
  return `Basic ${basic}`;
}

export async function executeJiraCreateIssue(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "jira_create_issue";
  const baseUrl = requireString(config, "baseUrl", NODE).replace(/\/+$/, "");
  const email = getString(config, "email");
  const token = await requireSecret(ctx, config, NODE);
  const projectKey = requireString(config, "projectKey", NODE);
  const issueType = requireString(config, "issueType", NODE);
  const summary = renderTemplate(requireString(config, "summary", NODE), ctx.templateData);
  const description = renderTemplate(getString(config, "description"), ctx.templateData);
  const extraFields = parseJsonField<Record<string, unknown>>(
    renderTemplate(getString(config, "fieldsJson"), ctx.templateData),
    NODE,
    "fieldsJson",
    {}
  );

  const fields: Record<string, unknown> = {
    project: { key: projectKey },
    issuetype: { name: issueType },
    summary,
    ...extraFields
  };
  if (description) {
    fields.description = {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: description }] }
      ]
    };
  }

  const fetchFn = getFetch(ctx);
  const res = await fetchFn(`${baseUrl}/rest/api/3/issue`, {
    method: "POST",
    headers: {
      authorization: email ? jiraAuthHeader(email, token) : `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({ fields })
  });
  return parseJsonResponse(res, NODE);
}

export async function executeJiraSearchIssues(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "jira_search_issues";
  const baseUrl = requireString(config, "baseUrl", NODE).replace(/\/+$/, "");
  const email = getString(config, "email");
  const token = await requireSecret(ctx, config, NODE);
  const jql = renderTemplate(requireString(config, "jql", NODE), ctx.templateData);
  const maxResults = getNumber(config, "maxResults", 50);

  const fetchFn = getFetch(ctx);
  const res = await fetchFn(`${baseUrl}/rest/api/3/search`, {
    method: "POST",
    headers: {
      authorization: email ? jiraAuthHeader(email, token) : `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({ jql, maxResults })
  });
  return parseJsonResponse(res, NODE);
}

// ---------------------------------------------------------------------------
// Salesforce
// ---------------------------------------------------------------------------

export async function executeSalesforceCreateRecord(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "salesforce_create_record";
  const instanceUrl = requireString(config, "instanceUrl", NODE).replace(/\/+$/, "");
  const apiVersion = getString(config, "apiVersion", "v58.0");
  const token = await requireSecret(ctx, config, NODE);
  const sobject = requireString(config, "sobject", NODE);
  const fields = parseJsonField<Record<string, unknown>>(
    renderTemplate(getString(config, "fieldsJson"), ctx.templateData),
    NODE,
    "fieldsJson",
    {}
  );

  const fetchFn = getFetch(ctx);
  const res = await fetchFn(
    `${instanceUrl}/services/data/${encodeURIComponent(apiVersion)}/sobjects/${encodeURIComponent(sobject)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(fields)
    }
  );
  return parseJsonResponse(res, NODE);
}

export async function executeSalesforceQuery(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "salesforce_query";
  const instanceUrl = requireString(config, "instanceUrl", NODE).replace(/\/+$/, "");
  const apiVersion = getString(config, "apiVersion", "v58.0");
  const token = await requireSecret(ctx, config, NODE);
  const soql = renderTemplate(requireString(config, "soql", NODE), ctx.templateData);

  const url = `${instanceUrl}/services/data/${encodeURIComponent(apiVersion)}/query?q=${encodeURIComponent(soql)}`;
  const fetchFn = getFetch(ctx);
  const res = await fetchFn(url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` }
  });
  return parseJsonResponse(res, NODE);
}

// ---------------------------------------------------------------------------
// HubSpot
// ---------------------------------------------------------------------------

export async function executeHubspotCreateContact(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "hubspot_create_contact";
  const token = await requireSecret(ctx, config, NODE);
  const properties = parseJsonField<Record<string, unknown>>(
    renderTemplate(getString(config, "propertiesJson"), ctx.templateData),
    NODE,
    "propertiesJson",
    {}
  );

  const fetchFn = getFetch(ctx);
  const res = await fetchFn("https://api.hubapi.com/crm/v3/objects/contacts", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ properties })
  });
  return parseJsonResponse(res, NODE);
}

export async function executeHubspotGetContact(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "hubspot_get_contact";
  const token = await requireSecret(ctx, config, NODE);
  const identifier = renderTemplate(requireString(config, "identifier", NODE), ctx.templateData);
  const idProperty = getString(config, "idProperty", "email");

  const url =
    idProperty === "id"
      ? `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(identifier)}`
      : `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(identifier)}?idProperty=${encodeURIComponent(idProperty)}`;
  const fetchFn = getFetch(ctx);
  const res = await fetchFn(url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` }
  });
  return parseJsonResponse(res, NODE);
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

function stripeEncode(form: Record<string, unknown>, prefix = ""): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(form)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item && typeof item === "object") {
          parts.push(...stripeEncode(item as Record<string, unknown>, `${fullKey}[${index}]`));
        } else {
          parts.push(`${encodeURIComponent(`${fullKey}[${index}]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else if (typeof value === "object") {
      parts.push(...stripeEncode(value as Record<string, unknown>, fullKey));
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts;
}

async function stripeRequest(
  ctx: Tier2Context,
  token: string,
  pathname: string,
  form: Record<string, unknown>,
  nodeLabel: string
): Promise<unknown> {
  const body = stripeEncode(form).join("&");
  const fetchFn = getFetch(ctx);
  const res = await fetchFn(`https://api.stripe.com/v1${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
  return parseJsonResponse(res, nodeLabel);
}

export async function executeStripeCreateCustomer(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "stripe_create_customer";
  const token = await requireSecret(ctx, config, NODE);
  const metadata = parseJsonField<Record<string, unknown>>(
    renderTemplate(getString(config, "metadataJson"), ctx.templateData),
    NODE,
    "metadataJson",
    {}
  );
  const form: Record<string, unknown> = {
    email: renderTemplate(getString(config, "email"), ctx.templateData) || undefined,
    name: renderTemplate(getString(config, "name"), ctx.templateData) || undefined,
    description: renderTemplate(getString(config, "description"), ctx.templateData) || undefined,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined
  };
  return stripeRequest(ctx, token, "/customers", form, NODE);
}

export async function executeStripeCreateCharge(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "stripe_create_charge";
  const token = await requireSecret(ctx, config, NODE);
  const amount = getNumber(config, "amount", 0);
  if (amount <= 0) {
    throw new WorkflowError(`${NODE}: amount must be positive (in cents)`, ErrorCategory.NODE_CONFIG, false);
  }
  const currency = requireString(config, "currency", NODE);
  const customerId = getString(config, "customerId");
  const description = renderTemplate(getString(config, "description"), ctx.templateData);
  const metadata = parseJsonField<Record<string, unknown>>(
    renderTemplate(getString(config, "metadataJson"), ctx.templateData),
    NODE,
    "metadataJson",
    {}
  );

  const form: Record<string, unknown> = {
    amount,
    currency,
    customer: customerId || undefined,
    description: description || undefined,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined
  };
  return stripeRequest(ctx, token, "/payment_intents", form, NODE);
}

export function executeStripeWebhookTrigger(config: Record<string, unknown>): unknown {
  return { ok: true, triggerType: "stripe", path: getString(config, "path") };
}

// ---------------------------------------------------------------------------
// AWS S3 — hand-rolled SigV4 to avoid the aws-sdk dependency
// ---------------------------------------------------------------------------

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function parseAwsCredentials(value: string | undefined, nodeLabel: string): AwsCredentials {
  if (!value) {
    throw new WorkflowError(
      `${nodeLabel}: AWS credentials secret is required (JSON with accessKeyId + secretAccessKey).`,
      ErrorCategory.NODE_CONFIG,
      false
    );
  }
  try {
    const parsed = JSON.parse(value) as AwsCredentials;
    if (!parsed.accessKeyId || !parsed.secretAccessKey) throw new Error("missing keys");
    return parsed;
  } catch {
    const colon = value.indexOf(":");
    if (colon > 0) {
      return { accessKeyId: value.slice(0, colon), secretAccessKey: value.slice(colon + 1) };
    }
    throw new WorkflowError(
      `${nodeLabel}: AWS credentials secret must be JSON {accessKeyId, secretAccessKey[, sessionToken]} or 'accessKeyId:secretAccessKey'.`,
      ErrorCategory.NODE_CONFIG,
      false
    );
  }
}

function awsUriEncode(value: string, keepSlash: boolean): string {
  return value
    .split("")
    .map((char) => {
      if (/[A-Za-z0-9_.~-]/.test(char)) return char;
      if (char === "/" && keepSlash) return "/";
      return `%${char
        .charCodeAt(0)
        .toString(16)
        .toUpperCase()
        .padStart(2, "0")}`;
    })
    .join("");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

interface SigV4Options {
  method: string;
  region: string;
  service: string;
  host: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string | Buffer;
  credentials: AwsCredentials;
  nowMs?: () => number;
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
  body: string | Buffer | undefined;
}

function signSigV4(opts: SigV4Options): SignedRequest {
  const now = opts.nowMs ? new Date(opts.nowMs()) : new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = awsUriEncode(opts.path, true) || "/";

  const queryEntries = Object.entries(opts.query ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  const canonicalQuery = queryEntries
    .map(([k, v]) => `${awsUriEncode(k, false)}=${awsUriEncode(v, false)}`)
    .join("&");

  const bodyBuffer = opts.body === undefined ? "" : opts.body;
  const payloadHash = sha256Hex(bodyBuffer);
  const signedHeadersInput: Record<string, string> = {
    host: opts.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...opts.headers
  };
  if (opts.credentials.sessionToken) {
    signedHeadersInput["x-amz-security-token"] = opts.credentials.sessionToken;
  }
  const sortedHeaderNames = Object.keys(signedHeadersInput)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders =
    sortedHeaderNames
      .map((name) => `${name}:${String(signedHeadersInput[name] ?? signedHeadersInput[Object.keys(signedHeadersInput).find((k) => k.toLowerCase() === name)!]).trim()}`)
      .join("\n") + "\n";
  const signedHeaders = sortedHeaderNames.join(";");

  const canonicalRequest = [
    opts.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");

  const credentialScope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join("\n");

  const signingKey = getSignatureKey(opts.credentials.secretAccessKey, dateStamp, opts.region, opts.service);
  const signature = hmac(signingKey, stringToSign).toString("hex");
  const authHeader = `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const outHeaders: Record<string, string> = {
    authorization: authHeader,
    host: opts.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...opts.headers
  };
  if (opts.credentials.sessionToken) {
    outHeaders["x-amz-security-token"] = opts.credentials.sessionToken;
  }

  const url = `https://${opts.host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  return { url, headers: outHeaders, body: opts.body };
}

export async function executeAwsS3PutObject(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "aws_s3_put_object";
  const region = requireString(config, "region", NODE);
  const bucket = requireString(config, "bucket", NODE);
  const key = renderTemplate(requireString(config, "key", NODE), ctx.templateData);
  const contentType = getString(config, "contentType", "application/octet-stream");
  const bodyRaw = renderTemplate(getString(config, "body"), ctx.templateData);
  const credentials = parseAwsCredentials(await resolveSecretOptional(ctx, config), NODE);

  const signed = signSigV4({
    method: "PUT",
    region,
    service: "s3",
    host: `${bucket}.s3.${region}.amazonaws.com`,
    path: `/${awsUriEncode(key, true)}`,
    headers: { "content-type": contentType },
    body: bodyRaw,
    credentials,
    nowMs: ctx.nowMs
  });

  const fetchFn = getFetch(ctx);
  const res = await fetchFn(signed.url, {
    method: "PUT",
    headers: signed.headers,
    body: bodyRaw
  });
  const text = await res.text();
  throwIfNotOk(NODE, res, text);
  return { ok: true, status: res.status, etag: res.headers.get("etag") ?? undefined, key };
}

export async function executeAwsS3GetObject(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "aws_s3_get_object";
  const region = requireString(config, "region", NODE);
  const bucket = requireString(config, "bucket", NODE);
  const key = renderTemplate(requireString(config, "key", NODE), ctx.templateData);
  const credentials = parseAwsCredentials(await resolveSecretOptional(ctx, config), NODE);

  const signed = signSigV4({
    method: "GET",
    region,
    service: "s3",
    host: `${bucket}.s3.${region}.amazonaws.com`,
    path: `/${awsUriEncode(key, true)}`,
    credentials,
    nowMs: ctx.nowMs
  });

  const fetchFn = getFetch(ctx);
  const res = await fetchFn(signed.url, { method: "GET", headers: signed.headers });
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok) {
    const text = await res.text();
    throwIfNotOk(NODE, res, text);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const isText = /^text\//i.test(contentType) || /application\/(json|xml)/i.test(contentType);
  return {
    ok: true,
    status: res.status,
    contentType,
    body: isText ? buffer.toString("utf8") : buffer.toString("base64"),
    encoding: isText ? "utf8" : "base64",
    size: buffer.length
  };
}

export async function executeAwsS3ListObjects(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "aws_s3_list_objects";
  const region = requireString(config, "region", NODE);
  const bucket = requireString(config, "bucket", NODE);
  const prefix = getString(config, "prefix");
  const maxKeys = getNumber(config, "maxKeys", 1000);
  const credentials = parseAwsCredentials(await resolveSecretOptional(ctx, config), NODE);

  const query: Record<string, string> = {
    "list-type": "2",
    "max-keys": String(Math.min(1000, Math.max(1, maxKeys)))
  };
  if (prefix) query.prefix = prefix;

  const signed = signSigV4({
    method: "GET",
    region,
    service: "s3",
    host: `${bucket}.s3.${region}.amazonaws.com`,
    path: "/",
    query,
    credentials,
    nowMs: ctx.nowMs
  });

  const fetchFn = getFetch(ctx);
  const res = await fetchFn(signed.url, { method: "GET", headers: signed.headers });
  const text = await res.text();
  throwIfNotOk(NODE, res, text);
  // S3 ListObjectsV2 returns XML — minimal parser for <Contents><Key>...<Size>...<LastModified>...
  const items: Array<{ key: string; size: number; lastModified: string }> = [];
  const regex = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    const block = match[1];
    const k = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1] ?? "";
    const size = Number(/<Size>([\s\S]*?)<\/Size>/.exec(block)?.[1] ?? 0);
    const lastModified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1] ?? "";
    items.push({ key: k, size, lastModified });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(text);
  return { ok: true, items, truncated, count: items.length };
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

export async function executeTelegramSendMessage(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "telegram_send_message";
  const token = await requireSecret(ctx, config, NODE);
  const chatId = renderTemplate(requireString(config, "chatId", NODE), ctx.templateData);
  const text = renderTemplate(requireString(config, "text", NODE), ctx.templateData);
  const parseMode = getString(config, "parseMode");
  const disableWebPagePreview = getBool(config, "disableWebPagePreview");

  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  if (disableWebPagePreview) body.disable_web_page_preview = true;

  const fetchFn = getFetch(ctx);
  const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return parseJsonResponse(res, NODE);
}

export function executeTelegramTrigger(config: Record<string, unknown>): unknown {
  return { ok: true, triggerType: "telegram", path: getString(config, "path") };
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

export async function executeDiscordSendMessage(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "discord_send_message";
  const webhookUrl = renderTemplate(getString(config, "webhookUrl"), ctx.templateData);
  const token = await resolveSecretOptional(ctx, config);
  const content = renderTemplate(getString(config, "content"), ctx.templateData);
  const username = renderTemplate(getString(config, "username"), ctx.templateData);
  const embeds = parseJsonField<unknown[]>(
    renderTemplate(getString(config, "embedsJson"), ctx.templateData),
    NODE,
    "embedsJson",
    []
  );

  const body: Record<string, unknown> = {};
  if (content) body.content = content;
  if (username) body.username = username;
  if (Array.isArray(embeds) && embeds.length > 0) body.embeds = embeds;

  const fetchFn = getFetch(ctx);
  if (webhookUrl) {
    const res = await fetchFn(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    throwIfNotOk(NODE, res, text);
    return { ok: true, status: res.status };
  }
  // Bot token path would need a channel id; we do not take one here — reject explicitly.
  if (token) {
    throw new WorkflowError(
      `${NODE}: bot token flow requires a webhookUrl (channel-based bot send is not supported yet).`,
      ErrorCategory.NODE_CONFIG,
      false
    );
  }
  throw new WorkflowError(
    `${NODE}: webhookUrl (or secretRef) is required.`,
    ErrorCategory.NODE_CONFIG,
    false
  );
}

export function executeDiscordTrigger(config: Record<string, unknown>): unknown {
  return {
    ok: true,
    triggerType: "discord",
    path: getString(config, "path"),
    publicKey: getString(config, "publicKey")
  };
}

// ---------------------------------------------------------------------------
// Google Drive polling trigger
// ---------------------------------------------------------------------------

export async function executeGoogleDriveTrigger(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "google_drive_trigger";
  const token = await requireSecret(ctx, config, NODE);
  const folderId = requireString(config, "folderId", NODE);
  const customQuery = getString(config, "query");
  const q = customQuery
    ? customQuery
    : `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`;
  const params = new URLSearchParams();
  params.set("q", q);
  params.set("fields", "files(id,name,mimeType,modifiedTime,md5Checksum,size,parents,webViewLink)");
  params.set("pageSize", "100");

  const fetchFn = getFetch(ctx);
  const res = await fetchFn(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` }
  });
  return parseJsonResponse(res, NODE);
}

// ---------------------------------------------------------------------------
// Google Calendar
// ---------------------------------------------------------------------------

export async function executeGoogleCalendarCreateEvent(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "google_calendar_create_event";
  const token = await requireSecret(ctx, config, NODE);
  const calendarId = requireString(config, "calendarId", NODE);
  const summary = renderTemplate(requireString(config, "summary", NODE), ctx.templateData);
  const description = renderTemplate(getString(config, "description"), ctx.templateData);
  const start = requireString(config, "start", NODE);
  const end = requireString(config, "end", NODE);
  const timeZone = getString(config, "timeZone", "UTC");
  const attendeesCsv = getString(config, "attendeesCsv");
  const attendees = attendeesCsv
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean)
    .map((email) => ({ email }));

  const body: Record<string, unknown> = {
    summary,
    description: description || undefined,
    start: { dateTime: start, timeZone },
    end: { dateTime: end, timeZone }
  };
  if (attendees.length > 0) body.attendees = attendees;

  const fetchFn = getFetch(ctx);
  const res = await fetchFn(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
  return parseJsonResponse(res, NODE);
}

export async function executeGoogleCalendarListEvents(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "google_calendar_list_events";
  const token = await requireSecret(ctx, config, NODE);
  const calendarId = requireString(config, "calendarId", NODE);
  const timeMin = getString(config, "timeMin");
  const timeMax = getString(config, "timeMax");
  const q = renderTemplate(getString(config, "q"), ctx.templateData);
  const maxResults = getNumber(config, "maxResults", 25);

  const params = new URLSearchParams();
  if (timeMin) params.set("timeMin", timeMin);
  if (timeMax) params.set("timeMax", timeMax);
  if (q) params.set("q", q);
  params.set("maxResults", String(Math.min(2500, Math.max(1, maxResults))));
  params.set("singleEvents", "true");
  params.set("orderBy", "startTime");

  const fetchFn = getFetch(ctx);
  const res = await fetchFn(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${token}` }
    }
  );
  return parseJsonResponse(res, NODE);
}

// ---------------------------------------------------------------------------
// Twilio SMS
// ---------------------------------------------------------------------------

export async function executeTwilioSendSms(
  config: Record<string, unknown>,
  ctx: Tier2Context
): Promise<unknown> {
  const NODE = "twilio_send_sms";
  const accountSid = requireString(config, "accountSid", NODE);
  const token = await requireSecret(ctx, config, NODE);
  const from = renderTemplate(requireString(config, "from", NODE), ctx.templateData);
  const to = renderTemplate(requireString(config, "to", NODE), ctx.templateData);
  const body = renderTemplate(requireString(config, "body", NODE), ctx.templateData);

  const form = new URLSearchParams();
  form.set("From", from);
  form.set("To", to);
  form.set("Body", body);

  const basic = Buffer.from(`${accountSid}:${token}`, "utf8").toString("base64");
  const fetchFn = getFetch(ctx);
  const res = await fetchFn(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    }
  );
  return parseJsonResponse(res, NODE);
}
