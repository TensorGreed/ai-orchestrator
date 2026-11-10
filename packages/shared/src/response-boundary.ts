import type { GuardActionValue } from "./guard";

/**
 * Phase 12 coverage — the response boundary: what an external caller receives from a run (a webhook or chat widget
 * answer, `/api/chat`, an MCP trigger's invoke result). A run started from one of these carries a `ResponseBoundary`,
 * and the engine checks the run's output on the `response` channel before the run is stored and answered. Only rule
 * sets with a `response` channel check anything; the built-in rule set has none, so nothing changes until an admin or
 * builder adds one.
 */
export const RESPONSE_BOUNDARY_SURFACES = ["webhook", "chat", "mcp_invoke"] as const;
export type ResponseBoundarySurface = (typeof RESPONSE_BOUNDARY_SURFACES)[number];

/** Where the run's answer goes. Set by the API for externally answered triggers only, never from a request body. */
export interface ResponseBoundary {
  surface: ResponseBoundarySurface;
}

/** The error code of a response or request content rules refused (HTTP bodies, MCP tool results). */
export const CONTENT_FILTER_CODE = "content_filter";
/** What the caller reads when the response was withheld. Names no rule, category or value. */
export const RESPONSE_WITHHELD_MESSAGE = "The response was withheld by content rules.";
/** What the caller reads when an incoming payload was refused at the route (`trigger_input`). */
export const TRIGGER_INPUT_REFUSED_MESSAGE = "The request was refused by content rules.";
/** HTTP status of a withheld response (the run itself ends `success`). */
export const RESPONSE_WITHHELD_STATUS = 422;

/**
 * The run-end check's outcome, on the run's result. `withheld`: a block (or a review or approval, which an external
 * caller cannot wait for) replaced the output with `withheldResponseOutput()`. `transformed`: a rewrite changed it.
 * `reason` lists categories and detectors, never values.
 */
export interface ResponseCheckSummary {
  action: GuardActionValue;
  withheld: boolean;
  transformed: boolean;
  reason: string;
}

/** The trigger types whose callers receive the run's output, and the surface each answers on. Builder routes are not. */
const BOUNDARY_TRIGGERS: Readonly<Record<string, ResponseBoundarySurface>> = {
  webhook: "webhook",
  webhook_test: "webhook",
  chat: "chat",
  mcp_server: "mcp_invoke"
};

/** The boundary a run of this trigger type answers across, or undefined (editor, schedule, builder routes, gateway). */
export function responseBoundaryForTrigger(triggerType: string | null | undefined): ResponseBoundary | undefined {
  const surface = typeof triggerType === "string" ? BOUNDARY_TRIGGERS[triggerType] : undefined;
  return surface ? { surface } : undefined;
}

/** Reads a boundary that crossed a queue or a stored record; undefined for anything else. */
export function parseResponseBoundary(value: unknown): ResponseBoundary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const surface = (value as { surface?: unknown }).surface;
  return typeof surface === "string" && (RESPONSE_BOUNDARY_SURFACES as readonly string[]).includes(surface)
    ? { surface: surface as ResponseBoundarySurface }
    : undefined;
}

/** The run output stored in history when the response was withheld (the caller gets the same, plus the execution id). */
export function withheldResponseOutput(): { error: string; code: typeof CONTENT_FILTER_CODE } {
  return { error: RESPONSE_WITHHELD_MESSAGE, code: CONTENT_FILTER_CODE };
}

/** The HTTP body of a withheld response (status `RESPONSE_WITHHELD_STATUS`). */
export function contentFilterEnvelope(executionId: string | undefined): { error: string; code: typeof CONTENT_FILTER_CODE; executionId: string | null } {
  return { ...withheldResponseOutput(), executionId: executionId ?? null };
}

/** Whether a run's response was withheld (its result carries the check's summary). */
export function responseWasWithheld(result: { responseCheck?: ResponseCheckSummary } | null | undefined): boolean {
  return result?.responseCheck?.withheld === true;
}
