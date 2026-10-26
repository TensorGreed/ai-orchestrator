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

/**
 * "Try the recorded question". In Chat it goes into the message box for the
 * visitor to send, so what they see asked is what gets answered. In the
 * editor, which has no prompt field, the next run is the recorded question
 * (it shows as the trigger's input on the canvas) and Run is pressed.
 */
export function tryRecordedQuestion(backend: RecordedInputRunner, workflowId: string, recordedInput: string, doc: Document = document): "filled" | "ran" | "unavailable" {
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
 * `?demoRun=recorded`, as soon as the editor's Run button is there. The
 * parameter is removed first, so a reload does not run it again.
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
    const active = win.document.querySelector<HTMLSelectElement>('select[aria-label="Workflow"]')?.value;
    if (run && !run.disabled && active === workflowId && backend.armRecordedInput(workflowId) !== null) {
      run.click();
      return;
    }
    if (Date.now() - started < timeoutMs) timer = setTimeout(attempt, 200);
  };
  timer = setTimeout(attempt, 200);
  return () => clearTimeout(timer);
}
