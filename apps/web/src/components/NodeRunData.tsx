import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { NodeExecutionResult } from "@ai-orchestrator/shared";
import {
  attachmentUse,
  formatItemCount,
  formatRunDuration,
  outputItemCount,
  portName,
  runPromptInput,
  splitNodeInput,
  usedPinnedData,
  type AttachmentUse
} from "../lib/run-data";

/** Characters of JSON shown before "Show all". */
export const RUN_DATA_JSON_LIMIT = 20_000;
/** Table rows shown per page. */
export const RUN_DATA_ROW_PAGE = 50;
const TABLE_MAX_COLUMNS = 12;
const CELL_MAX_CHARS = 300;
/** Rows read to find the table's columns. */
const COLUMN_SCAN_ROWS = 500;

type DataViewMode = "table" | "json" | "schema";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeStringify(value: unknown, space?: number): string {
  if (value === undefined) return "undefined";
  try {
    const text = JSON.stringify(value, null, space);
    return typeof text === "string" ? text : String(value);
  } catch {
    return "[value that cannot be shown as JSON]";
  }
}

function fullCellText(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  return safeStringify(value);
}

/** A table cell: clipped, with the full value (up to the JSON limit) in its tooltip. */
function Cell({ value, className }: { value: unknown; className: string }) {
  const text = fullCellText(value);
  if (text.length <= CELL_MAX_CHARS) return <td className={className}>{text}</td>;
  return (
    <td className={className} title={text.slice(0, RUN_DATA_JSON_LIMIT)}>
      {`${text.slice(0, CELL_MAX_CHARS - 1)}…`}
    </td>
  );
}

function inferSchema(value: unknown, depth = 0): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? "array (empty)" : [inferSchema(value[0], depth + 1)];
  if (typeof value !== "object") return typeof value;
  if (depth >= 6) return "object";
  const schema: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) schema[key] = inferSchema(child, depth + 1);
  return schema;
}

function defaultMode(value: unknown): DataViewMode {
  return value !== null && typeof value === "object" ? "table" : "json";
}

function DataTable({ value }: { value: unknown }) {
  const itemsSplit = useMemo(() => {
    if (!isRecord(value) || !Array.isArray(value.items)) return null;
    const { items, ...rest } = value;
    return { items: items as unknown[], rest };
  }, [value]);
  const [shown, setShown] = useState(RUN_DATA_ROW_PAGE);
  useEffect(() => setShown(RUN_DATA_ROW_PAGE), [value]);
  const isArray = Array.isArray(value);
  const rows: unknown[] = isArray ? (value as unknown[]) : [];
  const recordRows = isArray && rows.length > 0 && rows.every(isRecord);
  const columns = useMemo(() => {
    if (!recordRows) return [];
    const seen: string[] = [];
    for (const row of rows.slice(0, COLUMN_SCAN_ROWS)) {
      for (const key of Object.keys(row as Record<string, unknown>)) {
        if (!seen.includes(key)) seen.push(key);
        if (seen.length >= TABLE_MAX_COLUMNS) return seen;
      }
    }
    return seen;
  }, [recordRows, rows]);

  if (!isArray) {
    const record = isRecord(value) ? value : {};
    // Many nodes return `{ items: [...], count }`: the items get their own table.
    if (itemsSplit) {
      return (
        <>
          <div className="run-data-subtitle">items ({itemsSplit.items.length})</div>
          <DataTable value={itemsSplit.items} />
          {Object.keys(itemsSplit.rest).length > 0 ? <DataTable value={itemsSplit.rest} /> : null}
        </>
      );
    }
    const entries = Object.entries(record);
    if (entries.length === 0) return <div className="run-data-empty">Empty object</div>;
    const visible = entries.slice(0, shown);
    return (
      <>
        <table className="run-data-table">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(([key, child]) => (
              <tr key={key}>
                <th scope="row" className="run-data-key">
                  {key}
                </th>
                <Cell value={child} className="run-data-value" />
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length > shown ? (
          <button type="button" className="insp-btn run-data-more" onClick={() => setShown((count) => count + RUN_DATA_ROW_PAGE)}>
            Show {Math.min(RUN_DATA_ROW_PAGE, entries.length - shown)} more of {entries.length} fields
          </button>
        ) : null}
      </>
    );
  }

  if (rows.length === 0) return <div className="run-data-empty">No items</div>;
  const visible = rows.slice(0, shown);
  return (
    <>
      <table className="run-data-table">
        <thead>
          <tr>
            <th scope="col">#</th>
            {recordRows ? columns.map((column) => <th key={column} scope="col">{column}</th>) : <th scope="col">Value</th>}
          </tr>
        </thead>
        <tbody>
          {visible.map((row, index) => (
            <tr key={index}>
              <td className="run-data-index">{index + 1}</td>
              {recordRows ? (
                columns.map((column) => <Cell key={column} value={(row as Record<string, unknown>)[column]} className="run-data-value" />)
              ) : (
                <Cell value={row} className="run-data-value" />
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown ? (
        <button type="button" className="insp-btn run-data-more" onClick={() => setShown((count) => count + RUN_DATA_ROW_PAGE)}>
          Show {Math.min(RUN_DATA_ROW_PAGE, rows.length - shown)} more of {rows.length} items
        </button>
      ) : null}
    </>
  );
}

/** Long text, cut at the JSON limit until the user asks for all of it. */
function ClippedPre({ text, className }: { text: string; className: string }) {
  const [full, setFull] = useState(false);
  useEffect(() => setFull(false), [text]);
  const clipped = !full && text.length > RUN_DATA_JSON_LIMIT;
  return (
    <>
      <pre className={className} tabIndex={0}>
        {clipped ? `${text.slice(0, RUN_DATA_JSON_LIMIT)}\n…` : text}
      </pre>
      {clipped ? (
        <button type="button" className="insp-btn run-data-more" onClick={() => setFull(true)}>
          Show all ({Math.ceil(text.length / 1024)} KB)
        </button>
      ) : null}
    </>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  const text = useMemo(() => safeStringify(value, 2), [value]);
  return <ClippedPre text={text} className="run-data-json" />;
}

/** One value of a run, as a table, JSON or inferred schema. */
export function RunDataView({ value, label }: { value: unknown; label: string }) {
  const [mode, setMode] = useState<DataViewMode>(() => defaultMode(value));
  const structured = value !== null && typeof value === "object";
  const modes: Array<{ key: DataViewMode; text: string }> = structured
    ? [
        { key: "table", text: "Table" },
        { key: "json", text: "JSON" },
        { key: "schema", text: "Schema" }
      ]
    : [];
  const active = structured ? mode : "json";
  return (
    <div className="run-data-view">
      {modes.length > 0 ? (
        <div className="run-data-modes" role="group" aria-label={`${label}: view as`}>
          {modes.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={active === entry.key ? "active" : ""}
              aria-pressed={active === entry.key}
              onClick={() => setMode(entry.key)}
            >
              {entry.text}
            </button>
          ))}
        </div>
      ) : null}
      {active === "table" ? (
        <DataTable value={value} />
      ) : active === "schema" ? (
        <JsonBlock value={inferSchema(value)} />
      ) : typeof value === "string" ? (
        <ClippedPre text={value} className="run-data-json run-data-text" />
      ) : (
        <JsonBlock value={value} />
      )}
    </div>
  );
}

export type RunNodeResult = NodeExecutionResult & { liveText?: string };

function AttachmentNote({
  use,
  labelFor,
  onOpenNode,
  nodeExists
}: {
  use: AttachmentUse;
  labelFor: (id: string) => string;
  onOpenNode?: (id: string) => void;
  nodeExists: (id: string) => boolean;
}) {
  const agent = labelFor(use.usedByNodeId);
  return (
    <div className="run-data-note" data-testid="run-data-attachment">
      <p>
        Used by <strong>{agent}</strong> as its {portName(use.handle)}. Attached nodes do not run as their own step: the data
        they handled is in {agent}'s input and output.
      </p>
      {onOpenNode && nodeExists(use.usedByNodeId) ? (
        <button type="button" className="insp-btn" onClick={() => onOpenNode(use.usedByNodeId)}>
          Open {agent}
        </button>
      ) : null}
    </div>
  );
}

export function RunStatusLine({ result }: { result: RunNodeResult }) {
  const parts: string[] = [];
  if (result.status === "success" || (result.status === "error" && result.output !== undefined)) {
    parts.push(formatItemCount(outputItemCount(result.output)));
  }
  const duration = result.status === "running" || result.status === "skipped" ? undefined : formatRunDuration(result.durationMs);
  if (duration) parts.push(duration);
  return (
    <div className={`run-data-status run-data-status-${result.status}`} data-testid="run-data-status">
      <span className="run-data-status-dot" aria-hidden="true" />
      <strong>{result.status}</strong>
      {parts.map((part) => (
        <span key={part}> · {part}</span>
      ))}
    </div>
  );
}

interface NodeRunInputProps {
  result: RunNodeResult | undefined;
  labelFor: (nodeId: string) => string;
  isTrigger: boolean;
  /** The node has its own test data, so the run's prompt field is context, not its input. */
  hasOwnTestData?: boolean;
  onOpenNode?: (nodeId: string) => void;
  /** False for nodes of a past run that are no longer in the workflow (they cannot be opened). */
  nodeExists?: (nodeId: string) => boolean;
  /** Shown above the received data (for example the values the node resolved this run). */
  before?: ReactNode;
}

/** What the node received in the run: each upstream node's output, other fields in scope, and the run context. */
const ALWAYS = () => true;

export function NodeRunInput({ result, labelFor, isTrigger, hasOwnTestData = false, onOpenNode, nodeExists = ALWAYS, before }: NodeRunInputProps) {
  const input = result?.input;
  const promptIsInput = runPromptInput(input, hasOwnTestData) !== undefined;
  const split = useMemo(() => splitNodeInput(input, labelFor, { promptIsInput }), [input, labelFor, promptIsInput]);
  if (!result) {
    return <div className="insp-empty">No run data for this node yet. Run the workflow, or this node, to see what it receives.</div>;
  }
  const use = attachmentUse(result);
  if (use) return <AttachmentNote use={use} labelFor={labelFor} onOpenNode={onOpenNode} nodeExists={nodeExists} />;
  if (result.input === undefined) {
    return (
      <div className="insp-empty">
        {result.status === "running"
          ? "Running. Its input is recorded when it finishes."
          : result.status === "skipped"
            ? "Skipped in this run: it received nothing."
            : "This run recorded no input for this node."}
      </div>
    );
  }
  const otherKeys = Object.keys(split.otherFields);
  return (
    <div className="run-data-input">
      {before}
      {split.receivedFrom.length === 0 ? (
        <p className="run-data-hint">
          {isTrigger
            ? "This trigger starts the run, so no node sends it data. The run's input and context are below."
            : "Received nothing from upstream nodes in this run."}
        </p>
      ) : (
        split.receivedFrom.map((entry) => (
          <section key={entry.nodeId} className="run-data-block" aria-label={`From ${entry.label}`}>
            <h4 className="run-data-block-title">
              From{" "}
              {onOpenNode && nodeExists(entry.nodeId) ? (
                <button type="button" className="run-data-link" onClick={() => onOpenNode(entry.nodeId)}>
                  {entry.label}
                </button>
              ) : (
                entry.label
              )}
            </h4>
            <RunDataView value={entry.value} label={`From ${entry.label}`} />
          </section>
        ))
      )}
      {otherKeys.length > 0 ? (
        <section className="run-data-block" aria-label="Other fields">
          <h4 className="run-data-block-title">Run input</h4>
          <RunDataView value={split.otherFields} label="Other fields" />
        </section>
      ) : null}
      {Object.keys(split.runContext).length > 0 ? (
        <details className="run-data-context" open={isTrigger && otherKeys.length === 0 ? true : undefined}>
          <summary>Run context (prompt fields, variables, trigger)</summary>
          <p className="run-data-hint">The same for every node of this run. Available in templates, for example {"{{vars.KEY}}"}.</p>
          <RunDataView value={split.runContext} label="Run context" />
        </details>
      ) : null}
    </div>
  );
}

interface NodeRunOutputProps {
  result: RunNodeResult | undefined;
  labelFor: (nodeId: string) => string;
  onOpenNode?: (nodeId: string) => void;
  nodeExists?: (nodeId: string) => boolean;
  /** Pinned data stored on the workflow for this node, when there is no run result. */
  pinnedOutput?: { value: unknown };
  /** A result that is not from a workflow run (for example a code test), with its label. */
  notFromRun?: { label: string; content: ReactNode };
  /** Repeat the input next to an error (the tabs view, where the input is not beside the output). */
  failingInput?: ReactNode;
}

/** What the node produced in the run, its error with the input it failed on, or an explicit label for other data. */
export function NodeRunOutput({ result, labelFor, onOpenNode, nodeExists = ALWAYS, pinnedOutput, notFromRun, failingInput }: NodeRunOutputProps) {
  // A test result is shown on its own, labelled, above whatever the run recorded.
  const notFromRunBlock = notFromRun ? (
    <div className="run-data-output">
      <p className="run-data-label" data-testid="run-data-not-from-run">
        {notFromRun.label}
      </p>
      {notFromRun.content}
    </div>
  ) : null;
  if (!result) {
    if (pinnedOutput) {
      return (
        <div className="run-data-output">
          <p className="run-data-label run-data-label-pinned" data-testid="run-data-pinned">
            Pinned data, not from a run. Runs reuse it instead of running this node until you unpin it.
          </p>
          <RunDataView value={pinnedOutput.value} label="Pinned data" />
          {notFromRunBlock}
        </div>
      );
    }
    if (notFromRunBlock) return notFromRunBlock;
    return <div className="insp-empty">No run yet for this node. Run the workflow, or this node, to see its output.</div>;
  }
  const use = attachmentUse(result);
  if (use) return <AttachmentNote use={use} labelFor={labelFor} onOpenNode={onOpenNode} nodeExists={nodeExists} />;
  return (
    <div className="run-data-output">
      {notFromRunBlock}
      <RunStatusLine result={result} />
      {usedPinnedData(result) ? (
        <p className="run-data-label run-data-label-pinned" data-testid="run-data-pinned">
          This run reused the node's pinned data: the node did not run.
        </p>
      ) : null}
      {result.status === "running" ? (
        result.liveText ? (
          <section className="run-data-block" aria-label="Streaming output">
            <h4 className="run-data-block-title">Streaming output</h4>
            <pre className="run-data-json run-data-text" tabIndex={0}>
              {result.liveText}
            </pre>
          </section>
        ) : (
          <p className="run-data-hint">Running. The output appears when it finishes.</p>
        )
      ) : null}
      {result.error ? (
        <div className="run-data-error" role="alert">
          <strong>Error</strong>
          <pre>{result.error}</pre>
          {result.errorRemediation ? <p className="run-data-hint">{result.errorRemediation}</p> : null}
        </div>
      ) : null}
      {result.error && failingInput ? (
        <details className="run-data-context" open>
          <summary>Input it failed on</summary>
          {failingInput}
        </details>
      ) : null}
      {result.status !== "running" && result.output !== undefined ? (
        <RunDataView value={result.output} label="Output" />
      ) : result.status === "skipped" ? (
        <p className="run-data-hint">Skipped in this run: no output.</p>
      ) : result.status !== "running" && !result.error ? (
        <p className="run-data-hint">This run recorded no output for this node.</p>
      ) : null}
    </div>
  );
}

interface RunStepBarProps {
  steps: string[];
  currentId: string;
  labelFor: (nodeId: string) => string;
  onStep: (nodeId: string) => void;
  runLabel?: string;
  /** False while something else holds the keyboard (for example the unsaved-changes prompt). */
  keysEnabled?: boolean;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/** Previous / next node of the run, without closing the inspector (Alt+[ and Alt+]). */
export function RunStepBar({ steps, currentId, labelFor, onStep, runLabel, keysEnabled = true }: RunStepBarProps) {
  const index = steps.indexOf(currentId);
  const previous = index > 0 ? steps[index - 1] : undefined;
  const next = index >= 0 && index < steps.length - 1 ? steps[index + 1] : undefined;

  useEffect(() => {
    if (!keysEnabled) return;
    const handleKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || isTypingTarget(event.target)) return;
      const target = event.code === "BracketLeft" ? previous : event.code === "BracketRight" ? next : undefined;
      if (!target) return;
      event.preventDefault();
      onStep(target);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [keysEnabled, next, onStep, previous]);

  if (steps.length === 0) return null;
  return (
    <nav className="run-steps" aria-label="Run steps">
      <button
        type="button"
        className="insp-btn run-steps-btn"
        disabled={!previous}
        onClick={() => previous && onStep(previous)}
        title="Previous step (Alt+[)"
        aria-label={previous ? `Previous step: ${labelFor(previous)}` : "Previous step"}
      >
        ‹ Prev
      </button>
      <span className="run-steps-pos" aria-live="polite">
        {index >= 0 ? `Step ${index + 1} of ${steps.length}` : `Not a step of this run (${steps.length} steps)`}
        {runLabel ? <span className="run-steps-run"> · {runLabel}</span> : null}
      </span>
      <button
        type="button"
        className="insp-btn run-steps-btn"
        disabled={!next && index >= 0}
        onClick={() => {
          const target = next ?? (index < 0 ? steps[0] : undefined);
          if (target) onStep(target);
        }}
        title="Next step (Alt+])"
        aria-label={next ? `Next step: ${labelFor(next)}` : index < 0 ? `First step: ${labelFor(steps[0]!)}` : "Next step"}
      >
        Next ›
      </button>
    </nav>
  );
}
