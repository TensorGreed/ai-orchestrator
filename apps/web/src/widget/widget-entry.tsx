import React from "react";
import ReactDOM from "react-dom/client";
import { ChatWidget } from "./ChatWidget";

function resolveScriptElement(): HTMLScriptElement | null {
  if (document.currentScript instanceof HTMLScriptElement) {
    return document.currentScript;
  }

  const scripts = Array.from(document.querySelectorAll("script[data-workflow-id]"));
  if (!scripts.length) {
    return null;
  }
  const last = scripts[scripts.length - 1];
  return last instanceof HTMLScriptElement ? last : null;
}

function getApiBase(script: HTMLScriptElement): string {
  const explicitBase = script.dataset.apiBase?.trim();
  if (explicitBase) {
    return explicitBase.replace(/\/+$/, "");
  }

  try {
    const scriptUrl = new URL(script.src, window.location.href);
    return scriptUrl.origin;
  } catch {
    return window.location.origin;
  }
}

const script = resolveScriptElement();

if (script) {
  const workflowId = script.dataset.workflowId?.trim();
  if (workflowId) {
    const host = document.createElement("div");
    host.dataset.aiOrchestratorWidgetHost = workflowId;
    document.body.appendChild(host);

    const themeValue = script.dataset.theme === "light" ? "light" : "dark";
    const endpointPath = script.dataset.endpoint?.trim();
    const title = script.dataset.title?.trim();
    const systemPrompt = script.dataset.systemPrompt?.trim();
    const sessionId = script.dataset.sessionId?.trim();
    const apiBase = getApiBase(script);

    ReactDOM.createRoot(host).render(
      <React.StrictMode>
        <ChatWidget
          workflowId={workflowId}
          apiBase={apiBase}
          endpointPath={endpointPath}
          theme={themeValue}
          title={title}
          systemPrompt={systemPrompt}
          sessionId={sessionId}
        />
      </React.StrictMode>
    );
  } else {
    // eslint-disable-next-line no-console
    console.error("[ai-orchestrator-widget] Missing required data-workflow-id attribute.");
  }
}
