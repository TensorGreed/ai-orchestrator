/**
 * Built-in sample data for the starter templates, so they run with no setup
 * and no outside service:
 *
 *   GET      /api/sample-data/orders        a fixed list of example orders
 *   POST     /api/sample-data/notify        stands in for a chat or email notification: answers what it was sent
 *   GET|POST /api/sample-data/status/:code  answers with that HTTP status (to try retries and error outputs)
 *
 * The routes take no sign-in (a workflow's HTTP Request node calls them with no
 * credentials), read nothing from the database, store nothing and reveal
 * nothing about the deployment: the orders are fixed, and notify only echoes a
 * small JSON body back to its caller.
 */
import type { FastifyInstance } from "fastify";

/** The prefix every sample-data route shares; the starter templates name it after the API base URL. */
export const SAMPLE_DATA_PATH = "/api/sample-data";

/** The most bytes a notify body may hold (it is echoed back, so it stays small). */
export const SAMPLE_NOTIFY_MAX_BYTES = 16 * 1024;

export interface SampleOrder {
  id: string;
  customer: string;
  email: string;
  status: "paid" | "pending" | "refunded";
  total: number;
  currency: "USD";
  createdAt: string;
}

/** Fixed example orders: two are pending, one is over 200, one is refunded. */
export const SAMPLE_ORDERS: readonly SampleOrder[] = Object.freeze([
  { id: "ord_1001", customer: "Ada Lovelace", email: "ada@example.com", status: "paid", total: 129.5, currency: "USD", createdAt: "2026-01-05T09:12:00.000Z" },
  { id: "ord_1002", customer: "Grace Hopper", email: "grace@example.com", status: "pending", total: 48, currency: "USD", createdAt: "2026-01-05T10:40:00.000Z" },
  { id: "ord_1003", customer: "Alan Turing", email: "alan@example.com", status: "paid", total: 310.25, currency: "USD", createdAt: "2026-01-06T08:03:00.000Z" },
  { id: "ord_1004", customer: "Katherine Johnson", email: "katherine@example.com", status: "refunded", total: 75, currency: "USD", createdAt: "2026-01-06T15:27:00.000Z" },
  { id: "ord_1005", customer: "Edsger Dijkstra", email: "edsger@example.com", status: "pending", total: 220, currency: "USD", createdAt: "2026-01-07T11:55:00.000Z" },
  { id: "ord_1006", customer: "Barbara Liskov", email: "barbara@example.com", status: "paid", total: 18.99, currency: "USD", createdAt: "2026-01-07T13:31:00.000Z" }
]);

function statusCodeOf(raw: string): number | undefined {
  if (!/^\d{3}$/.test(raw)) return undefined;
  const code = Number(raw);
  // 1xx answers are not final responses, so they are not offered.
  return code >= 200 && code <= 599 ? code : undefined;
}

export function registerSampleDataRoutes(app: FastifyInstance): void {
  app.get(`${SAMPLE_DATA_PATH}/orders`, async () => ({ orders: SAMPLE_ORDERS, count: SAMPLE_ORDERS.length }));

  app.post(`${SAMPLE_DATA_PATH}/notify`, { bodyLimit: SAMPLE_NOTIFY_MAX_BYTES }, async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      reply.code(400);
      return { error: "Send a JSON object, for example {\"channel\":\"#orders\",\"text\":\"Hello\"}." };
    }
    return { delivered: true, simulated: true, received: body };
  });

  const answerStatus = async (request: { params: { code: string } }, reply: { code: (status: number) => unknown }) => {
    const code = statusCodeOf(request.params.code);
    if (code === undefined) {
      reply.code(400);
      return { error: "Use a status code from 200 to 599." };
    }
    reply.code(code);
    return code === 204 ? undefined : { status: code, ok: code < 400 };
  };
  app.get<{ Params: { code: string } }>(`${SAMPLE_DATA_PATH}/status/:code`, answerStatus);
  app.post<{ Params: { code: string } }>(`${SAMPLE_DATA_PATH}/status/:code`, answerStatus);
}
