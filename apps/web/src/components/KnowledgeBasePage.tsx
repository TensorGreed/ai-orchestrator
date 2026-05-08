/**
 * Phase 9.2 — Knowledge Base management UI.
 *
 * Single-pane layout: list on the left, detail/upload/search on the right.
 * Mirrors the Settings page sidebar pattern (grouped vertical nav) so the
 * Studio reads as one product.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  type ChunkOptions,
  type ChunkStrategy,
  type DocumentKind,
  type KnowledgeBase,
  type KnowledgeBaseChunkPreview,
  type KnowledgeBaseSource,
  createKnowledgeBase,
  deleteKnowledgeBaseApi,
  deleteKnowledgeBaseSource,
  fetchKnowledgeBase,
  fetchKnowledgeBaseChunks,
  fetchKnowledgeBases,
  searchKnowledgeBase,
  uploadKnowledgeBaseDocument
} from "../lib/api";

const EMBEDDER_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  { value: "token-embedder", label: "Token (built-in, demo only)", hint: "Zero-deps 64-d hash. Quality is poor — use only to demo the pipeline." },
  { value: "openai-embedder", label: "OpenAI (text-embedding-3-small)", hint: "Requires OPENAI_API_KEY or a secretRef in embedderConfig." },
  { value: "azure-openai-embedder", label: "Azure OpenAI", hint: "Set endpoint/deployment in embedderConfig." },
  { value: "cohere-embedder", label: "Cohere (embed-english-v3.0)", hint: "Requires COHERE_API_KEY." },
  { value: "mistral-embedder", label: "Mistral (mistral-embed)", hint: "Requires MISTRAL_API_KEY." },
  { value: "google-vertex-embedder", label: "Google Vertex (text-embedding-004)", hint: "Requires GEMINI_API_KEY." },
  { value: "huggingface-embedder", label: "HuggingFace (all-MiniLM-L6-v2)", hint: "Requires HUGGINGFACE_API_KEY." }
];

const CHUNK_STRATEGIES: Array<{ value: ChunkStrategy; label: string; hint: string }> = [
  { value: "separator", label: "Separator (paragraph-aware)", hint: "Default. Splits on \\n\\n, packs into chunkSize." },
  { value: "recursive", label: "Recursive", hint: "Cascades through \\n\\n → \\n → '. ' → ' ' until pieces fit." },
  { value: "character", label: "Character", hint: "Fixed-width sliding window over chars." },
  { value: "token", label: "Token (approximate)", hint: "1 token ≈ 4 chars; snaps to word boundaries." }
];

const KIND_OPTIONS: Array<{ value: DocumentKind; label: string }> = [
  { value: "text", label: "Plain text" },
  { value: "markdown", label: "Markdown" },
  { value: "html", label: "HTML" },
  { value: "csv", label: "CSV" },
  { value: "json", label: "JSON / NDJSON" }
];

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

function formatRelativeDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

interface KnowledgeBasePageProps {
  isAdmin: boolean;
  activeProjectId?: string | null;
}

export function KnowledgeBasePage({ isAdmin, activeProjectId }: KnowledgeBasePageProps) {
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const refreshList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchKnowledgeBases(activeProjectId ?? undefined);
      setBases(r.knowledgeBases);
      if (!selectedId && r.knowledgeBases.length > 0) {
        setSelectedId(r.knowledgeBases[0]!.id);
      } else if (selectedId && !r.knowledgeBases.some((kb) => kb.id === selectedId)) {
        setSelectedId(r.knowledgeBases[0]?.id ?? null);
      }
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [activeProjectId, selectedId]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  return (
    <section className="kb-page">
      <header className="kb-header">
        <div>
          <h2>Knowledge Bases</h2>
          <p className="kb-subtle">
            Persistent SQLite-backed vector store. Upload documents, chunk + embed them, then reference the KB id from a <code>rag_retrieve</code> node with <code>vectorStoreId: "knowledge-base"</code>.
          </p>
        </div>
        {isAdmin && (
          <button type="button" className="header-btn primary" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Cancel" : "+ New knowledge base"}
          </button>
        )}
      </header>

      {error && <div className="settings-error">{error}</div>}

      {showCreate && isAdmin && (
        <CreateKbForm
          projectId={activeProjectId ?? null}
          onCreated={async (kb) => {
            setShowCreate(false);
            await refreshList();
            setSelectedId(kb.id);
          }}
          onError={setError}
        />
      )}

      <div className="kb-layout">
        <aside className="kb-list">
          {loading && bases.length === 0 ? (
            <p className="kb-subtle">Loading…</p>
          ) : bases.length === 0 ? (
            <p className="kb-subtle">No knowledge bases yet. {isAdmin ? "Click \"+ New knowledge base\" to create one." : "Ask an admin to create one."}</p>
          ) : (
            bases.map((kb) => (
              <button
                key={kb.id}
                type="button"
                className={selectedId === kb.id ? "kb-item active" : "kb-item"}
                onClick={() => setSelectedId(kb.id)}
              >
                <div className="kb-item-name">{kb.name}</div>
                <div className="kb-item-meta">
                  <span>{kb.embedderId.replace("-embedder", "")}</span>
                  <span>·</span>
                  <span>{kb.chunkCount.toLocaleString()} chunks</span>
                  {kb.dimensions > 0 && (
                    <>
                      <span>·</span>
                      <span>{kb.dimensions}-d</span>
                    </>
                  )}
                </div>
              </button>
            ))
          )}
        </aside>

        <div className="kb-detail">
          {selectedId ? (
            <KnowledgeBaseDetail
              key={selectedId}
              kbId={selectedId}
              isAdmin={isAdmin}
              onDeleted={async () => {
                setSelectedId(null);
                await refreshList();
              }}
              onChanged={refreshList}
            />
          ) : (
            <p className="kb-subtle">Select a knowledge base on the left, or create one to get started.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function CreateKbForm({
  projectId,
  onCreated,
  onError
}: {
  projectId: string | null;
  onCreated: (kb: KnowledgeBase) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [embedderId, setEmbedderId] = useState("token-embedder");
  const [embedderConfigJson, setEmbedderConfigJson] = useState("{}");
  const [busy, setBusy] = useState(false);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      let parsedConfig: Record<string, unknown> = {};
      if (embedderConfigJson.trim()) {
        try {
          parsedConfig = JSON.parse(embedderConfigJson) as Record<string, unknown>;
        } catch {
          throw new Error("embedderConfig is not valid JSON");
        }
      }
      const res = await createKnowledgeBase({
        name: name.trim(),
        description: description.trim() || null,
        projectId,
        embedderId,
        embedderConfig: parsedConfig
      });
      await onCreated(res.knowledgeBase);
    } catch (err) {
      onError(formatError(err));
    } finally {
      setBusy(false);
    }
  }, [name, description, embedderId, embedderConfigJson, projectId, onCreated, onError]);

  const selectedEmbedder = EMBEDDER_OPTIONS.find((e) => e.value === embedderId);

  return (
    <form onSubmit={handleSubmit} className="kb-create-form">
      <div className="kb-form-row kb-form-row-2">
        <label>Name<input type="text" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Helpdesk corpus" /></label>
        <label>Description<input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Q1 support transcripts" /></label>
      </div>
      <div className="kb-form-row">
        <label>Embedder
          <select value={embedderId} onChange={(e) => setEmbedderId(e.target.value)}>
            {EMBEDDER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {selectedEmbedder && <small className="kb-subtle">{selectedEmbedder.hint}</small>}
        </label>
      </div>
      <div className="kb-form-row">
        <label>embedderConfig (JSON)
          <textarea
            value={embedderConfigJson}
            onChange={(e) => setEmbedderConfigJson(e.target.value)}
            rows={4}
            spellCheck={false}
            placeholder='{ "model": "text-embedding-3-small", "secretRef": { "secretId": "sec_..." } }'
          />
        </label>
      </div>
      <div className="kb-form-row">
        <button type="submit" className="header-btn primary" disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "Create knowledge base"}
        </button>
      </div>
    </form>
  );
}

function KnowledgeBaseDetail({
  kbId,
  isAdmin,
  onDeleted,
  onChanged
}: {
  kbId: string;
  isAdmin: boolean;
  onDeleted: () => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const [kb, setKb] = useState<KnowledgeBase | null>(null);
  const [sources, setSources] = useState<KnowledgeBaseSource[]>([]);
  const [chunks, setChunks] = useState<KnowledgeBaseChunkPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [detail, ch] = await Promise.all([
        fetchKnowledgeBase(kbId),
        fetchKnowledgeBaseChunks(kbId, { limit: 25 })
      ]);
      setKb(detail.knowledgeBase);
      setSources(detail.sources);
      setChunks(ch.chunks);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [kbId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleDelete = useCallback(async () => {
    if (!kb) return;
    if (!window.confirm(`Delete knowledge base "${kb.name}" and all ${kb.chunkCount} chunks? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await deleteKnowledgeBaseApi(kbId);
      await onDeleted();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }, [kb, kbId, onDeleted]);

  const handleDeleteSource = useCallback(async (sourceId: string) => {
    if (!window.confirm(`Delete all chunks under source "${sourceId}"?`)) return;
    setBusy(true);
    try {
      await deleteKnowledgeBaseSource(kbId, sourceId);
      await refresh();
      await onChanged();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }, [kbId, refresh, onChanged]);

  if (loading && !kb) return <p className="kb-subtle">Loading…</p>;
  if (!kb) return <p className="kb-subtle">{error ?? "Knowledge base not found."}</p>;

  return (
    <div className="kb-detail-pane">
      {error && <div className="settings-error">{error}</div>}

      <header className="kb-detail-header">
        <div>
          <h3>{kb.name}</h3>
          {kb.description && <p className="kb-subtle">{kb.description}</p>}
          <div className="kb-detail-meta">
            <span><strong>{kb.chunkCount.toLocaleString()}</strong> chunks</span>
            <span>·</span>
            <span><strong>{kb.dimensions || "—"}</strong> dimensions</span>
            <span>·</span>
            <span>embedder <code>{kb.embedderId}</code></span>
            <span>·</span>
            <span>updated {formatRelativeDate(kb.updatedAt)}</span>
          </div>
        </div>
        {isAdmin && (
          <button type="button" className="header-btn danger" onClick={() => void handleDelete()} disabled={busy}>
            Delete KB
          </button>
        )}
      </header>

      <UploadPanel kbId={kbId} onUploaded={async () => { await refresh(); await onChanged(); }} onError={setError} />

      <SearchPanel kbId={kbId} onError={setError} />

      <section className="kb-section">
        <h4>Sources ({sources.length})</h4>
        {sources.length === 0 ? (
          <p className="kb-subtle">No sources yet. Upload a document above.</p>
        ) : (
          <table className="kb-table">
            <thead>
              <tr>
                <th>Source ID</th>
                <th className="num">Chunks</th>
                {isAdmin && <th></th>}
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.sourceId}>
                  <td><code>{s.sourceId}</code></td>
                  <td className="num">{s.chunkCount}</td>
                  {isAdmin && (
                    <td>
                      <button type="button" className="kb-link-btn" onClick={() => void handleDeleteSource(s.sourceId)} disabled={busy}>
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="kb-section">
        <h4>Chunks (preview, first 25)</h4>
        {chunks.length === 0 ? (
          <p className="kb-subtle">No chunks yet.</p>
        ) : (
          <ul className="kb-chunk-list">
            {chunks.map((c) => (
              <li key={c.id} className="kb-chunk-item">
                <div className="kb-chunk-meta">
                  <span>#{c.chunkIndex}</span>
                  {c.sourceId && <span><code>{c.sourceId}</code></span>}
                </div>
                <div className="kb-chunk-content">{c.content}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function UploadPanel({
  kbId,
  onUploaded,
  onError
}: {
  kbId: string;
  onUploaded: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [filename, setFilename] = useState("");
  const [content, setContent] = useState("");
  const [kindOverride, setKindOverride] = useState<DocumentKind | "auto">("auto");
  const [sourceId, setSourceId] = useState("");
  const [strategy, setStrategy] = useState<ChunkStrategy>("recursive");
  const [chunkSize, setChunkSize] = useState("800");
  const [chunkOverlap, setChunkOverlap] = useState("80");
  const [csvTextColumn, setCsvTextColumn] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<{ sourceId: string; documentsLoaded: number; chunksInserted: number } | null>(null);

  const effectiveKind: DocumentKind = useMemo(() => {
    if (kindOverride !== "auto") return kindOverride;
    if (filename) {
      const lower = filename.toLowerCase();
      if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
      if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
      if (lower.endsWith(".csv")) return "csv";
      if (lower.endsWith(".json") || lower.endsWith(".ndjson")) return "json";
    }
    return "text";
  }, [filename, kindOverride]);

  const handleFile = useCallback(async (file: File) => {
    setFilename(file.name);
    setContent(await file.text());
  }, []);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) {
      onError("Content is empty.");
      return;
    }
    setBusy(true);
    try {
      const chunking: ChunkOptions = {
        strategy,
        chunkSize: Number(chunkSize),
        chunkOverlap: Number(chunkOverlap)
      };
      const res = await uploadKnowledgeBaseDocument(kbId, {
        filename: filename || undefined,
        kind: effectiveKind,
        content,
        sourceId: sourceId.trim() || undefined,
        chunking,
        csv: effectiveKind === "csv" && csvTextColumn.trim()
          ? { textColumn: csvTextColumn.trim() }
          : undefined
      });
      setLastResult(res);
      setContent("");
      setFilename("");
      setSourceId("");
      await onUploaded();
    } catch (err) {
      onError(formatError(err));
    } finally {
      setBusy(false);
    }
  }, [content, strategy, chunkSize, chunkOverlap, kbId, filename, effectiveKind, sourceId, csvTextColumn, onUploaded, onError]);

  return (
    <section className="kb-section">
      <h4>Upload a document</h4>
      <form onSubmit={handleSubmit} className="kb-create-form">
        <div className="kb-form-row kb-form-row-2">
          <label>File
            <input
              type="file"
              accept=".txt,.md,.markdown,.html,.htm,.csv,.json,.ndjson"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />
          </label>
          <label>Source ID (optional)
            <input type="text" value={sourceId} onChange={(e) => setSourceId(e.target.value)} placeholder="auto-generated if empty" />
          </label>
        </div>
        <div className="kb-form-row kb-form-row-2">
          <label>Kind
            <select value={kindOverride} onChange={(e) => setKindOverride(e.target.value as DocumentKind | "auto")}>
              <option value="auto">Auto-detect from filename</option>
              {KIND_OPTIONS.map((k) => (
                <option key={k.value} value={k.value}>{k.label}</option>
              ))}
            </select>
            <small className="kb-subtle">Detected: {effectiveKind}</small>
          </label>
          {effectiveKind === "csv" && (
            <label>CSV text column<input type="text" value={csvTextColumn} onChange={(e) => setCsvTextColumn(e.target.value)} placeholder="body" /></label>
          )}
        </div>
        <div className="kb-form-row">
          <label>Content (or pick a file above)
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={6}
              spellCheck={false}
              placeholder="Paste text, markdown, HTML, CSV, or JSON here…"
            />
          </label>
        </div>
        <div className="kb-form-row kb-form-row-3">
          <label>Strategy
            <select value={strategy} onChange={(e) => setStrategy(e.target.value as ChunkStrategy)}>
              {CHUNK_STRATEGIES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </label>
          <label>Chunk size<input type="number" min="50" value={chunkSize} onChange={(e) => setChunkSize(e.target.value)} /></label>
          <label>Overlap<input type="number" min="0" value={chunkOverlap} onChange={(e) => setChunkOverlap(e.target.value)} /></label>
        </div>
        <div className="kb-form-row">
          <button type="submit" className="header-btn primary" disabled={busy || !content.trim()}>
            {busy ? "Ingesting…" : "Upload & ingest"}
          </button>
        </div>
        {lastResult && (
          <div className="kb-success">
            ✓ Ingested <strong>{lastResult.chunksInserted}</strong> chunk{lastResult.chunksInserted === 1 ? "" : "s"} from {lastResult.documentsLoaded} document{lastResult.documentsLoaded === 1 ? "" : "s"} under source <code>{lastResult.sourceId}</code>.
          </div>
        )}
      </form>
    </section>
  );
}

function SearchPanel({ kbId, onError }: { kbId: string; onError: (msg: string) => void }) {
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState("5");
  const [results, setResults] = useState<Array<{ id: string; text: string; metadata: Record<string, unknown> & { sourceId?: string | null; similarityScore?: number } }>>([]);
  const [busy, setBusy] = useState(false);

  const handleSearch = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    try {
      const r = await searchKnowledgeBase(kbId, query, Number(topK));
      setResults(r.results);
    } catch (err) {
      onError(formatError(err));
    } finally {
      setBusy(false);
    }
  }, [query, topK, kbId, onError]);

  return (
    <section className="kb-section">
      <h4>Test search</h4>
      <p className="kb-subtle">
        Run a similarity search using the KB's configured embedder. Useful for sanity-checking retrieval before wiring it into a workflow.
      </p>
      <form onSubmit={handleSearch} className="kb-create-form">
        <div className="kb-form-row kb-form-row-2">
          <label>Query<input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="how do I reset my password" required /></label>
          <label>Top K<input type="number" min="1" max="50" value={topK} onChange={(e) => setTopK(e.target.value)} /></label>
        </div>
        <div className="kb-form-row">
          <button type="submit" className="header-btn primary" disabled={busy || !query.trim()}>
            {busy ? "Searching…" : "Search"}
          </button>
        </div>
      </form>
      {results.length > 0 && (
        <ul className="kb-chunk-list">
          {results.map((r, idx) => (
            <li key={r.id} className="kb-chunk-item">
              <div className="kb-chunk-meta">
                <span>#{idx + 1}</span>
                <span>score {(r.metadata.similarityScore ?? 0).toFixed(3)}</span>
                {r.metadata.sourceId && <span><code>{r.metadata.sourceId}</code></span>}
              </div>
              <div className="kb-chunk-content">{r.text}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
