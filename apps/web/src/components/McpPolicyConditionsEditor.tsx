/**
 * Phase 12.4 — the condition builder of a tool policy rule: rows of
 * "argument path, operator, value" (or a data label), combined with all / any.
 * Number comparisons take numbers; every other value is kept as the text
 * typed (007 stays "007"): the evaluator compares scalars as trimmed text and
 * numbers by value, so the text 5000 still equals an argument 5000. Only
 * `null` (unquoted) means null.
 */

import {
  MCP_POLICY_TEXT_OPS,
  labelValueNeedsTracking,
  type McpPolicyCondition,
  type McpPolicyConditionOp,
  type McpPolicyScalar,
  type McpToolPolicyConditions,
  type McpToolPolicyEffect
} from "@ai-orchestrator/shared";

export interface ConditionDraft {
  key: number;
  op: McpPolicyConditionOp;
  path: string;
  value: string;
  /** Upper bound of `between`. */
  value2: string;
  /** Text operators: compare without case. */
  ignoreCase: boolean;
  /** The stored value and the text it was shown as, so saving an untouched row keeps its exact value. */
  stored?: { text: string; value: McpPolicyCondition["value"] };
}

export interface ConditionsDraft {
  combine: "all" | "any";
  rows: ConditionDraft[];
}

export const CONDITION_OP_LABELS: Array<{ value: McpPolicyConditionOp; label: string }> = [
  { value: "equals", label: "equals" },
  { value: "one_of", label: "is one of" },
  { value: "not_one_of", label: "is not one of" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
  { value: "matches", label: "matches (glob: * and ?)" },
  { value: "lt", label: "is less than" },
  { value: "lte", label: "is at most" },
  { value: "gt", label: "is greater than" },
  { value: "gte", label: "is at least" },
  { value: "between", label: "is between" },
  { value: "exists", label: "is present / absent" },
  { value: "label_present", label: "run data has label" },
  { value: "label_absent", label: "run data lacks label" }
];

const LABEL_OPS: readonly McpPolicyConditionOp[] = ["label_present", "label_absent"];
const NUMBER_OPS: readonly McpPolicyConditionOp[] = ["lt", "lte", "gt", "gte"];
const LIST_OPS: readonly McpPolicyConditionOp[] = ["one_of", "not_one_of"];

let nextKey = 1;

export function emptyConditionRow(): ConditionDraft {
  return { key: nextKey++, op: "equals", path: "", value: "", value2: "", ignoreCase: false };
}

/** `equals` and list values are text (007 stays "007"); `null` means null, and a quoted value ("null") is that text. */
export function parseScalar(text: string): McpPolicyScalar {
  const trimmed = text.trim();
  if (trimmed === "null") return null;
  if (/^".*"$/.test(trimmed)) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Not valid JSON: compared as the text typed.
    }
  }
  return trimmed;
}

/** The text a stored value is edited as; text that would read as another type is quoted. */
export function scalarText(value: unknown): string {
  if (typeof value === "string") return parseScalar(value) === value ? value : JSON.stringify(value);
  if (value === null) return "null";
  return String(value);
}

function conditionToDraft(condition: McpPolicyCondition): ConditionDraft {
  const base = { key: nextKey++, op: condition.op, path: condition.path ?? "", value: "", value2: "", ignoreCase: condition.ignoreCase === true };
  if (condition.op === "exists") return { ...base, value: condition.value === false ? "absent" : "present" };
  if (condition.op === "between" && Array.isArray(condition.value)) {
    return { ...base, value: scalarText(condition.value[0]), value2: scalarText(condition.value[1]) };
  }
  if (Array.isArray(condition.value)) {
    const text = condition.value.map(scalarText).join(", ");
    return { ...base, value: text, stored: { text, value: condition.value } };
  }
  if (condition.op === "starts_with" || condition.op === "ends_with" || condition.op === "matches" || LABEL_OPS.includes(condition.op)) {
    return { ...base, value: String(condition.value ?? "") };
  }
  const text = scalarText(condition.value);
  return { ...base, value: text, stored: { text, value: condition.value } };
}

/** The row's value as stored when the row still shows it unchanged (a rule saved before keeps its typed values). */
function unchangedValue(row: ConditionDraft): McpPolicyCondition["value"] | undefined {
  return row.stored && row.stored.text === row.value ? row.stored.value : undefined;
}

/** `ignoreCase: true` for a text operator with the box ticked; nothing otherwise. */
function caseFlag(row: ConditionDraft): Pick<McpPolicyCondition, "ignoreCase"> {
  return row.ignoreCase && MCP_POLICY_TEXT_OPS.includes(row.op) ? { ignoreCase: true } : {};
}

export function conditionsToDraft(conditions: McpToolPolicyConditions | null | undefined): ConditionsDraft {
  if (!conditions) return { combine: "all", rows: [] };
  if ("any" in conditions) return { combine: "any", rows: conditions.any.map(conditionToDraft) };
  return { combine: "all", rows: conditions.all.map(conditionToDraft) };
}

/** The conditions to save, or the first row that cannot be saved and why. */
export function draftToConditions(draft: ConditionsDraft): { conditions: McpToolPolicyConditions | null } | { error: string } {
  if (draft.rows.length === 0) return { conditions: null };
  const list: McpPolicyCondition[] = [];
  for (const [index, row] of draft.rows.entries()) {
    const where = `Condition ${index + 1}`;
    if (LABEL_OPS.includes(row.op)) {
      if (!row.value.trim()) return { error: `${where}: enter a data label or data class, such as pii or email.` };
      list.push({ op: row.op, value: row.value.trim() });
      continue;
    }
    const path = row.path.trim();
    if (!path) return { error: `${where}: enter the argument path, such as repo or files[*].path.` };
    if (row.op === "exists") {
      list.push(row.value === "absent" ? { path, op: "exists", value: false } : { path, op: "exists" });
      continue;
    }
    if (NUMBER_OPS.includes(row.op) || row.op === "between") {
      const numbers = (row.op === "between" ? [row.value, row.value2] : [row.value]).map((text) => (text.trim() === "" ? Number.NaN : Number(text)));
      if (numbers.some((value) => !Number.isFinite(value))) return { error: `${where}: enter a number${row.op === "between" ? " for both bounds" : ""}.` };
      if (row.op === "between" && numbers[0]! > numbers[1]!) return { error: `${where}: the lower bound is above the upper bound.` };
      list.push({ path, op: row.op, value: row.op === "between" ? numbers : numbers[0]! });
      continue;
    }
    if (LIST_OPS.includes(row.op)) {
      const kept = unchangedValue(row);
      const values = Array.isArray(kept)
        ? kept
        : row.value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
            .map(parseScalar);
      if (values.length === 0) return { error: `${where}: enter one or more values, separated by commas.` };
      list.push({ path, op: row.op, value: values, ...caseFlag(row) });
      continue;
    }
    if (row.op === "equals") {
      const kept = unchangedValue(row);
      list.push({ path, op: "equals", value: kept !== undefined && !Array.isArray(kept) ? kept : parseScalar(row.value), ...caseFlag(row) });
      continue;
    }
    if (!row.value) return { error: `${where}: enter the text to compare with.` };
    list.push({ path, op: row.op, value: row.value, ...caseFlag(row) });
  }
  return { conditions: draft.combine === "any" ? { any: list } : { all: list } };
}

function valuePlaceholder(op: McpPolicyConditionOp): string {
  if (LIST_OPS.includes(op)) return "acme/prod, acme/infra";
  if (NUMBER_OPS.includes(op)) return "1000";
  if (op === "matches") return "*.prod.example.com";
  if (op === "starts_with") return "prod-";
  if (op === "ends_with") return ".pdf";
  if (LABEL_OPS.includes(op)) return "pii";
  return "main";
}

/** How several values (a list argument, or [*]) and a missing argument read for a rule with this effect. */
export function conditionsHint(effect: McpToolPolicyEffect | undefined): string {
  return effect === "allow"
    ? "Paths are argument names with dots for nesting and [*] for list items. This rule allows a call only when every list item matches; a missing argument, a value of another type or a list over 1,000 items never matches."
    : "Paths are argument names with dots for nesting and [*] for list items. This rule applies when any list item matches; a missing argument counts as “is not one of” (and matches no other operator), and a value of another type (text for a number, an object) counts as a match. Safest: deny broadly, then allow exceptions with “is one of”.";
}

/**
 * Phase 12.2 — what a rule's label conditions mean in practice: gateway calls carry no labels, and a `sensitive` or
 * data class condition makes the runs the rule covers track labels (scan node outputs for data classes). Empty with no
 * label rows.
 */
export function labelConditionNotes(draft: ConditionsDraft): string[] {
  const values = draft.rows.filter((row) => LABEL_OPS.includes(row.op)).map((row) => row.value.trim());
  if (values.length === 0) return [];
  const notes = ["Data labels exist only in workflow runs: calls through the MCP gateway carry none, so label conditions never match them."];
  if (values.some((value) => value && labelValueNeedsTracking(value))) {
    notes.push(
      "A “sensitive” or data class condition turns on label tracking for runs of the workflows this rule covers (those with an agent, MCP Tool or Execute Workflow node) while it is enabled: node outputs are scanned for data classes, which takes some time on large outputs, and the classes found also feed destination checks."
    );
  }
  return notes;
}

export function McpPolicyConditionsEditor({
  draft,
  onChange,
  disabled,
  effect
}: {
  draft: ConditionsDraft;
  onChange: (draft: ConditionsDraft) => void;
  disabled?: boolean;
  /** The rule's effect, which decides how lists and missing arguments read (see `conditionsHint`). */
  effect?: McpToolPolicyEffect;
}) {
  const update = (key: number, patch: Partial<ConditionDraft>) =>
    onChange({ ...draft, rows: draft.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)) });
  const remove = (key: number) => onChange({ ...draft, rows: draft.rows.filter((row) => row.key !== key) });

  return (
    <fieldset className="mcp-conditions" disabled={disabled} aria-label="Conditions">
      <legend>Conditions</legend>
      {draft.rows.length === 0 ? (
        <p className="kb-subtle">Every call to a matching tool. Add a condition to match only some calls, by their arguments or the run&apos;s data labels.</p>
      ) : (
        <>
          <label className="mcp-conditions-combine">
            Match
            <select
              aria-label="Combine conditions"
              value={draft.combine}
              onChange={(event) => onChange({ ...draft, combine: event.target.value as "all" | "any" })}
            >
              <option value="all">all of these</option>
              <option value="any">any of these</option>
            </select>
          </label>
          <ol className="mcp-condition-rows">
            {draft.rows.map((row, index) => {
              const isLabel = LABEL_OPS.includes(row.op);
              return (
                <li key={row.key} className="mcp-condition-row">
                  {!isLabel && (
                    <input
                      type="text"
                      aria-label={`Condition ${index + 1} argument path`}
                      value={row.path}
                      onChange={(event) => update(row.key, { path: event.target.value })}
                      placeholder="repo or files[*].path"
                      spellCheck={false}
                    />
                  )}
                  <select
                    aria-label={`Condition ${index + 1} operator`}
                    value={row.op}
                    onChange={(event) => {
                      const op = event.target.value as McpPolicyConditionOp;
                      update(row.key, { op, ...(op === "exists" ? { value: "present" } : row.op === "exists" ? { value: "" } : {}) });
                    }}
                  >
                    {CONDITION_OP_LABELS.map((entry) => (
                      <option key={entry.value} value={entry.value}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                  {row.op === "exists" ? (
                    <select
                      aria-label={`Condition ${index + 1} value`}
                      value={row.value === "absent" ? "absent" : "present"}
                      onChange={(event) => update(row.key, { value: event.target.value })}
                    >
                      <option value="present">is present</option>
                      <option value="absent">is absent</option>
                    </select>
                  ) : (
                    <input
                      type={NUMBER_OPS.includes(row.op) || row.op === "between" ? "number" : "text"}
                      aria-label={`Condition ${index + 1} value`}
                      value={row.value}
                      onChange={(event) => update(row.key, { value: event.target.value })}
                      placeholder={row.op === "between" ? "from" : valuePlaceholder(row.op)}
                      spellCheck={false}
                    />
                  )}
                  {row.op === "between" && (
                    <input
                      type="number"
                      aria-label={`Condition ${index + 1} upper bound`}
                      value={row.value2}
                      onChange={(event) => update(row.key, { value2: event.target.value })}
                      placeholder="to"
                    />
                  )}
                  {MCP_POLICY_TEXT_OPS.includes(row.op) && (
                    <label className="mcp-check mcp-condition-case">
                      <input
                        type="checkbox"
                        aria-label={`Condition ${index + 1} ignore case`}
                        checked={row.ignoreCase}
                        onChange={(event) => update(row.key, { ignoreCase: event.target.checked })}
                      />
                      Ignore case
                    </label>
                  )}
                  <button type="button" className="pg-btn ghost" onClick={() => remove(row.key)} aria-label={`Remove condition ${index + 1}`}>
                    Remove
                  </button>
                </li>
              );
            })}
          </ol>
        </>
      )}
      <div className="mcp-conditions-actions">
        <button type="button" className="pg-btn ghost" onClick={() => onChange({ ...draft, rows: [...draft.rows, emptyConditionRow()] })}>
          + Add condition
        </button>
        <small className="kb-subtle">{conditionsHint(effect)}</small>
      </div>
      {labelConditionNotes(draft).map((note) => (
        <p key={note} className="kb-subtle mcp-condition-note">
          {note}
        </p>
      ))}
    </fieldset>
  );
}

const OP_WORDS: Record<McpPolicyConditionOp, string> = {
  equals: "=",
  one_of: "is one of",
  not_one_of: "is not one of",
  starts_with: "starts with",
  ends_with: "ends with",
  matches: "matches",
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
  between: "is between",
  exists: "is present",
  label_present: "data has label",
  label_absent: "data lacks label"
};

/** A rule's conditions in words, for the rule list. */
export function describeConditions(conditions: McpToolPolicyConditions | null | undefined): string | null {
  if (!conditions) return null;
  const combine = "any" in conditions ? "any" : "all";
  const list = "any" in conditions ? conditions.any : conditions.all;
  if (list.length === 0) return null;
  const words = list.map((condition) => {
    if (LABEL_OPS.includes(condition.op)) return `${OP_WORDS[condition.op]} ${String(condition.value ?? "")}`;
    if (condition.op === "exists") return `${condition.path} ${condition.value === false ? "is absent" : "is present"}`;
    if (condition.op === "between" && Array.isArray(condition.value)) return `${condition.path} is between ${condition.value[0]} and ${condition.value[1]}`;
    const value = Array.isArray(condition.value) ? condition.value.map((entry) => JSON.stringify(entry)).join(", ") : JSON.stringify(condition.value);
    return `${condition.path} ${OP_WORDS[condition.op]} ${value}${condition.ignoreCase ? " (ignoring case)" : ""}`;
  });
  return words.join(combine === "any" ? " or " : " and ");
}
