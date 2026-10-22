import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ErrorCategory,
  LLMProviderError,
  readResponseText,
  resilientFetch,
  type ResilientFetchRetryInfo
} from "./resilient-fetch";
import { OpenAICompatibleProviderAdapter } from "./providers/openai-compatible";
import type { LLMStreamChunk } from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A body that sends `chunks` and then stays open without sending anything else. */
function stallingBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    }
  });
}

describe("resilientFetch", () => {
  it("calls onRetry before each backoff wait and stops retrying when the caller aborts during backoff", async () => {
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const retries: ResilientFetchRetryInfo[] = [];

    const pending = resilientFetch(
      "https://provider.test/v1/chat",
      { method: "POST", signal: controller.signal },
      {
        provider: "test",
        maxRetries: 5,
        baseDelayMs: 10_000,
        onRetry: (info) => {
          retries.push(info);
          // Abort while the request waits out its first backoff.
          setTimeout(() => controller.abort(new Error("Run stopped by the user")), 20);
        }
      }
    );

    const startedAt = Date.now();
    const error = await pending.then(
      () => undefined,
      (caught: unknown) => caught
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(error).toBeInstanceOf(LLMProviderError);
    expect((error as LLMProviderError).message).toContain("Run stopped by the user");
    expect((error as LLMProviderError).retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ provider: "test", attempt: 1, maxRetries: 5, reason: "status", status: 503 });
    expect(retries[0].delayMs).toBeGreaterThanOrEqual(10_000);
  });

  it("does not send a request when the signal is already aborted", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort("canceled");
    await expect(resilientFetch("https://provider.test", { signal: controller.signal }, { provider: "test" })).rejects.toThrow(
      /aborted: canceled/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts an in-flight request when the caller's signal aborts, whatever the abort reason is", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          })
      )
    );
    const controller = new AbortController();
    const pending = resilientFetch("https://provider.test", { signal: controller.signal }, { provider: "test", maxRetries: 3 });
    setTimeout(() => controller.abort({ category: "workflow_timeout" }), 10);
    await expect(pending).rejects.toBeInstanceOf(LLMProviderError);
  });
});

describe("bounded body reads", () => {
  it("fails a body that stalls after the headers instead of waiting forever", async () => {
    const response = new Response(stallingBody(['{"choices":']), { status: 200 });
    await expect(readResponseText(response, { timeoutMs: 50, provider: "test" })).rejects.toMatchObject({
      category: ErrorCategory.TIMEOUT,
      message: expect.stringContaining("not fully received within 50ms")
    });
  });

  it("stops a stalled body read when the caller aborts", async () => {
    const controller = new AbortController();
    const response = new Response(stallingBody(["partial"]), { status: 200 });
    setTimeout(() => controller.abort("Workflow execution canceled."), 10);
    await expect(
      readResponseText(response, { timeoutMs: 60_000, signal: controller.signal, provider: "test" })
    ).rejects.toThrow(/aborted: Workflow execution canceled\./);
  });
});

describe("stream idle timeout", () => {
  it("fails a stream that stops sending chunks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(stallingBody(['data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n']), {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
      )
    );
    const adapter = new OpenAICompatibleProviderAdapter();
    const received: LLMStreamChunk[] = [];
    const consume = async () => {
      for await (const chunk of adapter.generateStream(
        {
          provider: { providerId: "openai_compatible", model: "m", baseUrl: "http://provider.test/v1", extra: { streamIdleTimeoutMs: 60 } },
          messages: [{ role: "user", content: "hi" }]
        },
        { resolveSecret: async () => undefined }
      )) {
        received.push(chunk);
      }
    };

    await expect(consume()).rejects.toThrow(/stream sent no data for 60ms/);
    expect(received).toEqual([{ type: "text_delta", textDelta: "Hel" }]);
  });

  it("passes the run's signal to the request and stops the stream when it aborts", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Response(stallingBody([]), { status: 200 });
      })
    );
    const controller = new AbortController();
    const adapter = new OpenAICompatibleProviderAdapter();
    const consume = async () => {
      for await (const chunk of adapter.generateStream(
        { provider: { providerId: "openai_compatible", model: "m", baseUrl: "http://provider.test/v1" }, messages: [{ role: "user", content: "hi" }] },
        { resolveSecret: async () => undefined, signal: controller.signal }
      )) {
        void chunk;
      }
    };
    setTimeout(() => controller.abort("Workflow execution canceled."), 20);
    await expect(consume()).rejects.toThrow(/aborted/);
    expect(requestSignal?.aborted).toBe(true);
  });
});
