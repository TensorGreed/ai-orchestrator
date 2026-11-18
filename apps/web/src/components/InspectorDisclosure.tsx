/**
 * Small disclosure pieces of the node inspector: the `?` help next to a label and the per-node "Advanced" section
 * that holds a node type's rarely used fields. Both are native `<details>`, so they work with the keyboard and
 * screen readers without local state.
 */
import { useEffect, useState, type ReactNode } from "react";

/** Inline `?` next to a field label; the explanation opens on click (or Enter / Space). */
export function HelpHint({ children, topic }: { children: ReactNode; topic?: string }) {
  const name = topic ? `Help: ${topic}` : "Show help";
  return (
    <details className="cfg-help">
      <summary aria-label={name} title={name}>
        ?
      </summary>
      <div className="cfg-help-body cfg-tip">{children}</div>
    </details>
  );
}

/**
 * A node type's rarely used fields, closed by default. The summary counts the fields that differ from their
 * defaults, so a changed value is never hidden without a trace.
 */
export function AdvancedFields({
  setCount = 0,
  defaultOpen = false,
  children
}: {
  /** Fields in this section that differ from their defaults. */
  setCount?: number;
  /** Open it (for example when something in it needs attention). It stays open after that until the user closes it. */
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  return (
    <details
      className="cfg-advanced"
      data-testid="advanced-fields"
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <span>Advanced</span>
        {setCount > 0 ? <span className="cfg-advanced-count">{setCount} set</span> : null}
      </summary>
      <div className="cfg-advanced-body">{children}</div>
    </details>
  );
}

/** How many of `values` differ from their defaults (undefined, empty strings and empty lists count as unset). */
export function countSet(values: Array<[value: unknown, defaultValue: unknown, sampleValue?: unknown]>): number {
  let count = 0;
  for (const [value, defaultValue, sampleValue] of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0) continue;
    if (sameSetting(value, defaultValue) || (sampleValue !== undefined && sameSetting(value, sampleValue))) continue;
    count += 1;
  }
  return count;
}

function sameSetting(left: unknown, right: unknown): boolean {
  if (typeof left === "string" && typeof right === "string") return left.trim() === right.trim();
  return JSON.stringify(left) === JSON.stringify(right);
}
