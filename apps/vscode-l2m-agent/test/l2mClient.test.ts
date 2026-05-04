import { afterEach, describe, expect, it, vi } from "vitest";
import { L2MClient } from "../src/l2mClient";
import type { L2MAgentConfig } from "../src/protocol";

describe("L2MClient streaming", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the final result from a successful SSE stream", async () => {
    stubFetchStream([
      sse("execution_started", { executionId: "ex-1" }),
      sse("result", { status: "success", output: { message: "ok" } })
    ]);

    const result = await createClient().execute({
      sessionId: "s1",
      userPrompt: "hello"
    });

    expect(result).toEqual({ status: "success", output: { message: "ok" } });
  });

  it("throws when a stream reports an error after the result event", async () => {
    stubFetchStream([
      sse("result", { status: "error", error: "workflow failed" }),
      sse("error", { message: "workflow failed" })
    ]);

    await expect(createClient().execute({
      sessionId: "s1",
      userPrompt: "hello"
    })).rejects.toThrow("workflow failed");
  });
});

function createClient(): L2MClient {
  const config: L2MAgentConfig = {
    apiBaseUrl: "http://localhost:4000",
    workflowId: "wf-test",
    authToken: "test-token",
    streamResponses: true,
    requestTimeoutMs: 30_000,
    maxContextChars: 60_000,
    maxFileChars: 12_000,
    maxGitDiffChars: 20_000,
    maxDiagnostics: 50,
    maxOpenEditors: 10,
    maxPinnedFiles: 8,
    nearbyLineCount: 40,
    recentTurnCount: 12,
    maxCompactedMemoryChars: 20_000
  };
  return new L2MClient(config);
}

function stubFetchStream(chunks: string[]): void {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });

  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  })));
}

function sse(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}
