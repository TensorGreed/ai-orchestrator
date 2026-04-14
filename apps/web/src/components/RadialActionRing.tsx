import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { EditorNode, EditorNodeData } from "../lib/workflow";

export type RadialAction =
  | { kind: "edit" }
  | { kind: "duplicate" }
  | { kind: "toggleDisabled" }
  | { kind: "delete" }
  | { kind: "setColor"; color: EditorNodeData["color"] };

interface RadialActionRingProps {
  node: EditorNode;
  /** Absolute viewport-relative position of the node's center. */
  center: { x: number; y: number };
  onAction: (action: RadialAction) => void;
}

interface RingItem {
  id: string;
  label: string;
  title: string;
  angle: number;
  action: RadialAction;
  variant?: "danger" | "active";
}

const RADIUS = 58;
const BUTTON_SIZE = 36;

const COLOR_SWATCHES: Array<{ key: EditorNodeData["color"]; swatch: string; label: string }> = [
  { key: undefined, label: "None", swatch: "transparent" },
  { key: "blue", swatch: "#3b82f6", label: "Blue" },
  { key: "green", swatch: "#10b981", label: "Green" },
  { key: "yellow", swatch: "#eab308", label: "Yellow" },
  { key: "red", swatch: "#ef4444", label: "Red" },
  { key: "purple", swatch: "#8b5cf6", label: "Purple" },
  { key: "pink", swatch: "#ec4899", label: "Pink" },
  { key: "gray", swatch: "#94a3b8", label: "Gray" }
];

export function RadialActionRing({ node, center, onAction }: RadialActionRingProps) {
  const [showColors, setShowColors] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target as Node)) {
        setShowColors(false);
      }
    };
    if (showColors) {
      window.addEventListener("mousedown", onClick);
      return () => window.removeEventListener("mousedown", onClick);
    }
    return undefined;
  }, [showColors]);

  const items: RingItem[] = [
    {
      id: "edit",
      label: "✎",
      title: "Edit (Enter)",
      angle: -90,
      action: { kind: "edit" }
    },
    {
      id: "duplicate",
      label: "⎘",
      title: "Duplicate (Ctrl+D)",
      angle: -30,
      action: { kind: "duplicate" }
    },
    {
      id: "toggle",
      label: node.data.disabled ? "▶" : "⏸",
      title: node.data.disabled ? "Enable (E)" : "Disable (E)",
      angle: 30,
      action: { kind: "toggleDisabled" },
      variant: node.data.disabled ? "active" : undefined
    },
    {
      id: "color",
      label: "🎨",
      title: "Color…",
      angle: 90,
      action: { kind: "setColor", color: undefined }
    },
    {
      id: "delete",
      label: "🗑",
      title: "Delete (Del)",
      angle: 150,
      action: { kind: "delete" },
      variant: "danger"
    }
  ];

  const rootStyle: CSSProperties = {
    position: "fixed",
    left: center.x,
    top: center.y,
    pointerEvents: "none",
    zIndex: 25
  };

  return (
    <div ref={rootRef} className="radial-ring-root" style={rootStyle} aria-label="Node actions">
      {items.map((item) => {
        const rad = (item.angle * Math.PI) / 180;
        const tx = Math.cos(rad) * RADIUS;
        const ty = Math.sin(rad) * RADIUS;
        const style: CSSProperties = {
          position: "absolute",
          width: BUTTON_SIZE,
          height: BUTTON_SIZE,
          left: tx - BUTTON_SIZE / 2,
          top: ty - BUTTON_SIZE / 2,
          pointerEvents: "auto"
        };
        const className = `radial-ring-btn${item.variant ? ` radial-${item.variant}` : ""}`;
        return (
          <button
            key={item.id}
            type="button"
            className={className}
            style={style}
            title={item.title}
            aria-label={item.title}
            onClick={(event) => {
              event.stopPropagation();
              if (item.id === "color") {
                setShowColors((v) => !v);
                return;
              }
              onAction(item.action);
            }}
          >
            {item.label}
          </button>
        );
      })}
      {showColors && (
        <div className="radial-color-pop" style={{ pointerEvents: "auto" }}>
          {COLOR_SWATCHES.map((option) => (
            <button
              key={option.key ?? "none"}
              type="button"
              className={`radial-color-dot${node.data.color === option.key ? " selected" : ""}`}
              style={{
                background: option.swatch === "transparent" ? undefined : option.swatch
              }}
              title={option.label}
              aria-label={`Set color ${option.label}`}
              onClick={(event) => {
                event.stopPropagation();
                onAction({ kind: "setColor", color: option.key });
                setShowColors(false);
              }}
            >
              {option.swatch === "transparent" ? "∅" : ""}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
