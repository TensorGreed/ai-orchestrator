import { useEffect, useState } from "react";
import type { RunManifestView } from "@ai-orchestrator/shared";
import { ApiError, downloadAuditBundle, fetchExecutionManifest } from "../lib/api";
import { CopyButton } from "./McpToolsetsView";

const IN_PROGRESS = new Set(["running", "pending", "queued", "waiting_approval"]);

export function isAuditableRun(status: string, completedAt: string | null | undefined): boolean {
  return !IN_PROGRESS.has(status) && Boolean(completedAt);
}

function shortDigest(digest: string): string {
  return digest.length > 24 ? `${digest.slice(0, 12)}…${digest.slice(-8)}` : digest;
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return "The run is still in progress. Export it once it has finished.";
    if (error.status === 403) return "You don't have access to this run's workflow.";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Phase 11.1 — the signed manifest of a finished run (digest, signing key,
 * signed-at and what it covers) and the audit bundle download. Recent runs
 * get their manifest on first view; it never changes afterwards.
 */
export function AuditBundlePanel({ executionId, status, completedAt }: { executionId: string; status: string; completedAt: string | null | undefined }) {
  const auditable = isAuditableRun(status, completedAt);
  const [view, setView] = useState<RunManifestView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    if (!auditable) return;
    let cancelled = false;
    setError(null);
    fetchExecutionManifest(executionId)
      .then((response) => {
        if (!cancelled) setView(response);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [auditable, executionId]);

  if (!auditable) return null;

  const download = async () => {
    setBusy(true);
    setDownloadError(null);
    try {
      const bundle = await downloadAuditBundle(executionId);
      const href = URL.createObjectURL(bundle.blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = bundle.fileName;
      anchor.click();
      URL.revokeObjectURL(href);
    } catch (err) {
      setDownloadError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const manifest = view?.manifest;
  return (
    <section className="audit-bundle" aria-label="Audit bundle">
      <header className="audit-bundle-head">
        <span className="pg-eyebrow">Signed manifest</span>
        {manifest && (
          <span className="audit-bundle-count">
            {manifest.nodes.length} nodes · {manifest.modelCalls.length} model call{manifest.modelCalls.length === 1 ? "" : "s"} · {manifest.toolCalls.length} tool call
            {manifest.toolCalls.length === 1 ? "" : "s"} · {manifest.citations.length} citation{manifest.citations.length === 1 ? "" : "s"}
          </span>
        )}
        <button type="button" className="pg-btn small audit-bundle-action" onClick={() => void download()} disabled={busy}>
          {busy ? "Preparing…" : "Audit bundle"}
        </button>
      </header>
      {error && <div className="audit-bundle-error" role="alert">{error}</div>}
      {downloadError && <div className="audit-bundle-error" role="alert">{downloadError}</div>}
      {!view && !error && <div className="page-hint">Loading manifest…</div>}
      {view && (
        <dl className="audit-bundle-facts">
          <div>
            <dt>Manifest digest</dt>
            <dd>
              <code className="mono-cell" title={view.digest}>
                sha256 {shortDigest(view.digest)}
              </code>
              <CopyButton text={view.digest} ariaLabel="Copy manifest digest" />
            </dd>
          </div>
          <div>
            <dt>Signing key</dt>
            <dd>
              <code className="mono-cell">{view.keyId}</code>
              <span className="audit-bundle-muted">{view.algorithm}</span>
            </dd>
          </div>
          <div>
            <dt>Signed at</dt>
            <dd>
              <time dateTime={view.signedAt}>{new Date(view.signedAt).toLocaleString()}</time>
            </dd>
          </div>
          {manifest && (
            <div>
              <dt>Workflow</dt>
              <dd>
                <span>
                  v{manifest.workflow.workflowVersion ?? "?"}
                  {manifest.workflow.source === "current" ? " (definition at export time)" : manifest.workflow.source === "unavailable" ? " (definition unavailable)" : ""}
                </span>
                <code className="mono-cell" title={manifest.workflow.hash}>
                  {shortDigest(manifest.workflow.hash)}
                </code>
              </dd>
            </div>
          )}
        </dl>
      )}
      <p className="audit-bundle-hint">
        Verify a bundle offline with <code>l2m audit verify &lt;bundle.zip&gt; --public-key &lt;key&gt;</code>.
      </p>
    </section>
  );
}
