/**
 * HTTP SERVER spans, installed only while tracing is on (with OTEL_HTTP_SERVER_SPANS, the default).
 *
 * - `onRequest` starts the span (stable HTTP conventions) and decides what an inbound `traceparent` may do (D5:
 *   only authenticated callers and trusted proxies continue their trace; anyone else's is linked).
 * - Every route handler is wrapped (an `onRoute` hook, so it must be installed before routes are added) to run in
 *   the span's context, so spans started while handling the request (runs, model calls, MCP calls) are children.
 * - `onResponse`, or the connection closing first, ends it with the status code.
 * - The request's logger gets `trace_id` and `span_id`, so request log lines can be found from a trace.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";
import type { HttpServerSpan, InboundTraceUse, OtelRuntime } from "@ai-orchestrator/otel";
import { AddressList } from "../network-controls.js";
import { redactSensitiveUrl } from "../services/url-redaction.js";
import type { InboundTrust } from "./settings.js";

const SERVER_SPAN = Symbol("l2m.httpServerSpan");
const WRAPPED_HANDLER = Symbol("l2m.tracedHandler");
/** Marks a logger whose bindings already carry `trace_id`/`span_id`, so the log mixin does not add them twice. */
export const TRACE_BOUND_LOGGER = Symbol.for("l2m.traceBoundLogger");

/** Paths that never get a span: they would drown out useful ones. */
export const UNTRACED_PATHS: ReadonlySet<string> = new Set(["/health", "/ready", "/metrics"]);

type TracedRequest = FastifyRequest & { [SERVER_SPAN]?: HttpServerSpan };

/** The server span of a request, when one was started. */
export function requestServerSpan(request: FastifyRequest): HttpServerSpan | undefined {
  return (request as TracedRequest)[SERVER_SPAN];
}

/**
 * A pino `mixin` that adds the active span's ids to every log line written inside a span (outside request loggers,
 * which carry them as bindings already).
 */
export function traceLogMixin(runtime: OtelRuntime): (mergeObject: object, level: number, logger: unknown) => object {
  return (_mergeObject, _level, logger) => {
    if (logger && (logger as Record<symbol, unknown>)[TRACE_BOUND_LOGGER]) return {};
    return runtime.logFields() ?? {};
  };
}

/** Wraps every route handler added from now on so it runs in its request's span context. */
export function installHandlerContext(app: FastifyInstance, runtime: OtelRuntime): void {
  app.addHook("onRoute", (route) => {
    const handler = route.handler as RouteHandlerMethod & { [WRAPPED_HANDLER]?: true };
    if (typeof handler !== "function" || handler[WRAPPED_HANDLER]) return;
    const traced = function (this: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
      const server = (request as TracedRequest)[SERVER_SPAN];
      return server ? runtime.withContext(server.context, () => handler.call(this, request, reply)) : handler.call(this, request, reply);
    } as RouteHandlerMethod & { [WRAPPED_HANDLER]?: true };
    traced[WRAPPED_HANDLER] = true;
    route.handler = traced;
  });
}

export interface HttpServerSpanOptions {
  trustInbound: InboundTrust;
  /** Canonical ranges whose connections are trusted (matched against the socket address, not X-Forwarded-For). */
  trustedProxies: readonly string[];
  /**
   * True when the request carries a valid credential (session, API key, gateway client token). Called only for a
   * request that sends a `traceparent` under `authenticated` trust; it must not record the request's sign-in
   * context or count as activity. Errors count as "not authenticated".
   */
  isAuthenticated: (request: FastifyRequest) => Promise<boolean>;
}

function headerText(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" && value.length <= 512 ? value : undefined;
}

export function installHttpServerSpans(app: FastifyInstance, runtime: OtelRuntime, options: HttpServerSpanOptions): void {
  const trustedProxies = new AddressList(options.trustedProxies);

  const inboundUse = async (request: FastifyRequest): Promise<InboundTraceUse> => {
    if (options.trustInbound === "all") return "parent";
    if (options.trustInbound === "none") return "link";
    if (trustedProxies.has(request.socket?.remoteAddress)) return "parent";
    try {
      return (await options.isAuthenticated(request)) ? "parent" : "link";
    } catch {
      return "link";
    }
  };

  app.addHook("onRequest", async (request, reply) => {
    if (UNTRACED_PATHS.has(request.url.split("?")[0] ?? "")) return;
    const path = redactSensitiveUrl(request.url).split("?")[0] ?? "";
    const traceparent = headerText(request, "traceparent");
    const tracestate = headerText(request, "tracestate");
    const inbound = traceparent ? { traceparent, ...(tracestate ? { tracestate } : {}) } : undefined;
    const server = runtime.startHttpServerSpan({
      method: request.method,
      ...(request.routeOptions?.url ? { route: request.routeOptions.url } : {}),
      path,
      scheme: request.protocol,
      ...(request.ip ? { clientAddress: request.ip } : {}),
      requestId: request.id,
      ...(inbound ? { inbound } : {}),
      inboundUse: inbound ? await inboundUse(request) : "ignore"
    });
    (request as TracedRequest)[SERVER_SPAN] = server;
    // A hijacked or aborted response may never reach onResponse; the span still ends when the connection closes.
    reply.raw.once("close", () => server.end(reply.raw.statusCode));
    const log = request.log.child({ trace_id: server.handle.traceId, span_id: server.handle.spanId });
    (log as unknown as Record<symbol, unknown>)[TRACE_BOUND_LOGGER] = true;
    request.log = log;
    reply.log = log;
  });

  app.addHook("onResponse", async (request, reply) => {
    (request as TracedRequest)[SERVER_SPAN]?.end(reply.statusCode);
  });
}
