// Backup and restore drill (roadmap 13.1). Proves that a backup taken from a populated L2M instance restores to a
// working instance, with every backup method the runbook documents (apps/docs/docs/operations/backup-and-recovery.md):
//
//   1. Starts the API on a temporary database and populates it through the public API only: users (one with MFA),
//      a secret, MCP servers, workflows, finished runs, a release, a guard profile, a knowledge base, a signed run
//      manifest, a run paused for approval, an agent paused on its second write-tool approval (the first write's
//      result sealed with the master key), and the audit rows all of that writes.
//   2. Takes a backup with each method, then restores each into a fresh instance (new database, new port):
//        SQLite:   online backup (SQLite's backup API, API running) · file copy (API stopped) · db:export / db:import
//                  · db:import with a new master key (--source-master-key-file) · a lost master key
//        Postgres: pg_dump / pg_restore (API running) · db:export / db:import · db:copy from the SQLite backup
//                  · point-in-time recovery from a base backup and archived WAL (DR_DRILL_PITR)
//   3. Verifies every restored instance: password and MFA logins work, the secret decrypts (a run sends it to a local
//      echo server, which only reports whether it matched), users, workflows, runs, secrets, MCP servers, releases,
//      guard profiles, knowledge bases and the pending approvals match, every audit row of the backup is there and
//      the chain verifies, the stored manifest is unchanged and a run signed after the restore verifies offline with
//      the public key from before the backup, the paused run can be approved and finishes, and approving the agent
//      runs its second write only (the first is answered from its sealed result), also after a key rotation.
//   4. Prints the measured backup and restore times. Any mismatch fails the drill with a diff (exit 1).
//
//   node scripts/dr-drill.mjs [--only sqlite|postgres] [--keep] [--summary <file.json>]
//
// DR_DRILL_RUNS=<n> gives the source n finished runs instead of 3, to measure times on a bigger database.
//
// Postgres runs when DR_DRILL_POSTGRES_URL (or TEST_POSTGRES_URL, as the API tests use) points at a server where the
// role can create databases; DR_DRILL_REQUIRE_POSTGRES=true fails instead of skipping without one. The drill creates
// and drops its own databases (l2m_drill_*). Point-in-time recovery runs its own throwaway Postgres cluster
// (initdb/pg_ctl from DR_DRILL_PG_BIN, or found on the system) when DR_DRILL_PITR=true.
//
// Random free ports only (never 4000, 4100, 5173 or 5199). The master keys, passwords and the secret value are
// generated per run and never printed; each instance's log stays in the work directory (--keep keeps it).
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = path.join(repoRoot, "apps", "api");
const requireFromApi = createRequire(path.join(apiDir, "package.json"));
const Database = requireFromApi("better-sqlite3");
const pg = requireFromApi("pg");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const only = option("--only");
if (only !== undefined && only !== "sqlite" && only !== "postgres") {
  console.error("--only must be sqlite or postgres");
  process.exit(2);
}
const keep = flag("--keep");
const summaryFile = option("--summary");
const truthy = (value) => /^(1|true|yes)$/i.test(value ?? "");
const postgresUrl = process.env.DR_DRILL_POSTGRES_URL || process.env.TEST_POSTGRES_URL || "";
const requirePostgres = truthy(process.env.DR_DRILL_REQUIRE_POSTGRES);
const runPitr = truthy(process.env.DR_DRILL_PITR);
// Finished runs the source gets (default 3); raise it to measure backup and restore times on a bigger database.
const extraRuns = Math.max(3, Number(process.env.DR_DRILL_RUNS ?? 3) || 3);
const RESERVED_PORTS = new Set([4000, 4100, 5173, 5199]);

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-dr-drill-"));
const results = [];
const failures = [];
const cleanups = [];

// The API loads apps/api/.env over the environment (env-files.ts), which would point the drill's instances at your
// own database. Refuse rather than guess; the drill never reads the file's values.
const DRILL_KEYS = ["DB_TYPE", "DB_SQLITE_PATH", "DB_POSTGRESDB_URL", "SECRET_MASTER_KEY_BASE64", "API_PORT", "BOOTSTRAP_ADMIN_EMAIL", "BOOTSTRAP_ADMIN_PASSWORD"];
const apiEnvFile = path.join(apiDir, ".env");
if (fs.existsSync(apiEnvFile)) {
  const set = fs
    .readFileSync(apiEnvFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*export\s+/, "").split("=")[0]?.trim())
    .filter((key) => DRILL_KEYS.includes(key));
  if (set.length > 0) {
    console.error(`apps/api/.env sets ${set.join(", ")}, which would override the drill's settings. Move it aside while the drill runs.`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

const log = (line = "") => console.log(line);
const randomKey = () => crypto.randomBytes(32).toString("base64");
const seconds = (ms) => `${(ms / 1000).toFixed(2)} s`;
const fileSize = (file) => (fs.existsSync(file) ? fs.statSync(file).size : 0);
const kib = (bytes) => `${(bytes / 1024).toFixed(0)} KiB`;

class DrillFailure extends Error {}

async function freePort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port: picked } = server.address();
        server.close(() => resolve(picked));
      });
    });
    if (!RESERVED_PORTS.has(port)) return port;
  }
}

async function timed(fn) {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
}

/** `text` with the password of any URL in it replaced by ***. */
const redact = (text) => String(text).replace(/(\/\/[^:/@\s]+):[^@\s]+@/g, "$1:***@");

/**
 * A Postgres URL for a client tool: the URL without its password (for --dbname / -d) and the password as PGPASSWORD
 * for the child's environment, so it never appears in argv, the process list or an error message.
 */
function pgConnection(url) {
  const parsed = new URL(url);
  const password = decodeURIComponent(parsed.password);
  parsed.password = "";
  return { dbname: parsed.toString(), env: { ...process.env, ...(password ? { PGPASSWORD: password } : {}) } };
}

/** Runs a command; resolves with its output, rejects with the output's tail, URLs' passwords redacted. */
function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: options.cwd ?? repoRoot, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 || (options.allowFailure && code !== null)) resolve({ code, output });
      else reject(new DrillFailure(redact(`${path.basename(command)} ${commandArgs.join(" ")} exited ${code}:\n${output.trim().split("\n").slice(-25).join("\n")}`)));
    });
  });
}

/** The environment a child process gets: PATH and friends only, so nothing from the caller's shell leaks into an instance. */
function baseEnv(extra) {
  const keepKeys = ["PATH", "HOME", "TMPDIR", "LANG", "SystemRoot", "PNPM_HOME", "COREPACK_HOME", "XDG_CACHE_HOME", "NODE_OPTIONS"];
  const env = {};
  for (const key of keepKeys) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...extra };
}

/** pnpm --filter @ai-orchestrator/api <script> -- <args>, as an operator runs it. */
function apiScript(script, scriptArgs, env) {
  return run("pnpm", ["--silent", "--filter", "@ai-orchestrator/api", script, "--", ...scriptArgs], { env: baseEnv(env) });
}

// TOTP (RFC 6238: SHA-1, 6 digits, 30 s), as mfa-service.ts checks it.
function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
function totp(base32Secret) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hmac = crypto.createHmac("sha1", base32Decode(base32Secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

// ---------------------------------------------------------------------------------------------------------------
// The echo server the secret-check workflow calls: it answers whether the bearer token is the secret, never the token.

const SECRET_VALUE = `drill-${crypto.randomBytes(18).toString("hex")}`;
let echoUrl = "";
const echo = createServer((request, response) => {
  const authorized = request.headers.authorization === `Bearer ${SECRET_VALUE}`;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ authorized }));
});

// A chat model and an MCP server with one write tool, for the agent whose approved write result is sealed in its
// paused state (see agentWorkflow). The model asks to write a@, then b@, then answers; the tool records each write.

let fakeModelUrl = "";
let fakeMcpUrl = "";
const writeCalls = [];
const readJson = (request) =>
  new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
const fakeModel = createServer(async (request, response) => {
  const body = await readJson(request);
  const done = (body.messages ?? []).filter((message) => message.role === "tool").length;
  const email = done === 0 ? "a@example.org" : done === 1 ? "b@example.org" : "";
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: email ? "" : "All done.",
            tool_calls: email ? [{ id: `call-${done}`, type: "function", function: { name: "http_mcp__write_record", arguments: JSON.stringify({ email }) } }] : []
          }
        }
      ]
    })
  );
});
const fakeMcp = createServer(async (request, response) => {
  const rpc = await readJson(request);
  response.setHeader("content-type", "application/json");
  let result = {};
  if (rpc.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: {} };
  else if (rpc.method === "tools/list") {
    result = { tools: [{ name: "write_record", description: "Write a record", inputSchema: { type: "object", properties: { email: { type: "string" } } } }] };
  } else if (rpc.method === "tools/call") {
    const email = String(rpc.params?.arguments?.email ?? "");
    writeCalls.push(email);
    const structured = { written: email };
    result = { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
  }
  response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }));
});

// ---------------------------------------------------------------------------------------------------------------
// API instances

const ADMIN = { email: "admin@drill.example.com", password: `Adm-${crypto.randomBytes(12).toString("hex")}` };
const MFA_USER = { email: "mfa-builder@drill.example.com", password: `Mfa-${crypto.randomBytes(12).toString("hex")}`, role: "builder" };
const OPERATOR = { email: "operator@drill.example.com", password: `Op-${crypto.randomBytes(12).toString("hex")}`, role: "operator" };

class Api {
  constructor(name, settings) {
    this.name = name;
    this.settings = settings;
    this.dir = path.join(workDir, name);
    fs.mkdirSync(this.dir, { recursive: true });
    this.logFile = path.join(this.dir, "api.log");
  }

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Starts the API and waits for /health; returns the time to healthy. */
  async start() {
    this.port = await freePort();
    const env = baseEnv({
      API_HOST: "127.0.0.1",
      API_PORT: String(this.port),
      LOG_LEVEL: "warn",
      SECRET_MASTER_KEY_BASE64: this.settings.masterKey,
      BOOTSTRAP_ADMIN_EMAIL: ADMIN.email,
      BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
      RATE_LIMIT_ENABLED: "false",
      MCP_PROBE_INTERVAL_MS: "0",
      GIT_SYNC_WORKDIR: path.join(this.dir, "git"),
      SEED_SAMPLE_WORKFLOWS: "false",
      ...this.settings.dbEnv
    });
    const out = fs.openSync(this.logFile, "a");
    this.child = spawn(path.join(apiDir, "node_modules", ".bin", "tsx"), ["src/index.ts"], { cwd: apiDir, env, stdio: ["ignore", out, out] });
    fs.closeSync(out);
    this.exited = new Promise((resolve) => this.child.once("exit", (code) => resolve(code)));
    const started = performance.now();
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const exited = await Promise.race([this.exited, new Promise((resolve) => setTimeout(() => resolve(undefined), 250))]);
      if (exited !== undefined) throw new DrillFailure(`${this.name}: the API exited (${exited}) before it was healthy:\n${this.logTail()}`);
      try {
        const response = await fetch(`${this.url}/health`);
        if (response.ok) {
          this.jar = new Map();
          return performance.now() - started;
        }
      } catch {
        // Not listening yet.
      }
    }
    throw new DrillFailure(`${this.name}: no /health within 180 s:\n${this.logTail()}`);
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill("SIGTERM");
    const code = await Promise.race([this.exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 30_000))]);
    if (code === "timeout") {
      this.child.kill("SIGKILL");
      await this.exited;
    }
  }

  logTail() {
    return fs.existsSync(this.logFile) ? fs.readFileSync(this.logFile, "utf8").trim().split("\n").slice(-30).join("\n") : "(no log)";
  }

  /** A request as `who` (a cookie per user); returns { status, body }. */
  async call(who, method, url, body) {
    const headers = { accept: "application/json" };
    const cookie = this.jar.get(who);
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${this.url}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    const session = setCookie.find((value) => value.startsWith("ao_session="));
    if (session) this.jar.set(who, session.split(";")[0]);
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  }

  async ok(who, method, url, body) {
    const response = await this.call(who, method, url, body);
    if (response.status < 200 || response.status >= 300) {
      throw new DrillFailure(`${this.name}: ${method} ${url} as ${who} answered ${response.status}: ${JSON.stringify(response.body).slice(0, 400)}`);
    }
    return response.body;
  }

  /** Password login, then the TOTP step when the user has MFA. */
  async login(user, totpSecret) {
    const first = await this.ok(user.email, "POST", "/api/auth/login", { email: user.email, password: user.password });
    if (first.mfaChallenge) {
      if (!totpSecret) throw new DrillFailure(`${this.name}: ${user.email} got an MFA challenge the drill cannot answer`);
      await this.ok(user.email, "POST", "/api/auth/login/mfa", { challenge: first.mfaChallenge, code: totp(totpSecret) });
    }
    return first;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Population, snapshot and verification

const node = (id, type, config = {}) => ({ id, type, name: id, position: { x: 0, y: 0 }, config });

function secretWorkflow(secretId) {
  return {
    id: "wf-drill-secret",
    name: "Drill: call the echo server with the secret",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      node("hook", "webhook_input", { path: "drill-secret", method: "POST" }),
      node("call", "http_request", { method: "GET", urlTemplate: echoUrl, secretRef: { secretId }, responseType: "json" }),
      node("out", "output")
    ],
    edges: [
      { id: "e1", source: "hook", target: "call" },
      { id: "e2", source: "call", target: "out" }
    ]
  };
}

const APPROVAL_WORKFLOW = {
  id: "wf-drill-approval",
  name: "Drill: paused for approval",
  schemaVersion: "1.0.0",
  workflowVersion: 1,
  nodes: [
    node("hook", "webhook_input", { path: "drill-approval", method: "POST" }),
    node("approve", "human_approval", { approvalMessage: "Restore drill: approve?", timeoutMinutes: 10080 }),
    node("out", "output")
  ],
  edges: [
    { id: "e1", source: "hook", target: "approve" },
    { id: "e2", source: "approve", target: "out" }
  ]
};

/**
 * An agent with a write tool that needs approval (settings.writeToolApproval): the model asks to write a@, then b@,
 * then answers. Approving the first write runs it and pauses on the second with the first result sealed in the run's
 * state (with the master key). Approving the second after a restore must answer the first from that sealed result:
 * the write tool must see b@ only.
 */
function agentWorkflow(serverId) {
  return {
    id: "wf-drill-agent",
    name: "Drill: agent with an approved write tool",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    settings: { writeToolApproval: { enabled: true, approverRoles: ["admin"], timeoutMinutes: 10080 } },
    nodes: [
      node("in", "manual_trigger"),
      node("agent", "agent_orchestrator", { userPromptTemplate: "write the records", maxIterations: 6, toolCallingEnabled: true }),
      node("model", "llm_call", { provider: { providerId: "openai", model: "drill", baseUrl: fakeModelUrl, extra: { apiKey: "drill-not-a-key", maxRetries: 0 } } }),
      node("tool", "mcp_tool", { registryServerId: serverId, toolName: "__all__" }),
      node("out", "output")
    ],
    edges: [
      { id: "e1", source: "in", target: "agent" },
      { id: "e2", source: "agent", target: "out" },
      { id: "e3", source: "agent", sourceHandle: "chat_model", target: "model" },
      { id: "e4", source: "agent", sourceHandle: "tool", target: "tool" }
    ]
  };
}

const GUARD_PROFILE = {
  id: "drill-guard",
  name: "Drill guard profile",
  version: "1",
  channels: { prompt: { detectors: [{ id: "dlp.patterns", threshold: 0.5 }], actions: { email: { action: "mask" } }, defaultAction: { action: "allow" } } }
};

/** Runs the secret-check workflow; true when the echo server saw the right bearer token. */
async function secretRunAuthorized(api) {
  const result = await api.call(ADMIN.email, "POST", "/api/workflows/wf-drill-secret/execute", { user_prompt: "drill" });
  const call = result.body?.nodeResults?.find((entry) => entry.nodeId === "call");
  const authorized = JSON.stringify(call?.output ?? {}).includes('"authorized":true');
  return { authorized, status: result.body?.status, error: result.body?.error ?? call?.error, executionId: result.body?.executionId };
}

/** Waits until run `id` reaches one of `statuses` (a resume may be queued); returns the status it ended in. */
async function waitForRun(api, id, statuses, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = (await api.call(ADMIN.email, "GET", `/api/executions/${id}`)).body?.status;
    if (statuses.includes(status) || Date.now() > deadline) return status;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Approves the pending request of run `id` as the admin; returns the status the run reaches next. */
async function approveRun(api, id, until) {
  const pending = (await api.ok(ADMIN.email, "GET", "/api/approvals")).items.find((item) => item.executionId === id);
  if (!pending) return "no pending request";
  const decided = await api.call(ADMIN.email, "POST", `/api/approvals/${id}/approve`, { requestId: pending.requestId });
  if (decided.status !== 200 && decided.status !== 202) return `refused (${decided.status}: ${JSON.stringify(decided.body).slice(0, 200)})`;
  // The resume may be queued: the run stays waiting_approval until it runs, so wait for a final status or for a new
  // request on the same run (the next pause).
  const deadline = Date.now() + 60_000;
  for (;;) {
    const status = (await api.call(ADMIN.email, "GET", `/api/executions/${id}`)).body?.status;
    if (status !== "waiting_approval" && status !== "running" && status !== "queued" && until.includes(status)) return status;
    const next = (await api.ok(ADMIN.email, "GET", "/api/approvals")).items.find((item) => item.executionId === id && item.requestId !== pending.requestId);
    if (next && status === "waiting_approval" && until.includes(status)) return status;
    if (Date.now() > deadline) return status ?? "unknown";
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function populate(api) {
  await api.login(ADMIN);
  for (const user of [MFA_USER, OPERATOR]) {
    await api.ok(ADMIN.email, "POST", "/api/auth/register", { email: user.email, password: user.password, role: user.role });
  }
  await api.login(MFA_USER);
  const enrollment = await api.ok(MFA_USER.email, "POST", "/api/auth/mfa/enroll", {});
  const mfaSecret = enrollment.secret;
  await api.ok(MFA_USER.email, "POST", "/api/auth/mfa/activate", { code: totp(mfaSecret) });
  await api.login(OPERATOR);

  const secret = await api.ok(ADMIN.email, "POST", "/api/secrets", { name: "DRILL_ECHO_TOKEN", provider: "custom", value: SECRET_VALUE });
  await api.ok(ADMIN.email, "POST", "/api/mcp/servers", { name: "Drill MCP server", adapterId: "mock-mcp", probeEnabled: false });
  const writeServer = await api.ok(ADMIN.email, "POST", "/api/mcp/servers", {
    name: "Drill write tool",
    adapterId: "http_mcp",
    probeEnabled: false,
    connection: { endpoint: fakeMcpUrl }
  });
  await api.ok(ADMIN.email, "POST", "/api/workflows", secretWorkflow(secret.id));
  await api.ok(ADMIN.email, "POST", "/api/workflows", APPROVAL_WORKFLOW);
  await api.ok(ADMIN.email, "POST", "/api/workflows", agentWorkflow(writeServer.server.id));
  const runIds = [];
  for (let i = 0; i < extraRuns; i += 1) {
    const run = await secretRunAuthorized(api);
    if (!run.authorized) throw new DrillFailure(`populate: the secret-check run did not authorize (${run.status}: ${run.error ?? ""})`);
    runIds.push(run.executionId);
  }
  // A release (production pinned to version 1), a guard profile and a knowledge base: tables db:export once missed.
  await api.ok(ADMIN.email, "POST", "/api/workflows/wf-drill-secret/publish", { version: 1 });
  await api.ok(ADMIN.email, "POST", "/api/guard/profiles", { document: GUARD_PROFILE });
  const kb = await api.ok(ADMIN.email, "POST", "/api/knowledge-bases", { name: "Drill corpus", embedderId: "token-embedder", embedderConfig: {} });
  await api.ok(ADMIN.email, "POST", `/api/knowledge-bases/${kb.knowledgeBase.id}/ingest`, {
    sourceId: "drill-faq",
    documents: [{ content: "To restore a backup, stop the API first." }, { content: "Keep the master key apart from the backups." }]
  });
  // A signed run manifest (this generates the audit signing key, stored as an encrypted secret). The second run is
  // left without one: after a restore, signing it proves the restored key can be decrypted and is the same key.
  const manifest = await api.ok(ADMIN.email, "GET", `/api/executions/${runIds[0]}/manifest`);
  const signingKeys = await api.ok(ADMIN.email, "GET", "/api/audit/signing-keys");
  const signingKey = signingKeys.keys.find((key) => key.keyId === signingKeys.activeKeyId);

  const paused = await api.ok(ADMIN.email, "POST", "/api/workflows/wf-drill-approval/execute", { user_prompt: "drill" });
  if (paused.status !== "waiting_approval") throw new DrillFailure(`populate: the approval run is ${paused.status}, not waiting_approval`);
  // The agent: the first write approved and run, paused on the second with the first result sealed.
  const writesBefore = writeCalls.length;
  const agent = await api.ok(MFA_USER.email, "POST", "/api/workflows/wf-drill-agent/execute", {});
  if (agent.status !== "waiting_approval") throw new DrillFailure(`populate: the agent run is ${agent.status}, not waiting_approval`);
  const second = await approveRun(api, agent.executionId, ["waiting_approval", "success", "error"]);
  const writes = writeCalls.slice(writesBefore);
  if (second !== "waiting_approval" || writes.join(",") !== "a@example.org") {
    throw new DrillFailure(`populate: after the first approval the agent run is ${second} and the write tool saw ${JSON.stringify(writes)}`);
  }
  return {
    mfaSecret,
    approvalRunId: paused.executionId,
    agentRunId: agent.executionId,
    manifestRunId: runIds[0],
    manifestDigest: manifest.digest,
    unsignedRunId: runIds[1],
    signingKeyId: signingKey.keyId,
    signingPublicKey: signingKey.publicKey
  };
}

/** Every item of a paged listing (`items` + `total`), whatever page size the server clamps to. */
async function allItems(api, url) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const body = await api.ok(ADMIN.email, "GET", `${url}${url.includes("?") ? "&" : "?"}page=${page}&pageSize=200`);
    const batch = body.items ?? [];
    items.push(...batch);
    if (batch.length === 0 || (typeof body.total === "number" && items.length >= body.total)) return items;
  }
}

const listOf = (body, ...keys) => (Array.isArray(body) ? body : keys.map((key) => body?.[key]).find(Array.isArray) ?? []);

/** What a restored instance must hold. Read as the admin, who sees everything. */
async function snapshot(api) {
  const users = (await api.ok(ADMIN.email, "GET", "/api/users")).users.map((user) => `${user.email}:${user.role}`).sort();
  const workflows = (await api.ok(ADMIN.email, "GET", "/api/workflows")).map((workflow) => workflow.id).sort();
  const runs = (await allItems(api, "/api/executions")).map((run) => `${run.id}:${run.status}`).sort();
  const secrets = listOf(await api.ok(ADMIN.email, "GET", "/api/secrets"), "secrets", "items").map((secret) => `${secret.id}:${secret.name}`).sort();
  const mcpServers = (await api.ok(ADMIN.email, "GET", "/api/mcp/servers")).servers.map((server) => `${server.id}:${server.name}`).sort();
  const approvals = (await api.ok(ADMIN.email, "GET", "/api/approvals")).items.map((item) => `${item.executionId}:${item.requestId}:${item.status}`).sort();
  const releaseBody = await api.ok(ADMIN.email, "GET", "/api/workflows/wf-drill-secret/releases");
  const releases = [`published:${releaseBody.publishedVersion}`, ...releaseBody.releases.map((release) => `${release.id ?? release.version}:${release.version}:${release.verdict}`)].sort();
  const guardProfiles = listOf(await api.ok(ADMIN.email, "GET", "/api/guard/profiles"), "profiles", "items").map((profile) => `${profile.id}:${profile.version ?? profile.currentVersion ?? ""}`).sort();
  const knowledgeBases = listOf(await api.ok(ADMIN.email, "GET", "/api/knowledge-bases"), "knowledgeBases", "items").map((kb) => `${kb.id}:${kb.name}:${kb.chunkCount}`).sort();
  const chain = await api.ok(ADMIN.email, "GET", "/api/audit-log/verify-chain");
  const auditIds = (await allItems(api, "/api/audit")).map((entry) => entry.id);
  return { users, workflows, runs, secrets, mcpServers, approvals, releases, guardProfiles, knowledgeBases, chain, auditIds };
}

function listDiff(label, expected, actual) {
  const missing = expected.filter((item) => !actual.includes(item));
  const extra = actual.filter((item) => !expected.includes(item));
  if (missing.length === 0 && extra.length === 0) return [];
  return [`${label}: missing ${JSON.stringify(missing)}, unexpected ${JSON.stringify(extra)}`];
}

function chainText(chain) {
  const unverifiable = chain.unverifiable?.length ?? 0;
  return chain.ok ? `intact (${chain.rowsChecked} rows${unverifiable ? `, ${unverifiable} unverifiable` : ""})` : `BROKEN at ${chain.firstBrokenAt?.id}`;
}

/** Downloads run `id`'s audit bundle and verifies it offline with `l2m audit verify` against `publicKey`. */
async function bundleVerifies(api, id, publicKey) {
  const response = await fetch(`${api.url}/api/executions/${id}/bundle`, { headers: { cookie: api.jar.get(ADMIN.email) ?? "" } });
  if (!response.ok) return `the bundle answered ${response.status}: ${(await response.text()).slice(0, 200)}`;
  const file = path.join(api.dir, `bundle-${id}.zip`);
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  const verified = await run(process.execPath, [path.join(repoRoot, "packages", "cli", "bin", "l2m.mjs"), "audit", "verify", file, "--public-key", publicKey], { allowFailure: true });
  return verified.code === 0 ? null : `l2m audit verify exited ${verified.code}: ${verified.output.trim().split("\n").slice(-5).join(" | ")}`;
}

/**
 * Checks a restored instance against the snapshot taken before the backup. `keyKnown` false: the master key was lost,
 * so secrets, MFA and the signing key cannot be read (checked separately by the key-loss scenario).
 */
async function verifyRestore(api, expected, options = { keyKnown: true }) {
  const problems = [];
  try {
    await api.login(ADMIN);
  } catch (error) {
    throw new DrillFailure(`${api.name}: admin login failed after the restore: ${error.message}`);
  }
  if (options.keyKnown) {
    try {
      await api.login(MFA_USER, expected.mfaSecret);
    } catch (error) {
      problems.push(`MFA login failed: ${error.message}`);
    }
  }
  await api.login(OPERATOR);
  const actual = await snapshot(api);
  problems.push(...listDiff("users", expected.users, actual.users));
  problems.push(...listDiff("workflows", expected.workflows, actual.workflows));
  problems.push(...listDiff("runs (id:status)", expected.runs, actual.runs));
  problems.push(...listDiff("secrets", expected.secrets, actual.secrets));
  problems.push(...listDiff("MCP servers", expected.mcpServers, actual.mcpServers));
  problems.push(...listDiff("pending approvals", expected.approvals, actual.approvals));
  problems.push(...listDiff("releases", expected.releases, actual.releases));
  problems.push(...listDiff("guard profiles", expected.guardProfiles, actual.guardProfiles));
  problems.push(...listDiff("knowledge bases (id:name:chunks)", expected.knowledgeBases, actual.knowledgeBases));
  const missingAudit = expected.auditIds.filter((id) => !actual.auditIds.includes(id));
  if (missingAudit.length > 0) problems.push(`audit rows missing after the restore: ${missingAudit.length} of ${expected.auditIds.length} (${missingAudit.slice(0, 5).join(", ")})`);
  if (!actual.chain.ok || (actual.chain.unverifiable?.length ?? 0) !== (expected.chain.unverifiable?.length ?? 0) || actual.chain.rowsChecked < expected.chain.rowsChecked) {
    problems.push(`audit chain: before ${chainText(expected.chain)}, after ${chainText(actual.chain)}`);
  }
  const manifest = await api.call(ADMIN.email, "GET", `/api/executions/${expected.manifestRunId}/manifest`);
  if (manifest.body?.digest !== expected.manifestDigest) problems.push(`the stored run manifest changed: digest ${manifest.body?.digest ?? manifest.status}, was ${expected.manifestDigest}`);
  if (options.keyKnown) {
    const run = await secretRunAuthorized(api);
    if (!run.authorized) problems.push(`the secret did not decrypt into the run (${run.status}: ${run.error ?? "no error"})`);
    // The signing key: a run signed after the restore uses the same key, and its bundle verifies with the public key
    // taken before the backup.
    const keys = await api.ok(ADMIN.email, "GET", "/api/audit/signing-keys");
    if (keys.activeKeyId !== expected.signingKeyId) problems.push(`the active signing key is ${keys.activeKeyId}, was ${expected.signingKeyId}`);
    const bundle = await bundleVerifies(api, expected.unsignedRunId, expected.signingPublicKey);
    if (bundle) problems.push(`a manifest signed after the restore does not verify with the key from before the backup: ${bundle}`);
    const approved = await approveRun(api, expected.approvalRunId, ["success", "error"]);
    if (approved !== "success") problems.push(`approving the restored paused run: it ended ${approved}`);
    // The agent's second write: the first must be answered from its sealed result, so the tool sees b@ only.
    const callsBefore = writeCalls.length;
    const agent = await approveRun(api, expected.agentRunId, ["success", "error"]);
    const calls = writeCalls.slice(callsBefore);
    if (agent !== "success" || calls.join(",") !== "b@example.org") {
      problems.push(`approving the restored agent run: it ended ${agent}, and the write tool saw ${JSON.stringify(calls)} (expected ["b@example.org"]: the first write's sealed result must answer it)`);
    }
  }
  if (problems.length > 0) throw new DrillFailure(`${api.name}: the restore does not match the backup:\n  - ${problems.join("\n  - ")}`);
  return actual;
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios

async function scenario(name, method, fn) {
  log(`\n▶ ${name}`);
  try {
    const result = await fn();
    results.push({ name, method, ...result, ok: true });
    log(`  ✓ backup ${seconds(result.backupMs)}, restore ${seconds(result.restoreMs)} (backup ${kib(result.bytes)})${result.note ? ` — ${result.note}` : ""}`);
  } catch (error) {
    failures.push({ name, message: error instanceof Error ? error.message : String(error) });
    results.push({ name, method, ok: false });
    log(`  ✗ ${redact(error instanceof Error ? error.message : String(error))}`);
  }
}

/** Starts `api`, verifies it against `expected`, stops it. Restore time = `prepareMs` + start-to-healthy. */
async function startAndVerify(api, expected, prepareMs, options) {
  const startMs = await api.start();
  try {
    await verifyRestore(api, expected, options);
  } finally {
    await api.stop();
  }
  return prepareMs + startMs;
}

function copySqliteFiles(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(from + suffix)) fs.copyFileSync(from + suffix, to + suffix);
  }
}

async function sqliteDrill(context) {
  const masterKey = randomKey();
  const source = new Api("sqlite-source", { masterKey, dbEnv: { DB_SQLITE_PATH: path.join(workDir, "sqlite-source", "orchestrator.db") } });
  const sourceFile = source.settings.dbEnv.DB_SQLITE_PATH;
  log("\n▶ SQLite source: start and populate through the API");
  await source.start();
  const populated = await populate(source);
  const expected = { ...(await snapshot(source)), ...populated };
  log(`  ${expected.users.length} users, ${expected.workflows.length} workflows, ${expected.runs.length} runs, ${expected.secrets.length} secret, ${expected.mcpServers.length} MCP servers, ${expected.approvals.length} pending approvals, ${expected.releases.length - 1} release, ${expected.guardProfiles.length} guard profile, ${expected.knowledgeBases.join(" ")} (knowledge base:chunks), audit chain ${chainText(expected.chain)}`);

  // Taken while the API runs: the online backup and db:export.
  const onlineFile = path.join(workDir, "backups", "online.db");
  fs.mkdirSync(path.dirname(onlineFile), { recursive: true });
  const online = await timed(async () => {
    const db = new Database(sourceFile, { readonly: true, fileMustExist: true });
    try {
      await db.backup(onlineFile);
    } finally {
      db.close();
    }
  });
  const exportFile = path.join(workDir, "backups", "sqlite-export.json");
  const exported = await timed(() => apiScript("db:export", ["--out", exportFile], { DB_TYPE: "sqlite", DB_SQLITE_PATH: sourceFile }));
  await source.stop();

  // Taken while the API is stopped: a file copy.
  const copyFile = path.join(workDir, "backups", "stopped-copy", "orchestrator.db");
  const copied = await timed(async () => copySqliteFiles(sourceFile, copyFile));
  context.sqliteCopy = { file: copyFile, masterKey, expected };

  await scenario("SQLite online backup → SQLite", "native", async () => {
    const api = new Api("restore-sqlite-online", { masterKey, dbEnv: { DB_SQLITE_PATH: path.join(workDir, "restore-sqlite-online", "orchestrator.db") } });
    const prepare = await timed(async () => copySqliteFiles(onlineFile, api.settings.dbEnv.DB_SQLITE_PATH));
    return { backupMs: online.ms, restoreMs: await startAndVerify(api, expected, prepare.ms), bytes: fileSize(onlineFile) };
  });

  await scenario("SQLite file copy (API stopped) → SQLite", "native", async () => {
    const api = new Api("restore-sqlite-copy", { masterKey, dbEnv: { DB_SQLITE_PATH: path.join(workDir, "restore-sqlite-copy", "orchestrator.db") } });
    const prepare = await timed(async () => copySqliteFiles(copyFile, api.settings.dbEnv.DB_SQLITE_PATH));
    return { backupMs: copied.ms, restoreMs: await startAndVerify(api, expected, prepare.ms), bytes: fileSize(copyFile) };
  });

  await scenario("db:export → db:import (SQLite → SQLite)", "portable", async () => {
    const file = path.join(workDir, "restore-sqlite-import", "orchestrator.db");
    const api = new Api("restore-sqlite-import", { masterKey, dbEnv: { DB_SQLITE_PATH: file } });
    const restored = await timed(() => apiScript("db:import", ["--in", exportFile, "--yes"], { DB_TYPE: "sqlite", DB_SQLITE_PATH: file, SECRET_MASTER_KEY_BASE64: masterKey }));
    return { backupMs: exported.ms, restoreMs: await startAndVerify(api, expected, restored.ms), bytes: fileSize(exportFile) };
  });

  await scenario("db:import with a new master key (--source-master-key-file)", "portable", async () => {
    const newKey = randomKey();
    const file = path.join(workDir, "restore-sqlite-rekey", "orchestrator.db");
    const api = new Api("restore-sqlite-rekey", { masterKey: newKey, dbEnv: { DB_SQLITE_PATH: file } });
    // Without the old key, db:import refuses: the new key cannot open the backup's secrets (exit 2, nothing written).
    const refused = await run("pnpm", ["--silent", "--filter", "@ai-orchestrator/api", "db:import", "--", "--in", exportFile, "--yes"], {
      env: baseEnv({ DB_TYPE: "sqlite", DB_SQLITE_PATH: file, SECRET_MASTER_KEY_BASE64: newKey }),
      allowFailure: true
    });
    if (refused.code !== 2 || !/cannot open the backup's secrets/.test(refused.output)) {
      throw new DrillFailure(`db:import with the wrong key: expected a refusal (exit 2), got ${refused.code}: ${refused.output.trim().split("\n").slice(-3).join(" | ")}`);
    }
    const oldKeyFile = path.join(workDir, "old-master-key.txt");
    fs.writeFileSync(oldKeyFile, `${masterKey}\n`, { mode: 0o600 });
    const restored = await timed(() =>
      apiScript("db:import", ["--in", exportFile, "--yes", "--source-master-key-file", oldKeyFile], { DB_TYPE: "sqlite", DB_SQLITE_PATH: file, SECRET_MASTER_KEY_BASE64: newKey })
    );
    fs.rmSync(oldKeyFile);
    return { backupMs: exported.ms, restoreMs: await startAndVerify(api, expected, restored.ms), bytes: fileSize(exportFile), note: "secrets and MFA re-encrypted" };
  });

  await scenario("Master key lost: restore, then recover", "native", async () => {
    const file = path.join(workDir, "restore-sqlite-keyloss", "orchestrator.db");
    const api = new Api("restore-sqlite-keyloss", { masterKey: randomKey(), dbEnv: { DB_SQLITE_PATH: file } });
    const prepare = await timed(async () => copySqliteFiles(copyFile, file));
    const startMs = await api.start();
    const problems = [];
    try {
      await verifyRestore(api, expected, { keyKnown: false });
      // What a lost key takes: the stored secret and the MFA secret cannot be read.
      const run = await secretRunAuthorized(api);
      if (run.authorized) problems.push("the secret decrypted under a different master key");
      const mfa = await api.call(MFA_USER.email, "POST", "/api/auth/login", { email: MFA_USER.email, password: MFA_USER.password });
      const mfaStep = mfa.body?.mfaChallenge
        ? await api.call(MFA_USER.email, "POST", "/api/auth/login/mfa", { challenge: mfa.body.mfaChallenge, code: totp(expected.mfaSecret) })
        : mfa;
      if (mfaStep.status === 200) problems.push("the MFA user signed in although the MFA secret cannot be decrypted");
      // The agent's sealed write result cannot be opened: approving asks for the first write again, nothing runs yet.
      const callsBefore = writeCalls.length;
      const again = await approveRun(api, expected.agentRunId, ["waiting_approval", "success", "error"]);
      if (again !== "waiting_approval" || writeCalls.length !== callsBefore) {
        problems.push(`the agent run with an unreadable sealed result: expected it to ask again, it ended ${again} with writes ${JSON.stringify(writeCalls.slice(callsBefore))}`);
      }
      // The signing key is an encrypted secret too: signing a new manifest fails until an admin rotates.
      const unsigned = await api.call(ADMIN.email, "GET", `/api/executions/${expected.unsignedRunId}/manifest`);
      if (unsigned.status < 400 || !/cannot be read/.test(JSON.stringify(unsigned.body))) {
        problems.push(`signing with the unreadable key: expected "cannot be read", got ${unsigned.status} ${JSON.stringify(unsigned.body).slice(0, 200)}`);
      }
    } finally {
      await api.stop();
    }
    // Recovery as the runbook says: clear MFA enrolments with the API stopped, start, re-create the secret, re-point the workflow.
    const db = new Database(file);
    db.prepare("DELETE FROM mfa_secrets WHERE user_id IN (SELECT id FROM users WHERE email IN (?))").run(MFA_USER.email);
    db.close();
    await api.start();
    try {
      await api.login(ADMIN);
      await api.login(MFA_USER);
      const secret = await api.ok(ADMIN.email, "POST", "/api/secrets", { name: "DRILL_ECHO_TOKEN (re-entered)", provider: "custom", value: SECRET_VALUE });
      await api.ok(ADMIN.email, "POST", "/api/workflows", secretWorkflow(secret.id));
      const run = await secretRunAuthorized(api);
      if (!run.authorized) problems.push(`after re-entering the secret the run still failed (${run.status}: ${run.error ?? ""})`);
      await api.ok(ADMIN.email, "POST", "/api/audit/signing-keys/rotate", {});
      const signed = await api.call(ADMIN.email, "GET", `/api/executions/${expected.unsignedRunId}/manifest`);
      if (signed.status !== 200) problems.push(`after rotating the signing key, signing still failed (${signed.status})`);
    } finally {
      await api.stop();
    }
    if (problems.length > 0) throw new DrillFailure(problems.join("; "));
    return { backupMs: copied.ms, restoreMs: prepare.ms + startMs, bytes: fileSize(copyFile), note: "data and logins back; secrets re-entered, MFA reset, signing key rotated" };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Postgres

function databaseUrl(base, name) {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

async function adminQuery(sql) {
  const client = new pg.Client({ connectionString: postgresUrl });
  client.on("error", () => undefined);
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

async function createDatabase(name) {
  await adminQuery(`CREATE DATABASE "${name}"`);
  cleanups.push(() => adminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
  return databaseUrl(postgresUrl, name);
}

async function pgToolMajor(tool) {
  const { output } = await run(tool, ["--version"]);
  return Number(/(\d+)(?:\.\d+)?/.exec(output)?.[1] ?? 0);
}

async function postgresDrill(context) {
  const prefix = `l2m_drill_${crypto.randomBytes(4).toString("hex")}`;
  const masterKey = randomKey();
  const sourceUrl = await createDatabase(`${prefix}_source`);
  const pgEnv = (url) => ({ DB_TYPE: "postgres", DB_POSTGRESDB_URL: url });
  const source = new Api("postgres-source", { masterKey, dbEnv: pgEnv(sourceUrl) });
  log("\n▶ Postgres source: start and populate through the API");
  await source.start();
  const populated = await populate(source);
  const expected = { ...(await snapshot(source)), ...populated };
  log(`  ${expected.runs.length} runs, audit chain ${chainText(expected.chain)}`);

  const serverMajor = Number((await adminQuery("SHOW server_version_num")).rows[0].server_version_num.slice(0, -4));
  const dumpMajor = await pgToolMajor("pg_dump");
  if (dumpMajor < serverMajor) throw new DrillFailure(`pg_dump ${dumpMajor} cannot dump a Postgres ${serverMajor} server; install client tools ${serverMajor} or newer`);

  const dumpFile = path.join(workDir, "backups", "postgres.dump");
  fs.mkdirSync(path.dirname(dumpFile), { recursive: true });
  const sourceConnection = pgConnection(sourceUrl);
  const dumped = await timed(() => run("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", `--file=${dumpFile}`, `--dbname=${sourceConnection.dbname}`], { env: sourceConnection.env }));
  const exportFile = path.join(workDir, "backups", "postgres-export.json");
  const exported = await timed(() => apiScript("db:export", ["--out", exportFile], pgEnv(sourceUrl)));
  await source.stop();

  await scenario("pg_dump → pg_restore (Postgres → Postgres)", "native", async () => {
    const url = await createDatabase(`${prefix}_pgrestore`);
    const api = new Api("restore-pg-dump", { masterKey, dbEnv: pgEnv(url) });
    const target = pgConnection(url);
    const restored = await timed(() => run("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", `--dbname=${target.dbname}`, dumpFile], { env: target.env }));
    return { backupMs: dumped.ms, restoreMs: await startAndVerify(api, expected, restored.ms), bytes: fileSize(dumpFile) };
  });

  await scenario("db:export → db:import (Postgres → Postgres)", "portable", async () => {
    const url = await createDatabase(`${prefix}_import`);
    const api = new Api("restore-pg-import", { masterKey, dbEnv: pgEnv(url) });
    const restored = await timed(() => apiScript("db:import", ["--in", exportFile, "--yes"], { ...pgEnv(url), SECRET_MASTER_KEY_BASE64: masterKey }));
    return { backupMs: exported.ms, restoreMs: await startAndVerify(api, expected, restored.ms), bytes: fileSize(exportFile) };
  });

  if (context.sqliteCopy) {
    await scenario("db:copy SQLite backup → Postgres", "move", async () => {
      const { file, masterKey: sqliteKey, expected: sqliteExpected } = context.sqliteCopy;
      const url = await createDatabase(`${prefix}_copy`);
      const api = new Api("restore-sqlite-to-pg", { masterKey: sqliteKey, dbEnv: pgEnv(url) });
      // db:copy reads the file read-only; copy the backup first so the drill's backup stays untouched.
      const working = path.join(workDir, "restore-sqlite-to-pg", "source.db");
      copySqliteFiles(file, working);
      const copied = await timed(() => apiScript("db:copy", ["--from", `sqlite:${working}`, "--to", "postgres", "--yes"], { DB_POSTGRESDB_URL: url }));
      return { backupMs: 0, restoreMs: await startAndVerify(api, sqliteExpected, copied.ms), bytes: fileSize(file), note: "restore = db:copy + start" };
    });
  }

  if (runPitr) await pitrDrill(prefix);
}

// ---------------------------------------------------------------------------------------------------------------
// Point-in-time recovery: a throwaway cluster with WAL archiving, a base backup, changes before and after a target
// time, then a recovery to that time. Needs the server binaries (initdb, pg_ctl, pg_basebackup).

function findPgBin() {
  const candidates = [process.env.DR_DRILL_PG_BIN, ...["17", "16", "15", "14"].map((v) => `/usr/lib/postgresql/${v}/bin`), "/usr/local/bin", "/opt/homebrew/bin"];
  return candidates.find((dir) => dir && fs.existsSync(path.join(dir, "initdb")) && fs.existsSync(path.join(dir, "pg_ctl")));
}

/** Postgres refuses to run as root: under root the cluster runs as the `postgres` system user (runuser). */
function pgCommand(bin, tool, toolArgs, env) {
  const binary = path.join(bin, tool);
  if (process.getuid?.() === 0) return run("runuser", ["-u", "postgres", "--", binary, ...toolArgs], env ? { env } : {});
  return run(binary, toolArgs, env ? { env } : {});
}

async function pitrDrill(prefix) {
  await scenario("Postgres point-in-time recovery (base backup + WAL archive)", "pitr", async () => {
    const bin = findPgBin();
    if (!bin) throw new DrillFailure("DR_DRILL_PITR is set but no initdb/pg_ctl was found (set DR_DRILL_PG_BIN)");
    // Its own directory: under root the cluster runs as `postgres`, which must own it (the work directory is root's, 0700).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-dr-pitr-"));
    cleanups.push(async () => fs.rmSync(root, { recursive: true, force: true }));
    const data = path.join(root, "data");
    const archive = path.join(root, "wal-archive");
    const base = path.join(root, "base");
    const restoredData = path.join(root, "restored");
    fs.mkdirSync(archive, { recursive: true });
    const port = await freePort();
    const password = crypto.randomBytes(12).toString("hex");
    const pwFile = path.join(root, "pw");
    fs.writeFileSync(pwFile, password, { mode: 0o600 });
    if (process.getuid?.() === 0) await run("chown", ["-R", "postgres", root]);
    await pgCommand(bin, "initdb", ["-D", data, "-U", "postgres", `--pwfile=${pwFile}`, "--auth=scram-sha-256"]);
    fs.appendFileSync(
      path.join(data, "postgresql.conf"),
      `\nport = ${port}\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = '${root}'\nwal_level = replica\narchive_mode = on\n` +
        `archive_command = 'test ! -f ${archive}/%f && cp %p ${archive}/%f'\narchive_timeout = 1\n`
    );
    const ctl = async (dir, action) => {
      const logFile = path.join(root, `${path.basename(dir)}.log`);
      try {
        return await pgCommand(bin, "pg_ctl", ["-D", dir, "-w", "-t", "60", "-l", logFile, action]);
      } catch (error) {
        const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").slice(-15).join("\n") : "";
        throw new DrillFailure(`${error.message}\n${tail}`);
      }
    };
    await ctl(data, "start");
    cleanups.push(() => ctl(data, "stop").catch(() => undefined));
    const serverUrl = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
    const query = async (url, sql) => {
      const client = new pg.Client({ connectionString: url });
      client.on("error", () => undefined);
      await client.connect();
      try {
        return await client.query(sql);
      } finally {
        await client.end();
      }
    };
    await query(serverUrl, `CREATE DATABASE ${prefix}_pitr`);
    const dbUrl = databaseUrl(serverUrl, `${prefix}_pitr`);
    const masterKey = randomKey();
    const api = new Api("pitr-source", { masterKey, dbEnv: { DB_TYPE: "postgres", DB_POSTGRESDB_URL: dbUrl } });
    await api.start();
    let expected;
    let base_ms;
    try {
      const populated = await populate(api);
      // The base backup: taken while the API runs.
      base_ms = (await timed(() => pgCommand(bin, "pg_basebackup", ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-D", base, "-X", "stream", "-c", "fast"], { ...process.env, PGPASSWORD: password }))).ms;
      // Changes after the base backup, before the target: another finished run.
      const before = await secretRunAuthorized(api);
      if (!before.authorized) throw new DrillFailure("PITR: the run before the target time failed");
      expected = { ...(await snapshot(api)), ...populated };
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const target = (await query(dbUrl, "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS t")).rows[0].t;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      // A change after the target: a workflow that must not come back.
      await api.ok(ADMIN.email, "POST", "/api/workflows", {
        ...APPROVAL_WORKFLOW,
        id: "wf-drill-after-target",
        name: "Created after the recovery target",
        nodes: APPROVAL_WORKFLOW.nodes.map((entry) => (entry.id === "hook" ? node("hook", "webhook_input", { path: "drill-after-target", method: "POST" }) : entry))
      });
      await query(dbUrl, "SELECT pg_switch_wal()");
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expected.target = target;
    } finally {
      await api.stop();
    }
    await ctl(data, "stop");

    // Recover: the base backup, recovery.signal, restore_command and recovery_target_time; promote at the target.
    const recovered = await timed(async () => {
      await pgCommand(bin, "pg_ctl", ["--version"]);
      fs.cpSync(base, restoredData, { recursive: true });
      fs.appendFileSync(
        path.join(restoredData, "postgresql.conf"),
        `\narchive_mode = off\nrestore_command = 'cp ${archive}/%f %p'\nrecovery_target_time = '${expected.target}'\nrecovery_target_action = 'promote'\n`
      );
      fs.writeFileSync(path.join(restoredData, "recovery.signal"), "");
      if (process.getuid?.() === 0) await run("chown", ["-R", "postgres", restoredData]);
      fs.chmodSync(restoredData, 0o700);
      await ctl(restoredData, "start");
      cleanups.push(() => ctl(restoredData, "stop").catch(() => undefined));
      // Recovery has finished once the server accepts writes.
      const deadline = Date.now() + 120_000;
      while ((await query(serverUrl, "SELECT pg_is_in_recovery() AS r")).rows[0].r) {
        if (Date.now() > deadline) throw new DrillFailure("PITR: the server did not leave recovery within 120 s");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    });
    const restoredApi = new Api("pitr-restored", { masterKey, dbEnv: { DB_TYPE: "postgres", DB_POSTGRESDB_URL: dbUrl } });
    const restoreMs = await startAndVerify(restoredApi, expected, recovered.ms);
    await restoredApi.start();
    try {
      await restoredApi.login(ADMIN);
      const workflows = (await restoredApi.ok(ADMIN.email, "GET", "/api/workflows")).map((workflow) => workflow.id);
      if (workflows.includes("wf-drill-after-target")) throw new DrillFailure("PITR: a workflow created after the recovery target came back");
    } finally {
      await restoredApi.stop();
    }
    return { backupMs: base_ms, restoreMs, bytes: dirSize(base), note: "recovered to the target time; the later change is gone" };
  });
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

// ---------------------------------------------------------------------------------------------------------------

async function main() {
  await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
  echoUrl = `http://127.0.0.1:${echo.address().port}/echo`;
  await new Promise((resolve) => fakeModel.listen(0, "127.0.0.1", resolve));
  fakeModelUrl = `http://127.0.0.1:${fakeModel.address().port}/v1`;
  await new Promise((resolve) => fakeMcp.listen(0, "127.0.0.1", resolve));
  fakeMcpUrl = `http://127.0.0.1:${fakeMcp.address().port}/mcp`;
  log(`Restore drill — work directory ${workDir}`);
  const context = {};
  if (only !== "postgres") {
    try {
      await sqliteDrill(context);
    } catch (error) {
      failures.push({ name: "SQLite source", message: error instanceof Error ? error.message : String(error) });
      log(`  ✗ ${redact(error instanceof Error ? error.message : String(error))}`);
    }
  }
  if (only !== "sqlite") {
    if (!postgresUrl) {
      const message = "no DR_DRILL_POSTGRES_URL or TEST_POSTGRES_URL: the Postgres scenarios were skipped";
      if (requirePostgres) failures.push({ name: "Postgres", message });
      log(`\n${requirePostgres ? "✗" : "-"} ${message}`);
    } else {
      try {
        await postgresDrill(context);
      } catch (error) {
        failures.push({ name: "Postgres source", message: error instanceof Error ? error.message : String(error) });
        log(`  ✗ ${redact(error instanceof Error ? error.message : String(error))}`);
      }
    }
  }

  log(`\nMeasured times (${extraRuns} finished runs in the source; see the runbook for how they scale):`);
  log("| Scenario | Backup | Restore to healthy | Backup size | Result |");
  log("|---|---|---|---|---|");
  for (const result of results) {
    log(`| ${result.name} | ${result.ok ? seconds(result.backupMs) : "-"} | ${result.ok ? seconds(result.restoreMs) : "-"} | ${result.ok ? kib(result.bytes) : "-"} | ${result.ok ? "pass" : "FAIL"} |`);
  }
  if (summaryFile) fs.writeFileSync(summaryFile, JSON.stringify({ results, failures }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = ["## Restore drill", "", "| Scenario | Backup | Restore to healthy | Backup size | Result |", "|---|---|---|---|---|"];
    for (const result of results) {
      lines.push(`| ${result.name} | ${result.ok ? seconds(result.backupMs) : "-"} | ${result.ok ? seconds(result.restoreMs) : "-"} | ${result.ok ? kib(result.bytes) : "-"} | ${result.ok ? "pass" : "FAIL"} |`);
    }
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  }
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  failures.push({ name: "drill", message: error instanceof Error ? error.stack ?? error.message : String(error) });
}
for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
echo.close();
fakeModel.close();
fakeMcp.close();
if (failures.length > 0) {
  exitCode = 1;
  console.error(`\nRestore drill FAILED (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure.name}: ${redact(failure.message)}`);
  console.error(`Instance logs: ${workDir} (kept)`);
} else {
  log(`\nRestore drill passed: ${results.length} scenarios.`);
  if (!keep) fs.rmSync(workDir, { recursive: true, force: true });
}
if (keep && failures.length === 0) log(`Work directory kept: ${workDir}`);
process.exit(exitCode);
