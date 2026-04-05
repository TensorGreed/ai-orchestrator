import type { JSX } from "react";

export type PaletteCategoryIconKey = "ai" | "app" | "transform" | "flow" | "core" | "human" | "trigger";

export type NodePaletteIconKey =
  | PaletteCategoryIconKey
  | "code"
  | "http"
  | "set"
  | "response"
  | "merge"
  | "loop"
  | "wait"
  | "branch"
  | "output"
  | "tool"
  | "memory"
  | "connector"
  | "google_drive"
  | "webhook"
  | "schedule";

export function PaletteIcon({ icon }: { icon: NodePaletteIconKey }): JSX.Element {
  if (icon === "ai") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M9 9h6v6H9zM5 9V7a2 2 0 0 1 2-2h2M19 9V7a2 2 0 0 0-2-2h-2M5 15v2a2 2 0 0 0 2 2h2M19 15v2a2 2 0 0 1-2 2h-2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (icon === "app") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M3.8 12h16.4M12 3.8c2.4 2.2 3.8 5 3.8 8.2S14.4 18 12 20.2M12 3.8C9.6 6 8.2 8.8 8.2 12s1.4 6 3.8 8.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (icon === "transform") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 6h10M5 12h14M5 18h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path
          d="m17 4 2 2-2 2m2 4 2 2-2 2m-4 0 2 2-2 2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (icon === "flow") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="6" cy="6" r="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="18" cy="12" r="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="6" cy="18" r="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M8 6h4c3 0 4 2 4 4m0 2c0 2-1 4-4 4H8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (icon === "human") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="7.5" r="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M5.5 19c1.6-3.6 4-5.4 6.5-5.4s4.9 1.8 6.5 5.4M17 16l2 2 3-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (icon === "trigger") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M13 2 4 14h6l-1 8 9-12h-6z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    );
  }
  if (icon === "code") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="m9 8-4 4 4 4m6-8 4 4-4 4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (icon === "http") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h16v10H4z" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M4 10h16M8 14h3m2 0h3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "set") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 6h12M6 12h12M6 18h12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="8" cy="6" r="1.2" fill="currentColor" />
        <circle cx="8" cy="12" r="1.2" fill="currentColor" />
        <circle cx="8" cy="18" r="1.2" fill="currentColor" />
      </svg>
    );
  }
  if (icon === "response") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="5" width="16" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="m9 12 3 3 4-6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (icon === "merge") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 6v4a4 4 0 0 0 4 4h8M6 18v-4a4 4 0 0 1 4-4h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="6" cy="6" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="6" cy="18" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="18" cy="12" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    );
  }
  if (icon === "loop") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M7 8h8a4 4 0 1 1 0 8h-1m3 0-2.6 2.6M7 8 9.6 5.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (icon === "wait") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M12 8v5l3 2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "branch") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="6" cy="6" r="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="18" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="18" cy="16" r="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M8 6h3a3 3 0 0 1 3 3v5a3 3 0 0 0 3 3h1M14 9h4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (icon === "output") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="5" width="16" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M9 12h6m-3-3 3 3-3 3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (icon === "tool") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="m14 5 5 5-8 8-5 1 1-5zM12 7l5 5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (icon === "memory") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M9 9h6v6H9z" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    );
  }
  if (icon === "connector") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 7h4v4H7zM13 13h4v4h-4z" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M11 9h2m0 0v2m0-2-2 2m2 2h2m-2 0v2m0-2 2 2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (icon === "google_drive") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8.3 3.6h7.2l4.2 7.3h-7.2z" fill="#0F9D58" />
        <path d="m4.2 10.9 3.6-6.2 3.6 6.2-3.6 6.2z" fill="#4285F4" />
        <path d="M12.1 17.1h7.1l-3.6 6.2H8.5z" fill="#F4B400" />
      </svg>
    );
  }
  if (icon === "webhook") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 15a4 4 0 1 1 0-8h3m5 2a4 4 0 1 1 0 8h-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M9 12h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "schedule") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="6" width="16" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M8 4v4m8-4v4M4 10h16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

const NODE_ICON_MAP: Record<string, NodePaletteIconKey> = {
  webhook_input: "webhook",
  schedule_trigger: "schedule",
  text_input: "trigger",
  system_prompt: "ai",
  user_prompt: "ai",
  prompt_template: "ai",
  llm_call: "ai",
  agent_orchestrator: "ai",
  output_guardrail: "ai",
  rag_retrieve: "ai",
  local_memory: "memory",
  mcp_tool: "tool",
  connector_source: "connector",
  google_drive_source: "google_drive",
  http_request: "http",
  document_chunker: "transform",
  set_node: "set",
  input_validator: "transform",
  output_parser: "transform",
  code_node: "code",
  if_node: "branch",
  switch_node: "branch",
  try_catch: "branch",
  loop_node: "loop",
  merge_node: "merge",
  execute_workflow: "flow",
  wait_node: "wait",
  human_approval: "human",
  output: "output",
  pdf_output: "output",
  webhook_response: "response"
};

export function resolveNodeIcon(nodeType: string, fallbackIcon: PaletteCategoryIconKey = "core"): NodePaletteIconKey {
  return NODE_ICON_MAP[nodeType] ?? fallbackIcon;
}

export function NodeTypeIcon({
  nodeType,
  fallbackIcon = "core"
}: {
  nodeType: string;
  fallbackIcon?: PaletteCategoryIconKey;
}): JSX.Element {
  return <PaletteIcon icon={resolveNodeIcon(nodeType, fallbackIcon)} />;
}
