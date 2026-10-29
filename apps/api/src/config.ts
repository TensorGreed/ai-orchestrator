import fs from "node:fs";
import net from "node:net";
import { z } from "zod";
import { QUEUE_POOL_NAME_PATTERN } from "@ai-orchestrator/shared";

/** Phase 15.6 — production capture defaults (see the REPLAY_CAPTURE_* settings). */
export const REPLAY_CAPTURE_DEFAULTS = { enabled: true, maxRate: 1, retentionDays: 14, maxPerWorkflow: 200, maxBytesPerWorkflow: 209_715_200 } as const;

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no") {
      return false;
    }
  }
  return value;
}, z.boolean());

/** Like booleanFromEnv, but unset or blank stays undefined (for settings that are only read when a feature is on). */
const optionalBooleanFromEnv = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  booleanFromEnv.optional()
);

/** An optional whole number within [min, max]; an empty value counts as unset (as the .env.example template leaves it). */
function optionalIntFromEnv(min: number, max: number) {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.coerce.number().int().min(min).max(max).optional()
  );
}

const envSchema = z.object({
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("warn"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default("0.0.0.0"),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  API_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  WORKFLOW_EXECUTION_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  // Re-queue a queue job still running after this long; QueueService raises it to the run time limit + 60s.
  // Optional (no default) so hand-built AppConfig objects in tests still typecheck; QueueService defaults it to 600000.
  QUEUE_STUCK_JOB_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  // Phase 13.1 — queue workers. All optional: unset keeps today's behaviour (see resolveQueueSettings for defaults).
  /** Jobs one consumer runs at once (1-256, default 5). */
  QUEUE_CONCURRENCY: optionalIntFromEnv(1, 256),
  /** How often a consumer looks for due jobs, in ms (default 1000). */
  QUEUE_POLL_INTERVAL_MS: optionalIntFromEnv(50, 60_000),
  /** Cluster mode: how often a consumer renews the leases of its jobs, in ms (default 10000). */
  QUEUE_HEARTBEAT_MS: optionalIntFromEnv(100, 300_000),
  /** Cluster mode: a job whose heartbeat is older than this is taken back by the leader, in ms (default 45000). */
  QUEUE_LEASE_MS: optionalIntFromEnv(300, 3_600_000),
  /** Cluster mode: how often the leader looks for expired leases, in ms (default 15000). */
  QUEUE_REAPER_INTERVAL_MS: optionalIntFromEnv(100, 600_000),
  /** Cluster mode: comma-separated pools this consumer claims from (default `default`). */
  QUEUE_POOLS: z.string().optional(),
  /** Pending jobs per pool at which `/enqueue` answers 429 (default 0 = no limit). */
  QUEUE_MAX_PENDING: optionalIntFromEnv(0, 10_000_000),
  /** A consumer stops claiming while its resident memory is above this many MB (default off). */
  QUEUE_MAX_RSS_MB: optionalIntFromEnv(64, 1_048_576),
  /** A consumer stops claiming while its event loop lags more than this many ms (p99 over the last second; default off). */
  QUEUE_MAX_EVENT_LOOP_LAG_MS: optionalIntFromEnv(10, 60_000),
  /**
   * On SIGTERM/SIGINT, how long running queue jobs may finish before they are stopped and given back, in ms. The drain
   * runs in cluster mode (default 20000) or when this is set; otherwise the signals exit at once, as before.
   */
  SHUTDOWN_DRAIN_MS: optionalIntFromEnv(0, 3_600_000),
  // How often a streamed run (SSE) sends a `: ping` comment while nothing else
  // is sent. The web client treats 45s without any bytes as a lost connection,
  // so keep this well below that.
  SSE_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().max(30000).default(15000),
  EXECUTION_HISTORY_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(30),
  EXECUTION_HISTORY_PRUNE_INTERVAL_MS: z.coerce.number().int().positive().default(3600000),
  SEED_SAMPLE_WORKFLOWS: booleanFromEnv.default(false),
  SECRET_MASTER_KEY_BASE64: z.string().min(1).optional(),
  SESSION_COOKIE_NAME: z.string().min(1).default("ao_session"),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
  COOKIE_SECURE: booleanFromEnv.default(false),
  AUTH_ALLOW_PUBLIC_REGISTER: booleanFromEnv.default(false),
  // How a non-admin with no membership in a project is treated there:
  // `role` falls back to their global role (the historical behaviour),
  // `strict` gives them no access, so they only see projects they belong to.
  // Default-project secrets and MCP servers are shared with every project in
  // `role` only; in `strict` they need an explicit share.
  PROJECT_ISOLATION: z.enum(["role", "strict"]).default("role"),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().optional(),

  // Phase 5.1 — Authentication enhancements
  API_KEY_DEFAULT_EXPIRY_DAYS: z.coerce.number().int().nonnegative().default(0),
  MFA_ENABLED: booleanFromEnv.default(false),
  MFA_ENFORCE: booleanFromEnv.default(false),
  MFA_ISSUER: z.string().min(1).default("ai-orchestrator"),
  SAML_ENABLED: booleanFromEnv.default(false),
  SAML_ENTRY_POINT: z.string().optional(),
  SAML_ISSUER: z.string().optional(),
  SAML_CALLBACK_URL: z.string().optional(),
  SAML_IDP_CERT: z.string().optional(),
  SAML_GROUPS_ATTRIBUTE: z.string().default("groups"),
  LDAP_ENABLED: booleanFromEnv.default(false),
  LDAP_URL: z.string().optional(),
  LDAP_BIND_DN: z.string().optional(),
  LDAP_BIND_PASSWORD: z.string().optional(),
  LDAP_BASE_DN: z.string().optional(),
  LDAP_USER_FILTER: z.string().default("(mail={{email}})"),
  LDAP_GROUPS_ATTRIBUTE: z.string().default("memberOf"),
  // Phase 13.2 — OpenID Connect SSO. Off unless OIDC_ENABLED=true; the rest is checked (and defaulted) by
  // resolveOidcSettings only then. No zod defaults here, so hand-built AppConfig objects keep typechecking.
  OIDC_ENABLED: optionalBooleanFromEnv,
  OIDC_ISSUER: z.string().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URL: z.string().optional(),
  OIDC_SCOPES: z.string().optional(),
  OIDC_GROUPS_CLAIM: z.string().optional(),
  OIDC_REQUIRE_EMAIL_VERIFIED: optionalBooleanFromEnv,
  OIDC_ALLOWED_EMAIL_DOMAINS: z.string().optional(),
  OIDC_ALLOWED_GROUPS: z.string().optional(),
  // Phase 13.2 — optional SAML hardening and MFA on SSO (SAML and OIDC). Read only when that SSO is on; checked by
  // resolveSamlSettings / resolveSsoMfaSettings. No zod defaults, so hand-built AppConfig objects keep typechecking.
  SAML_IDP_ISSUER: z.string().optional(),
  SAML_ALLOWED_EMAIL_DOMAINS: z.string().optional(),
  SAML_ALLOWED_GROUPS: z.string().optional(),
  SAML_REQUIRE_IN_RESPONSE_TO: optionalBooleanFromEnv,
  SSO_MFA: z.string().optional(),
  SSO_MFA_OIDC_AMR: z.string().optional(),
  SSO_MFA_OIDC_ACR: z.string().optional(),
  SSO_MFA_SAML_AUTHN_CONTEXTS: z.string().optional(),

  // Phase 5.3 — External secrets
  EXTERNAL_SECRETS_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(300000),

  // Phase 5.4 — Audit logging
  AUDIT_LOG_ENABLED: booleanFromEnv.default(true),
  AUDIT_LOG_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(365),
  AUDIT_LOG_PRUNE_INTERVAL_MS: z.coerce.number().int().positive().default(3600000),

  // Phase 9.5 / 15.2 — LLM judges (faithfulness, answer_relevance, llm_judge).
  // EVAL_JUDGE_ENABLED=false turns every judge call off. A judge authenticates
  // with the scorer's secretRef (resolved through SecretService and checked
  // against the run's project and user); one without a secretRef may use the
  // deployment's provider environment keys only when
  // EVAL_JUDGE_ALLOW_ENV_CREDENTIALS=true. Per-scorer provider and model
  // override the defaults below.
  EVAL_JUDGE_ENABLED: booleanFromEnv.default(false),
  EVAL_JUDGE_ALLOW_ENV_CREDENTIALS: booleanFromEnv.default(false),
  EVAL_JUDGE_PROVIDER_ID: z.string().default("openai"),
  EVAL_JUDGE_MODEL: z.string().default("gpt-4o-mini"),
  EVAL_JUDGE_TEMPERATURE: z.coerce.number().min(0).max(2).default(0),
  EVAL_JUDGE_MAX_TOKENS: z.coerce.number().int().positive().default(512),
  /**
   * Phase 15.2 — base URL for judge calls (an OpenAI-compatible or Ollama
   * endpoint inside the deployment). Set by the operator only: scorers can
   * name a provider, model and secretRef, never a URL.
   */
  EVAL_JUDGE_BASE_URL: z.string().url().optional(),
  /**
   * Phase 15.2 — replay jobs and eval runs run in the background: how many
   * cases run at once in one API process, the most cases one run may have,
   * a replay job's spend limit (model plus judge calls, USD) when the request
   * names none, and every eval run's spend limit.
   */
  REPLAY_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  REPLAY_JOB_MAX_CASES: z.coerce.number().int().min(1).max(5_000).default(200),
  REPLAY_JOB_DEFAULT_MAX_COST_USD: z.coerce.number().positive().max(100_000).default(5),
  /**
   * Phase 15.3 — the most executions one replay job may run (golden-run
   * cases x repeats x 2 with a baseline rerun). A request over it is refused
   * with a 400. Default 500 (applied where it is used).
   */
  REPLAY_JOB_MAX_EXECUTIONS: z.coerce.number().int().min(1).max(100_000).optional(),
  EVAL_RUN_MAX_COST_USD: z.coerce.number().positive().max(100_000).default(5),
  /** Phase 15.2 — a case output or run diff whose JSON is larger is stored as a truncation marker (scorers see it whole). */
  EVAL_RESULT_MAX_BYTES: z.coerce.number().int().min(1_024).max(16 * 1024 * 1024).default(262_144),
  /**
   * Phase 15.2 — finished eval runs and replay jobs older than this are
   * deleted by the retention pruner (EXECUTION_HISTORY_PRUNE_INTERVAL_MS);
   * the newest run of every set is always kept. 0 keeps them forever.
   */
  EVAL_RUN_RETENTION_DAYS: z.coerce.number().int().nonnegative().max(36_500).default(90),
  /**
   * Phase 15.6 — the most recent recordings one guard policy simulation may
   * replay (a request asks for 50 by default and is capped here). Each
   * recording is one replay with models from its tape, so no model is called.
   * Default 200 (applied where it is used).
   */
  REPLAY_SIMULATION_MAX_CASES: z.coerce.number().int().min(1).max(5_000).optional(),

  // Phase 8.4 — Audit export to long-term sinks (SIEM, archive, etc.)
  // Phase 10.1 — MCP server registry health probes. 0 turns the background loop off.
  MCP_PROBE_INTERVAL_MS: z.coerce.number().int().nonnegative().default(300000),
  MCP_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  MCP_PROBE_HISTORY_LIMIT: z.coerce.number().int().positive().default(500),
  // Phase 10.4 — L2M as an MCP server and gateway (/mcp/<toolset>).
  /**
   * Comma-separated origins (scheme://host[:port]) whose browser requests the
   * MCP endpoint accepts, besides requests without an Origin header and the
   * endpoint's own origin. Everything else gets 403 (DNS-rebinding guard).
   */
  MCP_GATEWAY_ALLOWED_ORIGINS: z
    .string()
    .default("")
    .refine(
      (value) =>
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
          .every((entry) => /^https?:\/\/[^/\s]+$/i.test(entry)),
      { message: "MCP_GATEWAY_ALLOWED_ORIGINS must be a comma-separated list of origins like https://tools.example.com" }
    ),
  /** A gateway session with no request for this long is closed (and its stdio servers stopped). */
  MCP_GATEWAY_SESSION_IDLE_MS: z.coerce.number().int().min(10_000).default(1_800_000),
  /** Open gateway sessions across all clients; the least recently used idle session is closed past it. */
  MCP_GATEWAY_MAX_SESSIONS: z.coerce.number().int().positive().default(500),
  /**
   * Audit log for read-only registry tools called through the gateway: every
   * call, the first call of each tool per session (default), or none. Write
   * tools, workflow tools, failures and denials are always recorded.
   */
  MCP_GATEWAY_AUDIT_READ_ONLY_CALLS: z.enum(["all", "first_per_session", "none"]).default("first_per_session"),
  /** Base URL clients reach this instance at, used for the endpoint URLs shown in the UI. Empty = the browser's origin. */
  MCP_GATEWAY_PUBLIC_URL: z
    .string()
    .default("")
    .refine((value) => value === "" || /^https?:\/\/[^\s]+$/i.test(value), {
      message: "MCP_GATEWAY_PUBLIC_URL must be an http(s) URL"
    }),
  // Phase 10.6 — deployment-local catalog of approved MCP servers.
  /** JSON file of approved servers; empty = the built-in presets only. Read on start and when it changes. */
  MCP_CATALOG_FILE: z.string().default(""),
  /** `merge`: catalog entries plus the built-in presets. `exclusive`: catalog entries only. */
  MCP_CATALOG_MODE: z.enum(["merge", "exclusive"]).default("merge"),
  /** Admins may only register or import stdio servers whose command matches an approved catalog entry. */
  MCP_CATALOG_ENFORCE: booleanFromEnv.default(false),
  // Phase 10.5 — OAuth 2.1 for remote MCP servers.
  /**
   * Base URL the authorization server redirects the admin's browser back to
   * (`<base>/api/mcp/oauth/callback`). Empty = MCP_GATEWAY_PUBLIC_URL, else
   * the first WEB_ORIGIN (the web dev server proxies /api to the API).
   */
  MCP_OAUTH_REDIRECT_BASE_URL: z
    .string()
    .default("")
    .refine((value) => value === "" || /^https?:\/\/[^\s]+$/i.test(value), {
      message: "MCP_OAUTH_REDIRECT_BASE_URL must be an http(s) URL"
    }),
  /** How long an authorization started with Connect stays valid. */
  MCP_OAUTH_STATE_TTL_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(600_000),
  /** Access tokens are refreshed this long before they expire. */
  MCP_OAUTH_REFRESH_SKEW_MS: z.coerce.number().int().nonnegative().max(3_600_000).default(60_000),
  /**
   * Phase 10.5 — longest an MCP elicitation request waits for a person. The
   * run's execution timeout keeps counting while it waits, so a wait is also
   * capped by that.
   */
  MCP_ELICITATION_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(86_400_000).default(600_000),
  /** Phase 10.5 — largest MCP resource a run or the playground reads, in bytes. */
  MCP_RESOURCE_MAX_BYTES: z.coerce.number().int().min(1_024).max(1_073_741_824).default(5_242_880),
  /** Phase 10.8 — largest MCP cassette (serialized calls) a recorded run keeps, in bytes. */
  MCP_CASSETTE_MAX_BYTES: z.coerce.number().int().min(1_024).max(268_435_456).default(5_242_880),
  /** Phase 10.8 — most MCP calls one cassette keeps. */
  MCP_CASSETTE_MAX_CALLS: z.coerce.number().int().min(1).max(100_000).default(5_000),
  /**
   * Phase 12.1 — apply the built-in default guard profile to agent traffic
   * in projects and workflows with no guard binding. Bindings and guard
   * ports still apply when this is off.
   */
  GUARD_AUTO_APPLY: booleanFromEnv.default(true),
  // Phase 10.7 — MCP runtime safety.
  /** Sandbox mode for stdio servers that do not choose one: `none` (on the host) or `container`. */
  MCP_SANDBOX_DEFAULT: z.enum(["none", "container"]).default("none"),
  /** When true, stdio servers cannot run without a container sandbox (registry, inline nodes, tests). */
  MCP_SANDBOX_REQUIRED: booleanFromEnv.default(false),
  /**
   * Comma-separated absolute host directories that sandbox mounts must resolve
   * into (after symlinks). Empty = sandboxes cannot mount host paths.
   */
  MCP_SANDBOX_ALLOWED_MOUNT_ROOTS: z
    .string()
    .default("")
    .refine(
      (value) =>
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
          .every((entry) => entry.startsWith("/") && !entry.split("/").includes("..")),
      { message: "MCP_SANDBOX_ALLOWED_MOUNT_ROOTS must be a comma-separated list of absolute paths without '..'" }
    ),
  /** Container runtime for sandboxes: `auto` prefers docker, then podman. */
  MCP_SANDBOX_RUNTIME: z.enum(["auto", "docker", "podman"]).default("auto"),
  // Code nodes (JavaScript and Python).
  /** Master switch. When false, every code node fails with a clear error. */
  CODE_NODES_ENABLED: booleanFromEnv.default(true),
  /**
   * Where code nodes run: `auto` uses a container when docker or podman is
   * installed and both images are present locally, otherwise in process (JS
   * in a QuickJS WebAssembly sandbox, Python as a host subprocess) with a
   * startup warning; `container` insists on a container (code nodes fail
   * without a runtime); `in_process` always runs on the host.
   */
  CODE_SANDBOX_MODE: z.enum(["auto", "container", "in_process"]).default("auto"),
  /** Container runtime for code sandboxes: `auto` prefers docker, then podman. */
  CODE_SANDBOX_RUNTIME: z.enum(["auto", "docker", "podman"]).default("auto"),
  /** Pinned image (tag or digest) with `node` on PATH, for JavaScript code nodes in container mode. */
  CODE_SANDBOX_JS_IMAGE: z.string().trim().min(1).default("node:22.11.0-alpine3.20"),
  /** Pinned image with `python3` on PATH, for Python code nodes in container mode. */
  CODE_SANDBOX_PYTHON_IMAGE: z.string().trim().min(1).default("python:3.12.7-alpine3.20"),
  /** Memory ceiling for a code sandbox container, and for one in-process JavaScript run (MB). */
  CODE_SANDBOX_MEMORY_MB: z.coerce.number().int().min(32).max(16384).default(256),
  /** CPU ceiling for a code sandbox container (cores). */
  CODE_SANDBOX_CPUS: z.coerce.number().min(0.1).max(16).default(1),
  /** Process ceiling inside a code sandbox container. */
  CODE_SANDBOX_PIDS_LIMIT: z.coerce.number().int().min(8).max(4096).default(128),
  /** Time allowed for a code sandbox container to start, on top of the code's own timeout (ms). */
  CODE_SANDBOX_STARTUP_MS: z.coerce.number().int().min(1000).max(120000).default(8000),
  /**
   * Whether Python code nodes may run as host subprocesses when there is no
   * container sandbox. Host Python is not sandboxed: it can run commands,
   * open network connections the outbound guard never sees and read what the
   * API user can read. `deny` makes Python code nodes fail instead.
   */
  CODE_SANDBOX_PYTHON_IN_PROCESS: z.enum(["allow", "deny"]).default("deny"),
  /** Run host Python as this uid (the API needs CAP_SETUID and CAP_CHOWN, e.g. root in a container). Unset: the API's own user. */
  CODE_SANDBOX_PYTHON_UID: z.preprocess((value) => (value === "" ? undefined : value), z.coerce.number().int().min(0).max(4294967294).optional()),
  /** Run host Python with this gid (needs CAP_SETGID). Unset with a uid set: the same number as the uid. */
  CODE_SANDBOX_PYTHON_GID: z.preprocess((value) => (value === "" ? undefined : value), z.coerce.number().int().min(0).max(4294967294).optional()),
  /**
   * Ceiling on an in-process JavaScript code node's timeout (ms). The run
   * holds the API's event loop, so a node's own timeout is clamped to this,
   * and a per-item node may not exceed four times it in all.
   */
  CODE_SANDBOX_MAX_TIMEOUT_MS: z.coerce.number().int().min(100).max(300000).default(30000),
  /** Ceiling on what one in-process JavaScript code node returns, results and logs of all items together (MB). */
  CODE_SANDBOX_MAX_RESULT_MB: z.coerce.number().int().min(1).max(512).default(32),
  /** Time limit for a single `{{ }}` or Sort-node expression (ms). */
  EXPRESSION_TIMEOUT_MS: z.coerce.number().int().min(50).max(60000).default(1000),
  /** Heap limit for a single expression evaluation (MB). */
  EXPRESSION_MEMORY_MB: z.coerce.number().int().min(4).max(1024).default(64),
  /** Largest result one expression may return (MB, as JSON). */
  EXPRESSION_MAX_RESULT_MB: z.coerce.number().int().min(1).max(256).default(8),
  /** Time budget for all the expressions of one template together (ms); never less than EXPRESSION_TIMEOUT_MS. */
  EXPRESSION_TEMPLATE_BUDGET_MS: z.coerce.number().int().min(100).max(600000).default(5000),
  // Outbound URL guard for nodes that fetch a user-supplied URL (HTTP Request,
  // Web Browse, Chart data.url, HTML-render PDF).
  /** Block private ranges and localhost for those nodes. Metadata and link-local are always blocked. */
  OUTBOUND_DENY_PRIVATE: booleanFromEnv.default(false),
  /** Comma-separated hosts or CIDRs allowed through when OUTBOUND_DENY_PRIVATE is on (e.g. 10.0.0.0/8, *.internal:8080). */
  OUTBOUND_ALLOWLIST: z
    .string()
    .default("")
    .transform((value) => value.split(",").map((entry) => entry.trim()).filter(Boolean)),
  /**
   * Phase 11.1 — Ed25519 private key (base64 of the 32-byte seed) that signs
   * run manifests and audit bundles. When unset, the API generates one on
   * first use and stores it encrypted through SecretService. Generate with:
   * node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   */
  AUDIT_SIGNING_KEY_BASE64: z
    .string()
    .trim()
    .transform((value) => (value ? value : undefined))
    .refine((value) => value === undefined || (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, "base64").length === 32), {
      message: "AUDIT_SIGNING_KEY_BASE64 must be base64 of exactly 32 bytes"
    })
    .optional(),
  /**
   * Phase 15.1 — golden runs: the largest recording (input, node outputs and
   * run facts; the copied MCP cassette has its own MCP_CASSETTE_MAX_BYTES)
   * and how many one workflow may keep. Golden runs are never pruned, so
   * the 501st is refused rather than an older one dropped. One run can be
   * saved once.
   */
  REPLAY_RECORDING_MAX_BYTES: z.coerce.number().int().min(16_384).max(268_435_456).default(4_194_304),
  REPLAY_RECORDINGS_MAX_PER_WORKFLOW: z.coerce.number().int().min(1).max(100_000).default(500),
  /** Phase 15.1 — total bytes one workflow's golden runs may use (recordings plus their copied cassettes). */
  REPLAY_RECORDINGS_MAX_BYTES_PER_WORKFLOW: z.coerce.number().int().min(16_384).max(17_179_869_184).default(268_435_456),
  /**
   * Phase 15.1 — total bytes all golden runs in the deployment may use
   * (1 GiB). A builder can create workflows freely, so the per-workflow
   * budget alone does not bound storage.
   */
  REPLAY_RECORDINGS_MAX_TOTAL_BYTES: z.coerce.number().int().min(16_384).max(1_099_511_627_776).default(1_073_741_824),
  /**
   * Phase 15.6 — production capture. REPLAY_CAPTURE_ENABLED is the
   * deployment's kill switch (false: no workflow captures, whatever its
   * settings say). REPLAY_CAPTURE_MAX_RATE caps every workflow's sampling
   * rate (0..1). Captured runs nobody promoted are deleted after
   * REPLAY_CAPTURE_RETENTION_DAYS; a workflow keeps at most
   * REPLAY_CAPTURES_MAX_PER_WORKFLOW of them, in at most
   * REPLAY_CAPTURES_MAX_BYTES_PER_WORKFLOW bytes (200 MB; the oldest go
   * first). The default REPLAY_CAPTURE_MAX_RATE of 1 means no ceiling.
   * Unset means the defaults in `REPLAY_CAPTURE_DEFAULTS` (optional in the
   * type, so configs built in code need not name them).
   */
  REPLAY_CAPTURE_ENABLED: booleanFromEnv.optional(),
  REPLAY_CAPTURE_MAX_RATE: z.coerce.number().min(0).max(1).optional(),
  REPLAY_CAPTURE_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).optional(),
  REPLAY_CAPTURES_MAX_PER_WORKFLOW: z.coerce.number().int().min(1).max(10_000).optional(),
  REPLAY_CAPTURES_MAX_BYTES_PER_WORKFLOW: z.coerce.number().int().min(1_048_576).max(1_099_511_627_776).optional(),
  /**
   * Phase 15.5 — the largest golden-set file `POST /api/eval/datasets/import`
   * accepts (32 MiB), and the basis of that route's request body limit. The
   * caller is authenticated before the body is read, so only signed-in
   * builders can make the API read a body this large. Unset means the
   * default, `GOLDEN_SET_FILE_DEFAULT_MAX_BYTES` (optional in the type, so
   * configs built in code need not name it).
   */
  GOLDEN_SET_IMPORT_MAX_BYTES: z.coerce.number().int().min(65_536).max(1_073_741_824).optional(),
  /**
   * Phase 11.2 — how often the leader expires approval requests past their
   * timeout (ms). Overdue requests are also expired once at startup.
   */
  APPROVAL_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  /**
   * Phase 11.2 — the web app's public URL (for example https://l2m.example.com),
   * used for the inbox link in approval notifications. Empty = no link.
   */
  APP_PUBLIC_URL: z
    .string()
    .default("")
    .refine((value) => value === "" || /^https?:\/\/[^\s]+$/i.test(value), {
      message: "APP_PUBLIC_URL must be an http(s) URL"
    }),
  /** Phase 11.1 — largest audit bundle (zip) the API exports, in bytes. */
  AUDIT_BUNDLE_MAX_BYTES: z.coerce.number().int().min(1_024).max(2_147_483_647).default(104_857_600),
  AUDIT_EXPORT_ENABLED: booleanFromEnv.default(false),
  AUDIT_EXPORT_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  AUDIT_EXPORT_BATCH_SIZE: z.coerce.number().int().positive().default(500),
  /**
   * File-kind audit export sinks must write under this root. Defaults to
   * the API data dir so writes are container-local. Path traversal outside
   * this root is rejected at delivery time.
   */
  AUDIT_EXPORT_FILE_ROOT: z.string().default("apps/api/data"),

  // Phase 5.5 — Log streaming
  LOG_STREAM_ENABLED: booleanFromEnv.default(true),
  LOG_STREAM_FLUSH_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  LOG_STREAM_BUFFER_SIZE: z.coerce.number().int().positive().default(1000),
  LOG_STREAM_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  LOG_STREAM_EVENT_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(14),
  LOG_STREAM_EVENT_PRUNE_INTERVAL_MS: z.coerce.number().int().positive().default(3600000),

  // Phase 5.6 — Version control & environments
  GIT_SYNC_ENABLED: booleanFromEnv.default(true),
  GIT_SYNC_WORKDIR: z.string().default("apps/api/data/git"),
  GIT_BIN: z.string().default("git"),
  GIT_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  WORKFLOW_VERSION_RETENTION: z.coerce.number().int().nonnegative().default(100),

  // Phase 5.7 — Observability & metrics
  METRICS_ENABLED: booleanFromEnv.default(true),
  METRICS_PREFIX: z.string().default("ao"),
  METRICS_INCLUDE_PROCESS: booleanFromEnv.default(true),
  METRICS_SLO_SUCCESS_TARGET: z.coerce.number().min(0).max(1).default(0.99),
  METRICS_SLO_P95_LATENCY_MS: z.coerce.number().int().positive().default(30000),
  TRACING_ENABLED: booleanFromEnv.default(false),
  TRACING_ENDPOINT: z.string().optional(),
  TRACING_SERVICE_NAME: z.string().default("ai-orchestrator"),

  // Phase 8.1 — OpenTelemetry-grade observability.
  // Standard OTEL_* env vars. When OTEL_EXPORTER_OTLP_ENDPOINT is set we
  // export traces (and optionally metrics) over OTLP/HTTP-JSON. Trace export
  // also activates if the legacy TRACING_ENDPOINT is set — both paths share
  // the same TracingService.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.string().optional(),
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: z.string().optional(),
  /** Comma-separated `key=value` pairs added to every OTLP request (auth headers, tenant IDs). */
  OTEL_EXPORTER_OTLP_HEADERS: z.string().default(""),
  OTEL_SERVICE_NAME: z.string().optional(),
  OTEL_SERVICE_VERSION: z.string().optional(),
  OTEL_DEPLOYMENT_ENVIRONMENT: z.string().optional(),
  /** Comma-separated `key=value` pairs merged into every span/metric resource. */
  OTEL_RESOURCE_ATTRIBUTES: z.string().default(""),
  OTEL_METRICS_ENABLED: booleanFromEnv.default(false),
  OTEL_METRICS_PUSH_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /** Emit a SERVER span per HTTP request (in addition to per-execution/per-node spans). */
  OTEL_HTTP_SERVER_SPANS: booleanFromEnv.default(true),

  // Phase 8.2 — FinOps cost rollups.
  // JSON object overlaying `services/usage-service.ts` DEFAULT_PRICING. Same
  // shape: `{ providerId: { model: { inputUsdPer1M, outputUsdPer1M, cachedInputUsdPer1M? } } }`.
  // Operators with negotiated rates / self-hosted GPU costs override here.
  LLM_PRICING_OVERRIDES_JSON: z.string().default(""),
  /** Retention for usage_events rows. 0 disables pruning. */
  USAGE_EVENTS_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(365),

  // Phase 7.1 — Deployment & HA
  WORKER_MODE: z.enum(["all", "api", "webhook", "worker"]).default("all"),
  HA_ENABLED: booleanFromEnv.default(false),
  HA_INSTANCE_ID: z.string().optional(),
  HA_LEASE_TTL_MS: z.coerce.number().int().positive().default(30000),
  HA_RENEW_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
  /** Phase 13.1 — registry heartbeat period (Postgres; every instance, HA on or off). */
  CLUSTER_HEARTBEAT_MS: z.coerce.number().int().min(100).max(300_000).default(10_000),
  /** Phase 13.1 — an instance without a heartbeat this long counts as stopped (its inline runs fail in cluster mode). */
  CLUSTER_INSTANCE_TIMEOUT_MS: z.coerce.number().int().min(300).max(3_600_000).default(45_000),
  /** Phase 13.1 — cluster mode: how often an instance re-reads its running runs for a cancel it may have missed. 0 = off. */
  CLUSTER_CANCEL_CHECK_MS: z.coerce.number().int().nonnegative().max(300_000).default(10_000),

  // Phase 7.5 — Notifications
  NOTIFICATIONS_ENABLED: booleanFromEnv.default(false),
  /** Phase 11.2 — channels set from the environment also send approval.requested and approval.timed_out. */
  NOTIFICATIONS_APPROVAL_EVENTS: booleanFromEnv.default(true),
  NOTIFICATION_SMTP_HOST: z.string().optional(),
  NOTIFICATION_SMTP_PORT: z.coerce.number().int().positive().default(587),
  NOTIFICATION_SMTP_SECURE: booleanFromEnv.default(false),
  NOTIFICATION_SMTP_USER: z.string().optional(),
  NOTIFICATION_SMTP_PASS: z.string().optional(),
  NOTIFICATION_EMAIL_FROM: z.string().optional(),
  NOTIFICATION_EMAIL_TO: z.string().optional(),
  NOTIFICATION_SLACK_WEBHOOK_URL: z.string().optional(),
  NOTIFICATION_TEAMS_WEBHOOK_URL: z.string().optional(),

  // Phase 4.1/4.2 — Production hardening: rate limiting + security headers
  RATE_LIMIT_ENABLED: booleanFromEnv.default(true),
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_GLOBAL_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_AUTH_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_WEBHOOK_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_WEBHOOK_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * Which reverse proxies may set the client address (X-Forwarded-For) that rate limits are counted by. Unset = none:
   * every request counts against the address that connected (behind a proxy, all clients then share one count).
   * `true` (every hop), a hop count, or a comma list of proxy addresses / CIDRs (see parseTrustProxy).
   */
  TRUST_PROXY: z.string().optional(),
  HELMET_ENABLED: booleanFromEnv.default(true),
  HELMET_HSTS_ENABLED: booleanFromEnv.default(false),
  HELMET_CSP_ENABLED: booleanFromEnv.default(false),

  // Phase 6 — Community node SDK / marketplace.
  // Off by default. Even with this enabled, install/uninstall is admin-only
  // and (optionally) gated by COMMUNITY_NODES_ALLOWLIST. See
  // /docs/extensions/community-nodes for the threat model.
  COMMUNITY_NODES_ENABLED: booleanFromEnv.default(false),
  /** Where `npm install` writes the community packages. node_modules/ lives below. */
  COMMUNITY_NODES_DIR: z.string().default("./data/plugins"),
  /**
   * Comma-separated allowlist of installable package names. Each entry is
   * either an exact name (`l2m-nodes-cohere`) or a glob suffix (`l2m-nodes-*`).
   * Empty = allow any `l2m-nodes-*` package.
   */
  COMMUNITY_NODES_ALLOWLIST: z.string().default("")
});

export type AppConfig = z.infer<typeof envSchema>;

/** Parses an environment-shaped record into AppConfig, applying the same defaults as the process environment. */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }
  // Phase 13.1 — the Postgres settings are checked only when DB_TYPE=postgres (fail fast, before the store opens).
  if (isPostgresDbType(env.DB_TYPE)) parsePostgresSettings(env);
  // Phase 13.2 — the OIDC settings are checked only when OIDC_ENABLED=true (fail fast at startup).
  resolveOidcSettings(parsed.data);
  // Phase 13.2 — the SAML allow-lists / IdP issuer and SSO_MFA settings are checked only when SSO is on.
  resolveSamlSettings(parsed.data);
  resolveSsoMfaSettings(parsed.data);
  parseTrustProxy(parsed.data.TRUST_PROXY);
  // Phase 13.1 — queue settings that only work in cluster mode fail fast outside it.
  resolveQueueSettings(parsed.data, { clusterMode: isPostgresDbType(env.DB_TYPE) && parsed.data.HA_ENABLED === true });
  checkClusterTimings(parsed.data, env.DB_TYPE);

  return parsed.data;
}

// ---------------------------------------------------------------------------
// Phase 13.1 — queue workers. Every setting is optional; with none set a single instance behaves exactly as before.
// Cluster mode (DB_TYPE=postgres and HA_ENABLED=true) adds heartbeat leases, the lease reaper and pools.
// ---------------------------------------------------------------------------

export interface QueueSettings {
  concurrency: number;
  pollIntervalMs: number;
  heartbeatMs: number;
  leaseMs: number;
  reaperIntervalMs: number;
  /** The pools this consumer claims from (cluster mode). */
  pools: string[];
  /** Pending jobs per pool at which enqueue is refused; 0 = no limit. */
  maxPending: number;
  /** Stop claiming above this resident memory (MB); 0 = off. */
  maxRssMb: number;
  /** Stop claiming while the event loop's p99 lag exceeds this (ms); 0 = off. */
  maxEventLoopLagMs: number;
  /** The drain budget on SIGTERM/SIGINT, when the drain runs at all (see drainOnSignal). */
  shutdownDrainMs: number;
  /**
   * Whether SIGTERM/SIGINT drain before exiting: in cluster mode, or when SHUTDOWN_DRAIN_MS is set. Otherwise the
   * signals behave as before (the process exits at once).
   */
  drainOnSignal: boolean;
}

export const QUEUE_SETTING_DEFAULTS = {
  concurrency: 5,
  pollIntervalMs: 1_000,
  heartbeatMs: 10_000,
  leaseMs: 45_000,
  reaperIntervalMs: 15_000,
  /** Fits Kubernetes' default 30 s termination grace with the close grace (5 s) and margin to spare. */
  shutdownDrainMs: 20_000
} as const;

type QueueConfigInput = Partial<
  Pick<
    AppConfig,
    | "QUEUE_CONCURRENCY"
    | "QUEUE_POLL_INTERVAL_MS"
    | "QUEUE_HEARTBEAT_MS"
    | "QUEUE_LEASE_MS"
    | "QUEUE_REAPER_INTERVAL_MS"
    | "QUEUE_POOLS"
    | "QUEUE_MAX_PENDING"
    | "QUEUE_MAX_RSS_MB"
    | "QUEUE_MAX_EVENT_LOOP_LAG_MS"
    | "SHUTDOWN_DRAIN_MS"
  >
>;

/**
 * The queue settings with their defaults. Throws a clear error naming the setting when QUEUE_POOLS lists anything
 * but `default` outside cluster mode (one consumer there claims every job, so a pool filter would strand jobs), names
 * an invalid pool, or when the lease is shorter than two heartbeats.
 */
export function resolveQueueSettings(config: QueueConfigInput, options: { clusterMode: boolean }): QueueSettings {
  const fail = (detail: string): never => {
    throw new Error(`Invalid queue configuration: ${detail}`);
  };
  const pools = splitList(config.QUEUE_POOLS);
  for (const pool of pools) {
    if (!QUEUE_POOL_NAME_PATTERN.test(pool)) fail(`QUEUE_POOLS entry "${pool.slice(0, 64)}" must be letters, digits, _ or - (at most 63, starting with a letter or digit)`);
  }
  const resolvedPools = pools.length > 0 ? [...new Set(pools)] : ["default"];
  if (!options.clusterMode && (resolvedPools.length !== 1 || resolvedPools[0] !== "default")) {
    fail("QUEUE_POOLS needs cluster mode (DB_TYPE=postgres and HA_ENABLED=true); a single instance claims every job");
  }
  const heartbeatMs = config.QUEUE_HEARTBEAT_MS ?? QUEUE_SETTING_DEFAULTS.heartbeatMs;
  const leaseMs = config.QUEUE_LEASE_MS ?? Math.max(QUEUE_SETTING_DEFAULTS.leaseMs, heartbeatMs * 3);
  if (leaseMs < heartbeatMs * 2) fail("QUEUE_LEASE_MS must be at least twice QUEUE_HEARTBEAT_MS");
  return {
    concurrency: config.QUEUE_CONCURRENCY ?? QUEUE_SETTING_DEFAULTS.concurrency,
    pollIntervalMs: config.QUEUE_POLL_INTERVAL_MS ?? QUEUE_SETTING_DEFAULTS.pollIntervalMs,
    heartbeatMs,
    leaseMs,
    reaperIntervalMs: config.QUEUE_REAPER_INTERVAL_MS ?? QUEUE_SETTING_DEFAULTS.reaperIntervalMs,
    pools: resolvedPools,
    maxPending: config.QUEUE_MAX_PENDING ?? 0,
    maxRssMb: config.QUEUE_MAX_RSS_MB ?? 0,
    maxEventLoopLagMs: config.QUEUE_MAX_EVENT_LOOP_LAG_MS ?? 0,
    shutdownDrainMs: config.SHUTDOWN_DRAIN_MS ?? QUEUE_SETTING_DEFAULTS.shutdownDrainMs,
    drainOnSignal: options.clusterMode || config.SHUTDOWN_DRAIN_MS !== undefined
  };
}

/**
 * Phase 13.1 — in cluster mode (Postgres with HA on) an instance counts as stopped after CLUSTER_INSTANCE_TIMEOUT_MS
 * without a heartbeat, and its running runs are then failed. An instance stops its own runs one heartbeat before that
 * point, so a timeout under four heartbeats would abort live runs after one late heartbeat. It is refused at startup.
 */
export const CLUSTER_TIMEOUT_HEARTBEATS = 4;

export function checkClusterTimings(
  config: { HA_ENABLED: boolean; CLUSTER_HEARTBEAT_MS: number; CLUSTER_INSTANCE_TIMEOUT_MS: number },
  dbType: string | undefined
): void {
  if (!config.HA_ENABLED || !isPostgresDbType(dbType)) return;
  if (config.CLUSTER_INSTANCE_TIMEOUT_MS < CLUSTER_TIMEOUT_HEARTBEATS * config.CLUSTER_HEARTBEAT_MS) {
    throw new Error(
      `Invalid environment configuration: CLUSTER_INSTANCE_TIMEOUT_MS (${config.CLUSTER_INSTANCE_TIMEOUT_MS}) must be at least ` +
        `${CLUSTER_TIMEOUT_HEARTBEATS} times CLUSTER_HEARTBEAT_MS (${config.CLUSTER_HEARTBEAT_MS}) when HA_ENABLED=true on Postgres, ` +
        `so one late heartbeat never makes an instance stop its own runs or lets a peer count it as stopped`
    );
  }
}

const TRUST_PROXY_NAMED_RANGES = new Set(["loopback", "linklocal", "uniquelocal"]);

/**
 * TRUST_PROXY as Fastify's `trustProxy`: unset, empty or `false` → false (today's behaviour: the connecting address
 * counts); `true` → every hop is trusted; a whole number → that many hops; otherwise a comma list of IP addresses,
 * CIDR ranges or `loopback` / `linklocal` / `uniquelocal`. Anything else fails fast with the setting's name.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string[] {
  const value = (raw ?? "").trim();
  if (!value || value.toLowerCase() === "false") return false;
  if (value.toLowerCase() === "true") return true;
  if (/^\d+$/.test(value)) return Number(value);
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    if (TRUST_PROXY_NAMED_RANGES.has(entry)) continue;
    const [address, prefix, extra] = entry.split("/");
    const family = net.isIP(address ?? "");
    const prefixOk =
      prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= (family === 6 ? 128 : 32));
    if (family === 0 || !prefixOk || extra !== undefined) {
      throw new Error(
        `Invalid environment configuration: TRUST_PROXY entry "${entry}" is not an IP address, a CIDR range, ` +
          "loopback, linklocal or uniquelocal (or use true, false or a hop count)"
      );
    }
  }
  return entries;
}

export function getConfig(): AppConfig {
  return parseConfig(process.env);
}

// ---------------------------------------------------------------------------
// Phase 13.1 — database settings. SQLite (the default) needs none of these; DB_TYPE=postgres reads the DB_POSTGRESDB_*
// block below. Values are never echoed in errors or logs (the password, and the URL that may hold it, least of all).
// ---------------------------------------------------------------------------

/** DB_TYPE values that select the Postgres store (anything else, or nothing, is SQLite as before). */
export function isPostgresDbType(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "postgres" || normalized === "postgresql";
}

export interface PostgresSslSettings {
  /** Verify the server certificate (and host name) against the system CAs or `ca`. Off only by explicit opt-out. */
  rejectUnauthorized: boolean;
  /** PEM of a private CA (from DB_POSTGRESDB_SSL_CA, a path or the PEM itself). */
  ca?: string;
}

export interface PostgresSettings {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: PostgresSslSettings | false;
  poolSize: number;
  /** Where the settings came from (`url` when DB_POSTGRESDB_URL was set; it wins over the separate variables). */
  source: "url" | "variables";
  /** Startup warnings to print once (never containing secrets). */
  warnings: string[];
}

const DB_ENV = {
  url: "DB_POSTGRESDB_URL",
  host: "DB_POSTGRESDB_HOST",
  port: "DB_POSTGRESDB_PORT",
  database: "DB_POSTGRESDB_DATABASE",
  user: "DB_POSTGRESDB_USER",
  password: "DB_POSTGRESDB_PASSWORD",
  ssl: "DB_POSTGRESDB_SSL",
  sslCa: "DB_POSTGRESDB_SSL_CA",
  rejectUnauthorized: "DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED",
  poolSize: "DB_POSTGRESDB_POOL_SIZE"
} as const;

const optionalTrimmed = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : typeof value === "string" ? value.trim() : value),
  z.string().optional()
);

const postgresEnvSchema = z.object({
  [DB_ENV.url]: optionalTrimmed,
  [DB_ENV.host]: optionalTrimmed,
  [DB_ENV.port]: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.coerce.number().int().min(1).max(65535).optional()
  ),
  [DB_ENV.database]: optionalTrimmed,
  [DB_ENV.user]: optionalTrimmed,
  // Not trimmed: a password may legitimately start or end with spaces.
  [DB_ENV.password]: z.string().optional(),
  [DB_ENV.ssl]: z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), booleanFromEnv.optional()),
  [DB_ENV.sslCa]: optionalTrimmed,
  [DB_ENV.rejectUnauthorized]: z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), booleanFromEnv.optional()),
  [DB_ENV.poolSize]: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.coerce.number().int().min(1).max(1000).optional()
  )
});

const URL_SSL_MODES = new Set(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]);

function invalidDbSetting(message: string): Error {
  return new Error(`Invalid database configuration: ${message}`);
}

function parsePostgresUrl(raw: string): { host: string; port?: number; database?: string; user?: string; password?: string; sslMode?: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // The URL may hold the password: say what is wrong, never what it was.
    throw invalidDbSetting(`${DB_ENV.url} is not a valid URL (expected postgres://user:password@host:port/database).`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw invalidDbSetting(`${DB_ENV.url} must start with postgres:// or postgresql://.`);
  }
  if (!url.hostname) throw invalidDbSetting(`${DB_ENV.url} has no host.`);
  for (const key of url.searchParams.keys()) {
    if (key !== "sslmode") {
      throw invalidDbSetting(`${DB_ENV.url} has the unsupported parameter '${key}'; only sslmode is read (use the DB_POSTGRESDB_SSL* settings for TLS).`);
    }
  }
  if (url.searchParams.getAll("sslmode").length > 1) {
    // libpq applies the last one; reading the first would connect differently from psql on the same URL.
    throw invalidDbSetting(`${DB_ENV.url} has more than one sslmode; keep exactly one.`);
  }
  const sslMode = url.searchParams.get("sslmode") ?? undefined;
  if (sslMode !== undefined && !URL_SSL_MODES.has(sslMode)) {
    throw invalidDbSetting(`${DB_ENV.url} has an unknown sslmode; use disable, require, verify-ca or verify-full.`);
  }
  if (sslMode === "allow" || sslMode === "prefer") {
    // libpq would fall back to plain text with these; here TLS is either required (and verified) or off.
    throw invalidDbSetting(
      `${DB_ENV.url} has sslmode=${sslMode}, which would allow a connection without TLS; use require or disable. require, verify-ca and verify-full all verify the server certificate and host name here; for a private CA set ${DB_ENV.sslCa}.`
    );
  }
  const port = url.port ? Number(url.port) : undefined;
  const decode = (part: string, what: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      throw invalidDbSetting(`${DB_ENV.url} has a malformed percent escape in the ${what}; encode special characters as %XX.`);
    }
  };
  const database = decode(url.pathname.replace(/^\//, ""), "database name");
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port,
    database: database || undefined,
    user: url.username ? decode(url.username, "user name") : undefined,
    password: url.password ? decode(url.password, "password") : undefined,
    sslMode
  };
}

function readCa(value: string): string {
  if (value.includes("-----BEGIN")) return value.replace(/\\n/g, "\n");
  try {
    const pem = fs.readFileSync(value, "utf8");
    if (!pem.includes("-----BEGIN")) throw new Error("not PEM");
    return pem;
  } catch {
    throw invalidDbSetting(`${DB_ENV.sslCa} must be a PEM certificate or the path of a readable PEM file.`);
  }
}

/**
 * The Postgres connection settings from an environment record, validated. Throws a clear error naming the variable
 * (never its value) when one is invalid. DB_POSTGRESDB_URL wins over the separate variables when set; its `sslmode`
 * turns TLS on (require / verify-ca / verify-full) or off (disable), and must agree with DB_POSTGRESDB_SSL when both
 * are set. With TLS on, certificates are verified unless
 * DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED=false (a warning says so).
 */
export function parsePostgresSettings(env: Record<string, string | undefined>): PostgresSettings {
  const parsed = postgresEnvSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "")))].filter(Boolean);
    throw invalidDbSetting(
      names.map((name) => `${name} is invalid${name === DB_ENV.port ? " (1-65535)" : name === DB_ENV.poolSize ? " (1-1000)" : name === DB_ENV.ssl || name === DB_ENV.rejectUnauthorized ? " (true or false)" : ""}`).join("; ") + "."
    );
  }
  const values = parsed.data;
  const warnings: string[] = [];
  const fromUrl = values[DB_ENV.url] ? parsePostgresUrl(values[DB_ENV.url] as string) : undefined;

  // TLS: the URL's sslmode and DB_POSTGRESDB_SSL each decide alone; when both are set they must agree, so a leftover
  // DB_POSTGRESDB_SSL=false can never quietly turn off the TLS a URL asks for (or the reverse).
  const sslFromVariable = values[DB_ENV.ssl];
  const sslFromUrl = fromUrl?.sslMode === undefined ? undefined : fromUrl.sslMode !== "disable";
  if (sslFromUrl !== undefined && sslFromVariable !== undefined && sslFromUrl !== sslFromVariable) {
    throw invalidDbSetting(
      `the sslmode in ${DB_ENV.url} turns TLS ${sslFromUrl ? "on" : "off"} but ${DB_ENV.ssl}=${sslFromVariable} turns it ${sslFromVariable ? "on" : "off"}; remove ${DB_ENV.ssl} or make the two agree.`
    );
  }
  const sslOn = sslFromUrl ?? sslFromVariable ?? false;
  const rejectUnauthorized = values[DB_ENV.rejectUnauthorized];
  const caValue = values[DB_ENV.sslCa];
  if (!sslOn && caValue) {
    throw invalidDbSetting(
      `${DB_ENV.sslCa} is set but TLS is off; ` +
        (fromUrl?.sslMode !== undefined ? `change the sslmode in ${DB_ENV.url} to require, verify-ca or verify-full.` : `set ${DB_ENV.ssl}=true (or sslmode=verify-full in ${DB_ENV.url}).`)
    );
  }
  if (!sslOn && rejectUnauthorized === false) {
    throw invalidDbSetting(
      `${DB_ENV.rejectUnauthorized}=false is set but TLS is off; ` +
        (fromUrl?.sslMode !== undefined ? `change the sslmode in ${DB_ENV.url} to require, or remove it.` : `set ${DB_ENV.ssl}=true or remove it.`)
    );
  }
  let ssl: PostgresSslSettings | false = false;
  if (sslOn) {
    ssl = { rejectUnauthorized: rejectUnauthorized !== false, ...(caValue ? { ca: readCa(caValue) } : {}) };
    if (!ssl.rejectUnauthorized) {
      warnings.push(
        `${DB_ENV.rejectUnauthorized}=false: the Postgres server certificate is NOT verified, so the connection can be intercepted. Set ${DB_ENV.sslCa} to your CA instead.`
      );
    }
  }

  return {
    host: fromUrl?.host ?? values[DB_ENV.host] ?? "localhost",
    port: fromUrl ? fromUrl.port ?? 5432 : values[DB_ENV.port] ?? 5432,
    database: fromUrl ? fromUrl.database ?? "ai_orchestrator" : values[DB_ENV.database] ?? "ai_orchestrator",
    user: fromUrl ? fromUrl.user ?? "postgres" : values[DB_ENV.user] ?? "postgres",
    password: fromUrl ? fromUrl.password ?? "" : values[DB_ENV.password] ?? "",
    ssl,
    poolSize: values[DB_ENV.poolSize] ?? 10,
    source: fromUrl ? "url" : "variables",
    warnings
  };
}

/** A log-safe one-line description of the Postgres target (no password). */
export function describePostgresSettings(settings: Pick<PostgresSettings, "host" | "port" | "database" | "user" | "ssl">): string {
  const tls = settings.ssl === false ? "no TLS" : settings.ssl.rejectUnauthorized ? "TLS, certificate verified" : "TLS, certificate NOT verified";
  return `postgres ${settings.user}@${settings.host}:${settings.port}/${settings.database} (${tls})`;
}

// ---------------------------------------------------------------------------
// Phase 13.2 — OpenID Connect single sign-on. Everything is optional; with OIDC_ENABLED unset nothing is read.
// OIDC_CLIENT_SECRET is never part of an error message or log line.
// ---------------------------------------------------------------------------

export interface OidcSettings {
  /** Exactly the IdP's `issuer` value (compared verbatim with discovery and the ID token's `iss`). */
  issuer: string;
  clientId: string;
  /** Unset for a public client (PKCE only). */
  clientSecret?: string;
  /** Where the IdP sends the browser back: `<origin>/api/auth/oidc/callback`. */
  redirectUrl: string;
  /** Space-separated; always contains `openid`. */
  scopes: string;
  /** Claim (or dotted path, e.g. `realm_access.roles`) holding the user's groups. */
  groupsClaim: string;
  /** Link or create users by email only when the IdP marks it verified (`email_verified: true`). */
  requireEmailVerified: boolean;
  /** Web page the browser lands on after the callback (success, or `?sso_error=<code>`). */
  postLoginUrl: string;
  /** Lowercase email domains a login must belong to (exact match on the trusted email's domain); empty = any. */
  allowedEmailDomains: string[];
  /** Groups of which a login must hold at least one (exact match); empty = any. */
  allowedGroups: string[];
}

type OidcConfigInput = Pick<
  AppConfig,
  | "OIDC_ENABLED"
  | "OIDC_ISSUER"
  | "OIDC_CLIENT_ID"
  | "OIDC_CLIENT_SECRET"
  | "OIDC_REDIRECT_URL"
  | "OIDC_SCOPES"
  | "OIDC_GROUPS_CLAIM"
  | "OIDC_REQUIRE_EMAIL_VERIFIED"
  | "OIDC_ALLOWED_EMAIL_DOMAINS"
  | "OIDC_ALLOWED_GROUPS"
  | "WEB_ORIGIN"
>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https, or plain http on a loopback host (local IdPs in development and tests). */
export function isAllowedOidcUrl(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

/** The API route the IdP must send the browser back to; OIDC_REDIRECT_URL's path has to be exactly this. */
export const OIDC_CALLBACK_PATH = "/api/auth/oidc/callback";

function splitList(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean))];
}

/**
 * Lower-cased, de-duplicated email domains from a comma list (a leading `@` is dropped); empty when unset. Returns null
 * when an entry is not a plain domain such as example.com.
 */
export function parseAllowedEmailDomains(value: string | undefined): string[] | null {
  const domains = [...new Set(splitList(value).map((entry) => entry.replace(/^@/, "").toLowerCase()))];
  for (const domain of domains) {
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(domain)) return null;
  }
  return domains;
}

/** The web page an SSO login lands on (success, `?sso_error=<code>` or `?sso_mfa=totp`): the first WEB_ORIGIN. */
export function ssoPostLoginUrl(webOrigin: string): string {
  return `${firstWebOrigin(webOrigin)}/`;
}

function firstWebOrigin(webOrigin: string): string {
  const base = webOrigin.split(",").map((entry) => entry.trim()).find(Boolean) || "http://localhost:5173";
  return base.replace(/\/+$/, "");
}

/**
 * Returns the OIDC settings when OIDC_ENABLED=true, null otherwise. Throws a clear error (naming the variable, never
 * its value for the secret) when OIDC is on but misconfigured.
 */
export function resolveOidcSettings(config: OidcConfigInput): OidcSettings | null {
  if (config.OIDC_ENABLED !== true) return null;
  const fail = (detail: string): never => {
    throw new Error(`Invalid OIDC configuration: ${detail}`);
  };
  const issuer = config.OIDC_ISSUER?.trim() ?? "";
  if (!issuer) fail("OIDC_ISSUER is required when OIDC_ENABLED=true");
  let issuerUrl: URL | null = null;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    fail("OIDC_ISSUER must be an absolute URL");
  }
  if (!issuerUrl || !isAllowedOidcUrl(issuerUrl)) fail("OIDC_ISSUER must use https (plain http only on localhost)");
  if (issuerUrl && (issuerUrl.search || issuerUrl.hash || issuer.includes("#"))) {
    fail("OIDC_ISSUER must not have a query or fragment");
  }

  const clientId = config.OIDC_CLIENT_ID?.trim() ?? "";
  if (!clientId) fail("OIDC_CLIENT_ID is required when OIDC_ENABLED=true");
  const clientSecret = config.OIDC_CLIENT_SECRET?.trim() ? config.OIDC_CLIENT_SECRET.trim() : undefined;

  const webBase = firstWebOrigin(config.WEB_ORIGIN);
  const redirectUrl = config.OIDC_REDIRECT_URL?.trim() || `${webBase}${OIDC_CALLBACK_PATH}`;
  let parsedRedirect: URL | null = null;
  try {
    parsedRedirect = new URL(redirectUrl);
  } catch {
    fail("OIDC_REDIRECT_URL must be an absolute URL");
  }
  if (!parsedRedirect || (parsedRedirect.protocol !== "https:" && parsedRedirect.protocol !== "http:")) {
    fail("OIDC_REDIRECT_URL must be an http(s) URL");
  }
  if (parsedRedirect && !isAllowedOidcUrl(parsedRedirect)) {
    fail("OIDC_REDIRECT_URL must use https (plain http only on localhost); set it, or WEB_ORIGIN, to an https origin");
  }
  if (parsedRedirect && parsedRedirect.pathname !== OIDC_CALLBACK_PATH) {
    fail(`OIDC_REDIRECT_URL must point at the API callback route ${OIDC_CALLBACK_PATH} (no prefix or rewrite)`);
  }
  if (parsedRedirect && (parsedRedirect.search || parsedRedirect.hash || redirectUrl.includes("#"))) {
    fail("OIDC_REDIRECT_URL must not have a query or fragment");
  }

  const scopeList = (config.OIDC_SCOPES?.trim() || "openid email profile").split(/\s+/).filter(Boolean);
  if (!scopeList.includes("openid")) fail("OIDC_SCOPES must include openid");

  const groupsClaim = config.OIDC_GROUPS_CLAIM?.trim() || "groups";

  const allowedEmailDomains = parseAllowedEmailDomains(config.OIDC_ALLOWED_EMAIL_DOMAINS);
  if (!allowedEmailDomains) fail("OIDC_ALLOWED_EMAIL_DOMAINS must be a comma-separated list of domains such as example.com");
  const allowedGroups = splitList(config.OIDC_ALLOWED_GROUPS);

  return {
    issuer,
    clientId,
    clientSecret,
    redirectUrl,
    scopes: [...new Set(scopeList)].join(" "),
    groupsClaim,
    requireEmailVerified: config.OIDC_REQUIRE_EMAIL_VERIFIED !== false,
    postLoginUrl: ssoPostLoginUrl(config.WEB_ORIGIN),
    allowedEmailDomains: allowedEmailDomains ?? [],
    allowedGroups
  };
}

// ---------------------------------------------------------------------------
// Phase 13.2 — SAML parity with OIDC (optional IdP issuer pin and allow-lists). Nothing is read unless SAML_ENABLED=true.
// ---------------------------------------------------------------------------

export interface SamlSettings {
  /** The IdP entity ID a response's Issuer must equal; unset = whatever the (certificate-pinned) IdP sends. */
  idpIssuer?: string;
  /** Lowercase email domains a login must belong to (exact match on the asserted email's domain); empty = any. */
  allowedEmailDomains: string[];
  /** Groups (from SAML_GROUPS_ATTRIBUTE) of which a login must hold at least one (exact match); empty = any. */
  allowedGroups: string[];
  /** Web page the browser lands on after a form-posted callback (success, `?sso_error=<code>`, `?sso_mfa=totp`). */
  postLoginUrl: string;
  /**
   * SAML_REQUIRE_IN_RESPONSE_TO (default false): only responses to a login started from the same browser are accepted
   * (InResponseTo bound by a cookie); IdP-initiated sign-in is refused.
   */
  requireInResponseTo: boolean;
}

type SamlConfigInput = Pick<
  AppConfig,
  | "SAML_ENABLED"
  | "SAML_IDP_ISSUER"
  | "SAML_ALLOWED_EMAIL_DOMAINS"
  | "SAML_ALLOWED_GROUPS"
  | "SAML_REQUIRE_IN_RESPONSE_TO"
  | "SAML_CALLBACK_URL"
  | "WEB_ORIGIN"
>;

/** Returns the extra SAML settings when SAML_ENABLED=true, null otherwise; throws a clear error on a bad value. */
export function resolveSamlSettings(config: SamlConfigInput): SamlSettings | null {
  if (config.SAML_ENABLED !== true) return null;
  const fail = (detail: string): never => {
    throw new Error(`Invalid SAML configuration: ${detail}`);
  };
  const idpIssuer = config.SAML_IDP_ISSUER?.trim() || undefined;
  if (idpIssuer !== undefined) {
    // Identities are stored as `<entityId>#<nameId>`, so the entity ID must not contain the separator.
    if (idpIssuer.includes("#")) fail("SAML_IDP_ISSUER must not contain '#'");
    if (/\s/.test(idpIssuer)) fail("SAML_IDP_ISSUER must not contain whitespace");
  }
  const allowedEmailDomains = parseAllowedEmailDomains(config.SAML_ALLOWED_EMAIL_DOMAINS);
  if (!allowedEmailDomains) fail("SAML_ALLOWED_EMAIL_DOMAINS must be a comma-separated list of domains such as example.com");
  const requireInResponseTo = config.SAML_REQUIRE_IN_RESPONSE_TO === true;
  if (requireInResponseTo && config.SAML_CALLBACK_URL) {
    // The request cookie must be Secure (SameSite=None), which a browser keeps only for https (or localhost).
    let callback: URL | null = null;
    try {
      callback = new URL(config.SAML_CALLBACK_URL);
    } catch {
      fail("SAML_CALLBACK_URL must be a URL");
    }
    const localhost = callback !== null && ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname);
    if (callback !== null && callback.protocol !== "https:" && !localhost) {
      fail("SAML_REQUIRE_IN_RESPONSE_TO needs an https SAML_CALLBACK_URL (its request cookie is Secure)");
    }
  }
  return {
    idpIssuer,
    allowedEmailDomains: allowedEmailDomains ?? [],
    allowedGroups: splitList(config.SAML_ALLOWED_GROUPS),
    postLoginUrl: ssoPostLoginUrl(config.WEB_ORIGIN),
    requireInResponseTo
  };
}

// ---------------------------------------------------------------------------
// Phase 13.2 — MFA on SSO (SAML and OIDC). SSO_MFA unset (or `off`) keeps SSO sign-in exactly as before.
// ---------------------------------------------------------------------------

export type SsoMfaMode = "off" | "idp" | "idp_or_local";

export interface SsoMfaSettings {
  /** `off`: no MFA check on SSO; `idp`: the IdP must assert MFA; `idp_or_local`: IdP MFA, else the local TOTP step. */
  mode: SsoMfaMode;
  /** OIDC `amr` values (RFC 8176) any one of which counts as MFA. */
  oidcAmr: string[];
  /** OIDC `acr` values that count as MFA; also sent as `acr_values` on the authorization request when set. */
  oidcAcr: string[];
  /** SAML AuthnContextClassRef values that count as MFA. */
  samlAuthnContexts: string[];
}

/**
 * RFC 8176 `amr` values counted as MFA by default: only `mfa`, the one value that states multiple factors were used
 * (Entra ID, Okta, Auth0 and Ping send it after a second factor). The others name single methods: `otp` or `sms` alone
 * can be a passwordless one-time code, `hwk` / `swk` a key on its own, and `mca` multiple channels, not factors. Add
 * them with SSO_MFA_OIDC_AMR if your IdP reports a second factor only that way.
 */
export const SSO_MFA_DEFAULT_OIDC_AMR: readonly string[] = ["mfa"];

/**
 * SAML AuthnContextClassRef values counted as MFA by default: REFEDS MFA, Entra ID / AD FS `multipleauthn`, the
 * `MultiFactor` class some IdPs send, and the SAML 2.0 classes that are two-factor by definition.
 */
export const SSO_MFA_DEFAULT_SAML_AUTHN_CONTEXTS: readonly string[] = [
  "https://refeds.org/profile/mfa",
  "http://schemas.microsoft.com/claims/multipleauthn",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:MultiFactor",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorUnregistered",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:SmartcardPKI"
];

type SsoMfaConfigInput = Pick<
  AppConfig,
  "SSO_MFA" | "SSO_MFA_OIDC_AMR" | "SSO_MFA_OIDC_ACR" | "SSO_MFA_SAML_AUTHN_CONTEXTS" | "OIDC_ENABLED" | "SAML_ENABLED"
>;

/**
 * Returns the SSO MFA settings. They are read and checked only when OIDC or SAML is enabled (a bad value then fails
 * fast); with both off, or SSO_MFA unset, the mode is `off`.
 */
export function resolveSsoMfaSettings(config: SsoMfaConfigInput): SsoMfaSettings {
  const defaults: SsoMfaSettings = {
    mode: "off",
    oidcAmr: [...SSO_MFA_DEFAULT_OIDC_AMR],
    oidcAcr: [],
    samlAuthnContexts: [...SSO_MFA_DEFAULT_SAML_AUTHN_CONTEXTS]
  };
  if (config.OIDC_ENABLED !== true && config.SAML_ENABLED !== true) return defaults;
  const fail = (detail: string): never => {
    throw new Error(`Invalid SSO MFA configuration: ${detail}`);
  };
  const rawMode = (config.SSO_MFA ?? "").trim().toLowerCase() || "off";
  if (rawMode !== "off" && rawMode !== "idp" && rawMode !== "idp_or_local") {
    fail("SSO_MFA must be off, idp or idp_or_local");
  }
  const list = (name: string, value: string | undefined, fallback: readonly string[], pattern: RegExp, hint: string): string[] => {
    if (value === undefined || value.trim() === "") return [...fallback];
    const entries = splitList(value);
    for (const entry of entries) {
      if (!pattern.test(entry)) fail(`${name} must be a comma-separated list of ${hint}`);
    }
    return entries;
  };
  return {
    mode: rawMode as SsoMfaMode,
    oidcAmr: list("SSO_MFA_OIDC_AMR", config.SSO_MFA_OIDC_AMR, SSO_MFA_DEFAULT_OIDC_AMR, /^[A-Za-z0-9_.-]{1,64}$/, "amr values such as mfa,otp"),
    oidcAcr: list("SSO_MFA_OIDC_ACR", config.SSO_MFA_OIDC_ACR, [], /^[\x21-\x7e]{1,512}$/, "acr values (no spaces)"),
    samlAuthnContexts: list(
      "SSO_MFA_SAML_AUTHN_CONTEXTS",
      config.SSO_MFA_SAML_AUTHN_CONTEXTS,
      SSO_MFA_DEFAULT_SAML_AUTHN_CONTEXTS,
      /^[A-Za-z][A-Za-z0-9+.-]*:[\x21-\x7e]{1,512}$/,
      "AuthnContextClassRef URIs"
    )
  };
}
