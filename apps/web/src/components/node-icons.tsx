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
  | "schedule"
  | "azure_openai"
  | "azure_storage"
  | "azure_cosmos"
  | "azure_monitor"
  | "azure_search"
  | "azure_embedding"
  | "qdrant"
  | "gemini"
  | "openai"
  | "anthropic"
  | "ollama"
  | "openai_compatible"
  | "system_prompt"
  | "user_prompt"
  | "prompt_template"
  | "llm_call"
  | "agent_orchestrator"
  | "supervisor"
  | "output_guardrail"
  | "input_validator"
  | "output_parser"
  | "rag_retrieve"
  | "document_chunker"
  | "pdf_output"
  | "if_node"
  | "switch_node"
  | "try_catch"
  | "execute_workflow"
  | "mcp_tool"
  | "filter_node"
  | "stop_error"
  | "noop"
  | "aggregate"
  | "split_out"
  | "sort_node"
  | "limit_node"
  | "remove_duplicates"
  | "summarize"
  | "compare_datasets"
  | "rename_keys"
  | "edit_fields"
  | "date_time"
  | "crypto_node"
  | "jwt_node"
  | "xml_node"
  | "html_node"
  | "convert_file"
  | "extract_file"
  | "compression"
  | "edit_image"
  | "error_trigger"
  | "sub_workflow_trigger"
  | "form_trigger"
  | "chat_trigger"
  | "file_trigger"
  | "rss_trigger"
  | "sse_trigger"
  | "mcp_server_trigger"
  | "kafka_trigger"
  | "rabbitmq_trigger"
  | "mqtt_trigger"
  | "manual_trigger"
  | "sticky_note"
  | "text_input"
  | "basic_llm_chain"
  | "qa_chain"
  | "summarization_chain"
  | "information_extractor"
  | "text_classifier"
  | "sentiment_analysis"
  | "ai_transform";

export function PaletteIcon({ icon }: { icon: NodePaletteIconKey }): JSX.Element {
  // ─── Category icons ───
  if (icon === "ai") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M9 9h6v6H9zM5 9V7a2 2 0 0 1 2-2h2M19 9V7a2 2 0 0 0-2-2h-2M5 15v2a2 2 0 0 0 2 2h2M19 15v2a2 2 0 0 1-2 2h-2"
          fill="none" stroke="#7C3AED" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (icon === "app") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.2" fill="none" stroke="#0EA5E9" strokeWidth="1.8" />
        <path
          d="M3.8 12h16.4M12 3.8c2.4 2.2 3.8 5 3.8 8.2S14.4 18 12 20.2M12 3.8C9.6 6 8.2 8.8 8.2 12s1.4 6 3.8 8.2"
          fill="none" stroke="#0EA5E9" strokeWidth="1.4" strokeLinecap="round"
        />
      </svg>
    );
  }
  if (icon === "transform") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 6h10M5 12h14M5 18h8" fill="none" stroke="#F59E0B" strokeWidth="1.8" strokeLinecap="round" />
        <path d="m17 4 2 2-2 2m2 4 2 2-2 2m-4 0 2 2-2 2" fill="none" stroke="#D97706" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (icon === "flow") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="6" cy="6" r="2" fill="none" stroke="#6366F1" strokeWidth="1.8" />
        <circle cx="18" cy="12" r="2" fill="none" stroke="#6366F1" strokeWidth="1.8" />
        <circle cx="6" cy="18" r="2" fill="none" stroke="#6366F1" strokeWidth="1.8" />
        <path d="M8 6h4c3 0 4 2 4 4m0 2c0 2-1 4-4 4H8" fill="none" stroke="#6366F1" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "human") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="7.5" r="3" fill="none" stroke="#8B5CF6" strokeWidth="1.8" />
        <path d="M5.5 19c1.6-3.6 4-5.4 6.5-5.4s4.9 1.8 6.5 5.4" fill="none" stroke="#8B5CF6" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M17 16l2 2 3-3" fill="none" stroke="#22C55E" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (icon === "trigger") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M13 2 4 14h6l-1 8 9-12h-6z" fill="none" stroke="#F59E0B" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    );
  }
  if (icon === "core") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="#94A3B8" strokeWidth="1.8" />
      </svg>
    );
  }

  // ─── LLM / AI node icons ───
  if (icon === "system_prompt") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="4" width="16" height="16" rx="3" fill="none" stroke="#7C3AED" strokeWidth="1.6" />
        <path d="M8 9h8M8 12h6" fill="none" stroke="#A78BFA" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="16" cy="16" r="2.5" fill="#7C3AED" stroke="none" />
        <path d="M15 16h2M16 15v2" fill="none" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "user_prompt") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-4 3V6z" fill="none" stroke="#3B82F6" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M8 8h8M8 11h5" fill="none" stroke="#93C5FD" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "prompt_template") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="3" width="16" height="18" rx="2" fill="none" stroke="#8B5CF6" strokeWidth="1.6" />
        <path d="M8 8h8M8 12h5" fill="none" stroke="#C4B5FD" strokeWidth="1.4" strokeLinecap="round" />
        <text x="14" y="18" fontSize="8" fontWeight="bold" fill="#8B5CF6" fontFamily="monospace">{"{ }"}</text>
      </svg>
    );
  }
  if (icon === "llm_call") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="#7C3AED" strokeWidth="1.6" />
        <path d="M7 10h4M7 13h6" fill="none" stroke="#A78BFA" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="17" cy="12" r="2.5" fill="none" stroke="#7C3AED" strokeWidth="1.4" />
        <path d="M16.2 11.2l.8.8.8-.8" fill="none" stroke="#7C3AED" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (icon === "openai") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" fill="#F2F4F7" stroke="#9AA4B2" strokeWidth="1.2" />
        <path
          d="M12 5.8c1.9 0 3.6 1 4.5 2.5 1.8.2 3.1 1.7 3.1 3.6 0 1.6-1 3-2.4 3.5-.5 1.6-2 2.8-3.8 2.8-.8 0-1.5-.2-2.1-.6-.7.4-1.4.6-2.2.6-1.9 0-3.5-1.3-3.9-3.1-1.2-.6-2-1.9-2-3.3 0-1.8 1.3-3.3 3-3.6.8-1.7 3-2.9 5.8-2.9Z"
          fill="none"
          stroke="#111827"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path d="M8 12h8M12 8v8" fill="none" stroke="#111827" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "anthropic") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="#F6F0E8" />
        <path d="M7 17 11.1 7h1.8L17 17h-1.8l-.9-2.4H9.7L8.8 17H7Zm3.2-3.8h3.6L12 8.8l-1.8 4.4Z" fill="#1F2937" />
      </svg>
    );
  }
  if (icon === "ollama") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="#F3F4F6" />
        <path
          d="M7.4 16.8V9.2c0-2.2 1.6-4 3.6-4h2c2 0 3.6 1.8 3.6 4v7.6"
          fill="none"
          stroke="#111827"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <path d="M9 11.2h6M9.4 16.8h5.2" fill="none" stroke="#111827" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="10" cy="9.4" r="0.8" fill="#111827" />
        <circle cx="14" cy="9.4" r="0.8" fill="#111827" />
      </svg>
    );
  }
  if (icon === "openai_compatible") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="#EFF6FF" />
        <path d="M6 12h12M12 6v12" fill="none" stroke="#2563EB" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M8.5 8.5h7v7h-7z" fill="none" stroke="#1D4ED8" strokeWidth="1.4" />
      </svg>
    );
  }
  if (icon === "agent_orchestrator") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8" fill="none" stroke="#7C3AED" strokeWidth="1.6" />
        <circle cx="12" cy="12" r="3" fill="#7C3AED" />
        <path d="M12 4v3M12 17v3M4 12h3M17 12h3" fill="none" stroke="#A78BFA" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="12" cy="4" r="1.2" fill="#A78BFA" />
        <circle cx="12" cy="20" r="1.2" fill="#A78BFA" />
        <circle cx="4" cy="12" r="1.2" fill="#A78BFA" />
        <circle cx="20" cy="12" r="1.2" fill="#A78BFA" />
      </svg>
    );
  }
  if (icon === "supervisor") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="5" r="3" fill="none" stroke="#6D28D9" strokeWidth="1.6" />
        <circle cx="5" cy="18" r="2.5" fill="none" stroke="#A78BFA" strokeWidth="1.4" />
        <circle cx="19" cy="18" r="2.5" fill="none" stroke="#A78BFA" strokeWidth="1.4" />
        <path d="M12 8v3M9 13l-3 3M15 13l3 3" fill="none" stroke="#7C3AED" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="12" cy="12" r="1.5" fill="#6D28D9" />
      </svg>
    );
  }
  if (icon === "output_guardrail") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3l8 4v6c0 4.4-3.2 8.2-8 9.6C7.2 21.2 4 17.4 4 13V7l8-4z" fill="none" stroke="#EF4444" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M9 12l2 2 4-4" fill="none" stroke="#22C55E" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (icon === "input_validator") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="4" width="16" height="16" rx="3" fill="none" stroke="#0EA5E9" strokeWidth="1.6" />
        <path d="M8 12l2.5 2.5L16 9" fill="none" stroke="#0EA5E9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (icon === "output_parser") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h16M4 12h10M4 17h7" fill="none" stroke="#F59E0B" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M16 14l2.5 2.5M18.5 16.5l2 2" fill="none" stroke="#D97706" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="14" cy="14" r="3" fill="none" stroke="#D97706" strokeWidth="1.4" />
      </svg>
    );
  }
  if (icon === "rag_retrieve") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 6a2 2 0 0 1 2-2h6l2 2h4a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6z" fill="none" stroke="#10B981" strokeWidth="1.6" />
        <circle cx="12" cy="13" r="3" fill="none" stroke="#10B981" strokeWidth="1.4" />
        <path d="M14.2 15.2l2.3 2.3" fill="none" stroke="#059669" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "document_chunker") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="3" width="16" height="18" rx="2" fill="none" stroke="#F97316" strokeWidth="1.6" />
        <path d="M4 9h16M4 15h16" fill="none" stroke="#FB923C" strokeWidth="1.2" strokeDasharray="2 2" />
        <path d="M8 6h8M8 12h6M8 18h4" fill="none" stroke="#FDBA74" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }

  // ─── MCP Tool ───
  if (icon === "mcp_tool") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l2.6-2.6a6 6 0 0 1-7.8 7.8L7.3 19.7a2 2 0 0 1-2.8 0l-.2-.2a2 2 0 0 1 0-2.8l5.2-5.2a6 6 0 0 1 7.8-7.8L14.7 6.3z"
          fill="none" stroke="#0EA5E9" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
        />
      </svg>
    );
  }

  // ─── Memory ───
  if (icon === "memory") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="#8B5CF6" strokeWidth="1.6" />
        <rect x="9" y="9" width="6" height="6" rx="1" fill="#C4B5FD" stroke="#8B5CF6" strokeWidth="1" />
        <path d="M8 3v2M12 3v2M16 3v2M8 19v2M12 19v2M16 19v2M3 8h2M3 12h2M3 16h2M19 8h2M19 12h2M19 16h2" fill="none" stroke="#A78BFA" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }

  // ─── Code ───
  if (icon === "code") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m9 8-4 4 4 4" fill="none" stroke="#10B981" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="m15 8 4 4-4 4" fill="none" stroke="#10B981" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M13 6l-2 12" fill="none" stroke="#6EE7B7" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }

  // ─── HTTP ───
  if (icon === "http") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h16v10H4z" fill="none" stroke="#0EA5E9" strokeWidth="1.8" />
        <path d="M4 10h16" fill="none" stroke="#38BDF8" strokeWidth="1.4" />
        <path d="M8 14h3m2 0h3" fill="none" stroke="#7DD3FC" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }

  // ─── Set / Edit fields ───
  if (icon === "set") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 6h12M6 12h12M6 18h12" fill="none" stroke="#64748B" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="8" cy="6" r="1.2" fill="#3B82F6" />
        <circle cx="8" cy="12" r="1.2" fill="#8B5CF6" />
        <circle cx="8" cy="18" r="1.2" fill="#EC4899" />
      </svg>
    );
  }

  // ─── Response ───
  if (icon === "response") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="5" width="16" height="14" rx="2" fill="none" stroke="#10B981" strokeWidth="1.8" />
        <path d="m9 12 3 3 4-6" fill="none" stroke="#10B981" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // ─── Merge ───
  if (icon === "merge") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 6v4a4 4 0 0 0 4 4h8M6 18v-4a4 4 0 0 1 4-4h8" fill="none" stroke="#6366F1" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="6" cy="6" r="1.8" fill="#818CF8" stroke="#6366F1" strokeWidth="1" />
        <circle cx="6" cy="18" r="1.8" fill="#818CF8" stroke="#6366F1" strokeWidth="1" />
        <circle cx="18" cy="12" r="1.8" fill="#6366F1" stroke="#4F46E5" strokeWidth="1" />
      </svg>
    );
  }

  // ─── Loop ───
  if (icon === "loop") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 8h8a4 4 0 1 1 0 8h-1" fill="none" stroke="#8B5CF6" strokeWidth="1.8" strokeLinecap="round" />
        <path d="m14 18-2.6 2M14 18l-2.6-2M7 8 9.6 5.4M7 8l2.6 2.6" fill="none" stroke="#A78BFA" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // ─── Wait ───
  if (icon === "wait") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8" fill="none" stroke="#F59E0B" strokeWidth="1.8" />
        <path d="M12 8v5l3 2" fill="none" stroke="#D97706" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // ─── Branch (if) ───
  if (icon === "branch" || icon === "if_node") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="6" cy="12" r="2.5" fill="none" stroke="#F59E0B" strokeWidth="1.6" />
        <circle cx="19" cy="6" r="2" fill="none" stroke="#22C55E" strokeWidth="1.6" />
        <circle cx="19" cy="18" r="2" fill="none" stroke="#EF4444" strokeWidth="1.6" />
        <path d="M8.5 11L17 6M8.5 13L17 18" fill="none" stroke="#94A3B8" strokeWidth="1.4" strokeLinecap="round" />
        <text x="4.5" y="13.5" fontSize="5" fontWeight="bold" fill="#F59E0B" fontFamily="sans-serif">?</text>
      </svg>
    );
  }

  // ─── Switch ───
  if (icon === "switch_node") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="5" cy="12" r="2.5" fill="none" stroke="#8B5CF6" strokeWidth="1.6" />
        <circle cx="19" cy="5" r="1.8" fill="#22C55E" />
        <circle cx="19" cy="12" r="1.8" fill="#3B82F6" />
        <circle cx="19" cy="19" r="1.8" fill="#F59E0B" />
        <path d="M7.5 11L17.2 5M7.5 12H17.2M7.5 13L17.2 19" fill="none" stroke="#94A3B8" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }

  // ─── Try/Catch ───
  if (icon === "try_catch") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="#EF4444" strokeWidth="1.6" />
        <path d="M8 9l3 3-3 3" fill="none" stroke="#22C55E" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M14 15h4" fill="none" stroke="#EF4444" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  // ─── Output ───
  if (icon === "output") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="5" width="16" height="14" rx="2" fill="none" stroke="#10B981" strokeWidth="1.8" />
        <path d="M9 12h6m-3-3 3 3-3 3" fill="none" stroke="#10B981" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // ─── PDF Output ───
  if (icon === "pdf_output") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="none" stroke="#EF4444" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M14 3v5h5" fill="none" stroke="#EF4444" strokeWidth="1.4" strokeLinejoin="round" />
        <text x="6" y="17" fontSize="6" fontWeight="bold" fill="#EF4444" fontFamily="sans-serif">PDF</text>
      </svg>
    );
  }

  // ─── Connector ───
  if (icon === "connector") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="7" cy="7" r="3" fill="none" stroke="#0EA5E9" strokeWidth="1.4" />
        <circle cx="17" cy="17" r="3" fill="none" stroke="#8B5CF6" strokeWidth="1.4" />
        <path d="M9.5 9.5l5 5" fill="none" stroke="#64748B" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M15 7h2v2M9 17H7v-2" fill="none" stroke="#94A3B8" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // ─── Google Drive ───
  if (icon === "google_drive") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8.3 3.6h7.2l4.2 7.3h-7.2z" fill="#0F9D58" />
        <path d="m4.2 10.9 3.6-6.2 3.6 6.2-3.6 6.2z" fill="#4285F4" />
        <path d="M12.1 17.1h7.1l-3.6 6.2H8.5z" fill="#F4B400" />
      </svg>
    );
  }

  // ─── Webhook ───
  if (icon === "webhook") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="5" r="3" fill="none" stroke="#6366F1" strokeWidth="1.4" />
        <circle cx="5" cy="18" r="3" fill="none" stroke="#EC4899" strokeWidth="1.4" />
        <circle cx="19" cy="18" r="3" fill="none" stroke="#10B981" strokeWidth="1.4" />
        <path d="M12 8v3l-5.5 5M12 11l5.5 5" fill="none" stroke="#94A3B8" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // ─── Schedule ───
  if (icon === "schedule") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="6" width="16" height="14" rx="2" fill="none" stroke="#0EA5E9" strokeWidth="1.8" />
        <path d="M8 4v4m8-4v4M4 10h16" fill="none" stroke="#38BDF8" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="12" cy="15" r="1.5" fill="#0EA5E9" />
      </svg>
    );
  }

  // ─── Execute Workflow (sub-workflow) ───
  if (icon === "execute_workflow") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="3" fill="none" stroke="#6366F1" strokeWidth="1.4" />
        <rect x="7" y="7" width="10" height="10" rx="2" fill="none" stroke="#818CF8" strokeWidth="1.4" />
        <path d="M11 10l3 2-3 2z" fill="#6366F1" />
      </svg>
    );
  }

  // ─── Azure icons ───
  if (icon === "azure_openai") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4.8 17.5 11.8 4h4.6l-7 13.5H4.8zm5.2 2.5 4.2-8.1h4.8L14.8 20H10z" fill="none" stroke="#0078D4" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    );
  }
  if (icon === "azure_embedding") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="7" cy="7" r="2" fill="#0078D4" />
        <circle cx="17" cy="7" r="2" fill="#0078D4" />
        <circle cx="7" cy="17" r="2" fill="#0078D4" />
        <circle cx="17" cy="17" r="2" fill="#0078D4" />
        <path d="M9 7h6M7 9v6m10-6v6M9 17h6" fill="none" stroke="#0A3E74" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "azure_storage") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="5" width="16" height="4" rx="1.2" fill="#38B2AC" />
        <rect x="4" y="10" width="16" height="4" rx="1.2" fill="#2EA59F" />
        <rect x="4" y="15" width="16" height="4" rx="1.2" fill="#238A84" />
      </svg>
    );
  }
  if (icon === "azure_cosmos") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="2.1" fill="#1A73E8" />
        <ellipse cx="12" cy="12" rx="8" ry="3.6" fill="none" stroke="#1A73E8" strokeWidth="1.6" />
        <ellipse cx="12" cy="12" rx="3.6" ry="8" fill="none" stroke="#1A73E8" strokeWidth="1.4" />
      </svg>
    );
  }
  if (icon === "azure_monitor") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="12" width="3" height="7" rx="1" fill="#4A90E2" />
        <rect x="10.5" y="8" width="3" height="11" rx="1" fill="#2F78D0" />
        <rect x="17" y="5" width="3" height="14" rx="1" fill="#1D5FAF" />
      </svg>
    );
  }
  if (icon === "azure_search") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 15.5a4.5 4.5 0 1 1 3.4-7.4A5 5 0 0 1 19 9.8a4 4 0 0 1-1 7.7H10" fill="none" stroke="#3A8EE6" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="10" cy="15.5" r="2.8" fill="none" stroke="#0B4D8C" strokeWidth="1.6" />
        <path d="m12.1 17.6 2.4 2.4" fill="none" stroke="#0B4D8C" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  // ─── Qdrant ───
  if (icon === "qdrant") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3.6 19.2 7.8v8.4L12 20.4l-7.2-4.2V7.8z" fill="none" stroke="#e63b5c" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="m12 3.6 7.2 4.2-7.2 4.2-7.2-4.2 7.2-4.2zm0 8.4v8.4" fill="none" stroke="#b81f47" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    );
  }

  // ─── Gemini ───
  if (icon === "gemini") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2C12 2 14.5 8.5 12 12C9.5 8.5 12 2 12 2Z" fill="none" stroke="#4285F4" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12 22C12 22 14.5 15.5 12 12C9.5 15.5 12 22 12 22Z" fill="none" stroke="#34A853" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M2 12C2 12 8.5 9.5 12 12C8.5 14.5 2 12 2 12Z" fill="none" stroke="#EA4335" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M22 12C22 12 15.5 9.5 12 12C15.5 14.5 22 12 22 12Z" fill="none" stroke="#FBBC05" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // ─── Filter ───
  if (icon === "filter_node") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 6h16l-6 7v5l-4 2V13L4 6z" fill="none" stroke="#0EA5E9" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    );
  }

  // ─── Stop & Error ───
  if (icon === "stop_error") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <polygon points="12,3 21,8.2 21,15.8 12,21 3,15.8 3,8.2" fill="none" stroke="#EF4444" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M12 8v5" fill="none" stroke="#EF4444" strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="16" r="1" fill="#EF4444" />
      </svg>
    );
  }

  // ─── No-Op ───
  if (icon === "noop") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8" fill="none" stroke="#94A3B8" strokeWidth="1.6" />
        <path d="M8 12h8" fill="none" stroke="#94A3B8" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  // ─── Aggregate ───
  if (icon === "aggregate") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="4" width="6" height="6" rx="1" fill="none" stroke="#3B82F6" strokeWidth="1.4" />
        <rect x="14" y="4" width="6" height="6" rx="1" fill="none" stroke="#3B82F6" strokeWidth="1.4" />
        <rect x="4" y="14" width="6" height="6" rx="1" fill="none" stroke="#3B82F6" strokeWidth="1.4" />
        <rect x="14" y="14" width="6" height="6" rx="1" fill="#3B82F6" stroke="#2563EB" strokeWidth="1.4" />
        <path d="M10 7h4M10 17h4M7 10v4M17 10v4" fill="none" stroke="#93C5FD" strokeWidth="1" strokeLinecap="round" />
      </svg>
    );
  }

  // ─── Split Out ───
  if (icon === "split_out") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="6" cy="12" r="3" fill="#8B5CF6" stroke="#7C3AED" strokeWidth="1.2" />
        <circle cx="19" cy="6" r="2" fill="none" stroke="#A78BFA" strokeWidth="1.4" />
        <circle cx="19" cy="12" r="2" fill="none" stroke="#A78BFA" strokeWidth="1.4" />
        <circle cx="19" cy="18" r="2" fill="none" stroke="#A78BFA" strokeWidth="1.4" />
        <path d="M9 11l8-4M9 12h8M9 13l8 4" fill="none" stroke="#C4B5FD" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }

  // ─── Sort ───
  if (icon === "sort_node") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 4v16M7 4l-3 3M7 4l3 3" fill="none" stroke="#3B82F6" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M17 20V4M17 20l-3-3M17 20l3-3" fill="none" stroke="#EF4444" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // ─── Limit ───
  if (icon === "limit_node") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="4" width="16" height="16" rx="3" fill="none" stroke="#F59E0B" strokeWidth="1.6" />
        <text x="7" y="16" fontSize="10" fontWeight="bold" fill="#F59E0B" fontFamily="sans-serif">N</text>
      </svg>
    );
  }

  // ─── Remove Duplicates ───
  if (icon === "remove_duplicates") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="5" width="12" height="8" rx="2" fill="none" stroke="#94A3B8" strokeWidth="1.4" />
        <rect x="9" y="11" width="12" height="8" rx="2" fill="none" stroke="#EF4444" strokeWidth="1.4" />
        <path d="M14 13l2 2 3-3" fill="none" stroke="#22C55E" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // ─── Summarize ───
  if (icon === "summarize") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 6h16M4 10h16M4 14h10" fill="none" stroke="#94A3B8" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M4 18h6" fill="none" stroke="#8B5CF6" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }

  // ─── Compare Datasets ───
  if (icon === "compare_datasets") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="6" width="8" height="12" rx="1.5" fill="none" stroke="#3B82F6" strokeWidth="1.4" />
        <rect x="13" y="6" width="8" height="12" rx="1.5" fill="none" stroke="#F59E0B" strokeWidth="1.4" />
        <path d="M11 10h2M11 14h2" fill="none" stroke="#94A3B8" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  // ─── Rename Keys ───
  if (icon === "rename_keys") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <text x="3" y="12" fontSize="8" fill="#94A3B8" fontFamily="monospace">ab</text>
        <path d="M12 9l3 0" fill="none" stroke="#F59E0B" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M14 7l2 2-2 2" fill="none" stroke="#F59E0B" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        <text x="16" y="12" fontSize="8" fill="#10B981" fontFamily="monospace">xy</text>
        <path d="M4 17h16" fill="none" stroke="#E2E8F0" strokeWidth="1" />
      </svg>
    );
  }

  // ─── Edit Fields ───
  if (icon === "edit_fields") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="#3B82F6" strokeWidth="1.6" />
        <path d="M8 9h8M8 13h5" fill="none" stroke="#93C5FD" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M16 13l-2 5h3l-2 5" fill="none" stroke="#F59E0B" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // ─── Date/Time ───
  if (icon === "date_time") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="13" r="7" fill="none" stroke="#0EA5E9" strokeWidth="1.6" />
        <path d="M12 9v4l2.5 1.5" fill="none" stroke="#38BDF8" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8 4h8" fill="none" stroke="#0EA5E9" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  // ─── Crypto ───
  if (icon === "crypto_node") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="11" width="14" height="9" rx="2" fill="none" stroke="#F59E0B" strokeWidth="1.6" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" fill="none" stroke="#D97706" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="12" cy="15.5" r="1.5" fill="#F59E0B" />
      </svg>
    );
  }

  // ─── JWT ───
  if (icon === "jwt_node") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8" fill="none" stroke="#D63AFF" strokeWidth="1.6" />
        <text x="7" y="16" fontSize="8" fontWeight="bold" fill="#D63AFF" fontFamily="sans-serif">JWT</text>
      </svg>
    );
  }

  // ─── XML ───
  if (icon === "xml_node") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="none" stroke="#F97316" strokeWidth="1.4" />
        <path d="M8 9l2 3-2 3M16 9l-2 3 2 3" fill="none" stroke="#F97316" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M13 8l-2 8" fill="none" stroke="#FB923C" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }

  // ─── HTML ───
  if (icon === "html_node") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 4l1.6 16L12 21l6.4-1L20 4z" fill="none" stroke="#E34F26" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M8 8h8l-.5 5-3.5 1.2L8.5 13l-.2-2h3" fill="none" stroke="#F06529" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // ─── Convert to File ───
  if (icon === "convert_file") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="none" stroke="#3B82F6" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M14 3v5h5" fill="none" stroke="#3B82F6" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M9 14l3 3 3-3" fill="none" stroke="#60A5FA" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // ─── Extract from File ───
  if (icon === "extract_file") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="none" stroke="#8B5CF6" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M14 3v5h5" fill="none" stroke="#8B5CF6" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M9 15l3-3 3 3" fill="none" stroke="#A78BFA" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // ─── Compression ───
  if (icon === "compression") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="#64748B" strokeWidth="1.6" />
        <path d="M12 5v3M12 10v3M12 15v3M10 6h4M10 12h4M10 18h4" fill="none" stroke="#94A3B8" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }

  // ─── Edit Image ───
  if (icon === "edit_image") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="#EC4899" strokeWidth="1.6" />
        <circle cx="8" cy="10" r="2" fill="#FBCFE8" stroke="#EC4899" strokeWidth="1" />
        <path d="M3 16l5-4 4 3 3-2 5 3" fill="none" stroke="#EC4899" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // ─── Trigger variants ───
  if (icon === "manual_trigger") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3v6M8 6l4-3 4 3" fill="none" stroke="#22C55E" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="6" y="11" width="12" height="9" rx="2" fill="none" stroke="#22C55E" strokeWidth="1.6" />
        <path d="M10 15h4" fill="none" stroke="#86EFAC" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "form_trigger") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="3" width="14" height="18" rx="2" fill="none" stroke="#8B5CF6" strokeWidth="1.6" />
        <path d="M8 8h8M8 12h8M8 16h5" fill="none" stroke="#C4B5FD" strokeWidth="1.4" strokeLinecap="round" />
        <rect x="15" y="14" width="3" height="3" rx=".5" fill="none" stroke="#8B5CF6" strokeWidth="1.2" />
      </svg>
    );
  }
  if (icon === "chat_trigger") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8l-4 3V6z" fill="none" stroke="#10B981" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M8 8h8M8 11h5" fill="none" stroke="#6EE7B7" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "file_trigger") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="none" stroke="#F59E0B" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M14 3v5h5" fill="none" stroke="#F59E0B" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M13 2 4 14h6l-1 8 9-12h-6z" fill="none" stroke="#F59E0B" strokeWidth="0" />
        <circle cx="17" cy="17" r="4" fill="#FEF3C7" stroke="#F59E0B" strokeWidth="1.2" />
        <path d="M17 15v2h2" fill="none" stroke="#D97706" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "rss_trigger") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="6" cy="18" r="2" fill="#F97316" />
        <path d="M4 12a8 8 0 0 1 8 8" fill="none" stroke="#F97316" strokeWidth="2" strokeLinecap="round" />
        <path d="M4 6a14 14 0 0 1 14 14" fill="none" stroke="#FB923C" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "sse_trigger") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 8h4l2-4 3 8 2-4h5" fill="none" stroke="#0EA5E9" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M4 16h4l2 4 3-8 2 4h5" fill="none" stroke="#38BDF8" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (icon === "mcp_server_trigger") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="6" y="4" width="12" height="16" rx="2" fill="none" stroke="#6366F1" strokeWidth="1.6" />
        <circle cx="12" cy="9" r="2" fill="#818CF8" />
        <path d="M9 14h6M9 17h6" fill="none" stroke="#A5B4FC" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "kafka_trigger") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="3" fill="none" stroke="#231F20" strokeWidth="1.6" />
        <circle cx="18" cy="6" r="2" fill="none" stroke="#231F20" strokeWidth="1.4" />
        <circle cx="18" cy="18" r="2" fill="none" stroke="#231F20" strokeWidth="1.4" />
        <circle cx="6" cy="6" r="2" fill="none" stroke="#231F20" strokeWidth="1.4" />
        <circle cx="6" cy="18" r="2" fill="none" stroke="#231F20" strokeWidth="1.4" />
        <path d="M14 10l3-3M14 14l3 3M10 10l-3-3M10 14l-3 3" fill="none" stroke="#231F20" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "rabbitmq_trigger") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="8" width="18" height="10" rx="2" fill="none" stroke="#FF6600" strokeWidth="1.6" />
        <rect x="13" y="4" width="5" height="6" rx="1" fill="none" stroke="#FF6600" strokeWidth="1.4" />
        <circle cx="8" cy="13" r="2" fill="#FF6600" />
        <circle cx="14" cy="13" r="2" fill="none" stroke="#FF6600" strokeWidth="1.4" />
      </svg>
    );
  }
  if (icon === "mqtt_trigger") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="16" r="2" fill="#660066" />
        <path d="M6 8a6 6 0 0 1 12 0" fill="none" stroke="#660066" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M9 11a3 3 0 0 1 6 0" fill="none" stroke="#993399" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M12 14v-3" fill="none" stroke="#660066" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "error_trigger") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3L2 20h20L12 3z" fill="none" stroke="#EF4444" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M12 10v4" fill="none" stroke="#EF4444" strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="17" r="1" fill="#EF4444" />
      </svg>
    );
  }
  if (icon === "sub_workflow_trigger") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="3" fill="none" stroke="#6366F1" strokeWidth="1.4" />
        <path d="M13 2 4 14h6l-1 8 9-12h-6z" fill="none" stroke="#F59E0B" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    );
  }
  if (icon === "text_input") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="5" width="16" height="14" rx="2" fill="none" stroke="#64748B" strokeWidth="1.6" />
        <path d="M8 9h8M8 13h5" fill="none" stroke="#94A3B8" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M15 17v-4" fill="none" stroke="#3B82F6" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "sticky_note") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 4h16v12l-4 4H4V4z" fill="#FEF3C7" stroke="#F59E0B" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M16 16v4l4-4h-4z" fill="#FDE68A" stroke="#F59E0B" strokeWidth="1" strokeLinejoin="round" />
        <path d="M7 9h10M7 13h6" fill="none" stroke="#D97706" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }

  // ─── LLM Chain nodes ───
  if (icon === "basic_llm_chain") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 6h16v3H4zM4 11h16v3H4zM4 16h16v3H4z" fill="none" stroke="#7C3AED" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M12 9v2M12 14v2" fill="none" stroke="#A78BFA" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "qa_chain") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="10" r="7" fill="none" stroke="#0EA5E9" strokeWidth="1.6" />
        <text x="9" y="14" fontSize="10" fontWeight="bold" fill="#0EA5E9" fontFamily="sans-serif">?</text>
        <path d="M12 17v2M12 21v1" fill="none" stroke="#38BDF8" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "summarization_chain") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 6h16M4 10h14M4 14h10M4 18h6" fill="none" stroke="#F97316" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M18 14l2-2 2 2M20 12v8" fill="none" stroke="#FB923C" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (icon === "information_extractor") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="3" fill="none" stroke="#10B981" strokeWidth="1.4" />
        <path d="M7 8h4M7 12h6M7 16h3" fill="none" stroke="#6EE7B7" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M15 8h2M15 12h2M15 16h2" fill="none" stroke="#10B981" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "text_classifier") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4" width="7" height="7" rx="1.5" fill="none" stroke="#3B82F6" strokeWidth="1.4" />
        <rect x="14" y="4" width="7" height="7" rx="1.5" fill="none" stroke="#F59E0B" strokeWidth="1.4" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" fill="none" stroke="#10B981" strokeWidth="1.4" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" fill="none" stroke="#EF4444" strokeWidth="1.4" />
        <path d="M10 7.5h4M10 17.5h4M6.5 11v3M17.5 11v3" fill="none" stroke="#94A3B8" strokeWidth="1" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "sentiment_analysis") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="none" stroke="#EC4899" strokeWidth="1.6" />
        <circle cx="8.5" cy="10" r="1" fill="#EC4899" />
        <circle cx="15.5" cy="10" r="1" fill="#EC4899" />
        <path d="M8 15c1.5 2 6.5 2 8 0" fill="none" stroke="#EC4899" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "ai_transform") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 6h7v5H4z" fill="none" stroke="#8B5CF6" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M13 13h7v5h-7z" fill="none" stroke="#10B981" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M11 8.5h2l3 3.5h-2" fill="none" stroke="#F59E0B" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M14 10l1.5 2" fill="none" stroke="#F59E0B" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }

  // ─── Fallback ───
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="#94A3B8" strokeWidth="1.8" />
    </svg>
  );
}

/**
 * Mapping from Tier 1 integration node types to public logo paths.
 * Logos live at apps/web/public/logos/*.svg and are served statically.
 */
export const NODE_LOGO_MAP: Record<string, string> = {
  openai_chat_model: "/logos/openai.svg",
  anthropic_chat_model: "/logos/anthropic.svg",
  ollama_chat_model: "/logos/ollama.svg",
  openai_compatible_chat_model: "/logos/openai-compatible.svg",
  ai_gateway_chat_model: "/logos/openai-compatible.svg",
  azure_openai_chat_model: "/logos/azure-openai.svg",
  google_gemini_chat_model: "/logos/gemini.svg",
  http_request: "/logos/http.svg",
  webhook_input: "/logos/http.svg",
  webhook_response: "/logos/http.svg",
  slack_send_message: "/logos/slack.svg",
  slack_trigger: "/logos/slack.svg",
  smtp_send_email: "/logos/smtp.svg",
  imap_email_trigger: "/logos/imap.svg",
  google_sheets_read: "/logos/google-sheets.svg",
  google_sheets_append: "/logos/google-sheets.svg",
  google_sheets_update: "/logos/google-sheets.svg",
  google_sheets_trigger: "/logos/google-sheets.svg",
  postgres_query: "/logos/postgresql.svg",
  postgres_trigger: "/logos/postgresql.svg",
  mysql_query: "/logos/mysql.svg",
  mongo_operation: "/logos/mongodb.svg",
  redis_command: "/logos/redis.svg",
  redis_trigger: "/logos/redis.svg",
  github_action: "/logos/github.svg",
  github_webhook_trigger: "/logos/github.svg",
  teams_send_message: "/logos/microsoft-teams.svg",
  notion_create_page: "/logos/notion.svg",
  notion_query_database: "/logos/notion.svg",
  airtable_create_record: "/logos/airtable.svg",
  airtable_list_records: "/logos/airtable.svg",
  airtable_update_record: "/logos/airtable.svg",
  jira_create_issue: "/logos/jira.svg",
  jira_search_issues: "/logos/jira.svg",
  salesforce_create_record: "/logos/salesforce.svg",
  salesforce_query: "/logos/salesforce.svg",
  hubspot_create_contact: "/logos/hubspot.svg",
  hubspot_get_contact: "/logos/hubspot.svg",
  stripe_create_customer: "/logos/stripe.svg",
  stripe_create_charge: "/logos/stripe.svg",
  stripe_webhook_trigger: "/logos/stripe.svg",
  aws_s3_put_object: "/logos/aws-s3.svg",
  aws_s3_get_object: "/logos/aws-s3.svg",
  aws_s3_list_objects: "/logos/aws-s3.svg",
  telegram_send_message: "/logos/telegram.svg",
  telegram_trigger: "/logos/telegram.svg",
  discord_send_message: "/logos/discord.svg",
  discord_trigger: "/logos/discord.svg",
  google_drive_source: "/logos/google-drive.svg",
  google_drive_trigger: "/logos/google-drive.svg",
  google_calendar_create_event: "/logos/google-calendar.svg",
  google_calendar_list_events: "/logos/google-calendar.svg",
  twilio_send_sms: "/logos/twilio.svg"
};

export function resolveNodeLogo(nodeType: string): string | undefined {
  return NODE_LOGO_MAP[nodeType];
}

export function NodeLogoImage({
  nodeType,
  size = 20
}: {
  nodeType: string;
  size?: number;
}): JSX.Element | null {
  const src = resolveNodeLogo(nodeType);
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      style={{ objectFit: "contain", display: "inline-block" }}
    />
  );
}

const NODE_ICON_MAP: Record<string, NodePaletteIconKey> = {
  webhook_input: "webhook",
  schedule_trigger: "schedule",
  text_input: "text_input",
  system_prompt: "system_prompt",
  user_prompt: "user_prompt",
  prompt_template: "prompt_template",
  llm_call: "llm_call",
  openai_chat_model: "openai",
  anthropic_chat_model: "anthropic",
  ollama_chat_model: "ollama",
  openai_compatible_chat_model: "openai_compatible",
  ai_gateway_chat_model: "openai_compatible",
  azure_openai_chat_model: "azure_openai",
  google_gemini_chat_model: "gemini",
  embeddings_azure_openai: "azure_embedding",
  agent_orchestrator: "agent_orchestrator",
  supervisor_node: "supervisor",
  output_guardrail: "output_guardrail",
  input_validator: "input_validator",
  output_parser: "output_parser",
  rag_retrieve: "rag_retrieve",
  local_memory: "memory",
  session_artifact_load: "memory",
  session_artifact_save: "memory",
  mcp_tool: "mcp_tool",
  connector_source: "connector",
  google_drive_source: "google_drive",
  azure_storage: "azure_storage",
  azure_cosmos_db: "azure_cosmos",
  azure_monitor_http: "azure_monitor",
  azure_ai_search_vector_store: "azure_search",
  qdrant_vector_store: "qdrant",
  document_chunker: "document_chunker",
  http_request: "http",
  set_node: "set",
  code_node: "code",
  if_node: "if_node",
  switch_node: "switch_node",
  chat_intent_router: "switch_node",
  try_catch: "try_catch",
  loop_node: "loop",
  merge_node: "merge",
  execute_workflow: "execute_workflow",
  wait_node: "wait",
  human_approval: "human",
  output: "output",
  helper_chat_response: "response",
  pdf_output: "pdf_output",
  webhook_response: "response",
  filter_node: "filter_node",
  stop_and_error: "stop_error",
  noop_node: "noop",
  aggregate_node: "aggregate",
  split_out_node: "split_out",
  sort_node: "sort_node",
  limit_node: "limit_node",
  remove_duplicates_node: "remove_duplicates",
  summarize_node: "summarize",
  compare_datasets_node: "compare_datasets",
  rename_keys_node: "rename_keys",
  edit_fields_node: "edit_fields",
  date_time_node: "date_time",
  crypto_node: "crypto_node",
  jwt_node: "jwt_node",
  xml_node: "xml_node",
  html_node: "html_node",
  convert_to_file_node: "convert_file",
  extract_from_file_node: "extract_file",
  compression_node: "compression",
  edit_image_node: "edit_image",
  manual_trigger: "manual_trigger",
  form_trigger: "form_trigger",
  chat_trigger: "chat_trigger",
  file_trigger: "file_trigger",
  rss_trigger: "rss_trigger",
  sse_trigger: "sse_trigger",
  mcp_server_trigger: "mcp_server_trigger",
  kafka_trigger: "kafka_trigger",
  rabbitmq_trigger: "rabbitmq_trigger",
  mqtt_trigger: "mqtt_trigger",
  error_trigger: "error_trigger",
  sub_workflow_trigger: "sub_workflow_trigger",
  sticky_note: "sticky_note",
  basic_llm_chain: "basic_llm_chain",
  qa_chain: "qa_chain",
  summarization_chain: "summarization_chain",
  information_extractor: "information_extractor",
  text_classifier: "text_classifier",
  sentiment_analysis: "sentiment_analysis",
  ai_transform: "ai_transform"
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
  const logo = resolveNodeLogo(nodeType);
  if (logo) {
    return <NodeLogoImage nodeType={nodeType} />;
  }
  return <PaletteIcon icon={resolveNodeIcon(nodeType, fallbackIcon)} />;
}
