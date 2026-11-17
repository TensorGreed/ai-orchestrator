import { useState } from "react";
import type { DocumentScanRequest, DocumentScanResult } from "@ai-orchestrator/shared";
import { ApiError, scanGuardDocument } from "../lib/api";

/**
 * "Scan a document" on a rule set: an uploaded file (read in the browser and sent as base64) or a URL, checked with
 * the rule set's unsaved changes or its latest version. Shows each finding's location, data class, score and masked
 * preview, the risk level, and optionally the text with findings replaced. Nothing is saved.
 */

type Redact = "" | "mask" | "placeholder";

const KIND_LABEL: Record<string, string> = { text: "Plain text", markdown: "Markdown", html: "HTML", json: "JSON", csv: "CSV" };

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

/** A file's bytes as base64, in chunks (a large file would overflow a single String.fromCharCode call). */
export async function fileToBase64(file: Blob): Promise<string> {
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read"));
    reader.readAsArrayBuffer(file);
  });
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function GuardDocumentScanPanel({ profileId, draft }: { profileId: string; draft: Record<string, unknown> | null }) {
  const [mode, setMode] = useState<"upload" | "url">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [redact, setRedact] = useState<Redact>("");
  const [useDraft, setUseDraft] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DocumentScanResult | null>(null);
  const [showRedacted, setShowRedacted] = useState(false);
  const [dragging, setDragging] = useState(false);

  const ready = mode === "upload" ? file !== null : url.trim().length > 0;

  const scan = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const source: DocumentScanRequest["source"] =
        mode === "upload"
          ? { kind: "upload", contentBase64: await fileToBase64(file!), filename: file!.name.slice(0, 255), ...(file!.type ? { mediaType: file!.type } : {}) }
          : { kind: "url", url: url.trim() };
      const response = await scanGuardDocument(profileId, {
        source,
        ...(draft && useDraft ? { document: draft } : {}),
        ...(redact ? { redact } : {})
      });
      setResult(response.result);
      setShowRedacted(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="kb-section guard-document-scan" aria-label="Scan a document">
      <h4>Scan a document</h4>
      <p className="kb-subtle">
        Check a text, Markdown, HTML, JSON or CSV document with this rule set&apos;s data checks. Nothing is saved; PDF and Office files are not supported yet.
      </p>
      <div className="finops-range" role="radiogroup" aria-label="Document source">
        {(["upload", "url"] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            role="radio"
            aria-checked={mode === entry}
            className={mode === entry ? "finops-range-btn active" : "finops-range-btn"}
            onClick={() => setMode(entry)}
          >
            {entry === "upload" ? "Upload" : "URL"}
          </button>
        ))}
      </div>
      {mode === "upload" ? (
        <div
          className={dragging ? "guard-document-drop active" : "guard-document-drop"}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const dropped = event.dataTransfer.files[0];
            if (dropped) setFile(dropped);
          }}
        >
          <label>
            Document
            <input type="file" accept=".txt,.md,.markdown,.html,.htm,.json,.csv,.tsv,text/*,application/json" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </label>
          <span className="kb-subtle">{file ? `${file.name} (${formatBytes(file.size)})` : "or drop a file here"}</span>
        </div>
      ) : (
        <div>
          <label>
            Document URL
            <input type="url" placeholder="https://example.com/page.html" value={url} onChange={(event) => setUrl(event.target.value)} />
          </label>
          <small className="kb-subtle">Fetched by the server under the deployment&apos;s outbound URL checks, without cookies or credentials.</small>
        </div>
      )}
      <div className="guard-save-row">
        <label>
          Redacted text
          <select aria-label="Redacted text" value={redact} onChange={(event) => setRedact(event.target.value as Redact)}>
            <option value="">Do not show</option>
            <option value="mask">Masked values</option>
            <option value="placeholder">Placeholders ([EMAIL_1])</option>
          </select>
        </label>
        {draft && (
          <label className="guard-check">
            <input type="checkbox" checked={useDraft} onChange={(event) => setUseDraft(event.target.checked)} />
            <span>Use unsaved changes</span>
          </label>
        )}
        <button type="button" className="pg-btn primary" disabled={!ready || busy} onClick={() => void scan()}>
          {busy ? "Scanning…" : "Scan document"}
        </button>
      </div>
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
      {result && <DocumentScanResultView result={result} showRedacted={showRedacted} onShowRedacted={setShowRedacted} />}
    </section>
  );
}

function DocumentScanResultView({ result, showRedacted, onShowRedacted }: { result: DocumentScanResult; showRedacted: boolean; onShowRedacted: (value: boolean) => void }) {
  const counts = Object.entries(result.countsByClass);
  return (
    <div className="guard-document-result" role="status" aria-label="Scan result">
      <p>
        <strong>Risk: {result.riskLevel}</strong> · {KIND_LABEL[result.sniffedType] ?? result.sniffedType}, {formatBytes(result.bytes)}
        {result.typeMismatch && <> · read as {KIND_LABEL[result.sniffedType] ?? result.sniffedType}, not as the declared {result.mediaType ?? "type"}</>}
        {counts.length > 0 ? <> · {counts.map(([dataClass, count]) => `${count} ${dataClass}`).join(", ")}</> : <> · no findings</>}
      </p>
      {result.truncated && result.covered && (
        <p className="kb-subtle" role="note">
          Only the first {result.covered.chars.toLocaleString()} of {result.covered.of.toLocaleString()} characters were checked.
        </p>
      )}
      {result.findings.length > 0 && (
        <div className="mcp-table-scroll">
          <table className="kb-table">
            <thead>
              <tr>
                <th>Location</th>
                <th>Data class</th>
                <th className="num">Score</th>
                <th>Preview</th>
              </tr>
            </thead>
            <tbody>
              {result.findings.map((finding, index) => (
                <tr key={`${finding.location.label}-${index}`}>
                  <td>{finding.location.label}</td>
                  <td className="mono-cell">{finding.dataClass}</td>
                  <td className="num">{finding.score.toFixed(2)}</td>
                  <td className="mono-cell">{finding.maskedPreview}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.findingsTruncated && <p className="kb-subtle">The first {result.findings.length} findings are listed; the counts cover all of them.</p>}
      {result.redacted && (
        <>
          <label className="guard-check">
            <input type="checkbox" checked={showRedacted} onChange={(event) => onShowRedacted(event.target.checked)} />
            <span>Show redacted text</span>
          </label>
          {showRedacted && <textarea className="guard-json" aria-label="Redacted text" rows={10} readOnly value={result.redacted.text} />}
        </>
      )}
    </div>
  );
}
