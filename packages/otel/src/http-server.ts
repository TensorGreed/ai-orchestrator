import { ROOT_CONTEXT, SpanStatusCode, trace, type Context } from "@opentelemetry/api";
import type { TraceCarrier } from "@ai-orchestrator/shared";
import type { OtelRunInstrumentation, OtelSpanHandle } from "./instrumentation.js";
import {
  ATTR_CLIENT_ADDRESS,
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_REQUEST_METHOD_ORIGINAL,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
  KNOWN_HTTP_METHODS,
  L2M
} from "./semconv.js";

/**
 * What to do with an inbound `traceparent`: `parent` continues the caller's trace (and honours its sampled flag),
 * `link` starts a new trace that links to it, `ignore` starts a new trace with no reference to it.
 */
export type InboundTraceUse = "parent" | "link" | "ignore";

export interface HttpServerSpanInput {
  method: string;
  /** The matched route pattern (`/api/workflows/:id`); absent for unmatched requests. */
  route?: string;
  /** The path without the query, already redacted. */
  path: string;
  scheme?: string;
  clientAddress?: string;
  requestId?: string;
  /** The request's `traceparent` / `tracestate` headers. */
  inbound?: TraceCarrier;
  inboundUse: InboundTraceUse;
}

export interface HttpServerSpan {
  /** The context to run the request's handler in: it holds the server span. */
  readonly context: Context;
  readonly handle: OtelSpanHandle;
  /** Records the response status and ends the span. Idempotent. */
  end(statusCode: number): void;
}

/** Stable HTTP semantic conventions for a SERVER span: `{method} {route}`, or `{method}` when no route matched. */
export function startHttpServerSpan(instrumentation: OtelRunInstrumentation, input: HttpServerSpanInput): HttpServerSpan {
  const upper = input.method.toUpperCase();
  const known = KNOWN_HTTP_METHODS.has(upper);
  const method = known ? upper : "_OTHER";
  const name = input.route ? `${known ? method : "HTTP"} ${input.route}` : known ? method : "HTTP";

  const inbound = input.inboundUse === "ignore" ? null : instrumentation.extract(input.inbound);
  const parent: Context = inbound && input.inboundUse === "parent" ? inbound : ROOT_CONTEXT;
  const handle = instrumentation.startSpan({
    name,
    kind: "server",
    parent,
    attributes: {
      [ATTR_HTTP_REQUEST_METHOD]: method,
      [ATTR_HTTP_REQUEST_METHOD_ORIGINAL]: known ? undefined : input.method,
      [ATTR_HTTP_ROUTE]: input.route,
      [ATTR_URL_PATH]: input.path,
      [ATTR_URL_SCHEME]: input.scheme,
      [ATTR_CLIENT_ADDRESS]: input.clientAddress,
      [L2M.REQUEST_ID]: input.requestId
    }
  });
  if (inbound && input.inboundUse === "link") {
    const linked = trace.getSpanContext(inbound);
    if (linked) handle.span.addLink({ context: linked, attributes: { [L2M.LINK_REASON]: "untrusted_inbound" } });
  }
  const context = trace.setSpan(parent, handle.span);
  let ended = false;
  return {
    context,
    handle,
    end(statusCode: number) {
      if (ended) return;
      ended = true;
      handle.span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode);
      // A SERVER span is an error for 5xx only; 4xx is the client's problem and stays UNSET.
      if (statusCode >= 500) {
        handle.span.setAttribute(ATTR_ERROR_TYPE, String(statusCode));
        handle.span.setStatus({ code: SpanStatusCode.ERROR });
      }
      handle.end();
    }
  };
}
