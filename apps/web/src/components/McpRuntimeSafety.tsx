/**
 * Phase 10.7 — MCP runtime safety in the UI.
 *
 * - Sandbox fields for stdio servers (admin-only form) with warnings for an
 *   image pinned by tag only, networking turned on and writable mounts.
 * - Rate limit, concurrency, timeout and circuit breaker fields.
 * - Credential mode: one shared credential, or each user's own account.
 * - The runtime panel on the server page: breaker state, refused calls,
 *   limits and the last sandbox check, with an admin breaker reset.
 * - Admin list of who connected their own account, with revoke.
 * - "My connections": every user who can run workflows connects their own
 *   account to delegated servers. Tokens never reach the browser.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  connectMyMcpConnection,
  disconnectMyMcpConnection,
  fetchMcpServerUserConnections,
  fetchMyMcpConnections,
  resetMcpServerBreaker,
  revokeMcpServerUserConnection,
  type McpCredentialMode,
  type McpDelegatedFallback,
  type McpMyConnection,
  type McpRegisteredServer,
  type McpRuntimeLimits,
  type McpRuntimeStateView,
  type McpSandboxPolicyView,
  type McpSandboxSettings,
  type McpUserConnectionView
} from "../lib/api";

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function formatSeconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms % 60_000 === 0 && ms >= 60_000) return `${ms / 60_000} min`;
  return `${Math.round(ms / 100) / 10} s`;
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

const DIGEST = /@sha256:[a-f0-9]{64}$/;

export interface SandboxMountDraft {
  source: string;
  target: string;
  writable: boolean;
}

export interface SandboxDraft {
  /** `default`: follow MCP_SANDBOX_DEFAULT (stored as null). */
  mode: "default" | "none" | "container";
  runtime: "" | "docker" | "podman";
  image: string;
  cpus: string;
  memoryMb: string;
  pidsLimit: string;
  tmpfsMb: string;
  network: "none" | "bridge";
  user: string;
  workdir: string;
  mounts: SandboxMountDraft[];
}

export function sandboxDraftFrom(settings: McpSandboxSettings | null | undefined): SandboxDraft {
  return {
    mode: settings ? (settings.mode === "container" ? "container" : "none") : "default",
    runtime: settings?.runtime ?? "",
    image: settings?.image ?? "",
    cpus: settings?.cpus !== undefined ? String(settings.cpus) : "",
    memoryMb: settings?.memoryMb !== undefined ? String(settings.memoryMb) : "",
    pidsLimit: settings?.pidsLimit !== undefined ? String(settings.pidsLimit) : "",
    tmpfsMb: settings?.tmpfsMb !== undefined ? String(settings.tmpfsMb) : "",
    network: settings?.network === "bridge" ? "bridge" : "none",
    user: settings?.user ?? "",
    workdir: settings?.workdir ?? "",
    mounts: (settings?.mounts ?? []).map((mount) => ({ source: mount.source, target: mount.target, writable: mount.writable === true }))
  };
}

function optionalNumber(raw: string, label: string, { integer = true, min = 1 } = {}): { value?: number; error?: string } {
  const text = raw.trim();
  if (!text) return {};
  const value = Number(text);
  if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    return { error: `${label} must be ${integer ? "a whole number" : "a number"} of at least ${min}.` };
  }
  return { value };
}

/** The settings to save (null = deployment default), or the first problem. */
export function sandboxFromDraft(draft: SandboxDraft): { value: McpSandboxSettings | null; error: string | null } {
  if (draft.mode === "default") return { value: null, error: null };
  if (draft.mode === "none") return { value: { mode: "none" }, error: null };
  const image = draft.image.trim();
  if (!image) return { value: null, error: "A container sandbox needs an image." };
  if (!DIGEST.test(image) && (!/:[^/]+$/.test(image) || /:latest$/.test(image))) {
    return { value: null, error: "Pin the image to a version tag or, better, a digest (@sha256:…); 'latest' is not allowed." };
  }
  const settings: McpSandboxSettings = { mode: "container", image, network: draft.network };
  if (draft.runtime) settings.runtime = draft.runtime;
  const numbers: Array<[keyof McpSandboxSettings, string, string, boolean]> = [
    ["cpus", draft.cpus, "CPUs", false],
    ["memoryMb", draft.memoryMb, "Memory", true],
    ["pidsLimit", draft.pidsLimit, "Process limit", true],
    ["tmpfsMb", draft.tmpfsMb, "/tmp size", true]
  ];
  for (const [key, raw, label, integer] of numbers) {
    const parsed = optionalNumber(raw, label, { integer, min: integer ? 1 : 0.1 });
    if (parsed.error) return { value: null, error: parsed.error };
    if (parsed.value !== undefined) (settings as unknown as Record<string, unknown>)[key] = parsed.value;
  }
  if (draft.user.trim()) {
    if (!/^\d+(:\d+)?$/.test(draft.user.trim()) || /^0(:|$)/.test(draft.user.trim())) {
      return { value: null, error: "The sandbox user must be a numeric uid (or uid:gid) other than root (0)." };
    }
    settings.user = draft.user.trim();
  }
  if (draft.workdir.trim()) settings.workdir = draft.workdir.trim();
  const mounts = draft.mounts.filter((mount) => mount.source.trim() || mount.target.trim());
  for (const mount of mounts) {
    if (!mount.source.trim().startsWith("/") || !mount.target.trim().startsWith("/")) {
      return { value: null, error: "Mount host paths and container paths must both be absolute." };
    }
  }
  if (mounts.length > 0) {
    settings.mounts = mounts.map((mount) => ({
      source: mount.source.trim(),
      target: mount.target.trim(),
      ...(mount.writable ? { writable: true } : {})
    }));
  }
  return { value: settings, error: null };
}

/** Warnings shown under the sandbox fields (none of them stop a save). */
export function sandboxWarnings(draft: SandboxDraft, policy: McpSandboxPolicyView | null | undefined): string[] {
  const warnings: string[] = [];
  const effective = draft.mode === "default" ? policy?.defaultMode ?? "none" : draft.mode;
  if (effective === "none") {
    if (policy?.required) warnings.push("This deployment requires a container sandbox for stdio servers (MCP_SANDBOX_REQUIRED); saving without one is refused.");
    else warnings.push("Without a sandbox the command runs on the API host with the API's permissions.");
    return warnings;
  }
  const image = draft.image.trim();
  if (image && !DIGEST.test(image)) warnings.push("The image is pinned by tag only. Pin it by digest (@sha256:…) so it cannot change under you.");
  if (draft.network === "bridge") warnings.push("Networking is on: the server can reach the network from inside the container.");
  if (draft.mounts.some((mount) => mount.writable && (mount.source.trim() || mount.target.trim()))) {
    warnings.push("A writable mount lets the server change files on the host.");
  }
  if (draft.mounts.some((mount) => mount.source.trim()) && (policy?.allowedMountRoots.length ?? 0) === 0) {
    warnings.push("No mount roots are allowed on this deployment (MCP_SANDBOX_ALLOWED_MOUNT_ROOTS), so mounts are refused.");
  }
  if (policy && !policy.detectedRuntime) {
    warnings.push(
      policy.runtime === "auto"
        ? "No docker or podman CLI was found on the API host; the server cannot start until one is installed."
        : `The ${policy.runtime} CLI set by MCP_SANDBOX_RUNTIME was not found on the API host; the server cannot start until it is installed.`
    );
  }
  return warnings;
}

export function McpSandboxFields({
  draft,
  onChange,
  policy
}: {
  draft: SandboxDraft;
  onChange: (next: SandboxDraft) => void;
  policy: McpSandboxPolicyView | null | undefined;
}) {
  const set = <K extends keyof SandboxDraft>(key: K, value: SandboxDraft[K]) => onChange({ ...draft, [key]: value });
  const container = draft.mode === "container" || (draft.mode === "default" && policy?.defaultMode === "container");
  const warnings = sandboxWarnings(draft, policy);
  const setMount = (index: number, patch: Partial<SandboxMountDraft>) =>
    set(
      "mounts",
      draft.mounts.map((mount, i) => (i === index ? { ...mount, ...patch } : mount))
    );
  return (
    <fieldset className="mcp-sampling-fields mcp-safety-fields" aria-label="Sandbox">
      <legend>Sandbox</legend>
      <p className="kb-subtle">
        Runs the command in a throwaway container: read-only root, a small writable /tmp, no network unless you turn it
        on, no root user, all capabilities dropped. Secrets reach it as environment variables, never on the command line.
      </p>
      <div className="kb-form-row kb-form-row-2">
        <label>
          Mode
          <select value={draft.mode} onChange={(e) => set("mode", e.target.value as SandboxDraft["mode"])}>
            <option value="default">Deployment default ({policy?.defaultMode === "container" ? "container" : "none"})</option>
            <option value="container">Container</option>
            <option value="none">None (runs on the API host)</option>
          </select>
        </label>
        <label>
          Container CLI
          <select value={draft.runtime} onChange={(e) => set("runtime", e.target.value as SandboxDraft["runtime"])} disabled={!container}>
            <option value="">
              Auto{policy?.detectedRuntime ? ` (${policy.detectedRuntime} found)` : ""}
            </option>
            <option value="docker">docker</option>
            <option value="podman">podman</option>
          </select>
        </label>
      </div>
      {container && (
        <>
          <label>
            Image (pinned)
            <input
              type="text"
              value={draft.image}
              onChange={(e) => set("image", e.target.value)}
              placeholder="node:22.11.0-alpine3.20@sha256:…"
              spellCheck={false}
            />
          </label>
          <div className="mcp-safety-grid">
            <label>
              CPUs
              <input type="number" min="0.1" step="0.1" value={draft.cpus} onChange={(e) => set("cpus", e.target.value)} placeholder="1" />
            </label>
            <label>
              Memory (MB)
              <input type="number" min="1" step="1" value={draft.memoryMb} onChange={(e) => set("memoryMb", e.target.value)} placeholder="512" />
            </label>
            <label>
              Processes
              <input type="number" min="1" step="1" value={draft.pidsLimit} onChange={(e) => set("pidsLimit", e.target.value)} placeholder="256" />
            </label>
            <label>
              /tmp (MB)
              <input type="number" min="1" step="1" value={draft.tmpfsMb} onChange={(e) => set("tmpfsMb", e.target.value)} placeholder="64" />
            </label>
          </div>
          <div className="kb-form-row kb-form-row-2">
            <label>
              Network
              <select value={draft.network} onChange={(e) => set("network", e.target.value as SandboxDraft["network"])}>
                <option value="none">Off</option>
                <option value="bridge">On (bridge)</option>
              </select>
            </label>
            <label>
              Run as (uid:gid)
              <input type="text" value={draft.user} onChange={(e) => set("user", e.target.value)} placeholder="65534:65534" spellCheck={false} />
            </label>
          </div>
          <div className="mcp-safety-mounts">
            <span className="mcp-safety-label">Host folders</span>
            {draft.mounts.length === 0 && (
              <p className="kb-subtle">
                None.{" "}
                {policy?.allowedMountRoots.length
                  ? `Allowed under ${policy.allowedMountRoots.join(", ")}.`
                  : "This deployment allows no host folders (MCP_SANDBOX_ALLOWED_MOUNT_ROOTS)."}
              </p>
            )}
            {draft.mounts.map((mount, index) => (
              <div className="mcp-safety-mount" key={index}>
                <label className="mcp-safety-cell">
                  <span>Host path</span>
                  <input
                    type="text"
                    aria-label={`Host path ${index + 1}`}
                    value={mount.source}
                    onChange={(e) => setMount(index, { source: e.target.value })}
                    placeholder="/srv/l2m/data"
                    spellCheck={false}
                    title={mount.source}
                  />
                </label>
                <label className="mcp-safety-cell">
                  <span>In the container</span>
                  <input
                    type="text"
                    aria-label={`Container path ${index + 1}`}
                    value={mount.target}
                    onChange={(e) => setMount(index, { target: e.target.value })}
                    placeholder="/data"
                    spellCheck={false}
                  />
                </label>
                <label className="mcp-check">
                  <input type="checkbox" checked={mount.writable} onChange={(e) => setMount(index, { writable: e.target.checked })} />
                  Writable
                </label>
                <button
                  type="button"
                  className="pg-btn ghost"
                  aria-label={`Remove mount ${index + 1}`}
                  onClick={() => set("mounts", draft.mounts.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                className="pg-btn ghost"
                onClick={() => set("mounts", [...draft.mounts, { source: "", target: "", writable: false }])}
              >
                + Add host folder
              </button>
            </div>
          </div>
        </>
      )}
      {warnings.length > 0 && (
        <ul className="mcp-safety-warnings" aria-label="Sandbox warnings">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Limits and breaker
// ---------------------------------------------------------------------------

export interface ToolRuleDraft {
  pattern: string;
  requestsPerMinute: string;
  maxConcurrent: string;
  timeoutSec: string;
}

export interface LimitsDraft {
  requestsPerMinute: string;
  burst: string;
  maxConcurrent: string;
  maxQueueWaitSec: string;
  timeoutSec: string;
  tools: ToolRuleDraft[];
  breakerEnabled: boolean;
  failureThreshold: string;
  errorRatePercent: string;
  windowSec: string;
  minimumCalls: string;
  cooldownSec: string;
}

const sec = (ms: number | null | undefined) => (ms === null || ms === undefined ? "" : String(ms / 1000));

export function limitsDraftFrom(limits: McpRuntimeLimits | null | undefined): LimitsDraft {
  const breaker = limits?.breaker;
  return {
    requestsPerMinute: limits?.requestsPerMinute ? String(limits.requestsPerMinute) : "",
    burst: limits?.burst ? String(limits.burst) : "",
    maxConcurrent: limits?.maxConcurrent ? String(limits.maxConcurrent) : "",
    maxQueueWaitSec: sec(limits?.maxQueueWaitMs ?? 10_000),
    timeoutSec: sec(limits?.timeoutMs),
    tools: (limits?.tools ?? []).map((rule) => ({
      pattern: rule.pattern,
      requestsPerMinute: rule.requestsPerMinute ? String(rule.requestsPerMinute) : "",
      maxConcurrent: rule.maxConcurrent ? String(rule.maxConcurrent) : "",
      timeoutSec: sec(rule.timeoutMs)
    })),
    breakerEnabled: breaker?.enabled ?? true,
    failureThreshold: String(breaker?.failureThreshold ?? 5),
    errorRatePercent: String(breaker?.errorRatePercent ?? 50),
    windowSec: sec(breaker?.windowMs ?? 60_000),
    minimumCalls: String(breaker?.minimumCalls ?? 10),
    cooldownSec: sec(breaker?.cooldownMs ?? 30_000)
  };
}

export function limitsFromDraft(draft: LimitsDraft): { value: McpRuntimeLimits | null; error: string | null } {
  const count = (raw: string, label: string) => optionalNumber(raw, label);
  const seconds = (raw: string, label: string, min = 1) => {
    const parsed = optionalNumber(raw, label, { integer: false, min });
    return parsed.error ? parsed : { value: parsed.value === undefined ? undefined : Math.round(parsed.value * 1000) };
  };
  const fields = {
    requestsPerMinute: count(draft.requestsPerMinute, "Calls per minute"),
    burst: count(draft.burst, "Burst"),
    maxConcurrent: count(draft.maxConcurrent, "Concurrent calls"),
    maxQueueWaitMs: seconds(draft.maxQueueWaitSec, "Queue wait", 0),
    timeoutMs: seconds(draft.timeoutSec, "Call timeout"),
    failureThreshold: count(draft.failureThreshold, "Consecutive failures"),
    errorRatePercent: optionalNumber(draft.errorRatePercent, "Error rate", { integer: false, min: 1 }),
    windowMs: seconds(draft.windowSec, "Window"),
    minimumCalls: count(draft.minimumCalls, "Minimum calls"),
    cooldownMs: seconds(draft.cooldownSec, "Cooldown")
  };
  for (const field of Object.values(fields)) {
    if (field.error) return { value: null, error: field.error };
  }
  if ((fields.errorRatePercent.value ?? 50) > 100) return { value: null, error: "Error rate must be at most 100%." };
  const tools: McpRuntimeLimits["tools"] = [];
  for (const rule of draft.tools) {
    if (!rule.pattern.trim()) continue;
    const rpm = count(rule.requestsPerMinute, `Calls per minute for ${rule.pattern}`);
    const concurrent = count(rule.maxConcurrent, `Concurrent calls for ${rule.pattern}`);
    const timeout = seconds(rule.timeoutSec, `Timeout for ${rule.pattern}`);
    const problem = rpm.error ?? concurrent.error ?? timeout.error;
    if (problem) return { value: null, error: problem };
    tools.push({
      pattern: rule.pattern.trim(),
      requestsPerMinute: rpm.value ?? null,
      maxConcurrent: concurrent.value ?? null,
      timeoutMs: timeout.value ?? null
    });
  }
  return {
    value: {
      requestsPerMinute: fields.requestsPerMinute.value ?? null,
      burst: fields.burst.value ?? null,
      maxConcurrent: fields.maxConcurrent.value ?? null,
      maxQueueWaitMs: fields.maxQueueWaitMs.value ?? 10_000,
      timeoutMs: fields.timeoutMs.value ?? null,
      tools,
      breaker: {
        enabled: draft.breakerEnabled,
        failureThreshold: fields.failureThreshold.value ?? 5,
        errorRatePercent: fields.errorRatePercent.value ?? 50,
        windowMs: fields.windowMs.value ?? 60_000,
        minimumCalls: fields.minimumCalls.value ?? 10,
        cooldownMs: fields.cooldownMs.value ?? 30_000
      }
    },
    error: null
  };
}

export function McpLimitsFields({ draft, onChange }: { draft: LimitsDraft; onChange: (next: LimitsDraft) => void }) {
  const set = <K extends keyof LimitsDraft>(key: K, value: LimitsDraft[K]) => onChange({ ...draft, [key]: value });
  const setRule = (index: number, patch: Partial<ToolRuleDraft>) =>
    set(
      "tools",
      draft.tools.map((rule, i) => (i === index ? { ...rule, ...patch } : rule))
    );
  return (
    <fieldset className="mcp-sampling-fields mcp-safety-fields" aria-label="Limits and circuit breaker">
      <legend>Limits and circuit breaker</legend>
      <p className="kb-subtle">
        Shared by workflow runs, the gateway and the playground on each API instance. Calls over a limit wait up to the
        queue time, then fail with a retry hint. Empty means unlimited.
      </p>
      <div className="mcp-safety-grid">
        <label>
          Calls per minute
          <input type="number" min="1" step="1" value={draft.requestsPerMinute} onChange={(e) => set("requestsPerMinute", e.target.value)} placeholder="Unlimited" />
        </label>
        <label>
          Burst
          <input type="number" min="1" step="1" value={draft.burst} onChange={(e) => set("burst", e.target.value)} placeholder="= per minute" />
        </label>
        <label>
          Concurrent calls
          <input type="number" min="1" step="1" value={draft.maxConcurrent} onChange={(e) => set("maxConcurrent", e.target.value)} placeholder="Unlimited" />
        </label>
        <label>
          Queue wait (s)
          <input type="number" min="0" step="any" value={draft.maxQueueWaitSec} onChange={(e) => set("maxQueueWaitSec", e.target.value)} />
        </label>
        <label>
          Call timeout (s)
          <input type="number" min="1" step="any" value={draft.timeoutSec} onChange={(e) => set("timeoutSec", e.target.value)} placeholder="Connection's" />
        </label>
      </div>
      <div className="mcp-safety-mounts">
        <span className="mcp-safety-label">Per-tool limits</span>
        {draft.tools.length === 0 && <p className="kb-subtle">None. Tool patterns may use * (for example write_*).</p>}
        {draft.tools.map((rule, index) => (
          <div className="mcp-safety-rule" key={index}>
            <label className="mcp-safety-cell">
              <span>Tool pattern</span>
              <input
                type="text"
                aria-label={`Tool pattern ${index + 1}`}
                value={rule.pattern}
                onChange={(e) => setRule(index, { pattern: e.target.value })}
                placeholder="search_*"
                spellCheck={false}
              />
            </label>
            <label className="mcp-safety-cell">
              <span>Per minute</span>
              <input type="number" min="1" aria-label={`Calls per minute ${index + 1}`} value={rule.requestsPerMinute} onChange={(e) => setRule(index, { requestsPerMinute: e.target.value })} placeholder="Unlimited" />
            </label>
            <label className="mcp-safety-cell">
              <span>At once</span>
              <input type="number" min="1" aria-label={`Concurrent calls ${index + 1}`} value={rule.maxConcurrent} onChange={(e) => setRule(index, { maxConcurrent: e.target.value })} placeholder="Unlimited" />
            </label>
            <label className="mcp-safety-cell">
              <span>Timeout (s)</span>
              <input type="number" min="1" step="any" aria-label={`Timeout seconds ${index + 1}`} value={rule.timeoutSec} onChange={(e) => setRule(index, { timeoutSec: e.target.value })} placeholder="Server's" />
            </label>
            <button type="button" className="pg-btn ghost" aria-label={`Remove tool limit ${index + 1}`} onClick={() => set("tools", draft.tools.filter((_, i) => i !== index))}>
              Remove
            </button>
          </div>
        ))}
        <div>
          <button
            type="button"
            className="pg-btn ghost"
            onClick={() => set("tools", [...draft.tools, { pattern: "", requestsPerMinute: "", maxConcurrent: "", timeoutSec: "" }])}
          >
            + Add tool limit
          </button>
        </div>
      </div>
      <label className="mcp-check">
        <input type="checkbox" checked={draft.breakerEnabled} onChange={(e) => set("breakerEnabled", e.target.checked)} />
        Pause calls to this server after repeated failures (circuit breaker)
      </label>
      <div className="mcp-safety-grid">
        <label>
          Consecutive failures
          <input type="number" min="1" step="1" value={draft.failureThreshold} onChange={(e) => set("failureThreshold", e.target.value)} disabled={!draft.breakerEnabled} />
        </label>
        <label>
          or error rate (%)
          <input type="number" min="1" max="100" step="any" value={draft.errorRatePercent} onChange={(e) => set("errorRatePercent", e.target.value)} disabled={!draft.breakerEnabled} />
        </label>
        <label>
          over (s)
          <input type="number" min="1" step="any" value={draft.windowSec} onChange={(e) => set("windowSec", e.target.value)} disabled={!draft.breakerEnabled} />
        </label>
        <label>
          once calls ≥
          <input type="number" min="1" step="1" value={draft.minimumCalls} onChange={(e) => set("minimumCalls", e.target.value)} disabled={!draft.breakerEnabled} />
        </label>
        <label>
          Pause for (s)
          <input type="number" min="1" step="any" value={draft.cooldownSec} onChange={(e) => set("cooldownSec", e.target.value)} disabled={!draft.breakerEnabled} />
        </label>
      </div>
      <p className="kb-subtle">
        Policy blocks and invalid arguments never count as failures. After the pause, one trial call goes through; a
        success resumes calls.
      </p>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Credential mode
// ---------------------------------------------------------------------------

export function McpCredentialFields({
  mode,
  fallback,
  onModeChange,
  onFallbackChange,
  oauth
}: {
  mode: McpCredentialMode;
  fallback: McpDelegatedFallback;
  onModeChange: (mode: McpCredentialMode) => void;
  onFallbackChange: (fallback: McpDelegatedFallback) => void;
  /** Delegated credentials need OAuth. */
  oauth: boolean;
}) {
  return (
    <fieldset className="mcp-sampling-fields mcp-safety-fields" aria-label="Credentials">
      <legend>Credentials</legend>
      <label>
        Whose account calls use
        <select value={mode} onChange={(e) => onModeChange(e.target.value as McpCredentialMode)}>
          <option value="service">One shared credential (secret or the server's OAuth connection)</option>
          <option value="delegated" disabled={!oauth && mode !== "delegated"}>
            Each user's own account (OAuth)
          </option>
        </select>
      </label>
      {!oauth && <p className="kb-subtle">Each user's own account needs the auth type OAuth above.</p>}
      {mode === "delegated" && (
        <>
          <p className="kb-subtle">
            Every user connects their own account under My connections. A run uses the account of the person who started
            it; a gateway call uses the client's owner. There is never a fallback to a shared credential.
          </p>
          <label>
            Unattended runs (webhooks, schedules, queue)
            <select value={fallback} onChange={(e) => onFallbackChange(e.target.value as McpDelegatedFallback)}>
              <option value="none">Fail: there is no user to act for</option>
              <option value="owner">Use the workflow owner's connection</option>
            </select>
          </label>
        </>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Runtime panel on the server page
// ---------------------------------------------------------------------------

export const BREAKER_LABEL: Record<McpRuntimeStateView["breaker"]["state"], string> = {
  closed: "Closed",
  open: "Circuit open",
  half_open: "Half-open"
};

function limitsSummary(limits: McpRuntimeLimits | undefined): string {
  if (!limits) return "No limits";
  const parts: string[] = [];
  if (limits.requestsPerMinute) parts.push(`${limits.requestsPerMinute}/min${limits.burst ? ` (burst ${limits.burst})` : ""}`);
  if (limits.maxConcurrent) parts.push(`${limits.maxConcurrent} at once`);
  if (limits.timeoutMs) parts.push(`timeout ${formatSeconds(limits.timeoutMs)}`);
  if (limits.tools.length) parts.push(`${limits.tools.length} tool rule${limits.tools.length === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "No limits";
}

export function McpRuntimePanel({
  server,
  isAdmin,
  onChanged
}: {
  server: McpRegisteredServer;
  isAdmin: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [runtime, setRuntime] = useState<McpRuntimeStateView | undefined>(server.runtime);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setRuntime(server.runtime), [server.runtime]);

  const breaker = runtime?.breaker;
  const rejected = runtime?.rejected ?? { rate_limited: 0, concurrency_limited: 0, circuit_open: 0 };
  const sandbox = server.adapterId === "stdio_mcp" ? server.sandbox ?? null : null;
  const status = server.adapterId === "stdio_mcp" ? server.sandboxStatus ?? null : null;
  const breakerSettings = server.limits?.breaker;

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await resetMcpServerBreaker(server.id);
      setRuntime(result.runtime);
      await onChanged();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mcp-oauth mcp-runtime" aria-label="Runtime safety">
      <div className="mcp-oauth-head">
        <div>
          <h4>Runtime safety</h4>
          <span className={`mcp-breaker-state is-${breaker?.state ?? "closed"}`}>
            {breaker?.state === "closed" || !breaker ? "Circuit closed" : BREAKER_LABEL[breaker.state]}
          </span>
        </div>
        {isAdmin && breaker && breaker.state !== "closed" && (
          <div className="page-actions">
            <button type="button" className="pg-btn" onClick={() => void reset()} disabled={busy}>
              {busy ? "Resetting…" : "Reset breaker"}
            </button>
          </div>
        )}
      </div>
      {error && <div className="settings-error">{error}</div>}
      {breaker?.state === "open" && (
        <p className="mcp-runtime-alert" role="alert">
          Calls to this server are paused after repeated failures. The next trial call goes through at {formatDate(breaker.retryAt)}.
        </p>
      )}
      {isAdmin && breaker?.lastError && breaker.state !== "closed" && <div className="settings-error">Last failure: {breaker.lastError}</div>}
      <dl className="mcp-oauth-facts">
        <dt>Breaker</dt>
        <dd>
          {breakerSettings?.enabled === false
            ? "Off"
            : `opens after ${breakerSettings?.failureThreshold ?? 5} failures in a row or ${breakerSettings?.errorRatePercent ?? 50}% over ${formatSeconds(breakerSettings?.windowMs ?? 60_000)}; pauses ${formatSeconds(breakerSettings?.cooldownMs ?? 30_000)}`}
        </dd>
        <dt>Recent</dt>
        <dd>
          {breaker ? `${breaker.windowFailures} failed of ${breaker.windowCalls} in the window · ${breaker.consecutiveFailures} in a row` : "—"}
        </dd>
        <dt>Limits</dt>
        <dd>{limitsSummary(server.limits)}</dd>
        <dt>Now</dt>
        <dd>
          {runtime ? `${runtime.inFlight} in flight · ${runtime.queued} waiting` : "—"}
        </dd>
        <dt>Refused</dt>
        <dd>
          {rejected.rate_limited} rate limited · {rejected.concurrency_limited} over the concurrency cap · {rejected.circuit_open} while open
        </dd>
        {server.adapterId === "stdio_mcp" && (
          <>
            <dt>Sandbox</dt>
            <dd>
              {sandbox?.mode === "container"
                ? `container · ${sandbox.image ?? "no image"} · network ${sandbox.network === "bridge" ? "on" : "off"}`
                : sandbox?.mode === "none"
                  ? "none (runs on the API host)"
                  : "deployment default"}
            </dd>
            <dt>Last check</dt>
            <dd>
              {status
                ? `${status.ok ? "can start" : "cannot start"}${status.runtime ? ` with ${status.runtime}` : ""} · ${formatDate(status.checkedAt)}`
                : "not checked yet (probe the server)"}
            </dd>
          </>
        )}
        {server.credentialMode === "delegated" && (
          <>
            <dt>Credentials</dt>
            <dd>
              each user's own account · unattended runs {server.delegatedFallback === "owner" ? "use the workflow owner's" : "fail"}
            </dd>
          </>
        )}
      </dl>
      {status && status.problems.length > 0 && (
        <ul className="mcp-safety-warnings is-problem" aria-label="Sandbox problems">
          {status.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {status && status.warnings.length > 0 && (
        <ul className="mcp-safety-warnings" aria-label="Sandbox warnings">
          {status.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      <p className="kb-subtle">State of this API instance; each instance keeps its own counters.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Admin: who connected their own account
// ---------------------------------------------------------------------------

const CONNECTION_STATE_LABEL: Record<McpUserConnectionView["state"], string> = {
  connected: "Connected",
  expired: "Expired",
  error: "Error",
  not_connected: "Not connected"
};

export function McpUserConnectionsPanel({ serverId }: { serverId: string }) {
  const [connections, setConnections] = useState<McpUserConnectionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchMcpServerUserConnections(serverId);
      setConnections(result.connections);
    } catch (err) {
      setError(formatError(err));
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (connection: McpUserConnectionView) => {
    if (!window.confirm(`Revoke ${connection.userEmail ?? connection.userId}'s connection? Their tokens are deleted and their runs fail until they connect again.`)) return;
    setBusy(connection.userId);
    setError(null);
    try {
      await revokeMcpServerUserConnection(serverId, connection.userId);
      await load();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mcp-oauth" aria-label="User connections">
      <div className="mcp-oauth-head">
        <h4>Connected users</h4>
      </div>
      <p className="kb-subtle">Each user connects their own account under My connections. No token is shown here.</p>
      {error && <div className="settings-error">{error}</div>}
      {connections && connections.length === 0 && <p className="kb-subtle">Nobody has connected yet.</p>}
      {connections && connections.length > 0 && (
        <ul className="mcp-connection-list">
          {connections.map((connection) => (
            <li key={connection.userId}>
              <div>
                <strong>{connection.userEmail ?? connection.userId}</strong>
                <span className={`mcp-oauth-state is-${connection.state.replace("_", "-")}`}>{CONNECTION_STATE_LABEL[connection.state]}</span>
                <div className="kb-subtle">
                  {connection.subject ? `as ${connection.subject} · ` : ""}connected {formatDate(connection.connectedAt)}
                  {connection.expiresAt ? ` · expires ${formatDate(connection.expiresAt)}` : ""}
                </div>
                {connection.lastError && <div className="kb-subtle">{connection.lastError}</div>}
              </div>
              <button type="button" className="pg-btn ghost danger" onClick={() => void revoke(connection)} disabled={busy !== null}>
                {busy === connection.userId ? "Revoking…" : "Revoke"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// My connections
// ---------------------------------------------------------------------------

const POPUP_FEATURES = "popup=yes,width=560,height=720";
const POPUP_POLL_MS = 800;

export function McpMyConnectionsPage() {
  const [connections, setConnections] = useState<McpMyConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchMyMcpConnections();
      setConnections(result.connections);
      setError(null);
    } catch (err) {
      setConnections([]);
      setError(err instanceof ApiError && err.status === 403 ? "Your role cannot run workflows, so there is nothing to connect." : formatError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; ok?: unknown; error?: unknown } | null;
      if (!data || data.type !== "l2m:mcp-oauth") return;
      stopPolling();
      setBusy(null);
      setError(data.ok === true ? null : typeof data.error === "string" && data.error ? data.error : "Authorization did not complete.");
      void load();
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      stopPolling();
    };
  }, [load, stopPolling]);

  const connect = async (serverId: string) => {
    setBusy(serverId);
    setError(null);
    try {
      const result = await connectMyMcpConnection(serverId);
      const popup = window.open(result.authorizationUrl, `l2m-mcp-connect-${serverId}`, POPUP_FEATURES);
      if (!popup) {
        setBusy(null);
        setError("The browser blocked the sign-in window. Allow popups for this site and try again.");
        return;
      }
      stopPolling();
      pollRef.current = window.setInterval(() => {
        if (popup.closed) {
          stopPolling();
          setBusy(null);
          void load();
        }
      }, POPUP_POLL_MS);
    } catch (err) {
      setBusy(null);
      setError(formatError(err));
    }
  };

  const disconnect = async (entry: McpMyConnection) => {
    if (!window.confirm(`Disconnect your account from ${entry.serverName}? Your runs that use it fail until you connect again.`)) return;
    setBusy(entry.serverId);
    setError(null);
    try {
      await disconnectMyMcpConnection(entry.serverId);
      await load();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="kb-page mcp-page page-pane">
      <header className="kb-header page-head">
        <div className="page-head-copy">
          <h2 className="page-title">My connections</h2>
          <p className="page-sub">
            MCP servers that act with each person's own account. Connect yours here; runs you start use it, and nobody
            else's runs can. Tokens stay on the server and never reach this page.
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="pg-btn" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </header>
      {error && <div className="settings-error">{error}</div>}
      {connections === null ? (
        <p className="kb-subtle">Loading…</p>
      ) : connections.length === 0 ? (
        !error && <p className="kb-subtle">No MCP server here uses personal accounts yet.</p>
      ) : (
        <ul className="mcp-my-connections">
          {connections.map((entry) => {
            const state = entry.connection?.state ?? "not_connected";
            const connected = state === "connected";
            return (
              <li key={entry.serverId} className="mcp-oauth">
                <div className="mcp-oauth-head">
                  <div>
                    <h4>{entry.serverName}</h4>
                    <span className={`mcp-oauth-state is-${state.replace("_", "-")}`}>
                      {connected && entry.connection?.subject ? `Connected as ${entry.connection.subject}` : CONNECTION_STATE_LABEL[state]}
                    </span>
                  </div>
                  <div className="page-actions">
                    <button type="button" className="pg-btn primary" onClick={() => void connect(entry.serverId)} disabled={busy !== null}>
                      {busy === entry.serverId ? "Waiting for sign-in…" : connected ? "Reconnect" : "Connect"}
                    </button>
                    {entry.connection && (
                      <button type="button" className="pg-btn ghost danger" onClick={() => void disconnect(entry)} disabled={busy !== null}>
                        Disconnect
                      </button>
                    )}
                  </div>
                </div>
                {entry.description && <p className="kb-subtle">{entry.description}</p>}
                {entry.connection?.lastError && state !== "connected" && <div className="settings-error">{entry.connection.lastError}</div>}
                <dl className="mcp-oauth-facts">
                  <dt>Connected</dt>
                  <dd>{formatDate(entry.connection?.connectedAt)}</dd>
                  <dt>Expires</dt>
                  <dd>
                    {formatDate(entry.connection?.expiresAt)}
                    {entry.connection?.hasRefreshToken ? " (renews automatically)" : ""}
                  </dd>
                  <dt>Scope</dt>
                  <dd>{entry.connection?.scope ?? "—"}</dd>
                  <dt>Unattended runs</dt>
                  <dd>
                    {entry.delegatedFallback === "owner"
                      ? "use the connection of the workflow's owner"
                      : "cannot use this server (no person to act for)"}
                  </dd>
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
