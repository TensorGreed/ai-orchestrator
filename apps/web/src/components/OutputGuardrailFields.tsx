/**
 * Phase 12 coverage — config fields of the Output Guardrail node: which checks run, and the settings of the checks
 * that need them (the JSON Schema, topics, safety categories, grounding strictness, the model for model-backed checks).
 * Kept out of NodeConfigModal so the modal only routes here.
 */

import { useState } from "react";
import { CONTENT_SAFETY_CATEGORY_VALUES, OUTPUT_GUARDRAIL_CHECK_VALUES } from "@ai-orchestrator/shared";
import { SAFETY_CATEGORY_LABELS, modelFields, textToTopics, topicsToText, withModelField, withOption } from "../lib/output-check-edit";

type Config = Record<string, unknown>;
type SetConfig = (update: (current: Config) => Config) => void;

const rec = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export const OUTPUT_GUARDRAIL_CHECK_LABELS: Record<string, { label: string; help: string }> = {
  no_pii: { label: "No personal data", help: "Emails, phone numbers, payment cards (checksum-verified), IBANs and national ids." },
  no_profanity: { label: "No profanity", help: "A short list of swear words." },
  must_contain_json: { label: "Contains JSON", help: "The answer holds a JSON value, bare or in a code block." },
  matches_schema: { label: "Matches a JSON Schema", help: "With a schema, the answer's JSON must match it; without one, the whole answer must be JSON." },
  topic: { label: "Stays on topic", help: "Denied topics, or the only topics allowed." },
  safety: { label: "Safe content", help: "Self-harm, violence, sexual content and hate." },
  grounding: { label: "Grounded in sources", help: "Each claim is supported by the documents of the retrieval steps before this node." }
};

export function OutputGuardrailFields({ config, setConfig }: { config: Config; setConfig: SetConfig }) {
  const checks = Array.isArray(config.checks) ? config.checks.map(String) : ["no_pii"];
  const topics = rec(config.topics);
  const safety = rec(config.safety);
  const grounding = rec(config.grounding);
  const [schemaText, setSchemaText] = useState(() => (config.schema === undefined ? "" : typeof config.schema === "string" ? config.schema : JSON.stringify(config.schema, null, 2)));
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const needsModel = (checks.includes("safety") && safety.mode === "model") || (checks.includes("grounding") && grounding.judge === true);
  const checkModel = modelFields(config.checkModel);

  const toggleCheck = (check: string, on: boolean) =>
    setConfig((current) => {
      const list = Array.isArray(current.checks) ? current.checks.map(String) : [];
      return { ...current, checks: on ? [...new Set([...list, check])] : list.filter((entry) => entry !== check) };
    });
  const setSection = (key: "topics" | "safety" | "grounding", field: string, value: unknown) =>
    setConfig((current) => {
      const next = withOption(rec(current[key]), field, value);
      const updated = { ...current };
      if (Object.keys(next).length > 0) updated[key] = next;
      else delete updated[key];
      return updated;
    });
  const applySchema = (text: string) => {
    setSchemaText(text);
    if (!text.trim()) {
      setSchemaError(null);
      setConfig((current) => {
        const { schema: _schema, ...rest } = current;
        return rest;
      });
      return;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      setSchemaError(null);
      setConfig((current) => ({ ...current, schema: parsed }));
    } catch {
      setSchemaError("Not a JSON object yet; the last valid schema is kept.");
    }
  };

  return (
    <>
      <fieldset className="cfg-field">
        <legend className="cfg-label">Checks</legend>
        {OUTPUT_GUARDRAIL_CHECK_VALUES.map((check) => (
          <label key={check} className="guard-check" title={OUTPUT_GUARDRAIL_CHECK_LABELS[check]?.help}>
            <input type="checkbox" checked={checks.includes(check)} onChange={(event) => toggleCheck(check, event.target.checked)} />
            <span>{OUTPUT_GUARDRAIL_CHECK_LABELS[check]?.label ?? check}</span>
          </label>
        ))}
        <div className="cfg-help">Personal data, schema, topic, safety and grounding findings are recorded as content rule events.</div>
      </fieldset>

      {checks.includes("matches_schema") && (
        <label className="cfg-field">
          <span className="cfg-label">JSON Schema</span>
          <textarea className="cfg-input" rows={6} aria-label="Output Guardrail JSON Schema" value={schemaText} onChange={(event) => applySchema(event.target.value)} placeholder='{"type": "object", "required": ["status"]}' />
          {schemaError ? <span className="cfg-help" role="alert">{schemaError}</span> : <span className="cfg-help">Empty: the whole answer only has to be JSON.</span>}
        </label>
      )}

      {checks.includes("topic") && (
        <>
          <label className="cfg-field">
            <span className="cfg-label">Denied topics</span>
            <textarea
              className="cfg-input"
              rows={3}
              aria-label="Output Guardrail denied topics"
              defaultValue={topicsToText(topics.deny)}
              placeholder={"investment advice: buy stocks, crypto\nlegal advice"}
              onBlur={(event) => setSection("topics", "deny", textToTopics(event.target.value, topics.deny))}
            />
            <span className="cfg-help">One per line: a name, then the phrases that mean it.</span>
          </label>
          <label className="cfg-field">
            <span className="cfg-label">Allowed topics</span>
            <textarea
              className="cfg-input"
              rows={3}
              aria-label="Output Guardrail allowed topics"
              defaultValue={topicsToText(topics.allow)}
              placeholder={"billing: invoice, refund, payment\nshipping"}
              onBlur={(event) => setSection("topics", "allow", textToTopics(event.target.value, topics.allow))}
            />
            <span className="cfg-help">When set, an answer about none of these fails.</span>
          </label>
        </>
      )}

      {checks.includes("safety") && (
        <fieldset className="cfg-field">
          <legend className="cfg-label">Safety categories</legend>
          {CONTENT_SAFETY_CATEGORY_VALUES.map((category) => {
            const chosen = Array.isArray(safety.categories) ? safety.categories.map(String) : [...CONTENT_SAFETY_CATEGORY_VALUES];
            return (
              <label key={category} className="guard-check">
                <input
                  type="checkbox"
                  checked={chosen.includes(category)}
                  onChange={(event) => {
                    const next = event.target.checked ? [...new Set([...chosen, category])] : chosen.filter((entry) => entry !== category);
                    setSection("safety", "categories", next.length === CONTENT_SAFETY_CATEGORY_VALUES.length ? undefined : next);
                  }}
                />
                <span>{SAFETY_CATEGORY_LABELS[category]}</span>
              </label>
            );
          })}
          <label className="guard-check">
            <input type="checkbox" checked={safety.mode === "model"} onChange={(event) => setSection("safety", "mode", event.target.checked ? "model" : undefined)} />
            <span>Judge with a chat model instead of the built-in rules</span>
          </label>
        </fieldset>
      )}

      {checks.includes("grounding") && (
        <fieldset className="cfg-field">
          <legend className="cfg-label">Grounding</legend>
          <label className="cfg-field">
            <span className="cfg-label">Minimum support</span>
            <input
              className="cfg-input"
              type="number"
              min={0}
              max={1}
              step={0.05}
              aria-label="Output Guardrail minimum support"
              value={typeof grounding.minSupport === "number" ? grounding.minSupport : 0.5}
              onChange={(event) => setSection("grounding", "minSupport", Math.min(1, Math.max(0, Number(event.target.value) || 0)))}
            />
          </label>
          <label className="guard-check">
            <input type="checkbox" checked={grounding.requireCitations === true} onChange={(event) => setSection("grounding", "requireCitations", event.target.checked ? true : undefined)} />
            <span>Every claim must cite a source</span>
          </label>
          <label className="guard-check">
            <input type="checkbox" checked={grounding.judge === true} onChange={(event) => setSection("grounding", "judge", event.target.checked ? true : undefined)} />
            <span>Ask a chat model about borderline sentences</span>
          </label>
        </fieldset>
      )}

      {needsModel && (
        <div className="cfg-field" role="group" aria-label="Check model">
          <span className="cfg-label">Check model</span>
          <input
            className="cfg-input"
            aria-label="Check model provider"
            placeholder="Provider id (empty: the upstream model)"
            value={checkModel.providerId}
            onChange={(event) => setConfig((current) => ({ ...withOption(current, "checkModel", withModelField(current.checkModel, "providerId", event.target.value)) }))}
          />
          <input
            className="cfg-input"
            aria-label="Check model name"
            placeholder="Model"
            value={checkModel.model}
            onChange={(event) => setConfig((current) => ({ ...withOption(current, "checkModel", withModelField(current.checkModel, "model", event.target.value)) }))}
          />
          <span className="cfg-help">Each check is a model call, counted in the run&apos;s cost. Empty: the model of the step before this node.</span>
        </div>
      )}
    </>
  );
}
