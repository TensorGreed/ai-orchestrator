/**
 * Phase 10.5 — the form a person fills when an MCP server asks for input
 * during a run (`elicitation/create`). The schema the server sent is flat
 * and primitive, so the fields come from the same generator the playground
 * uses. Accept validates and sends the values; decline and cancel send only
 * the action. Credential-looking fields are refused here as well as on the
 * server: elicitation never carries secrets.
 */

import { useEffect, useMemo, useState } from "react";
import type { McpElicitationAction, McpElicitationView } from "@ai-orchestrator/shared";
import { ApiError, answerMcpElicitation } from "../lib/api";
import { buildSchemaForm, collectArgs, initialFormValues, type FormValue, type FormValues } from "../lib/mcp-schema-form";
import { McpSchemaForm } from "./McpSchemaForm";

/** Same heuristic as the API and the config importer. */
const CREDENTIAL_NAME = /(token|key|secret|passw|pwd|auth|credential|cookie|(^|[-_])pat($|[-_]))/i;

export function credentialLikeFields(elicitation: Pick<McpElicitationView, "requestedSchema">): string[] {
  return Object.keys(elicitation.requestedSchema?.properties ?? {}).filter((name) => CREDENTIAL_NAME.test(name));
}

export const ELICITATION_STATUS_LABELS: Record<McpElicitationView["status"], string> = {
  pending: "Waiting for your answer",
  accepted: "Answered",
  declined: "Declined",
  cancelled: "Cancelled",
  expired: "Expired",
  auto_declined: "Declined automatically"
};

function formatError(error: unknown): string {
  if (error instanceof ApiError) {
    const details = (error.payload as { details?: unknown } | undefined)?.details;
    if (Array.isArray(details) && details.length > 0) return `${error.message}: ${details.map(String).join("; ")}`;
    return error.message;
  }
  return error instanceof Error ? error.message : "Unexpected error";
}

function remaining(expiresAt: string, now: number): string | null {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "deadline passed";
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return minutes > 0 ? `${minutes} min ${seconds} s left` : `${seconds} s left`;
}

interface McpElicitationFormProps {
  elicitation: McpElicitationView;
  /** Called with the settled request after the API accepted the answer. */
  onAnswered?: (elicitation: McpElicitationView) => void;
  /** Smaller chrome for the chat bubble. */
  compact?: boolean;
}

export function McpElicitationForm({ elicitation, onAnswered, compact = false }: McpElicitationFormProps) {
  const form = useMemo(() => buildSchemaForm(elicitation.requestedSchema), [elicitation.requestedSchema]);
  const [values, setValues] = useState<FormValues>(() => initialFormValues(elicitation.requestedSchema, form.fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<McpElicitationAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const pending = elicitation.status === "pending";
  const refused = credentialLikeFields(elicitation);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pending]);

  const onFieldChange = (path: string, value: FormValue) => {
    setValues((current) => ({ ...current, [path]: value }));
    setErrors((current) => {
      if (!current[path]) return current;
      const { [path]: _removed, ...rest } = current;
      return rest;
    });
  };

  const send = async (action: McpElicitationAction) => {
    let content: Record<string, string | number | boolean> | undefined;
    if (action === "accept") {
      if (!form.fields) {
        setError("This request cannot be answered from the form.");
        return;
      }
      const collected = collectArgs(form.fields, values);
      setErrors(collected.errors);
      if (Object.keys(collected.errors).length > 0) return;
      content = Object.fromEntries(
        Object.entries(collected.args).filter(
          (entry): entry is [string, string | number | boolean] =>
            typeof entry[1] === "string" || typeof entry[1] === "number" || typeof entry[1] === "boolean"
        )
      );
    }
    setBusy(action);
    setError(null);
    try {
      const result = await answerMcpElicitation(elicitation.id, { action, ...(content ? { content } : {}) });
      onAnswered?.(result.elicitation);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(null);
    }
  };

  const timeLeft = pending ? remaining(elicitation.expiresAt, now) : null;
  const where = [elicitation.serverName ?? elicitation.serverId, elicitation.toolName].filter(Boolean).join(" · ");

  return (
    <section className={compact ? "mcp-elicit is-compact" : "mcp-elicit"} aria-label="Server question" data-testid="mcp-elicitation">
      <header className="mcp-elicit-head">
        <span className="mcp-elicit-badge" aria-hidden="true">?</span>
        <div className="mcp-elicit-title">
          <strong>{pending ? "The server needs your input" : ELICITATION_STATUS_LABELS[elicitation.status]}</strong>
          <span className="kb-subtle">
            {where}
            {!compact && elicitation.workflowName ? ` · ${elicitation.workflowName}` : ""}
            {timeLeft ? ` · ${timeLeft}` : ""}
          </span>
        </div>
      </header>
      <p className="mcp-elicit-message">{elicitation.message}</p>
      {pending && refused.length > 0 ? (
        <div className="settings-error" role="alert">
          This request asks for credentials ({refused.join(", ")}). Secrets are never collected through a server question; it
          can only be declined. Store the credential as a secret on the server instead.
        </div>
      ) : pending ? (
        <p className="mcp-elicit-warning" role="note">
          Never type passwords, API keys or other secrets here. Your answer goes to the MCP server as it is.
        </p>
      ) : null}
      {pending && refused.length === 0 && form.fields && (
        <McpSchemaForm fields={form.fields} values={values} errors={errors} disabled={busy !== null} onChange={onFieldChange} />
      )}
      {!pending && elicitation.reason && <p className="kb-subtle">{elicitation.reason}</p>}
      {!pending && elicitation.answeredBy && (
        <p className="kb-subtle">
          by {elicitation.answeredBy}
          {elicitation.answeredAt ? ` at ${new Date(elicitation.answeredAt).toLocaleTimeString()}` : ""}
        </p>
      )}
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
      {pending && (
        <div className="mcp-form-actions">
          {refused.length === 0 && (
            <button type="button" className="pg-btn primary" onClick={() => void send("accept")} disabled={busy !== null}>
              {busy === "accept" ? "Sending…" : "Send answer"}
            </button>
          )}
          <button type="button" className="pg-btn ghost" onClick={() => void send("decline")} disabled={busy !== null}>
            {busy === "decline" ? "Declining…" : "Decline"}
          </button>
          <button type="button" className="pg-btn ghost" onClick={() => void send("cancel")} disabled={busy !== null} title="Tell the server you cancelled rather than declined">
            {busy === "cancel" ? "Cancelling…" : "Cancel"}
          </button>
        </div>
      )}
    </section>
  );
}
