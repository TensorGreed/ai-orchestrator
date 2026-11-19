/**
 * "Describe it": a builder describes a workflow in words, a model drafts it, and the dialog shows a preview (a small
 * canvas and a list of what it creates, the credentials to pick and the addresses it calls) before anything is saved.
 * Inserting saves it as a new draft workflow; nothing is ever overwritten. With no real model (Echo) the server says
 * so and offers the closest templates instead. Another model can be chosen under "More" (kept in this browser).
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  HOSTED_MODEL_DEFAULTS,
  MODEL_PROVIDER_CHOICES,
  WORKFLOW_BUILDER_PROMPT_MAX_CHARS,
  type DefaultModelProvider,
  type Workflow,
  type WorkflowBuilderModel,
  type WorkflowBuilderResult
} from "@ai-orchestrator/shared";
import { buildWorkflowFromDescription, fetchSecrets, fetchWorkflowBuilderStatus, type SecretListItem } from "../lib/api";

const MODEL_STORAGE_KEY = "l2m:builder-model";
const storageKey = (userId?: string) => (userId ? `${MODEL_STORAGE_KEY}:${userId}` : MODEL_STORAGE_KEY);
const BASE_URL_PROVIDERS = new Set(["openai_compatible", "azure_openai", "ollama"]);

/**
 * The model this person chose under "More" in this browser, if any (a provider, model, base URL and secret id; never
 * a key).
 */
export function readStoredBuilderModel(userId?: string): WorkflowBuilderModel | null {
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WorkflowBuilderModel>;
    if (typeof parsed.providerId !== "string" || typeof parsed.model !== "string" || !parsed.providerId || !parsed.model) return null;
    return {
      providerId: parsed.providerId,
      model: parsed.model,
      ...(typeof parsed.baseUrl === "string" && parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
      ...(parsed.secretRef && typeof parsed.secretRef.secretId === "string" ? { secretRef: { secretId: parsed.secretRef.secretId } } : {})
    };
  } catch {
    return null;
  }
}

function storeBuilderModel(model: WorkflowBuilderModel | null, userId?: string): void {
  try {
    if (model) window.localStorage.setItem(storageKey(userId), JSON.stringify(model));
    else window.localStorage.removeItem(storageKey(userId));
  } catch {
    // Private windows and blocked storage: the choice lasts until the dialog closes.
  }
}

export function builderModelLabel(model: { providerId: string; model: string }): string {
  if (model.providerId === "echo") return "Echo (built-in demo, no key)";
  const provider = MODEL_PROVIDER_CHOICES.find((choice) => choice.value === model.providerId)?.label ?? model.providerId;
  return `${provider} · ${model.model}`;
}

/** A small, read-only drawing of the draft: steps as boxes, attachments dashed under their agent. */
export function BuilderPreviewCanvas({ workflow }: { workflow: Workflow }) {
  const layout = useMemo(() => {
    const width = 150;
    const height = 44;
    const xs = workflow.nodes.map((node) => node.position.x);
    const ys = workflow.nodes.map((node) => node.position.y);
    const minX = xs.length ? Math.min(...xs) : 0;
    const minY = ys.length ? Math.min(...ys) : 0;
    const boxes = new Map(
      workflow.nodes.map((node) => [node.id, { x: node.position.x - minX + 10, y: node.position.y - minY + 10, label: node.name, type: node.type }])
    );
    const maxX = Math.max(...[...boxes.values()].map((box) => box.x + width), 200) + 10;
    const maxY = Math.max(...[...boxes.values()].map((box) => box.y + height), 80) + 10;
    return { boxes, width, height, viewBox: `0 0 ${maxX} ${maxY}` };
  }, [workflow]);
  return (
    <svg className="builder-preview-canvas" viewBox={layout.viewBox} role="img" aria-label={`Preview of ${workflow.name}`}>
      {workflow.edges.map((edge) => {
        const from = layout.boxes.get(edge.source);
        const to = layout.boxes.get(edge.target);
        if (!from || !to) return null;
        const attachment = Boolean(edge.sourceHandle && ["chat_model", "memory", "tool", "worker", "guard", "protection"].includes(edge.sourceHandle));
        const x1 = attachment ? from.x + layout.width / 2 : from.x + layout.width;
        const y1 = attachment ? from.y + layout.height : from.y + layout.height / 2;
        const x2 = attachment ? to.x + layout.width / 2 : to.x;
        const y2 = attachment ? to.y : to.y + layout.height / 2;
        return (
          <g key={edge.id} className={attachment ? "builder-preview-edge attachment" : "builder-preview-edge"}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} />
            {edge.sourceHandle && !attachment ? (
              <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4} textAnchor="middle">
                {edge.sourceHandle}
              </text>
            ) : null}
          </g>
        );
      })}
      {[...layout.boxes.entries()].map(([id, box]) => (
        <g key={id} className="builder-preview-node">
          <rect x={box.x} y={box.y} width={layout.width} height={layout.height} rx={8} />
          <text x={box.x + 10} y={box.y + 18}>
            {box.label.length > 20 ? `${box.label.slice(0, 19)}…` : box.label}
          </text>
          <text className="builder-preview-type" x={box.x + 10} y={box.y + 34}>
            {box.type}
          </text>
        </g>
      ))}
    </svg>
  );
}

interface WorkflowBuilderDialogProps {
  /**
   * The model a new LLM Call node would start on (a server key, else a saved secret, else Echo), shown until the
   * server says which model a build in the project uses.
   */
  defaultModel: DefaultModelProvider;
  /** The project's secrets as the studio has them; the dialog loads the project's list again when it opens. */
  secrets: SecretListItem[];
  projectId?: string;
  /** Keeps the model chosen under More per person. */
  userId?: string;
  /** Saves the draft as a new workflow and opens it. */
  onCreate: (workflow: Workflow) => Promise<void>;
  /** Makes a workflow from a template and opens it. */
  onUseTemplate: (templateId: string) => Promise<void>;
  onClose: () => void;
}

type Phase = { kind: "idle" } | { kind: "building" } | { kind: "result"; result: WorkflowBuilderResult } | { kind: "error"; message: string };

export function WorkflowBuilderDialog({
  defaultModel: studioDefault,
  secrets: studioSecrets,
  projectId,
  userId,
  onCreate,
  onUseTemplate,
  onClose
}: WorkflowBuilderDialogProps) {
  const promptId = useId();
  const providerId = useId();
  const modelId = useId();
  const baseUrlId = useId();
  const secretId = useId();
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [override, setOverride] = useState<WorkflowBuilderModel | null>(() => readStoredBuilderModel(userId));
  const [serverDefault, setServerDefault] = useState<DefaultModelProvider | null>(null);
  const [loadedSecrets, setLoadedSecrets] = useState<SecretListItem[] | null>(null);
  const buildAbort = useRef<AbortController | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const savingRef = useRef(false);
  savingRef.current = saving;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    promptRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      // While a draft is being saved the dialog stays; a build still running is stopped by closing.
      if (event.key === "Escape" && !savingRef.current) onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Closing stops a build still running: the server stops calling the model when the request goes away.
      buildAbort.current?.abort();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  // The model a build would use comes from the server, and the credentials from the project, so the dialog matches
  // the build even where the studio has not loaded them (the Workflows page).
  useEffect(() => {
    let cancelled = false;
    fetchWorkflowBuilderStatus(projectId)
      .then((status) => {
        if (!cancelled && status.defaultModel) setServerDefault(status.defaultModel);
      })
      .catch(() => undefined);
    fetchSecrets(projectId ? { projectId } : {})
      .then((items) => {
        if (!cancelled) setLoadedSecrets(items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const secrets = loadedSecrets ?? studioSecrets;
  // The server's answer is the model and the credential a build uses: once it is in, it wins over the studio's guess.
  const defaultModel: DefaultModelProvider = serverDefault ?? studioDefault;
  // With no credential picked, a hosted model's key comes from the server's environment.
  const noCredentialLabel = !override && defaultModel.providerId !== "echo" && !defaultModel.secretRef ? "The server's key" : "None (or the server's key)";
  const model: { providerId: string; model: string } = override ?? defaultModel;
  const building = phase.kind === "building";

  const updateOverride = (patch: Partial<WorkflowBuilderModel>) => {
    const base: WorkflowBuilderModel = override ?? {
      providerId: defaultModel.providerId,
      model: defaultModel.model,
      ...(defaultModel.secretRef ? { secretRef: { ...defaultModel.secretRef } } : {})
    };
    const next: WorkflowBuilderModel = { ...base, ...patch };
    if (patch.providerId && patch.providerId !== base.providerId) {
      // Another provider: its own address, and only a credential saved for it.
      delete next.baseUrl;
      const kept = secrets.find((secret) => secret.id === next.secretRef?.secretId);
      if (!kept || kept.provider !== patch.providerId) delete next.secretRef;
    }
    if (!next.baseUrl) delete next.baseUrl;
    if (!next.secretRef?.secretId) delete next.secretRef;
    setOverride(next);
    storeBuilderModel(next.model.trim() ? next : null, userId);
  };

  /** The override as sent: a credential that is no longer in the project's list is left out. */
  const overrideToSend = (): WorkflowBuilderModel | null => {
    if (!override || !override.model.trim()) return null;
    const sent: WorkflowBuilderModel = { ...override, model: override.model.trim() };
    if (sent.secretRef && loadedSecrets && !loadedSecrets.some((secret) => secret.id === sent.secretRef!.secretId)) delete sent.secretRef;
    return sent;
  };

  const build = async () => {
    const text = prompt.trim();
    if (!text || building) return;
    setPhase({ kind: "building" });
    setSaveError(null);
    const controller = new AbortController();
    buildAbort.current = controller;
    const sent = overrideToSend();
    try {
      const result = await buildWorkflowFromDescription(
        {
          prompt: text,
          ...(projectId ? { projectId } : {}),
          ...(sent ? { model: sent } : {})
        },
        controller.signal
      );
      if (!controller.signal.aborted) setPhase({ kind: "result", result });
    } catch (buildError) {
      if (!controller.signal.aborted) {
        setPhase({ kind: "error", message: buildError instanceof Error ? buildError.message : "Could not build the workflow" });
      }
    } finally {
      if (buildAbort.current === controller) buildAbort.current = null;
    }
  };

  const create = async (workflow: Workflow) => {
    setSaving(true);
    setSaveError(null);
    try {
      await onCreate(workflow);
    } catch (createError) {
      setSaveError(createError instanceof Error ? createError.message : "Could not save the draft");
    } finally {
      setSaving(false);
    }
  };

  const startFromTemplate = async (templateId: string) => {
    setSaving(true);
    setSaveError(null);
    try {
      await onUseTemplate(templateId);
    } catch (templateError) {
      setSaveError(templateError instanceof Error ? templateError.message : "Could not use the template");
    } finally {
      setSaving(false);
    }
  };

  const result = phase.kind === "result" ? phase.result : null;
  const ready = result?.status === "ready" ? result : null;

  return (
    <div className="pg-modal-backdrop" role="presentation" onClick={building || saving ? undefined : onClose}>
      <div
        className={`pg-modal builder-modal${ready ? " builder-modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-builder-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="pg-modal-header">
          <div>
            <h3 id="workflow-builder-title" className="pg-modal-title">
              Describe a workflow
            </h3>
            <p className="settings-help">
              Say what should start it and what it should do. You see the workflow before anything is saved, and it is saved as
              a new draft.
            </p>
          </div>
        </header>
        <div className="pg-modal-body builder-body">
          {ready ? (
            <section className="builder-preview" aria-label="Preview">
              <h4 className="builder-preview-title">{ready.workflow.name}</h4>
              {ready.workflow.description ? <p className="settings-help">{ready.workflow.description}</p> : null}
              <div className="builder-preview-grid">
                <BuilderPreviewCanvas workflow={ready.workflow} />
                <div className="builder-preview-lists">
                  <h5>It will create</h5>
                  <ul data-testid="builder-preview-nodes">
                    {ready.preview.nodes.map((node) => (
                      <li key={node.id}>
                        <strong>{node.label}</strong> <span className="builder-muted">{node.typeLabel}</span>
                      </li>
                    ))}
                  </ul>
                  {ready.preview.credentials.length > 0 ? (
                    <>
                      <h5>Credentials to pick</h5>
                      <ul data-testid="builder-preview-credentials">
                        {ready.preview.credentials.map((entry) => (
                          <li key={`${entry.nodeId}-${entry.label}`}>
                            {entry.nodeLabel}: {entry.label}
                            {entry.required ? "" : " (if needed)"}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  {ready.preview.unfinished.length > 0 ? (
                    <>
                      <h5>Still to fill in</h5>
                      <ul data-testid="builder-preview-unfinished">
                        {ready.preview.unfinished.map((issue, index) => (
                          <li key={index}>{issue.message}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  {ready.preview.addresses.length > 0 ? (
                    <>
                      <h5>Calls these addresses when it runs</h5>
                      <ul data-testid="builder-preview-addresses">
                        {ready.preview.addresses.map((entry) => (
                          <li key={`${entry.nodeId}-${entry.url}`}>
                            <code>{entry.url}</code> <span className="builder-muted">({entry.nodeLabel})</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  {ready.preview.notes.length > 0 ? (
                    <ul className="builder-notes">
                      {ready.preview.notes.map((note, index) => (
                        <li key={index}>{note}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
              {saveError ? (
                <p className="gate-error" role="alert">
                  {saveError}
                </p>
              ) : null}
              <div className="webhook-test-actions">
                <button type="button" className="pg-btn" onClick={() => setPhase({ kind: "idle" })} disabled={saving}>
                  Edit description
                </button>
                <button type="button" className="pg-btn primary" onClick={() => void create(ready.workflow)} disabled={saving}>
                  {saving ? "Saving…" : "Create draft"}
                </button>
              </div>
            </section>
          ) : (
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void build();
              }}
            >
              <div className="cfg-field">
                <label className="cfg-label" htmlFor={promptId}>
                  What should the workflow do?
                </label>
                <textarea
                  id={promptId}
                  ref={promptRef}
                  rows={5}
                  maxLength={WORKFLOW_BUILDER_PROMPT_MAX_CHARS}
                  placeholder="When a form is submitted, check the email address, post the details to our CRM API and reply with a thank-you."
                  value={prompt}
                  disabled={building}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void build();
                    }
                  }}
                />
              </div>
              <p className="settings-help" data-testid="builder-model">
                Model: {builderModelLabel(model)}
              </p>
              <details className="builder-more">
                <summary>More</summary>
                <div className="builder-more-fields">
                  <div className="cfg-field">
                    <label className="cfg-label" htmlFor={providerId}>
                      Provider
                    </label>
                    <select id={providerId} value={model.providerId} disabled={building} onChange={(event) => {
                        const next = event.target.value;
                        const hosted = HOSTED_MODEL_DEFAULTS.find((entry) => entry.providerId === next)?.model;
                        updateOverride({ providerId: next, model: next === "echo" ? "echo" : (hosted ?? "") });
                      }}>
                      {MODEL_PROVIDER_CHOICES.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="cfg-field">
                    <label className="cfg-label" htmlFor={modelId}>
                      Model
                    </label>
                    <input id={modelId} value={override?.model ?? defaultModel.model} disabled={building} onChange={(event) => updateOverride({ model: event.target.value })} />
                  </div>
                  {BASE_URL_PROVIDERS.has(model.providerId) ? (
                    <div className="cfg-field">
                      <label className="cfg-label" htmlFor={baseUrlId}>
                        Base URL
                      </label>
                      <input
                        id={baseUrlId}
                        placeholder="http://localhost:8000/v1"
                        value={override?.baseUrl ?? ""}
                        disabled={building}
                        onChange={(event) => updateOverride({ baseUrl: event.target.value.trim() })}
                      />
                    </div>
                  ) : null}
                  <div className="cfg-field">
                    <label className="cfg-label" htmlFor={secretId}>
                      Credential
                    </label>
                    <select
                      id={secretId}
                      value={(override ?? defaultModel).secretRef?.secretId ?? ""}
                      disabled={building}
                      onChange={(event) => updateOverride({ secretRef: event.target.value ? { secretId: event.target.value } : undefined })}
                    >
                      <option value="">{noCredentialLabel}</option>
                      {secrets.map((secret) => (
                        <option key={secret.id} value={secret.id}>
                          {secret.name} ({secret.provider})
                        </option>
                      ))}
                    </select>
                  </div>
                  {override ? (
                    <button
                      type="button"
                      className="pg-btn ghost"
                      disabled={building}
                      onClick={() => {
                        setOverride(null);
                        storeBuilderModel(null, userId);
                      }}
                    >
                      Use the default model
                    </button>
                  ) : null}
                </div>
              </details>

              {phase.kind === "error" ? (
                <p className="gate-error" role="alert">
                  {phase.message}
                </p>
              ) : null}
              {result?.status === "question" ? (
                <div className="builder-callout" role="status">
                  <strong>The model asks:</strong> {result.question}
                  <div className="settings-help">Add the answer to your description and build again.</div>
                </div>
              ) : null}
              {result?.status === "failed" ? (
                <div className="builder-callout builder-callout-error" role="alert">
                  <strong>{result.message}</strong>
                  {result.issues.length > 0 ? (
                    <ul>
                      {result.issues.slice(0, 8).map((issue, index) => (
                        <li key={index}>{issue.message}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {result?.status === "needs_model" ? (
                <div className="builder-callout" role="status" data-testid="builder-needs-model">
                  <p>{result.message}</p>
                  {result.templates.length > 0 ? (
                    <ul className="builder-templates">
                      {result.templates.map((template) => (
                        <li key={template.id}>
                          <div>
                            <strong>{template.name}</strong>
                            {template.description ? <div className="builder-muted">{template.description}</div> : null}
                          </div>
                          <button type="button" className="pg-btn" disabled={saving} onClick={() => void startFromTemplate(template.id)}>
                            Use template
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {saveError ? <p className="gate-error">{saveError}</p> : null}
                </div>
              ) : null}

              <div className="webhook-test-actions">
                <button type="button" className="pg-btn" onClick={onClose} disabled={saving}>
                  Cancel
                </button>
                <button type="submit" className="pg-btn primary" disabled={building || !prompt.trim() || Boolean(override && !override.model.trim())}>
                  {building ? "Building…" : "Build"}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
