import { useMemo, useState, type FormEvent } from "react";

interface WidgetMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface ChatWidgetProps {
  workflowId: string;
  apiBase: string;
  endpointPath?: string;
  theme?: "light" | "dark";
  title?: string;
  systemPrompt?: string;
  sessionId?: string;
}

function createWidgetMessageId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function createWidgetSessionId(workflowId: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `widget-${workflowId}-${crypto.randomUUID()}`;
  }
  return `widget-${workflowId}-${Date.now().toString(36)}`;
}

function decodeBufferLikeText(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.type !== "Buffer" || !Array.isArray(record.data)) {
    return null;
  }
  const bytes = record.data.filter((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255) as number[];
  if (bytes.length !== record.data.length) {
    return null;
  }
  try {
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

function extractAssistantText(value: unknown): string {
  const decodedRoot = decodeBufferLikeText(value);
  if (decodedRoot !== null) {
    return decodedRoot;
  }

  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const candidate = [record.result, record.answer, record.text, record.content].find(
      (entry) =>
        (typeof entry === "string" && String(entry).trim()) ||
        decodeBufferLikeText(entry) !== null
    );
    const decoded = decodeBufferLikeText(candidate);
    if (decoded !== null) {
      return decoded;
    }
    if (typeof candidate === "string") {
      return candidate;
    }
  }

  if (value === undefined || value === null) {
    return "";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isPdfDataUrl(value: string): boolean {
  return /^data:application\/pdf;base64,/i.test(value.trim());
}

export function ChatWidget({
  workflowId,
  apiBase,
  endpointPath,
  theme = "dark",
  title = "AI Assistant",
  systemPrompt = "You are a helpful assistant.",
  sessionId
}: ChatWidgetProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<WidgetMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatSessionId] = useState(() => sessionId ?? createWidgetSessionId(workflowId));

  const endpointUrl = useMemo(() => {
    const normalizedBase = apiBase.replace(/\/+$/, "");
    const resolvedPath = endpointPath?.trim()
      ? endpointPath.trim()
      : `/webhook/${encodeURIComponent(workflowId)}`;

    if (/^https?:\/\//i.test(resolvedPath)) {
      return resolvedPath;
    }

    return `${normalizedBase}${resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`}`;
  }, [apiBase, endpointPath, workflowId]);

  const palette = theme === "light"
    ? {
        panelBg: "#ffffff",
        panelBorder: "#d6deec",
        buttonBg: "#265af3",
        buttonText: "#ffffff",
        textColor: "#243047",
        assistantBg: "#f5f8ff",
        userBg: "#265af3",
        userText: "#ffffff"
      }
    : {
        panelBg: "#111827",
        panelBorder: "#2a3954",
        buttonBg: "#4f7cff",
        buttonText: "#ffffff",
        textColor: "#e5eefc",
        assistantBg: "#1c2940",
        userBg: "#4f7cff",
        userText: "#ffffff"
      };

  const sendMessage = async () => {
    const trimmed = input.trim();
    if (!trimmed || busy) {
      return;
    }

    setError(null);
    setBusy(true);
    setInput("");

    const userMessageId = createWidgetMessageId("user");
    const assistantMessageId = createWidgetMessageId("assistant");

    setMessages((current) => [
      ...current,
      { id: userMessageId, role: "user", text: trimmed },
      { id: assistantMessageId, role: "assistant", text: "..." }
    ]);

    try {
      const response = await fetch(endpointUrl, {
        method: "POST",
        headers: {
          "content-type": "text/plain;charset=UTF-8"
        },
        body: JSON.stringify({
          user_prompt: trimmed,
          system_prompt: systemPrompt,
          session_id: chatSessionId
        })
      });

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).error === "string"
            ? String((payload as Record<string, unknown>).error)
            : "Widget request failed";
        throw new Error(message);
      }

      const payloadRecord = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
      const answer = extractAssistantText(payloadRecord.output ?? payloadRecord.result ?? payloadRecord);

      setMessages((current) =>
        current.map((entry) =>
          entry.id === assistantMessageId
            ? {
                ...entry,
                text: answer || "No response returned."
              }
            : entry
        )
      );
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Widget request failed";
      setError(message);
      setMessages((current) =>
        current.map((entry) =>
          entry.id === assistantMessageId
            ? {
                ...entry,
                text: `Error: ${message}`
              }
            : entry
        )
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void sendMessage();
  };

  return (
    <div style={{ position: "fixed", right: "18px", bottom: "18px", zIndex: 2147483000, fontFamily: "'Inter', sans-serif" }}>
      {isOpen && (
        <div
          style={{
            width: "320px",
            maxWidth: "calc(100vw - 24px)",
            height: "460px",
            maxHeight: "calc(100vh - 92px)",
            borderRadius: "14px",
            border: `1px solid ${palette.panelBorder}`,
            background: palette.panelBg,
            boxShadow: "0 18px 46px rgba(10, 18, 36, 0.35)",
            marginBottom: "10px",
            display: "grid",
            gridTemplateRows: "48px 1fr auto"
          }}
        >
          <div
            style={{
              borderBottom: `1px solid ${palette.panelBorder}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 12px",
              color: palette.textColor
            }}
          >
            <strong style={{ fontSize: "0.92rem" }}>{title}</strong>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              style={{
                border: "none",
                background: "transparent",
                color: palette.textColor,
                fontSize: "0.95rem",
                cursor: "pointer"
              }}
              aria-label="Close widget"
            >
              x
            </button>
          </div>

          <div style={{ padding: "10px", overflowY: "auto", display: "grid", gap: "8px", alignContent: "start" }}>
            {messages.length === 0 && (
              <div style={{ color: palette.textColor, opacity: 0.75, fontSize: "0.84rem" }}>
                Ask a question to start the conversation.
              </div>
            )}
            {messages.map((message) => (
              <div
                key={message.id}
                style={{
                  justifySelf: message.role === "user" ? "end" : "start",
                  maxWidth: "88%",
                  borderRadius: "10px",
                  padding: "8px 10px",
                  fontSize: "0.85rem",
                  lineHeight: 1.4,
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  background: message.role === "user" ? palette.userBg : palette.assistantBg,
                  color: message.role === "user" ? palette.userText : palette.textColor
                }}
              >
                {message.role === "assistant" && message.text && isPdfDataUrl(message.text) ? (
                  <a href={message.text} download="workflow-output.pdf" target="_blank" rel="noreferrer">
                    Download PDF
                  </a>
                ) : (
                  message.text
                )}
              </div>
            ))}
          </div>

          <form onSubmit={handleSubmit} style={{ borderTop: `1px solid ${palette.panelBorder}`, padding: "10px", display: "grid", gap: "8px" }}>
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Type your message..."
              style={{
                borderRadius: "8px",
                border: `1px solid ${palette.panelBorder}`,
                background: theme === "light" ? "#fff" : "#0e172a",
                color: palette.textColor,
                fontSize: "0.85rem",
                padding: "8px 10px"
              }}
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              style={{
                border: "none",
                borderRadius: "8px",
                background: palette.buttonBg,
                color: palette.buttonText,
                fontWeight: 700,
                padding: "9px 12px",
                cursor: busy ? "not-allowed" : "pointer",
                opacity: busy ? 0.72 : 1
              }}
            >
              {busy ? "Sending..." : "Send"}
            </button>
            {error && <div style={{ color: "#f87171", fontSize: "0.76rem" }}>{error}</div>}
          </form>
        </div>
      )}

      <button
        type="button"
        onClick={() => setIsOpen((value) => !value)}
        style={{
          width: "56px",
          height: "56px",
          borderRadius: "50%",
          border: "none",
          background: palette.buttonBg,
          color: palette.buttonText,
          fontWeight: 700,
          cursor: "pointer",
          boxShadow: "0 14px 30px rgba(37, 89, 243, 0.42)"
        }}
        aria-label="Toggle chat widget"
      >
        Chat
      </button>
    </div>
  );
}
