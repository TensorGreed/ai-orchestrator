import { useState } from "react";
import {
  OUTPUT_CHECK_LABELS,
  SAFETY_CATEGORY_LABELS,
  modelFields,
  textToTopics,
  topicsToText,
  withModelField,
  withOption,
  type OutputCheckId
} from "../lib/output-check-edit";

/**
 * Phase 12 coverage — the settings of one output check in the rule set editor: the JSON Schema an answer must match,
 * the topics it must avoid or stay within, which safety categories count, how strict grounding is. Model-backed modes
 * name a model; their calls count in the run's cost.
 */
export function OutputCheckOptions({
  detectorId,
  options,
  readOnly,
  buffered,
  onChange,
  onBuffered
}: {
  detectorId: OutputCheckId;
  options: Record<string, unknown>;
  readOnly: boolean;
  /** The check's rule holds streamed answers back until the whole answer passed. */
  buffered: boolean;
  onChange: (options: Record<string, unknown>) => void;
  onBuffered: (buffered: boolean) => void;
}) {
  return (
    <fieldset className="guard-output-check" disabled={readOnly} aria-label={`${OUTPUT_CHECK_LABELS[detectorId]} settings`}>
      <legend>{OUTPUT_CHECK_LABELS[detectorId]}</legend>
      {detectorId === "output.schema" && <SchemaFields options={options} onChange={onChange} />}
      {detectorId === "output.topic" && <TopicFields options={options} onChange={onChange} />}
      {detectorId === "output.safety" && <SafetyFields options={options} onChange={onChange} />}
      {detectorId === "output.grounding" && <GroundingFields options={options} onChange={onChange} />}
      {(detectorId === "output.schema" || detectorId === "output.grounding") && (
        <label className="guard-check">
          <input type="checkbox" checked={buffered} onChange={(event) => onBuffered(event.target.checked)} />
          <span>Check the whole answer before streaming any of it</span>
        </label>
      )}
      {(detectorId === "output.schema" || detectorId === "output.grounding") && !buffered && (
        <p className="kb-subtle">Streamed answers are checked when they end; if this check fails then, the rest of the answer is withheld.</p>
      )}
    </fieldset>
  );
}

function SchemaFields({ options, onChange }: { options: Record<string, unknown>; onChange: (options: Record<string, unknown>) => void }) {
  // Local text while typing; the parent remounts this (by key) when another rule set or channel is shown.
  const [text, setText] = useState(() => (options.schema ? JSON.stringify(options.schema, null, 2) : ""));
  const [error, setError] = useState<string | null>(null);
  const apply = (value: string) => {
    setText(value);
    if (!value.trim()) {
      setError(null);
      onChange(withOption(options, "schema", undefined));
      return;
    }
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      setError(null);
      onChange(withOption(options, "schema", parsed));
    } catch {
      setError("Not a JSON object yet; the last valid schema is kept.");
    }
  };
  return (
    <>
      <label>
        <span>JSON Schema the answer must match (empty: the answer only has to be JSON)</span>
        <textarea className="guard-json" rows={6} aria-label="Answer JSON Schema" value={text} onChange={(event) => apply(event.target.value)} />
      </label>
      {error && <p className="kb-subtle" role="alert">{error}</p>}
      <label className="guard-check">
        <input type="checkbox" checked={options.strict === true} onChange={(event) => onChange(withOption(options, "strict", event.target.checked ? true : undefined))} />
        <span>Refuse properties the schema does not list</span>
      </label>
    </>
  );
}

function TopicFields({ options, onChange }: { options: Record<string, unknown>; onChange: (options: Record<string, unknown>) => void }) {
  const semantic = options.mode === "semantic";
  const model = modelFields(options.model);
  return (
    <>
      <label>
        <span>Denied topics, one per line (name: phrase, phrase)</span>
        <textarea rows={3} aria-label="Denied topics" defaultValue={topicsToText(options.deny)} onBlur={(event) => onChange(withOption(options, "deny", textToTopics(event.target.value, options.deny)))} />
      </label>
      <label>
        <span>Allowed topics (when set, an answer about none of them is off topic)</span>
        <textarea rows={3} aria-label="Allowed topics" defaultValue={topicsToText(options.allow)} onBlur={(event) => onChange(withOption(options, "allow", textToTopics(event.target.value, options.allow)))} />
      </label>
      <label>
        <span>Match by</span>
        <select value={semantic ? "semantic" : "phrases"} onChange={(event) => onChange(withOption(options, "mode", event.target.value === "semantic" ? "semantic" : undefined))}>
          <option value="phrases">Phrases (no model calls)</option>
          <option value="semantic">Meaning (an embedding model; counted in the run's cost)</option>
        </select>
      </label>
      {semantic && <ModelInputs label="Embedding model" value={model} onChange={(field, value) => onChange(withOption(options, "model", withModelField(options.model, field, value)))} />}
    </>
  );
}

function SafetyFields({ options, onChange }: { options: Record<string, unknown>; onChange: (options: Record<string, unknown>) => void }) {
  const all = Object.keys(SAFETY_CATEGORY_LABELS);
  const chosen = Array.isArray(options.categories) ? (options.categories as string[]) : all;
  const byModel = options.mode === "model";
  const toggle = (category: string, on: boolean) => {
    const next = on ? [...new Set([...chosen, category])] : chosen.filter((entry) => entry !== category);
    onChange(withOption(options, "categories", next.length === all.length ? undefined : next));
  };
  return (
    <>
      <div className="guard-output-categories">
        {all.map((category) => (
          <label key={category} className="guard-check">
            <input type="checkbox" checked={chosen.includes(category)} onChange={(event) => toggle(category, event.target.checked)} />
            <span>{SAFETY_CATEGORY_LABELS[category]}</span>
          </label>
        ))}
      </div>
      <label>
        <span>Judged by</span>
        <select value={byModel ? "model" : "rules"} onChange={(event) => onChange(withOption(options, "mode", event.target.value === "model" ? "model" : undefined))}>
          <option value="rules">Built-in rules (no model calls)</option>
          <option value="model">A chat model (counted in the run's cost)</option>
        </select>
      </label>
      {byModel && (
        <ModelInputs
          label="Chat model (empty: the model of the node being checked)"
          value={modelFields(options.model)}
          onChange={(field, value) => onChange(withOption(options, "model", withModelField(options.model, field, value)))}
        />
      )}
    </>
  );
}

function GroundingFields({ options, onChange }: { options: Record<string, unknown>; onChange: (options: Record<string, unknown>) => void }) {
  const judge = options.judge === true || Boolean(options.judge && typeof options.judge === "object");
  return (
    <>
      <label>
        <span>Minimum support (share of a sentence's terms found in its sources)</span>
        <input
          type="number"
          min={0}
          max={1}
          step={0.05}
          aria-label="Minimum support"
          value={typeof options.minSupport === "number" ? options.minSupport : 0.5}
          onChange={(event) => onChange(withOption(options, "minSupport", Math.min(1, Math.max(0, Number(event.target.value) || 0))))}
        />
      </label>
      <label className="guard-check">
        <input type="checkbox" checked={options.requireCitations === true} onChange={(event) => onChange(withOption(options, "requireCitations", event.target.checked ? true : undefined))} />
        <span>Every claim must cite a source</span>
      </label>
      <label className="guard-check">
        <input type="checkbox" checked={options.onNoSources === "flag"} onChange={(event) => onChange(withOption(options, "onNoSources", event.target.checked ? "flag" : undefined))} />
        <span>Flag answers that have no sources at all</span>
      </label>
      <label className="guard-check">
        <input type="checkbox" checked={judge} onChange={(event) => onChange(withOption(options, "judge", event.target.checked ? true : undefined))} />
        <span>Ask a chat model about borderline sentences (counted in the run's cost)</span>
      </label>
    </>
  );
}

function ModelInputs({ label, value, onChange }: { label: string; value: { providerId: string; model: string }; onChange: (field: "providerId" | "model", value: string) => void }) {
  return (
    <div className="guard-output-model" role="group" aria-label={label}>
      <span>{label}</span>
      <input aria-label={`${label}: provider`} placeholder="Provider id (openai, azure_openai, ollama…)" value={value.providerId} onChange={(event) => onChange("providerId", event.target.value)} />
      <input aria-label={`${label}: model`} placeholder="Model" value={value.model} onChange={(event) => onChange("model", event.target.value)} />
    </div>
  );
}
