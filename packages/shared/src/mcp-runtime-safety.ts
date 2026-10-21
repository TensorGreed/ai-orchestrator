import { z } from "zod";

// ---------------------------------------------------------------------------
// Phase 10.7 — MCP runtime safety: sandboxed stdio servers, rate limits,
// concurrency caps and a circuit breaker per registry server, and delegated
// (per-user) credentials.
// ---------------------------------------------------------------------------

// Sandbox -------------------------------------------------------------------

export type McpSandboxMode = "none" | "container";
export type McpContainerRuntime = "docker" | "podman";
export type McpSandboxNetwork = "none" | "bridge";

export const MCP_SANDBOX_MODES: readonly McpSandboxMode[] = ["none", "container"];
export const MCP_CONTAINER_RUNTIMES: readonly McpContainerRuntime[] = ["docker", "podman"];

/** A host path made visible inside the container. Read-only unless `writable` is set. */
export interface McpSandboxMount {
  /** Absolute host path; must resolve (after symlinks) inside an allowed mount root. */
  source: string;
  /** Absolute path inside the container. */
  target: string;
  /** Mounted read-write only when explicitly set. */
  writable?: boolean;
}

/**
 * How a registry stdio server runs. `none` spawns the command on the API
 * host (the behaviour before 10.7); `container` runs it in a throwaway
 * container with the limits below.
 */
export interface McpSandboxSettings {
  mode: McpSandboxMode;
  /** Container CLI; null or absent picks the deployment's runtime (auto-detected). */
  runtime?: McpContainerRuntime | null;
  /** Image with a tag or digest, e.g. `node:22-alpine@sha256:…`. Required for `container`. */
  image?: string;
  /** CPU limit in cores. */
  cpus?: number;
  memoryMb?: number;
  pidsLimit?: number;
  /** Size of the writable tmpfs mounted at /tmp. */
  tmpfsMb?: number;
  /** Networking is off unless an admin opts in. */
  network?: McpSandboxNetwork;
  mounts?: McpSandboxMount[];
  /** Numeric `uid:gid` the command runs as; never root. */
  user?: string;
  /** Working directory inside the container. */
  workdir?: string;
}

export const DEFAULT_MCP_SANDBOX_LIMITS = {
  cpus: 1,
  memoryMb: 512,
  pidsLimit: 256,
  tmpfsMb: 64,
  network: "none" as McpSandboxNetwork,
  user: "65534:65534"
};

/** What a probe (or a dry check) found out about a server's sandbox. */
export interface McpSandboxStatus {
  mode: McpSandboxMode;
  /** Where the mode came from: the server's own setting or the deployment default. */
  source: "server" | "default";
  runtime: McpContainerRuntime | null;
  image: string | null;
  pinnedByDigest: boolean;
  network: McpSandboxNetwork | null;
  /** True when the sandbox can start as configured (runtime present, mounts valid, policy met). */
  ok: boolean;
  /** Human-readable problems that stop it from starting. */
  problems: string[];
  /** Warnings that do not stop it (an image pinned by tag only, networking on, writable mounts). */
  warnings: string[];
  checkedAt: string;
}

/** Deployment-level sandbox policy, as the UI needs to know it. */
export interface McpSandboxPolicyView {
  defaultMode: McpSandboxMode;
  required: boolean;
  runtime: McpContainerRuntime | "auto";
  detectedRuntime: McpContainerRuntime | null;
  allowedMountRoots: string[];
}

// Container image references: registry host (optional port), path, tag and/or digest.
const IMAGE_PATTERN =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\.[a-z0-9-]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

/** True when the image reference is syntactically valid (and cannot be read as a CLI flag). */
export function isValidContainerImage(image: string): boolean {
  return image.length > 0 && image.length <= 512 && !image.startsWith("-") && IMAGE_PATTERN.test(image);
}

export function isImagePinnedByDigest(image: string): boolean {
  return /@sha256:[a-f0-9]{64}$/.test(image);
}

/** The tag part of an image reference, without the digest; null when there is none. */
export function imageTag(image: string): string | null {
  const withoutDigest = image.replace(/@sha256:[a-f0-9]{64}$/, "");
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  return lastColon > lastSlash ? withoutDigest.slice(lastColon + 1) : null;
}

/** Pinned means a digest, or a tag other than `latest`. */
export function isImagePinned(image: string): boolean {
  if (isImagePinnedByDigest(image)) return true;
  const tag = imageTag(image);
  return tag !== null && tag !== "latest";
}

const ABSOLUTE_POSIX_PATH = /^\/[^\0\n\r,"]*$/;
const NUMERIC_USER = /^[0-9]{1,10}(?::[0-9]{1,10})?$/;
const FORBIDDEN_TARGET_ROOTS = ["/proc", "/sys", "/dev"];

export function isNonRootNumericUser(user: string): boolean {
  if (!NUMERIC_USER.test(user)) return false;
  const [uid] = user.split(":");
  return Number(uid) !== 0;
}

function normalizePosix(value: string): string {
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** A container-side path that is absolute, has no `..` and does not cover the root or kernel filesystems. */
export function isSafeContainerTarget(target: string): boolean {
  if (!ABSOLUTE_POSIX_PATH.test(target) || target.split("/").includes("..")) return false;
  const normalized = normalizePosix(target);
  if (normalized === "/") return false;
  return !FORBIDDEN_TARGET_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

const mountSchema = z.object({
  source: z.string().trim().min(1).max(1024).refine((value) => ABSOLUTE_POSIX_PATH.test(value) && !value.split("/").includes(".."), {
    message: "source must be an absolute host path without .., commas or quotes"
  }),
  target: z.string().trim().min(1).max(1024).refine(isSafeContainerTarget, {
    message: "target must be an absolute container path, not /, /proc, /sys or /dev, without .. or commas"
  }),
  writable: z.boolean().optional()
});

export const mcpSandboxSettingsSchema = z
  .object({
    mode: z.enum(["none", "container"]),
    runtime: z.enum(["docker", "podman"]).nullable().optional(),
    image: z
      .string()
      .trim()
      .max(512)
      .refine((value) => value === "" || isValidContainerImage(value), { message: "image is not a valid container image reference" })
      .optional(),
    cpus: z.number().min(0.1).max(64).optional(),
    memoryMb: z.number().int().min(32).max(262_144).optional(),
    pidsLimit: z.number().int().min(8).max(32_768).optional(),
    tmpfsMb: z.number().int().min(1).max(16_384).optional(),
    network: z.enum(["none", "bridge"]).optional(),
    mounts: z.array(mountSchema).max(20).optional(),
    user: z
      .string()
      .trim()
      .refine(isNonRootNumericUser, { message: "user must be a numeric uid or uid:gid other than 0 (root)" })
      .optional(),
    workdir: z
      .string()
      .trim()
      .max(1024)
      .refine((value) => value === "" || isSafeContainerTarget(value), { message: "workdir must be an absolute container path" })
      .optional()
  })
  .superRefine((value, ctx) => {
    if (value.mode !== "container") return;
    if (!value.image) {
      ctx.addIssue({ code: "custom", path: ["image"], message: "A container sandbox needs an image." });
    } else if (!isImagePinned(value.image)) {
      ctx.addIssue({ code: "custom", path: ["image"], message: "Pin the image by tag or digest (not latest)." });
    }
    const targets = new Set<string>();
    for (const [index, mount] of (value.mounts ?? []).entries()) {
      const target = normalizePosix(mount.target);
      if (target === "/tmp" || target.startsWith("/tmp/")) {
        ctx.addIssue({ code: "custom", path: ["mounts", index, "target"], message: "/tmp is the sandbox's tmpfs; mount elsewhere." });
      }
      if (targets.has(target)) {
        ctx.addIssue({ code: "custom", path: ["mounts", index, "target"], message: "Two mounts share a target." });
      }
      targets.add(target);
    }
  });

/** Fill in the defaults of a stored or submitted sandbox block; null for none or junk. */
export function normalizeMcpSandboxSettings(value: unknown): McpSandboxSettings | null {
  const parsed = mcpSandboxSettingsSchema.safeParse(value);
  if (!parsed.success) return null;
  const data = parsed.data;
  if (data.mode === "none") return { mode: "none" };
  return {
    mode: "container",
    runtime: data.runtime ?? null,
    image: data.image,
    cpus: data.cpus ?? DEFAULT_MCP_SANDBOX_LIMITS.cpus,
    memoryMb: data.memoryMb ?? DEFAULT_MCP_SANDBOX_LIMITS.memoryMb,
    pidsLimit: data.pidsLimit ?? DEFAULT_MCP_SANDBOX_LIMITS.pidsLimit,
    tmpfsMb: data.tmpfsMb ?? DEFAULT_MCP_SANDBOX_LIMITS.tmpfsMb,
    network: data.network ?? DEFAULT_MCP_SANDBOX_LIMITS.network,
    mounts: (data.mounts ?? []).map((mount) => ({
      source: mount.source,
      target: mount.target,
      ...(mount.writable ? { writable: true } : {})
    })),
    user: data.user ?? DEFAULT_MCP_SANDBOX_LIMITS.user,
    ...(data.workdir ? { workdir: data.workdir } : {})
  };
}

// Rate limits, concurrency and the circuit breaker -----------------------------

/** Limits for the tools whose name matches `pattern` (`*` is a wildcard). Each matching tool gets its own budget. */
export interface McpToolLimitRule {
  pattern: string;
  requestsPerMinute?: number | null;
  maxConcurrent?: number | null;
  timeoutMs?: number | null;
}

export interface McpBreakerSettings {
  enabled: boolean;
  /** Consecutive server failures that open the breaker. */
  failureThreshold: number;
  /** Failure share (percent) over `windowMs` that opens the breaker, once `minimumCalls` were made in the window. */
  errorRatePercent: number;
  windowMs: number;
  minimumCalls: number;
  /** How long the breaker stays open before one probe call is let through. */
  cooldownMs: number;
}

export interface McpRuntimeLimits {
  /** Server-wide token bucket; null = unlimited. */
  requestsPerMinute: number | null;
  /** Bucket size; null = the per-minute rate. */
  burst: number | null;
  /** Calls in flight at once; null = unlimited. */
  maxConcurrent: number | null;
  /** How long a call may wait for a free slot or a token before it fails. */
  maxQueueWaitMs: number;
  /** Per-call timeout override for every tool of the server; null = the connection's timeout. */
  timeoutMs: number | null;
  tools: McpToolLimitRule[];
  breaker: McpBreakerSettings;
}

export const DEFAULT_MCP_BREAKER_SETTINGS: McpBreakerSettings = {
  enabled: true,
  failureThreshold: 5,
  errorRatePercent: 50,
  windowMs: 60_000,
  minimumCalls: 10,
  cooldownMs: 30_000
};

export const DEFAULT_MCP_RUNTIME_LIMITS: McpRuntimeLimits = {
  requestsPerMinute: null,
  burst: null,
  maxConcurrent: null,
  maxQueueWaitMs: 10_000,
  timeoutMs: null,
  tools: [],
  breaker: DEFAULT_MCP_BREAKER_SETTINGS
};

const positiveIntOrNull = (max: number) => z.number().int().min(1).max(max).nullable().optional();

export const mcpToolLimitRuleSchema = z.object({
  pattern: z.string().trim().min(1).max(200),
  requestsPerMinute: positiveIntOrNull(100_000),
  maxConcurrent: positiveIntOrNull(1_000),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).nullable().optional()
});

export const mcpBreakerSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  failureThreshold: z.number().int().min(1).max(1_000).optional(),
  errorRatePercent: z.number().min(1).max(100).optional(),
  windowMs: z.number().int().min(1_000).max(3_600_000).optional(),
  minimumCalls: z.number().int().min(1).max(10_000).optional(),
  cooldownMs: z.number().int().min(1_000).max(3_600_000).optional()
});

export const mcpRuntimeLimitsSchema = z.object({
  requestsPerMinute: positiveIntOrNull(100_000),
  burst: positiveIntOrNull(100_000),
  maxConcurrent: positiveIntOrNull(1_000),
  maxQueueWaitMs: z.number().int().min(0).max(300_000).optional(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).nullable().optional(),
  tools: z.array(mcpToolLimitRuleSchema).max(50).optional(),
  breaker: mcpBreakerSettingsSchema.optional()
});

/** Fill in the defaults of a stored or submitted limits block. */
export function normalizeMcpRuntimeLimits(value: unknown): McpRuntimeLimits {
  const parsed = mcpRuntimeLimitsSchema.safeParse(value ?? {});
  if (!parsed.success) return { ...DEFAULT_MCP_RUNTIME_LIMITS, tools: [], breaker: { ...DEFAULT_MCP_BREAKER_SETTINGS } };
  const data = parsed.data;
  return {
    requestsPerMinute: data.requestsPerMinute ?? null,
    burst: data.burst ?? null,
    maxConcurrent: data.maxConcurrent ?? null,
    maxQueueWaitMs: data.maxQueueWaitMs ?? DEFAULT_MCP_RUNTIME_LIMITS.maxQueueWaitMs,
    timeoutMs: data.timeoutMs ?? null,
    tools: (data.tools ?? []).map((rule) => ({
      pattern: rule.pattern,
      requestsPerMinute: rule.requestsPerMinute ?? null,
      maxConcurrent: rule.maxConcurrent ?? null,
      timeoutMs: rule.timeoutMs ?? null
    })),
    breaker: { ...DEFAULT_MCP_BREAKER_SETTINGS, ...stripUndefined(data.breaker ?? {}) }
  };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) (out as Record<string, unknown>)[key] = entry;
  }
  return out;
}

export type McpBreakerState = "closed" | "open" | "half_open";

/** Why a call was refused before it reached the server. */
export type McpRuntimeRejection = "rate_limited" | "concurrency_limited" | "circuit_open";

export const MCP_RUNTIME_REJECTIONS: readonly McpRuntimeRejection[] = ["rate_limited", "concurrency_limited", "circuit_open"];

/** In-memory runtime state of one registry server on this API instance. */
export interface McpRuntimeStateView {
  serverId: string;
  breaker: {
    state: McpBreakerState;
    /** When the current state began. */
    since: string | null;
    consecutiveFailures: number;
    /** Calls and failures in the error-rate window. */
    windowCalls: number;
    windowFailures: number;
    /** While open: when the next probe call is let through. */
    retryAt: string | null;
    lastError: string | null;
    lastFailureAt: string | null;
  };
  inFlight: number;
  queued: number;
  /** Calls refused on this instance since it started, by reason. */
  rejected: Record<McpRuntimeRejection, number>;
}

/** One breaker state change, as audited and shown in the changes feed. */
export interface McpBreakerTransition {
  serverId: string;
  from: McpBreakerState;
  to: McpBreakerState;
  at: string;
  reason: string;
  consecutiveFailures: number;
  retryAt: string | null;
  lastError: string | null;
}

// Delegated credentials --------------------------------------------------------

/**
 * `service`: one shared credential for everybody (a secret, or the server's
 * OAuth connection). `delegated`: every user connects their own OAuth account
 * and calls use the run subject's token.
 */
export type McpCredentialMode = "service" | "delegated";

/** What unattended runs (webhooks, schedules, queue) of a delegated server use. */
export type McpDelegatedFallback = "none" | "owner";

export const MCP_CREDENTIAL_MODES: readonly McpCredentialMode[] = ["service", "delegated"];

/** Whose token a call to a delegated server uses, resolved by the engine from the run subject. */
export interface McpDelegatedUser {
  userId: string;
  /** user: the person who started the run; owner: the workflow owner (fallback); client: the gateway client's owner. */
  source: "user" | "owner" | "client";
}

/** One user's connection to a delegated server, as the UI may show it (never a token). */
export interface McpUserConnectionView {
  serverId: string;
  serverName: string;
  userId: string;
  userEmail: string | null;
  state: "connected" | "expired" | "error" | "not_connected";
  subject: string | null;
  scope: string | null;
  expiresAt: string | null;
  hasRefreshToken: boolean;
  connectedAt: string | null;
  lastRefreshAt: string | null;
  lastError: string | null;
}

/** A delegated server as the "My connections" view lists it for the signed-in user. */
export interface McpMyConnection {
  serverId: string;
  serverName: string;
  description: string | null;
  delegatedFallback: McpDelegatedFallback;
  connection: McpUserConnectionView | null;
}
