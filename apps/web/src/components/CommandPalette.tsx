import { useEffect, useMemo, useRef, useState } from "react";
import { SearchIcon } from "./shell-icons";
import type { CommandPaletteItem } from "./studio-layout-types";

/** Pure filter used by the palette: case-insensitive substring match on label, group and hint. */
export function filterCommandItems(items: CommandPaletteItem[], query: string): CommandPaletteItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  const terms = needle.split(/\s+/);
  return items.filter((item) => {
    const haystack = `${item.label} ${item.group} ${item.hint ?? ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

interface CommandPaletteProps {
  open: boolean;
  items: CommandPaletteItem[];
  onClose: () => void;
}

export function CommandPalette({ open, items, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => filterCommandItems(items, query), [items, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onWindowKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onWindowKey);
    return () => window.removeEventListener("keydown", onWindowKey);
  }, [open, onClose]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, open]);

  if (!open) return null;

  const runItem = (item: CommandPaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (filtered.length === 0 ? 0 : (index + 1) % filtered.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (filtered.length === 0 ? 0 : (index - 1 + filtered.length) % filtered.length));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runItem(filtered[activeIndex]);
    }
  };

  let lastGroup: string | null = null;

  return (
    <div className="cmdk-overlay" onMouseDown={onClose} role="presentation">
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="cmdk-input-row">
          <SearchIcon className="cmdk-search-icon" />
          <input
            ref={inputRef}
            className="cmdk-input"
            type="text"
            value={query}
            placeholder="Type a command or search…"
            aria-label="Search commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={filtered[activeIndex] ? `cmdk-item-${filtered[activeIndex].id}` : undefined}
            aria-autocomplete="list"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="cmdk-esc">esc</kbd>
        </div>
        <ul className="cmdk-list" id="cmdk-list" role="listbox" ref={listRef}>
          {filtered.length === 0 && <li className="cmdk-empty">No matching commands</li>}
          {filtered.map((item, index) => {
            const showGroup = item.group !== lastGroup;
            lastGroup = item.group;
            return (
              <li key={item.id} className="cmdk-row" data-index={index}>
                {showGroup && <div className="cmdk-group">{item.group}</div>}
                <button
                  type="button"
                  id={`cmdk-item-${item.id}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={index === activeIndex ? "cmdk-item is-active" : "cmdk-item"}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => runItem(item)}
                >
                  <span className="cmdk-item-label">{item.label}</span>
                  {item.hint && <span className="cmdk-item-hint">{item.hint}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
