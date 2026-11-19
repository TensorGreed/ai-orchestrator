/**
 * Small disclosure pieces of the node inspector: the `?` help next to a label and the one "More" section that holds a
 * node's rarely used settings. Both are native `<details>`, so they work with the keyboard and screen readers.
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

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

interface MoreEntry {
  count: number;
  open: boolean;
}

/** Where a node form's rarely used fields go: the inspector's one More section. */
interface MoreSlot {
  target: HTMLElement | null;
  report: (id: string, entry: MoreEntry | null) => void;
}

const MoreSlotContext = createContext<MoreSlot | null>(null);

/** The More section's disclosure: closed by default; the summary counts the settings that differ from their defaults. */
function MoreDisclosure({ setCount, defaultOpen, children }: { setCount: number; defaultOpen: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  return (
    <details
      className="cfg-advanced cfg-more"
      data-testid="advanced-fields"
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <span>More</span>
        {setCount > 0 ? <span className="cfg-advanced-count">{setCount} set</span> : null}
      </summary>
      <div className="cfg-advanced-body">{children}</div>
    </details>
  );
}

/**
 * The inspector's form with its one More section after it. The node form's `AdvancedFields` (wherever they sit in
 * `form`) are shown at the top of More, followed by `settings`, the settings every node has. The summary counts what
 * differs from the defaults in both, so a changed value is never hidden without a trace.
 */
export function FormWithMore({
  form,
  settings,
  settingsCount = 0,
  settingsOpen = false
}: {
  form: ReactNode;
  settings?: ReactNode;
  /** Settings in `settings` that differ from their defaults. */
  settingsCount?: number;
  /** Open More (something in `settings` needs attention). */
  settingsOpen?: boolean;
}) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [entries, setEntries] = useState<Record<string, MoreEntry>>({});
  const report = useCallback((id: string, entry: MoreEntry | null) => {
    setEntries((current) => {
      const previous = current[id];
      if (entry === null) {
        if (!previous) return current;
        const { [id]: _removed, ...rest } = current;
        return rest;
      }
      if (previous && previous.count === entry.count && previous.open === entry.open) return current;
      return { ...current, [id]: entry };
    });
  }, []);
  const slot = useMemo(() => ({ target, report }), [target, report]);
  const values = Object.values(entries);
  const count = settingsCount + values.reduce((sum, entry) => sum + entry.count, 0);
  const open = settingsOpen || values.some((entry) => entry.open);
  return (
    <MoreSlotContext.Provider value={slot}>
      {form}
      <MoreDisclosure setCount={count} defaultOpen={open}>
        <div className="cfg-more-fields" ref={setTarget} />
        {settings}
      </MoreDisclosure>
    </MoreSlotContext.Provider>
  );
}

/**
 * A node type's rarely used fields. Inside the inspector they are shown in its one More section (see `FormWithMore`);
 * elsewhere they get a closed section of their own. The summary counts the fields that differ from their defaults.
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
  const slot = useContext(MoreSlotContext);
  const id = useId();
  const report = slot?.report;
  useEffect(() => {
    report?.(id, { count: setCount, open: defaultOpen });
  }, [report, id, setCount, defaultOpen]);
  useEffect(() => () => report?.(id, null), [report, id]);
  if (slot) return slot.target ? createPortal(children, slot.target) : null;
  return (
    <MoreDisclosure setCount={setCount} defaultOpen={defaultOpen}>
      {children}
    </MoreDisclosure>
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
