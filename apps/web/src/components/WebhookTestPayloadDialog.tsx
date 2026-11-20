/**
 * The body "Webhook run" sends: what `{{webhook.<field>}}` reads in the run. It is kept in the workflow's settings
 * (saved with the workflow and shown to everyone who can read it), so fields named like credentials are refused.
 */
import { useEffect, useId, useRef, useState } from "react";
import { TEST_WEBHOOK_PAYLOAD_MAX_CHARS, testWebhookPayloadCredentialFields } from "@ai-orchestrator/shared";

/** The text the editor starts from: the saved payload, or an empty object. */
export function testPayloadText(payload: Record<string, unknown> | undefined): string {
  return payload && Object.keys(payload).length > 0 ? JSON.stringify(payload, null, 2) : "{}";
}

/** Reads the typed payload: a JSON object without credential fields, within the size limit. */
export function parseTestPayload(text: string): { payload: Record<string, unknown> } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { payload: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return { error: `Not valid JSON: ${error instanceof Error ? error.message : "parse error"}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "The payload must be a JSON object, such as {\"customer\": \"Ana\"}." };
  }
  if (JSON.stringify(parsed).length > TEST_WEBHOOK_PAYLOAD_MAX_CHARS) {
    return { error: `The payload is larger than ${TEST_WEBHOOK_PAYLOAD_MAX_CHARS / 1024} KB.` };
  }
  const credentials = testWebhookPayloadCredentialFields(parsed);
  if (credentials.length > 0) {
    return {
      error: `The test payload is saved with the workflow, so it cannot hold credentials. Remove ${credentials.join(", ")}, or use a secret in the node instead.`
    };
  }
  return { payload: parsed as Record<string, unknown> };
}

interface WebhookTestPayloadDialogProps {
  payload: Record<string, unknown> | undefined;
  /** The workflow's webhook is switched off: its URL and test URL refuse calls, this run does not. */
  webhookOff?: boolean;
  busy?: boolean;
  /** Runs with the payload, which the caller keeps in the workflow's settings. */
  onRun: (payload: Record<string, unknown>) => void;
  onClose: () => void;
}

export function WebhookTestPayloadDialog({ payload, webhookOff, busy, onRun, onClose }: WebhookTestPayloadDialogProps) {
  const fieldId = useId();
  const helpId = useId();
  const [text, setText] = useState(() => testPayloadText(payload));
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    textRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const submit = () => {
    const result = parseTestPayload(text);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setError(null);
    onRun(result.payload);
  };

  return (
    <div className="pg-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="pg-modal write-gate-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="webhook-test-payload-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="pg-modal-header">
          <div>
            <h3 id="webhook-test-payload-title" className="pg-modal-title">
              Webhook run
            </h3>
            <p className="settings-help" id={helpId}>
              The request body this run receives, as a call to the webhook URL sends it. Nodes read its fields as{" "}
              <code>{"{{webhook.customer}}"}</code>. It is saved with the workflow, so keep credentials out of it.
            </p>
          </div>
        </header>
        <div className="pg-modal-body">
          {webhookOff ? (
            <p className="cfg-tip" role="note" data-testid="webhook-run-off-note">
              A webhook in this workflow is off: its URL and test URL answer &quot;not found&quot; until you turn it on.
              Webhook run from the editor still works.
            </p>
          ) : null}
          <div className="cfg-field">
            <label className="cfg-label" htmlFor={fieldId}>
              Test payload (JSON)
            </label>
            <textarea
              id={fieldId}
              ref={textRef}
              className="cfg-input webhook-test-payload"
              rows={10}
              spellCheck={false}
              aria-describedby={helpId}
              aria-invalid={error ? true : undefined}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </div>
          {error ? (
            <div className="error-banner" role="alert">
              {error}
            </div>
          ) : null}
          <div className="webhook-test-actions">
            <button type="button" className="pg-btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="pg-btn primary" onClick={submit} disabled={busy}>
              Run
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
