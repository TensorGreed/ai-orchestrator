import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { NodeTypeIcon, PaletteIcon, type PaletteCategoryIconKey } from "./node-icons";

export interface PaletteDefinition {
  type: string;
  label: string;
  category: string;
  description: string;
  sampleConfig: Record<string, unknown>;
}

export interface PaletteSection {
  key: string;
  title: string;
  description: string;
  icon: PaletteCategoryIconKey;
  items: PaletteDefinition[];
}

export interface NodePaletteProps {
  title: string;
  subtitle: string;
  sections: PaletteSection[];
  /** When set, the palette is a flat filtered list (agent attachment drawer). */
  flatItems?: PaletteDefinition[] | null;
  emptyMessage?: string;
  onPick: (definition: PaletteDefinition) => void;
  onClose: () => void;
  onTidy?: () => void;
}

interface FlatRow {
  item: PaletteDefinition;
  sectionKey: string;
  icon: PaletteCategoryIconKey;
}

function matches(item: PaletteDefinition, query: string): boolean {
  return (
    item.label.toLowerCase().includes(query) ||
    item.type.toLowerCase().includes(query) ||
    item.description.toLowerCase().includes(query)
  );
}

/**
 * Searchable node palette grouped by category. Filter input is focused on
 * open, Esc closes, arrow keys move the highlight and Enter adds the node.
 */
export function NodePalette({ title, subtitle, sections, flatItems, emptyMessage, onPick, onClose, onTidy }: NodePaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const normalized = query.trim().toLowerCase();

  const visibleSections = useMemo<PaletteSection[]>(() => {
    if (flatItems) {
      const items = normalized ? flatItems.filter((item) => matches(item, normalized)) : flatItems;
      return items.length ? [{ key: "filtered", title, description: subtitle, icon: "ai", items }] : [];
    }
    return sections
      .map((section) => ({
        ...section,
        items: normalized ? section.items.filter((item) => matches(item, normalized)) : section.items
      }))
      .filter((section) => section.items.length > 0);
  }, [flatItems, normalized, sections, subtitle, title]);

  const rows = useMemo<FlatRow[]>(
    () => visibleSections.flatMap((section) => section.items.map((item) => ({ item, sectionKey: section.key, icon: section.icon }))),
    [visibleSections]
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [normalized, flatItems]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row-index="${activeIndex}"]`);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (rows.length ? (index + 1) % rows.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (rows.length ? (index - 1 + rows.length) % rows.length : 0));
    } else if (event.key === "Enter") {
      const row = rows[activeIndex];
      if (row) {
        event.preventDefault();
        onPick(row.item);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  const onDragStart = (event: DragEvent<HTMLElement>, type: string) => {
    event.dataTransfer.setData("application/reactflow", type);
    event.dataTransfer.effectAllowed = "move";
  };

  let rowCursor = -1;

  return (
    <aside
      className="node-palette"
      role="dialog"
      aria-label={title}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <div className="node-palette-header">
        <div className="node-palette-heading-row">
          <div className="node-palette-heading">
            <h3>{title}</h3>
            <p>{subtitle}</p>
          </div>
          {onTidy && (
            <button type="button" className="node-palette-tidy-btn" onClick={onTidy} title="Tidy layout (stage columns)">
              Tidy
            </button>
          )}
          <button className="node-palette-close-btn" onClick={onClose} title="Close node palette (Esc)" aria-label="Close node palette">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m7 7 10 10M17 7 7 17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        <label className="node-palette-search">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="m16 16 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            placeholder="Search nodes…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search nodes"
            aria-activedescendant={rows[activeIndex] ? `palette-row-${rows[activeIndex]!.item.type}` : undefined}
            autoComplete="off"
          />
          <kbd>Esc</kbd>
        </label>
      </div>

      <div className="node-palette-body" ref={listRef}>
        {rows.length === 0 && (
          <div className="node-palette-empty">
            {normalized ? `No nodes match "${query.trim()}".` : emptyMessage ?? "No nodes available."}
          </div>
        )}
        {visibleSections.map((section) => (
          <section key={section.key} className="node-palette-section" aria-label={section.title}>
            {!flatItems && (
              <header className="node-palette-section-head">
                <span className="node-palette-section-icon">
                  <PaletteIcon icon={section.icon} />
                </span>
                <span className="node-palette-section-title">{section.title}</span>
                <span className="node-palette-section-count">{section.items.length}</span>
              </header>
            )}
            <div className="node-palette-list" role="listbox" aria-label={section.title}>
              {section.items.map((item) => {
                rowCursor += 1;
                const rowIndex = rowCursor;
                const active = rowIndex === activeIndex;
                return (
                  <button
                    key={item.type}
                    id={`palette-row-${item.type}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-row-index={rowIndex}
                    className={`node-palette-node-row${active ? " active" : ""}`}
                    draggable
                    onDragStart={(event) => onDragStart(event, item.type)}
                    onMouseEnter={() => setActiveIndex(rowIndex)}
                    onClick={() => onPick(item)}
                    title={item.description}
                  >
                    <span className="node-palette-icon-wrap">
                      <NodeTypeIcon nodeType={item.type} fallbackIcon={section.icon} />
                    </span>
                    <span className="node-palette-row-copy">
                      <strong>{item.label}</strong>
                      <small>{item.description || item.type}</small>
                    </span>
                    <span className="node-palette-row-type">{item.type}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </aside>
  );
}
