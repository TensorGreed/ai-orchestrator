/**
 * Phase 13.1 — reattach: follows one execution for a stream (GET /api/executions/:id/events). It sends the run as
 * stored (`execution`), the run's events from then on, and the end (`result`, or `error`).
 *
 * - An `mcp_elicitation` event goes out only when `elicitationVisible` allows its elicitation (the elicitation API's
 *   rule); the events after it wait for that check, so the order holds.
 * - A client that leaves releases the relay at once, also while the relay is still opening.
 */
import { isRunSettled, type PersistedRun, type RunEventName, type RunRelay } from "./run-event-relay.js";

export interface ExecutionFollow {
  /** Subscribes to the run's events (resolves once subscribed). */
  open: (onEvent: (name: RunEventName, payload: Record<string, unknown>) => void) => Promise<RunRelay>;
  /** The run as stored now (read after the subscription, so no event between the two is missed). */
  readExecution: () => Promise<unknown>;
  /** Whether the viewer may see this elicitation; read once per elicitation id. */
  elicitationVisible: (elicitationId: string) => Promise<boolean>;
  send: (event: string, payload: unknown) => void;
  /** How long the stream waits for the run to end. */
  waitMs: number;
}

export interface ExecutionFollower {
  /** Runs the stream to its end; resolves once the end was sent, or at once after `close`. */
  done: Promise<void>;
  /** The client went away: stop relaying and release the subscription and its poll. */
  close: () => void;
}

export function followExecution(follow: ExecutionFollow): ExecutionFollower {
  let closed = false;
  let relay: RunRelay | null = null;
  const visibility = new Map<string, Promise<boolean>>();
  let delivered: Promise<void> = Promise.resolve();
  let checking = 0;
  const send = (event: string, payload: unknown) => {
    if (!closed) follow.send(event, payload);
  };

  const onEvent = (name: RunEventName, payload: Record<string, unknown>) => {
    if (name !== "mcp_elicitation") {
      if (checking === 0) send(name, payload);
      else delivered = delivered.then(() => send(name, payload));
      return;
    }
    const elicitation = payload.elicitation as { id?: unknown } | undefined;
    const id = typeof elicitation?.id === "string" ? elicitation.id : "";
    let visible = visibility.get(id);
    if (!visible) {
      visible = id ? follow.elicitationVisible(id).catch(() => false) : Promise.resolve(false);
      visibility.set(id, visible);
    }
    const check = visible;
    checking += 1;
    delivered = delivered.then(async () => {
      try {
        if (await check) send(name, payload);
      } finally {
        checking -= 1;
      }
    });
  };

  const close = () => {
    if (closed) return;
    closed = true;
    relay?.close();
  };

  const run = async () => {
    try {
      const opened = await follow.open(onEvent);
      relay = opened;
      if (closed) {
        // The client left while the relay was opening: release it now, not when the run ends.
        opened.close();
        return;
      }
      const current = await follow.readExecution();
      send("execution", current);
      if (current && isRunSettled(current as PersistedRun)) opened.check();
      const end = await opened.ended(follow.waitMs);
      await delivered;
      if (end.kind === "result") send("result", end.result);
      // The job's last error may hold raw text: the stream says only that it failed (the run's record has the rest).
      else if (end.kind === "failed") send("error", { message: "The run failed on its worker" });
      else if (end.kind === "timeout") send("error", { message: "The run did not finish while this stream waited; it may still finish." });
    } catch (error) {
      send("error", { message: error instanceof Error ? error.message : "Could not follow the run" });
    } finally {
      close();
    }
  };

  return { done: run(), close };
}
