import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicProviderAdapter,
  DEFAULT_ANTHROPIC_MODEL,
  anthropicModelRejectsSampling,
  describeAnthropicFailure
} from "./anthropic";

const ctx = { resolveSecret: async () => "test-key" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const okBody = { content: [{ type: "text", text: "hi" }], usage: { input_tokens: 3, output_tokens: 1 } };

function stubFetch(...responses: Response[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    return next;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, bodies };
}

function request(model: string | undefined, extra: Record<string, unknown> = {}) {
  return {
    provider: { providerId: "anthropic", model: model as string, ...extra },
    messages: [{ role: "user" as const, content: "hello" }]
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AnthropicProviderAdapter defaults", () => {
  it("defaults to a current Claude model", async () => {
    const adapter = new AnthropicProviderAdapter();
    expect(DEFAULT_ANTHROPIC_MODEL).toBe("claude-sonnet-5-5");
    const schema = adapter.definition.configSchema as { properties: { model: { default: string } } };
    expect(schema.properties.model.default).toBe("claude-sonnet-5-5");

    const { bodies } = stubFetch(jsonResponse(200, okBody));
    await adapter.generate(request(""), ctx);
    expect(bodies[0]?.model).toBe("claude-sonnet-5-5");
  });
});

describe("anthropicModelRejectsSampling", () => {
  it("flags current models and keeps older ones", () => {
    for (const model of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7", "claude-fable-5-1", "anthropic.claude-opus-5-5"]) {
      expect(anthropicModelRejectsSampling(model)).toBe(true);
    }
    for (const model of ["claude-3-5-sonnet-latest", "claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5-20251001", "claude-sonnet-4-20250514", "custom-model"]) {
      expect(anthropicModelRejectsSampling(model)).toBe(false);
    }
  });
});

describe("AnthropicProviderAdapter sampling parameters", () => {
  it("does not send temperature to models that reject it, even when configured", async () => {
    const { bodies } = stubFetch(jsonResponse(200, okBody));
    await new AnthropicProviderAdapter().generate(request("claude-sonnet-5-5", { temperature: 0.2 }), ctx);
    expect(bodies[0]).not.toHaveProperty("temperature");
  });

  it("keeps a configured temperature for older models and omits it when unset", async () => {
    const { bodies } = stubFetch(jsonResponse(200, okBody), jsonResponse(200, okBody));
    const adapter = new AnthropicProviderAdapter();
    await adapter.generate(request("claude-haiku-4-5-20251001", { temperature: 0.4 }), ctx);
    await adapter.generate(request("claude-haiku-4-5-20251001"), ctx);
    expect(bodies[0]?.temperature).toBe(0.4);
    expect(bodies[1]).not.toHaveProperty("temperature");
  });

  it("retries once without a sampling parameter the API rejects", async () => {
    const { bodies, fetchMock } = stubFetch(
      jsonResponse(400, {
        type: "error",
        error: { type: "invalid_request_error", message: "`temperature` is deprecated for this model." }
      }),
      jsonResponse(200, okBody)
    );
    const result = await new AnthropicProviderAdapter().generate(request("claude-sonnet-4-6", { temperature: 0.3 }), ctx);
    expect(result.content).toBe("hi");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[0]?.temperature).toBe(0.3);
    expect(bodies[1]).not.toHaveProperty("temperature");
  });

  it("does not retry other 400 errors", async () => {
    const { fetchMock } = stubFetch(
      jsonResponse(400, { type: "error", error: { type: "invalid_request_error", message: "max_tokens: too large" } })
    );
    await expect(new AnthropicProviderAdapter().generate(request("claude-sonnet-4-6", { temperature: 0.3 }), ctx)).rejects.toThrow(
      /Anthropic request failed \(400\)/
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses adaptive thinking on models that reject thinking budgets", async () => {
    const { bodies } = stubFetch(jsonResponse(200, okBody));
    await new AnthropicProviderAdapter().generate(
      request("claude-sonnet-5-5", { extra: { enableThinking: true, thinkingTokens: 2048 } }),
      ctx
    );
    expect(bodies[0]?.thinking).toEqual({ type: "adaptive" });
  });
});

describe("AnthropicProviderAdapter errors", () => {
  it("explains a 404 for a retired model and points at the Model field", async () => {
    stubFetch(
      jsonResponse(404, {
        type: "error",
        error: { type: "not_found_error", message: "model: claude-3-5-sonnet-latest" }
      })
    );
    const error = await new AnthropicProviderAdapter().generate(request("claude-3-5-sonnet-latest"), ctx).then(
      () => new Error("expected the request to fail"),
      (caught: unknown) => caught as Error
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Anthropic model "claude-3-5-sonnet-latest" is not available');
    expect(error.message).toContain("Model field");
    expect(error.message).toContain("claude-sonnet-5-5");
  });

  it("keeps the raw body for other failures", () => {
    expect(describeAnthropicFailure(500, "boom", "claude-sonnet-5-5")).toBe("Anthropic request failed (500): boom");
    expect(describeAnthropicFailure(404, "<html>not found</html>", "claude-sonnet-5-5")).toBe(
      "Anthropic request failed (404): <html>not found</html>"
    );
  });

  it("asks for an API key when none is configured", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(
        new AnthropicProviderAdapter().generate(request("claude-sonnet-5-5"), { resolveSecret: async () => undefined })
      ).rejects.toThrow(/requires API key/);
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});
