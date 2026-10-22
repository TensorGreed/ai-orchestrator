import { afterEach, describe, expect, it, vi } from "vitest";
import { STREAM_IDLE_TIMEOUT_MS, StreamConnectionLostError, executeWorkflowStream } from "./api";

const encoder = new TextEncoder();

/** A run stream the test writes to by hand; it never closes on its own. */
function controllableStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
    cancel() {
      canceled = true;
    }
  });
  return {
    body,
    send: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    wasCanceled: () => canceled
  };
}

function stubStreamFetch(body: ReadableStream<Uint8Array>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }))
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("run stream watchdog", () => {
  it("gives up after 45s without any bytes, cancels the reader and names the execution", async () => {
    vi.useFakeTimers();
    const stream = controllableStream();
    stubStreamFetch(stream.body);

    const run = executeWorkflowStream("wf-1", { input: {} });
    const outcome = run.then(
      () => undefined,
      (error: unknown) => error
    );
    stream.send('event: execution_started\ndata: {"executionId":"exec-42"}\n\n');

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1);
    // A heartbeat is enough to keep the connection alive.
    stream.send(": ping\n\n");
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1);
    expect(stream.wasCanceled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(StreamConnectionLostError);
    expect((error as StreamConnectionLostError).executionId).toBe("exec-42");
    expect((error as Error).message).toBe(
      "Lost connection to the run; it may still be running on the server (execution exec-42)."
    );
    expect(stream.wasCanceled()).toBe(true);
  });

  it("ignores ping comments and returns the final result", async () => {
    const stream = controllableStream();
    stubStreamFetch(stream.body);
    const onNodeStart = vi.fn();

    const run = executeWorkflowStream("wf-1", { input: {} }, { onNodeStart });
    stream.send(": ping\n\n");
    stream.send('event: node_start\ndata: {"nodeId":"n1","nodeType":"llm_call","startedAt":"2026-10-22T00:00:00.000Z"}\n\n');
    stream.send(": ping\n\n");
    stream.send('event: result\ndata: {"workflowId":"wf-1","status":"success","startedAt":"a","completedAt":"b","nodeResults":[]}\n\n');
    stream.close();

    const result = await run;
    expect(result.status).toBe("success");
    expect(onNodeStart).toHaveBeenCalledTimes(1);
  });
});
