import { useCallback, useEffect, useState } from "react";
import { NOT_IN_DEMO_MESSAGE, type DemoNotice } from "./fake-backend";
import { DEMO_NOTICE_EVENT, demoBackend } from "./demo-transport";
import { RUN_RECORDED_PARAM, isApiLink, recordedRunUrl, runRecordedFromUrl, tryRecordedQuestion } from "./demo-actions";

export const DEMO_BANNER_DISMISSED_KEY = "l2m-demo:banner-dismissed";
export const DEMO_TOUR_KEY = "l2m-demo:tour";
const DOCS_URL = "/docs/";
const SELF_HOST_URL = "/docs/getting-started/quickstart";

interface TourStep {
  title: string;
  body: string;
  action?: { label: string; workflowId?: string; mode: string; runRecorded?: boolean };
}

export const TOUR_STEPS: TourStep[] = [
  {
    title: "Build an agent",
    body: "Agents are the round hubs. The chat model, memory and MCP tools attach to them as slots on the rings, not as steps in the flow.",
    action: { label: "Open the support agent", workflowId: "wf-demo-support-agent", mode: "editor" }
  },
  {
    title: "Run it",
    body: "Run the recorded question. Its run replays as it happened: node activity, each tool call, tokens and cost on the run tape. Other questions need a real deployment.",
    action: { label: "Run the recorded question", workflowId: "wf-demo-support-agent", mode: "editor", runRecorded: true }
  },
  {
    title: "See the guard",
    body: "A prompt guard blocked an email address before any model saw it. Security lists every guard verdict with masked evidence.",
    action: { label: "Open Security", mode: "security" }
  },
  {
    title: "Ship behind a release gate",
    body: "A new version reaches production only when its replay against the golden set passes. This draft regressed, so publishing is blocked.",
    action: { label: "Open the gated workflow", workflowId: "wf-demo-faq-release", mode: "editor" }
  }
];

type TourState = { status: "open"; step: number } | { status: "done" };

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Blocked storage: the choice lasts for this page.
  }
}

function readTour(): TourState {
  const raw = readStorage(DEMO_TOUR_KEY);
  if (raw === "done") return { status: "done" };
  const step = Number(raw);
  return { status: "open", step: Number.isInteger(step) && step >= 0 && step < TOUR_STEPS.length ? step : 0 };
}

function appUrl(params: Record<string, string>) {
  const query = new URLSearchParams(params).toString();
  return `${import.meta.env.BASE_URL}${query ? `?${query}` : ""}`;
}

/** Drops the editor's unsaved copies so a reload opens what the demo backend holds. */
function clearEditorCopies(workflowId?: string) {
  for (const storage of [window.sessionStorage, window.localStorage]) {
    try {
      for (let index = storage.length - 1; index >= 0; index -= 1) {
        const key = storage.key(index);
        if (!key) continue;
        const wip = key.startsWith("ai-orchestrator:session:wip:") || key === "ai-orchestrator:wip-workflow";
        if (wip && (!workflowId || key.endsWith(`:${workflowId}`) || key === "ai-orchestrator:wip-workflow")) storage.removeItem(key);
        if (!workflowId && (key === "ai-orchestrator:session:last-workflow-id" || key === "ai-orchestrator:last-workflow-id")) storage.removeItem(key);
      }
    } catch {
      // Blocked storage holds no copies.
    }
  }
}

export function resetDemo() {
  demoBackend.reset();
  clearEditorCopies();
  writeStorage(DEMO_BANNER_DISMISSED_KEY, null);
  writeStorage(DEMO_TOUR_KEY, null);
  window.location.assign(appUrl({}));
}

export function DemoChrome() {
  const [dismissed, setDismissed] = useState(() => readStorage(DEMO_BANNER_DISMISSED_KEY) === "1");
  const [tour, setTour] = useState<TourState>(readTour);
  const [notice, setNotice] = useState<DemoNotice | null>(null);

  useEffect(() => {
    document.documentElement.dataset.demoBar = dismissed ? "off" : "on";
  }, [dismissed]);

  useEffect(() => {
    const onNotice = (event: Event) => setNotice((event as CustomEvent<DemoNotice>).detail);
    window.addEventListener(DEMO_NOTICE_EVENT, onNotice);
    return () => window.removeEventListener(DEMO_NOTICE_EVENT, onNotice);
  }, []);

  useEffect(() => runRecordedFromUrl(demoBackend), []);

  // Exports and downloads link straight to the API, which a static host cannot serve.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || !isApiLink(link.href, window.location.origin)) return;
      event.preventDefault();
      event.stopPropagation();
      setNotice({ kind: "not_in_demo", message: NOT_IN_DEMO_MESSAGE });
    };
    // A middle click opens a link without a "click" event.
    document.addEventListener("click", onClick, true);
    document.addEventListener("auxclick", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("auxclick", onClick, true);
    };
  }, []);

  const saveTour = useCallback((next: TourState) => {
    setTour(next);
    writeStorage(DEMO_TOUR_KEY, next.status === "done" ? "done" : String(next.step));
  }, []);

  const dismiss = (value: boolean) => {
    setDismissed(value);
    writeStorage(DEMO_BANNER_DISMISSED_KEY, value ? "1" : null);
  };

  const step = tour.status === "open" ? TOUR_STEPS[tour.step] : undefined;
  const goTo = (action: NonNullable<TourStep["action"]>) => {
    window.location.assign(
      appUrl({ ...(action.workflowId ? { workflowId: action.workflowId } : {}), mode: action.mode, ...(action.runRecorded ? { [RUN_RECORDED_PARAM]: "recorded" } : {}) })
    );
  };

  return (
    <>
      {dismissed ? (
        <button type="button" className="demo-pill" onClick={() => dismiss(false)} aria-label="Show the demo banner">
          <span className="demo-dot" aria-hidden="true" /> Live demo
        </button>
      ) : (
        <div className="demo-bar" role="region" aria-label="Live demo">
          <span className="demo-dot" aria-hidden="true" />
          <p className="demo-bar-text">
            <strong>Live demo</strong> — everything runs in your browser; nothing is saved on a server.
          </p>
          <nav className="demo-bar-links" aria-label="Demo">
            <button type="button" className="demo-link" onClick={resetDemo}>
              Reset demo
            </button>
            {tour.status === "done" && (
              <button type="button" className="demo-link" onClick={() => saveTour({ status: "open", step: 0 })}>
                Tour
              </button>
            )}
            <a className="demo-link" href={DOCS_URL}>
              Docs
            </a>
            <a className="demo-link demo-link-primary" href={SELF_HOST_URL}>
              Self-host L2M
            </a>
          </nav>
          <button type="button" className="demo-close" onClick={() => dismiss(true)} aria-label="Dismiss the demo banner">
            ×
          </button>
        </div>
      )}

      {notice && (
        <div className="demo-notice" role="status">
          <p>{notice.message}</p>
          <div className="demo-notice-actions">
            {notice.kind === "run_not_recorded" && notice.restorable && (
              <button
                type="button"
                className="demo-button demo-button-primary"
                onClick={() => {
                  demoBackend.restoreRecorded(notice.workflowId);
                  clearEditorCopies(notice.workflowId);
                  window.location.assign(appUrl({ workflowId: notice.workflowId, mode: "editor" }));
                }}
              >
                Restore the recorded version
              </button>
            )}
            {notice.kind === "run_not_recorded" && notice.similar && (
              <button
                type="button"
                className="demo-button demo-button-primary"
                onClick={() => window.location.assign(recordedRunUrl(notice.similar!.workflowId))}
              >
                Run “{notice.similar.name}”
              </button>
            )}
            {notice.kind === "input_not_recorded" && (
              <button
                type="button"
                className="demo-button demo-button-primary"
                onClick={() => {
                  const outcome = tryRecordedQuestion(demoBackend, notice.workflowId, notice.recordedInput);
                  if (outcome !== "unavailable") setNotice(null);
                }}
              >
                Try the recorded question
              </button>
            )}
            <button type="button" className="demo-button" onClick={() => setNotice(null)}>
              Close
            </button>
          </div>
        </div>
      )}

      {step && tour.status === "open" && (
        <aside className="demo-tour" aria-label="Demo tour" aria-live="polite">
          <p className="demo-tour-count">
            Step {tour.step + 1} of {TOUR_STEPS.length}
          </p>
          <h2 className="demo-tour-title">{step.title}</h2>
          <p className="demo-tour-body">{step.body}</p>
          <div className="demo-tour-actions">
            {step.action && (
              <button type="button" className="demo-button" onClick={() => goTo(step.action!)}>
                {step.action.label}
              </button>
            )}
            <span className="demo-tour-spacer" />
            <button type="button" className="demo-button demo-button-ghost" onClick={() => saveTour({ status: "done" })}>
              Skip tour
            </button>
            {tour.step + 1 < TOUR_STEPS.length ? (
              <button type="button" className="demo-button demo-button-primary" onClick={() => saveTour({ status: "open", step: tour.step + 1 })}>
                Next
              </button>
            ) : (
              <button type="button" className="demo-button demo-button-primary" onClick={() => saveTour({ status: "done" })}>
                Done
              </button>
            )}
          </div>
        </aside>
      )}
    </>
  );
}
