import { memo } from "react";
import { type NodeProps } from "reactflow";
import type { EditorNodeData } from "../lib/workflow";

/**
 * Lightweight markdown → HTML conversion sufficient for sticky-note annotations.
 * Supports: #/##/### headings, **bold**, *italic*, `code`, - / * lists, and line breaks.
 * Deliberately tiny (no external dep) since sticky notes are view-only annotations.
 */
function renderMarkdown(input: string): string {
  const escape = (s: string) =>
    s.replace(/[&<>"']/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
    );

  const lines = input.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;

  const flushList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  for (const raw of lines) {
    const line = raw;
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      continue;
    }
    flushList();
    if (/^###\s+/.test(line)) out.push(`<h3>${inline(line.replace(/^###\s+/, ""))}</h3>`);
    else if (/^##\s+/.test(line)) out.push(`<h2>${inline(line.replace(/^##\s+/, ""))}</h2>`);
    else if (/^#\s+/.test(line)) out.push(`<h1>${inline(line.replace(/^#\s+/, ""))}</h1>`);
    else if (!line.trim()) out.push("<br/>");
    else out.push(`<p>${inline(line)}</p>`);
  }
  flushList();

  function inline(text: string): string {
    return escape(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
        const safeUrl = /^https?:\/\//i.test(url) ? url : "#";
        return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      });
  }

  return out.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function StickyNoteComponent({ data, selected }: NodeProps<EditorNodeData>) {
  const config = asRecord(data.config);
  const content = typeof config.content === "string" && config.content.trim() ? config.content : data.label;
  const color = typeof config.color === "string" ? config.color : "yellow";
  const fontSize = typeof config.fontSize === "number" ? config.fontSize : 14;
  const html = renderMarkdown(content);
  return (
    <div
      className={`wf-sticky wf-sticky-${color}${selected ? " selected" : ""}`}
      style={{ fontSize: `${fontSize}px` }}
    >
      <div className="wf-sticky-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export const StickyNoteNode = memo(StickyNoteComponent);
