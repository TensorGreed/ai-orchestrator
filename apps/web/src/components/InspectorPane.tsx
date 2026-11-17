/**
 * The Input and Output panes of the node inspector: one header (title, Table / JSON switch, a "⋯" menu with the
 * schema view, internal fields and the pane's own actions, and a collapse button), a body, and the separators that
 * resize the panes. A collapsed pane is a thin rail that opens again on click.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { RunDataPaneContext, type DataViewMode, type RunDataPaneView } from "./NodeRunData";

export interface PaneMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  /** A checkable entry (view options): rendered as menuitemcheckbox. */
  checked?: boolean;
  disabled?: boolean;
  /** Why the entry is disabled, shown as its tooltip. */
  note?: string;
}

/** A small "⋯" menu. Escape closes it without closing the inspector; focus returns to the button. */
export function PaneMenu({ label, items }: { label: string; items: PaneMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    first?.focus();
    const handlePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (menuRef.current?.contains(target) || buttonRef.current?.contains(target))) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointer);
    return () => document.removeEventListener("pointerdown", handlePointer);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // Handled here, so the inspector's own Escape (close) does not run.
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      // Focus leaves the menu: close it, and let the Tab move focus on.
      setOpen(false);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : event.key === "ArrowDown"
            ? (index + 1) % buttons.length
            : (index - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div className="insp-menu" onKeyDown={open ? handleKeyDown : undefined}>
      <button
        ref={buttonRef}
        type="button"
        className="insp-icon-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open ? (
        <div ref={menuRef} id={menuId} className="insp-menu-list" role="menu" aria-label={label}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={item.checked === undefined ? undefined : item.checked}
              disabled={item.disabled}
              title={item.note}
              onClick={() => {
                item.onSelect();
                close(true);
              }}
            >
              {item.checked !== undefined ? (
                <span className="insp-menu-check" aria-hidden="true">
                  {item.checked ? "✓" : ""}
                </span>
              ) : null}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface DataPaneProps {
  /** "Input" or "Output": the pane's region name and title. */
  title: "Input" | "Output";
  collapsed?: boolean;
  /** Without it the pane cannot be collapsed (the tabs layout, where the pane is the whole tab). */
  onToggleCollapsed?: () => void;
  /** Short text after the title (for example "Pinned"). */
  meta?: ReactNode;
  /** The pane's own menu entries, after the view entries. */
  actions?: PaneMenuItem[];
  children: ReactNode;
}

/** One data pane with its own view choice, shared by every block inside it. */
export function DataPane({ title, collapsed = false, onToggleCollapsed, meta, actions = [], children }: DataPaneProps) {
  const [mode, setMode] = useState<DataViewMode>("table");
  const [showInternal, setShowInternal] = useState(false);
  const view = useMemo<RunDataPaneView>(() => ({ mode, showInternal, setShowInternal }), [mode, showInternal]);
  const lower = title.toLowerCase();
  const side = title === "Input" ? "input" : "output";
  // The button that was clicked unmounts on toggle: focus moves to the one that replaces it.
  const toggleButtonRef = useRef<HTMLButtonElement | null>(null);
  const refocusAfterToggle = useRef(false);
  useEffect(() => {
    if (!refocusAfterToggle.current) return;
    refocusAfterToggle.current = false;
    toggleButtonRef.current?.focus();
  }, [collapsed]);
  const toggle = onToggleCollapsed
    ? () => {
        refocusAfterToggle.current = true;
        onToggleCollapsed();
      }
    : undefined;

  if (collapsed && toggle) {
    return (
      <section className={`insp-pane insp-pane-${side} collapsed`} aria-label={title}>
        <button ref={toggleButtonRef} type="button" className="insp-pane-rail" onClick={toggle} aria-expanded={false} aria-label={`Show ${lower}`} title={`Show ${lower}`}>
          <span>{title}</span>
        </button>
      </section>
    );
  }

  const viewItems: PaneMenuItem[] = [
    { key: "schema", label: "Schema view", checked: mode === "schema", onSelect: () => setMode(mode === "schema" ? "table" : "schema") },
    { key: "internal", label: "Show internal fields", checked: showInternal, onSelect: () => setShowInternal(!showInternal) }
  ];

  return (
    <section className={`insp-pane insp-pane-${side}`} aria-label={title}>
      <div className="insp-pane-head">
        <h3 className="insp-pane-title">{title}</h3>
        {meta ? <span className="insp-pane-meta">{meta}</span> : null}
        <div className="run-data-modes insp-pane-modes" role="group" aria-label={`${title}: view as`}>
          {(["table", "json"] as const).map((key) => (
            <button key={key} type="button" className={mode === key ? "active" : ""} aria-pressed={mode === key} onClick={() => setMode(key)}>
              {key === "table" ? "Table" : "JSON"}
            </button>
          ))}
        </div>
        <PaneMenu label={`${title} options`} items={[...viewItems, ...actions]} />
        {toggle ? (
          <button
            ref={toggleButtonRef}
            type="button"
            className="insp-icon-btn insp-pane-collapse"
            onClick={toggle}
            aria-expanded={true}
            aria-label={`Hide ${lower}`}
            title={`Hide ${lower}`}
          >
            <span aria-hidden="true">{side === "input" ? "‹" : "›"}</span>
          </button>
        ) : null}
      </div>
      <div className="insp-pane-body">
        <RunDataPaneContext.Provider value={view}>{children}</RunDataPaneContext.Provider>
      </div>
    </section>
  );
}

/** Drag or arrow keys to resize the pane on one side of it. */
export function PaneSeparator({
  label,
  value,
  min,
  max,
  onChange,
  onCommit,
  /** +1 when moving right makes the pane wider (input pane), -1 when it makes it narrower (output pane). */
  direction
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  onCommit: () => void;
  direction: 1 | -1;
}) {
  const origin = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = useCallback((next: number) => Math.round(Math.min(max, Math.max(min, next))), [max, min]);
  // The callbacks change on every render; the drag listeners read the latest ones without subscribing again.
  const latest = useRef({ onChange, onCommit, clamp });
  latest.current = { onChange, onCommit, clamp };

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      if (!origin.current) return;
      latest.current.onChange(latest.current.clamp(origin.current.width + direction * (event.clientX - origin.current.x)));
    };
    const up = () => {
      setDragging(false);
      origin.current = null;
      latest.current.onCommit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
    };
  }, [direction, dragging]);

  return (
    <div
      className={dragging ? "insp-pane-sep active" : "insp-pane-sep"}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        origin.current = { x: event.clientX, width: value };
        setDragging(true);
      }}
      onKeyDown={(event) => {
        if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          onChange(event.key === "Home" ? min : max);
          onCommit();
          return;
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const step = event.shiftKey ? 64 : 16;
        onChange(clamp(value + (event.key === "ArrowRight" ? step : -step) * direction));
        onCommit();
      }}
    />
  );
}
