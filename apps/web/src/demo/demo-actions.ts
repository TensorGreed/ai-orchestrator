/**
 * What the demo chrome does to the studio page: run a recorded question,
 * and keep links that point straight at the API (exports, downloads) from
 * landing on a 404 of the static host.
 */

/** `?demoRun=recorded` on a studio URL: once the editor is up, run the workflow's recorded question. */
export const RUN_RECORDED_PARAM = "demoRun";

export interface RecordedInputRunner {
  armRecordedInput(workflowId: string): string | null;
}

/** Whether a link goes to this origin's API, which the static demo cannot serve as a page or a file. */
export function isApiLink(href: string, origin: string): boolean {
  try {
    const url = new URL(href, origin);
    return url.origin === origin && /^\/api(\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

/** Types into a React-controlled input the way a person would, so the studio's state follows. */
function fillInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
}

function runButton(doc: Document): HTMLButtonElement | null {
  return doc.querySelector<HTMLButtonElement>('button[aria-label="Run workflow"]');
}

/** The workflow the studio has open, from its HUD switcher. */
function openWorkflowId(doc: Document): string | null {
  return doc.querySelector<HTMLSelectElement>('select[aria-label="Workflow"]')?.value || null;
}

/** A studio URL in the editor for this workflow that runs its recorded question once it is open. */
export function recordedRunUrl(workflowId: string, base: string = import.meta.env.BASE_URL): string {
  return `${base}?${new URLSearchParams({ workflowId, mode: "editor", [RUN_RECORDED_PARAM]: "recorded" }).toString()}`;
}

/**
 * "Try the recorded question". In Chat on that workflow it goes into the
 * message box for the visitor to send, so what they see asked is what gets
 * answered. In the editor on that workflow, which has no prompt field, the
 * next run is the recorded question (it shows as the trigger's input on the
 * canvas) and Run is pressed. With another workflow open it opens this one
 * and runs it there, rather than arming a run the open workflow would take.
 */
export function tryRecordedQuestion(
  backend: RecordedInputRunner,
  workflowId: string,
  recordedInput: string,
  doc: Document = document,
  navigate: (url: string) => void = (url) => window.location.assign(url)
): "filled" | "ran" | "opened" | "unavailable" {
  if (openWorkflowId(doc) !== workflowId) {
    navigate(recordedRunUrl(workflowId));
    return "opened";
  }
  const chatInput = doc.querySelector<HTMLInputElement>("input.chat-message-input");
  if (chatInput) {
    fillInput(chatInput, recordedInput);
    return "filled";
  }
  const run = runButton(doc);
  if (!run || run.disabled || backend.armRecordedInput(workflowId) === null) return "unavailable";
  run.click();
  return "ran";
}

/**
 * Runs the recorded question of the workflow in the URL when it carries
 * `?demoRun=recorded`, as soon as the editor has that workflow open. The
 * parameter is removed first, so a reload does not run it again. When the
 * workflow no longer has a recorded graph, Run is still pressed: the demo then
 * says so and offers to restore the recorded version.
 */
export function runRecordedFromUrl(backend: RecordedInputRunner, win: Window = window, timeoutMs = 15_000): () => void {
  const url = new URL(win.location.href);
  const workflowId = url.searchParams.get("workflowId");
  if (url.searchParams.get(RUN_RECORDED_PARAM) !== "recorded" || !workflowId) return () => undefined;
  url.searchParams.delete(RUN_RECORDED_PARAM);
  win.history.replaceState(win.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = () => {
    const run = runButton(win.document);
    // Wait until the editor has opened this workflow, not just drawn its Run button.
    if (run && !run.disabled && openWorkflowId(win.document) === workflowId) {
      backend.armRecordedInput(workflowId);
      run.click();
      return;
    }
    if (Date.now() - started < timeoutMs) timer = setTimeout(attempt, 200);
  };
  timer = setTimeout(attempt, 200);
  return () => clearTimeout(timer);
}
