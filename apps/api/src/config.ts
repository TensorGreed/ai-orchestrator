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
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default("0.0.0.0"),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  WORKFLOW_EXECUTION_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
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
  AUDIT_LOG_PRUNE_INTERVAL_MS: z.coerce.number().int().positive().default(3600000)
});

export type AppConfig = z.infer<typeof envSchema>;

export function getConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }

  return parsed.data;
}
