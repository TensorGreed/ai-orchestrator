import { z } from "zod";

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

const envSchema = z.object({
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("warn"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default("0.0.0.0"),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  API_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  WORKFLOW_EXECUTION_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
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

  // Phase 5.3 — External secrets
  EXTERNAL_SECRETS_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(300000),

  // Phase 5.4 — Audit logging
  AUDIT_LOG_ENABLED: booleanFromEnv.default(true),
  AUDIT_LOG_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(365),
  AUDIT_LOG_PRUNE_INTERVAL_MS: z.coerce.number().int().positive().default(3600000),

  // Phase 9.5 — RAG eval judge.
  // When EVAL_JUDGE_ENABLED=true, the eval framework can run faithfulness +
  // answer_relevance scorers using the named provider. Provider credentials
  // come from the standard provider-config + secret resolution path; per-
  // scorer overrides take precedence.
  EVAL_JUDGE_ENABLED: booleanFromEnv.default(false),
  EVAL_JUDGE_PROVIDER_ID: z.string().default("openai"),
  EVAL_JUDGE_MODEL: z.string().default("gpt-4o-mini"),
  EVAL_JUDGE_TEMPERATURE: z.coerce.number().min(0).max(2).default(0),
  EVAL_JUDGE_MAX_TOKENS: z.coerce.number().int().positive().default(512),

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

  // Phase 7.5 — Notifications
  NOTIFICATIONS_ENABLED: booleanFromEnv.default(false),
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

  return parsed.data;
}

export function getConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }

  return parsed.data;
}
