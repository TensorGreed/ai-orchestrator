import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_RECORDED_PARAM, isApiLink, runRecordedFromUrl, tryRecordedQuestion } from "./demo-actions";

const ORIGIN = "https://lsquarem.com";

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("API links", () => {
  it("are same-origin links under /api/, which a static host cannot serve", () => {
    expect(isApiLink("/api/audit/export?from=2026-01-01", ORIGIN)).toBe(true);
    expect(isApiLink(`${ORIGIN}/api/mcp/cassettes/c1/export`, ORIGIN)).toBe(true);
    expect(isApiLink("/api", ORIGIN)).toBe(true);
    expect(isApiLink("/docs/", ORIGIN)).toBe(false);
    expect(isApiLink("/demo/?mode=editor", ORIGIN)).toBe(false);
    expect(isApiLink("/apidocs", ORIGIN)).toBe(false);
    expect(isApiLink("https://example.com/api/x", ORIGIN)).toBe(false);
  });
});

describe("Try the recorded question", () => {
  it("puts the question in the chat box for the visitor to send", () => {
    document.body.innerHTML = '<input class="chat-message-input" aria-label="Message" value="Tell me a joke" /><button aria-label="Run workflow"></button>';
    const input = document.querySelector<HTMLInputElement>("input")!;
    const typed = vi.fn();
    input.addEventListener("input", typed);
    const backend = { armRecordedInput: vi.fn(() => "recorded") };
    expect(tryRecordedQuestion(backend, "wf-1", "What is MCP?")).toBe("filled");
    expect(input.value).toBe("What is MCP?");
    expect(typed).toHaveBeenCalledTimes(1);
    expect(backend.armRecordedInput).not.toHaveBeenCalled();
  });

  it("in the editor, runs the recorded question once through the Run button", () => {
    document.body.innerHTML = '<button aria-label="Run workflow"></button>';
    const clicked = vi.fn();
    document.querySelector("button")!.addEventListener("click", clicked);
    const backend = { armRecordedInput: vi.fn(() => "What is MCP?") };
    expect(tryRecordedQuestion(backend, "wf-1", "What is MCP?")).toBe("ran");
    expect(backend.armRecordedInput).toHaveBeenCalledWith("wf-1");
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a Run button or a recording", () => {
    const backend = { armRecordedInput: vi.fn(() => null) };
    expect(tryRecordedQuestion(backend, "wf-1", "x")).toBe("unavailable");
    document.body.innerHTML = '<button aria-label="Run workflow"></button>';
    expect(tryRecordedQuestion(backend, "wf-1", "x")).toBe("unavailable");
  });

  it("runs from a ?demoRun=recorded link once the editor has opened that workflow, and drops the parameter", () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", `/demo/?workflowId=wf-1&mode=editor&${RUN_RECORDED_PARAM}=recorded`);
    const backend = { armRecordedInput: vi.fn(() => "What is MCP?") };
    const stop = runRecordedFromUrl(backend, window);
    expect(window.location.search).toBe("?workflowId=wf-1&mode=editor");
    const clicked = vi.fn();
    document.body.innerHTML = '<select aria-label="Workflow"><option value="other" selected>Other</option><option value="wf-1">One</option></select><button aria-label="Run workflow"></button>';
    document.querySelector("button")!.addEventListener("click", clicked);
    vi.advanceTimersByTime(600);
    expect(clicked).not.toHaveBeenCalled();
    document.querySelector("select")!.value = "wf-1";
    vi.advanceTimersByTime(250);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(backend.armRecordedInput).toHaveBeenCalledWith("wf-1");
    vi.advanceTimersByTime(2000);
    expect(clicked).toHaveBeenCalledTimes(1);
    stop();
    window.history.replaceState(null, "", "/");
  });
});
