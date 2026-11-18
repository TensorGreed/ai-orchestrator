import { ENTITY_SERVICE_ENABLE_COMMAND, type EntityEngine, type GuardEntityEngineInfo } from "@ai-orchestrator/shared";
import {
  contextWordsText,
  DEFAULT_ENTITY_MAX_CHARS,
  ENTITY_CLASS_LABELS,
  ENTITY_DATA_CLASSES,
  entityClassesOf,
  entityEngineOf,
  entityJudgeOf,
  entityMinScoreOf,
  withContextWords,
  withEntityClass,
  withEntityJudge,
  withEntityMinScore,
  withEntityOption
} from "../lib/entity-options-edit";
import { ModelInputs } from "./OutputCheckOptions";

const ENGINE_LABELS: Record<EntityEngine, string> = {
  auto: "The deployment's names and addresses service (the built-in rules when none is set up)",
  rules: "Built-in rules only (basic)",
  endpoint: "The names and addresses service only",
  union: "The built-in rules and the service together"
};

const STATUS_LABELS: Record<GuardEntityEngineInfo["status"], string> = {
  rules: "built-in rules",
  loaded: "ready",
  idle: "not loaded yet",
  not_ready: "running, no model loaded",
  error: "not working"
};

/** What the status line says about the engine this rule set uses. */
function EngineStatus({ engine, chosen }: { engine?: GuardEntityEngineInfo; chosen: EntityEngine }) {
  const service = engine && engine.status !== "rules" ? engine : undefined;
  if (!service || chosen === "rules") {
    return (
      <div className="kb-subtle" data-testid="entities-engine">
        <p>
          <strong>Basic</strong>: built-in rules only. Good on street addresses in 6 countries (US, UK, Canada, Australia, Germany, France); person names
          only with a cue such as a title, a field label or a greeting; well-known places. Names without a cue are mostly missed.
        </p>
        {service ? (
          <p>This rule set does not use the deployment&apos;s names and addresses service; pick another engine to use it.</p>
        ) : (
          <p>
            For better recall, an admin runs the local names and addresses service and sets CONTENT_RULES_NER_ENDPOINT on the API: <code>{ENTITY_SERVICE_ENABLE_COMMAND}</code>
          </p>
        )}
      </div>
    );
  }
  const model = service.model ? `${service.model.id} ${service.model.version}` : null;
  const detail = service.error ?? service.message;
  return (
    <p className="kb-subtle" data-testid="entities-engine">
      {service.kind === "endpoint" ? "Names and addresses service" : `Engine ${service.id} ${service.version}`}: {STATUS_LABELS[service.status]}
      {model ? `, model ${model}` : ""}
      {detail ? ` (${detail})` : ""}.{chosen === "union" ? " The built-in rules run as well." : ""}
    </p>
  );
}

/**
 * Names and addresses (`data.entities`) in the rule set editor: which classes to report, the lowest score per class,
 * the engine, one-word names, context words, the longest text checked and the optional judge. The status line says
 * what the deployment has: the built-in rules alone ("basic", with the command that adds the local service), or the
 * service's health and model.
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
  const chosen = entityEngineOf(options);
  const hasService = Boolean(engine && engine.status !== "rules");
  const judge = entityJudgeOf(options);
  // Loaded engine info says whether a service is set up; while it loads, no warning.
  const missingService = Boolean(engine) && !hasService && (chosen === "endpoint" || chosen === "union");
  const waits = judge.enabled || (hasService && engine?.kind === "endpoint" && chosen !== "rules");
  return (
    <fieldset className="guard-output-check" disabled={readOnly} aria-label="Names and addresses settings">
      <legend>Names and addresses</legend>
      <EngineStatus {...(engine ? { engine } : {})} chosen={chosen} />
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
        <select value={chosen} onChange={(event) => onChange(withEntityOption(options, "engine", event.target.value === "auto" ? undefined : event.target.value))}>
          {(Object.keys(ENGINE_LABELS) as EntityEngine[]).map((value) => (
            <option key={value} value={value}>
              {ENGINE_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      {missingService && (
        <p className="guard-warning" role="alert">
          This deployment has no names and addresses service, so this check fails on every input and the rule set&apos;s failure setting decides.
        </p>
      )}
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
      <label className="guard-check">
        <input type="checkbox" checked={judge.enabled} onChange={(event) => onChange(withEntityJudge(options, { enabled: event.target.checked }))} />
        <span>Ask a chat model about uncertain spans (counted in the run&apos;s cost)</span>
      </label>
      {judge.enabled && (
        <div className="guard-entity-judge" role="group" aria-label="Judge">
          <p className="guard-warning" data-testid="entities-judge-warning">
            Each uncertain span and up to 120 characters around it go to the model named here. If that model is an external service, this text leaves the
            deployment. Confirmed spans are reported; rejected ones are dropped. Not available on AI gateway routes.
          </p>
          <ModelInputs label="Judge model" model={judge.model} onModel={(next) => onChange(withEntityJudge(options, { model: next }))} />
          <label>
            <span>Uncertain from score</span>
            <input
              type="number"
              aria-label="Uncertain from score"
              min={0}
              max={1}
              step={0.05}
              value={judge.band[0]}
              onChange={(event) => onChange(withEntityJudge(options, { band: [Number(event.target.value), judge.band[1]] }))}
            />
          </label>
          <label>
            <span>Uncertain up to score</span>
            <input
              type="number"
              aria-label="Uncertain up to score"
              min={0}
              max={1}
              step={0.05}
              value={judge.band[1]}
              onChange={(event) => onChange(withEntityJudge(options, { band: [judge.band[0], Number(event.target.value)] }))}
            />
          </label>
          <label>
            <span>Spans judged per check at most</span>
            <input type="number" aria-label="Spans judged per check" min={1} max={50} value={judge.maxSpans} onChange={(event) => onChange(withEntityJudge(options, { maxSpans: Number(event.target.value) }))} />
          </label>
        </div>
      )}
      {waits && (
        <label>
          <span>Time limit of this check, in milliseconds (it waits on a service or a model, so the rule set&apos;s latency budget does not apply)</span>
          <input
            type="number"
            aria-label="Time limit of this check"
            min={1000}
            max={300_000}
            step={1000}
            value={typeof options.timeoutMs === "number" ? options.timeoutMs : 30_000}
            onChange={(event) => {
              const value = Math.floor(Number(event.target.value));
              onChange(withEntityOption(options, "timeoutMs", Number.isFinite(value) && value >= 1000 && value !== 30_000 ? Math.min(value, 300_000) : undefined));
            }}
          />
        </label>
      )}
      <p className="kb-subtle">Language: English. Findings count as medium risk; the rule set&apos;s allow-list and dictionaries apply.</p>
    </fieldset>
  );
}
