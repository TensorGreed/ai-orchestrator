import { useEffect } from "react";

interface ShortcutRow {
  keys: string[];
  description: string;
}

const SHORTCUT_GROUPS: Array<{ title: string; rows: ShortcutRow[] }> = [
  {
    title: "Canvas",
    rows: [
      { keys: ["Shift + click"], description: "Add or remove a node from the current selection" },
      { keys: ["Shift + drag"], description: "Drag-select multiple nodes at once" },
      { keys: ["Double-click node"], description: "Open the node configuration panel" },
      { keys: ["Double-click edge"], description: "Delete the edge" },
      { keys: ["Right-click edge"], description: "Delete the edge" }
    ]
  },
  {
    title: "Edit",
    rows: [
      { keys: ["Ctrl/⌘ + C"], description: "Copy selected nodes (and the edges between them)" },
      { keys: ["Ctrl/⌘ + V"], description: "Paste at canvas center with a small offset" },
      { keys: ["Ctrl/⌘ + D"], description: "Duplicate selected nodes in place" },
      { keys: ["Ctrl/⌘ + Z"], description: "Undo last add / delete / paste / duplicate / config change" },
      { keys: ["Ctrl/⌘ + Shift + Z", "Ctrl/⌘ + Y"], description: "Redo" },
      { keys: ["E"], description: "Toggle enabled/disabled on selected nodes" },
      { keys: ["Delete", "Backspace"], description: "Delete selected nodes or edges" }
    ]
  },
  {
    title: "Navigation",
    rows: [
      { keys: ["Scroll"], description: "Pan the canvas" },
      { keys: ["Ctrl/⌘ + scroll"], description: "Zoom in / out" },
      { keys: ["Escape"], description: "Close the open panel or node library" }
    ]
  },
  {
    title: "Help",
    rows: [
      { keys: ["?", "Ctrl/⌘ + /"], description: "Open this reference" }
    ]
  }
];

interface KeyboardShortcutsPanelProps {
  open: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsPanel({ open, onClose }: KeyboardShortcutsPanelProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="shortcuts-overlay" onClick={onClose}>
      <aside
        className="shortcuts-panel"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="Keyboard shortcuts"
      >
        <div className="shortcuts-header">
          <h3>Keyboard shortcuts</h3>
          <button type="button" className="shortcuts-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="shortcuts-body">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} className="shortcuts-group">
              <h4>{group.title}</h4>
              <ul>
                {group.rows.map((row) => (
                  <li key={row.description}>
                    <span className="shortcuts-keys">
                      {row.keys.map((k, index) => (
                        <span key={k}>
                          {index > 0 ? <em className="shortcuts-or"> or </em> : null}
                          <kbd>{k}</kbd>
                        </span>
                      ))}
                    </span>
                    <span className="shortcuts-desc">{row.description}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </aside>
    </div>
  );
}
