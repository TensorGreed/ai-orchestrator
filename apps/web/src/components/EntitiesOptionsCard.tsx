import type { GuardEntityEngineInfo } from "@ai-orchestrator/shared";
import {
  contextWordsText,
  DEFAULT_ENTITY_MAX_CHARS,
  ENTITY_CLASS_LABELS,
  ENTITY_DATA_CLASSES,
  entityClassesOf,
  entityMinScoreOf,
  withContextWords,
  withEntityClass,
  withEntityMinScore,
  withEntityOption
} from "../lib/entity-options-edit";

/**
 * Names and addresses (`data.entities`) in the rule set editor: which classes to report, the lowest score per class,
 * the engine, one-word names, context words and the longest text checked. The engine line says what the deployment
 * has: the built-in rules alone, or a recognizer an admin set up.
 */
export function EntitiesOptionsCard({
  options,
  engine,
  readOnly,
  onChange
}: {
  options: Record<string, unknown>;
  /** From the detector list; absent while it loads. */
  engine?: GuardEntityEngineInfo;
  readOnly: boolean;
  onChange: (options: Record<string, unknown>) => void;
}) {
  const classes = entityClassesOf(options);
  const rulesOnly = !engine || engine.status === "rules" || options.engine === "rules";
  return (
    <fieldset className="guard-output-check" disabled={readOnly} aria-label="Names and addresses settings">
      <legend>Names and addresses</legend>
      <p className="kb-subtle" data-testid="entities-engine">
        {rulesOnly
          ? "Rules only: street addresses in 6 countries (US, UK, Canada, Australia, Germany, France), person names with a cue such as a title, a field label or a greeting, and well-known places. Names without a cue are mostly missed; add a local model for full coverage."
          : `Engine: ${engine.id} ${engine.version} (${engine.status}${engine.error ? `: ${engine.error}` : ""}).`}
      </p>
      <div className="guard-output-categories" role="group" aria-label="Classes to report">
        {ENTITY_DATA_CLASSES.map((dataClass) => {
          const on = classes.includes(dataClass);
          return (
            <span key={dataClass} className="guard-entity-class">
              <label className="guard-check">
                <input
                  type="checkbox"
                  checked={on}
                  // At least one class stays on.
                  disabled={readOnly || (on && classes.length === 1)}
                  onChange={(event) => onChange(withEntityClass(options, dataClass, event.target.checked))}
                />
                <span>{ENTITY_CLASS_LABELS[dataClass]}</span>
              </label>
              <input
                type="number"
                className="guard-threshold"
                aria-label={`Lowest score for ${ENTITY_CLASS_LABELS[dataClass].toLowerCase()}`}
                min={0}
                max={1}
                step={0.05}
                value={entityMinScoreOf(options, dataClass)}
                disabled={readOnly || !on}
                onChange={(event) => onChange(withEntityMinScore(options, dataClass, Number(event.target.value)))}
              />
            </span>
          );
        })}
      </div>
      <label>
        <span>Engine</span>
        <select value={options.engine === "rules" ? "rules" : "auto"} onChange={(event) => onChange(withEntityOption(options, "engine", event.target.value === "rules" ? "rules" : undefined))}>
          <option value="auto">The deployment's engine (the built-in rules when none is set up)</option>
          <option value="rules">Built-in rules only</option>
        </select>
      </label>
      <label className="guard-check">
        <input type="checkbox" checked={options.singleTokenNames === true} onChange={(event) => onChange(withEntityOption(options, "singleTokenNames", event.target.checked ? true : undefined))} />
        <span>Report one-word names without a cue (more false positives)</span>
      </label>
      <label>
        <span>Words that raise the score nearby (comma separated)</span>
        <textarea rows={2} aria-label="Words that raise the score" defaultValue={contextWordsText(options, "boost")} onBlur={(event) => onChange(withContextWords(options, "boost", event.target.value))} />
      </label>
      <label>
        <span>Words that lower the score nearby (comma separated)</span>
        <textarea rows={2} aria-label="Words that lower the score" defaultValue={contextWordsText(options, "suppress")} onBlur={(event) => onChange(withContextWords(options, "suppress", event.target.value))} />
      </label>
      <label>
        <span>Longest text checked, in characters (longer text fails the check, and the rule set's failure setting decides)</span>
        <input
          type="number"
          aria-label="Longest text checked"
          min={1}
          max={1_000_000}
          step={1000}
          value={typeof options.maxChars === "number" ? options.maxChars : DEFAULT_ENTITY_MAX_CHARS}
          onChange={(event) => {
            const value = Math.floor(Number(event.target.value));
            onChange(withEntityOption(options, "maxChars", Number.isFinite(value) && value > 0 && value !== DEFAULT_ENTITY_MAX_CHARS ? Math.min(value, 1_000_000) : undefined));
          }}
        />
      </label>
      <p className="kb-subtle">Language: English. Findings count as medium risk; the rule set's allow-list and dictionaries apply.</p>
    </fieldset>
  );
}
