import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@ai-orchestrator/shared";
import { envKeyMayGoTo } from "./default-base-urls";
import { createDefaultEmbeddingRegistry } from "./embeddings";
import { createDefaultProviderRegistry } from "./index";
import type { LLMStreamChunk } from "./types";

/**
 * A deployment env key (OPENAI_API_KEY and the rest) only ever goes to the provider's own endpoint, to
 * AZURE_OPENAI_ENDPOINT for Azure, or to a base URL the operator lists in PROVIDER_ENV_KEY_BASE_URLS. A base URL a node
 * or request names elsewhere gets no env key.
 */

const ENV_KEYS: Record<string, string> = {
  OPENAI_API_KEY: "sk-env-openai-SECRET",
  ANTHROPIC_API_KEY: "sk-ant-env-SECRET",
  AZURE_OPENAI_API_KEY: "azure-env-SECRET",
  AZURE_OPENAI_ENDPOINT: "https://corp.openai.azure.com"
};
const saved: Record<string, string | undefined> = {};
const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
const noSecret = { resolveSecret: async () => undefined };

interface Seen {
  url: string;
  headers: Record<string, string>;
}

function stubFetch(): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
      seen.push({ url: String(url), headers });
      const body = String(url).includes("/embeddings")
        ? { data: [{ embedding: [0.1, 0.2], index: 0 }] }
        : String(url).includes("/messages")
          ? { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }
          : { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    })
  );
  return seen;
}

function leaked(seen: Seen[]): boolean {
  return seen.some((request) => Object.values(request.headers).some((value) => /SECRET/.test(value)));
}

async function collect(stream: AsyncGenerator<LLMStreamChunk>): Promise<LLMStreamChunk[]> {
  const out: LLMStreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

beforeEach(() => {
  for (const [key, value] of Object.entries({ ...ENV_KEYS, PROVIDER_ENV_KEY_BASE_URLS: undefined, EVAL_JUDGE_BASE_URL: undefined })) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("envKeyMayGoTo", () => {
  it("allows no base URL, the provider's own endpoint (any path) and listed gateways, by origin", () => {
    expect(envKeyMayGoTo("openai", undefined, {})).toBe(true);
    expect(envKeyMayGoTo("openai", "", {})).toBe(true);
    expect(envKeyMayGoTo("openai", "https://api.openai.com/v1", {})).toBe(true);
    expect(envKeyMayGoTo("openai", "https://API.openai.com:443/other", {})).toBe(true);
    expect(envKeyMayGoTo("anthropic", "https://api.anthropic.com/v1", {})).toBe(true);
    expect(envKeyMayGoTo("azure_openai", "https://corp.openai.azure.com/", { AZURE_OPENAI_ENDPOINT: "https://corp.openai.azure.com" })).toBe(true);
    expect(envKeyMayGoTo("openai", "https://gw.example.com/v1", { PROVIDER_ENV_KEY_BASE_URLS: " https://gw.example.com , https://x.example" })).toBe(true);
  });

  it("matches a listed gateway by path prefix at a segment boundary, so a shared host only covers its own path", () => {
    const env = { PROVIDER_ENV_KEY_BASE_URLS: "https://gateway.example.net/v1/acct-a/gw" };
    expect(envKeyMayGoTo("openai", "https://gateway.example.net/v1/acct-a/gw", env)).toBe(true);
    expect(envKeyMayGoTo("openai", "https://gateway.example.net/v1/acct-a/gw/openai", env)).toBe(true);
    expect(envKeyMayGoTo("openai", "https://gateway.example.net/v1/acct-a/gw-evil/openai", env)).toBe(false);
    expect(envKeyMayGoTo("openai", "https://gateway.example.net/v1/acct-b/gw/openai", env)).toBe(false);
    expect(envKeyMayGoTo("openai", "https://gateway.example.net/", env)).toBe(false);
  });

  it("allows EVAL_JUDGE_BASE_URL only when EVAL_JUDGE_ALLOW_ENV_CREDENTIALS is on", () => {
    expect(envKeyMayGoTo("openai", "https://judge.example.com/v1", { EVAL_JUDGE_BASE_URL: "https://judge.example.com/v1" })).toBe(false);
    expect(envKeyMayGoTo("openai", "https://judge.example.com/v1", { EVAL_JUDGE_BASE_URL: "https://judge.example.com/v1", EVAL_JUDGE_ALLOW_ENV_CREDENTIALS: "true" })).toBe(true);
  });

  it("refuses any other host, look-alikes, other schemes or ports, and unreadable URLs", () => {
    for (const url of [
      "https://evil.example.com/v1",
      "https://api.openai.com.evil.example/v1",
      "http://api.openai.com/v1",
      "https://api.openai.com:8443/v1",
      "https://user:pw@evil.example/v1",
      "not a url",
      "{{vars.base}}"
    ]) {
      expect(envKeyMayGoTo("openai", url, {}), url).toBe(false);
    }
    expect(envKeyMayGoTo("openai", "https://api.anthropic.com/v1", {})).toBe(false);
    expect(envKeyMayGoTo("azure_openai", "https://other.openai.azure.com", { AZURE_OPENAI_ENDPOINT: "https://corp.openai.azure.com" })).toBe(false);
    expect(envKeyMayGoTo("azure_openai", "https://corp.openai.azure.com", {})).toBe(false);
  });
});

describe("a builder-chosen host never receives the env key", () => {
  const registry = createDefaultProviderRegistry();

  it("OpenAI chat (generate and stream) refuses to send OPENAI_API_KEY to a custom base URL", async () => {
    const seen = stubFetch();
    const provider = { providerId: "openai", model: "gpt-4o-mini", baseUrl: "https://evil.example.com/v1" };
    await expect(registry.get("openai").generate({ provider, messages }, noSecret)).rejects.toThrow(/secret for a custom base URL/);
    await expect(collect(registry.get("openai").generateStream!({ provider, messages }, noSecret))).rejects.toThrow(/secret for a custom base URL/);
    expect(seen).toEqual([]);
  });

  it("OpenAI chat sends a secret to a custom base URL, and the env key to its own endpoint", async () => {
    const seen = stubFetch();
    await registry.get("openai").generate(
      { provider: { providerId: "openai", model: "gpt-4o-mini", baseUrl: "https://gw.example.com/v1", secretRef: { secretId: "s" } }, messages },
      { resolveSecret: async () => "sk-from-secret" }
    );
    await registry.get("openai").generate({ provider: { providerId: "openai", model: "gpt-4o-mini" }, messages }, noSecret);
    expect(seen[0]).toMatchObject({ url: "https://gw.example.com/v1/chat/completions", headers: { authorization: "Bearer sk-from-secret" } });
    expect(seen[1]).toMatchObject({ url: "https://api.openai.com/v1/chat/completions", headers: { authorization: `Bearer ${ENV_KEYS.OPENAI_API_KEY}` } });
  });

  it("a gateway the operator lists gets the env key", async () => {
    process.env.PROVIDER_ENV_KEY_BASE_URLS = "https://gw.example.com";
    const seen = stubFetch();
    await registry.get("openai").generate({ provider: { providerId: "openai", model: "m", baseUrl: "https://gw.example.com/v1" }, messages }, noSecret);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${ENV_KEYS.OPENAI_API_KEY}`);
  });

  it("Anthropic refuses to send ANTHROPIC_API_KEY to a custom base URL", async () => {
    const seen = stubFetch();
    await expect(
      registry.get("anthropic").generate({ provider: { providerId: "anthropic", model: "claude-sonnet-5-5", baseUrl: "https://evil.example.com/v1" }, messages }, noSecret)
    ).rejects.toThrow(/secret for a custom base URL/);
    expect(seen).toEqual([]);
    await registry.get("anthropic").generate({ provider: { providerId: "anthropic", model: "claude-sonnet-5-5" }, messages }, noSecret);
    expect(seen[0]?.headers["x-api-key"]).toBe(ENV_KEYS.ANTHROPIC_API_KEY);
  });

  it("Azure OpenAI refuses to send AZURE_OPENAI_API_KEY to an endpoint other than AZURE_OPENAI_ENDPOINT", async () => {
    const seen = stubFetch();
    await expect(
      registry.get("azure_openai").generate({ provider: { providerId: "azure_openai", model: "dep", baseUrl: "https://evil.example.com" }, messages }, noSecret)
    ).rejects.toThrow(/only sent to AZURE_OPENAI_ENDPOINT/);
    expect(seen).toEqual([]);
    await registry.get("azure_openai").generate({ provider: { providerId: "azure_openai", model: "dep" }, messages }, noSecret);
    expect(seen[0]?.url).toContain("https://corp.openai.azure.com/");
    expect(seen[0]?.headers["api-key"]).toBe(ENV_KEYS.AZURE_OPENAI_API_KEY);
  });

  it("embeddings (OpenAI and Azure) keep the env key off a custom endpoint", async () => {
    const seen = stubFetch();
    const embeddings = createDefaultEmbeddingRegistry();
    await expect(
      embeddings.get("openai")!.embed({ provider: { providerId: "openai", model: "text-embedding-3-small", baseUrl: "https://evil.example.com/v1" }, input: ["x"] }, noSecret)
    ).rejects.toThrow(/secret for a custom base URL/);
    await expect(
      embeddings.get("azure_openai")!.embed({ provider: { providerId: "azure_openai", model: "dep", baseUrl: "https://evil.example.com" }, input: ["x"] }, noSecret)
    ).rejects.toThrow(/only sent to AZURE_OPENAI_ENDPOINT/);
    expect(seen).toEqual([]);
    expect(leaked(seen)).toBe(false);
  });
});

describe("model calls do not follow redirects", () => {
  it("a 303 from a base URL is a failed call, and the redirect target gets nothing", async () => {
    const http = await import("node:http");
    const hits: string[] = [];
    const target = http.createServer((request, response) => {
      hits.push(String(request.headers["x-api-key"] ?? request.headers.authorization ?? ""));
      response.end("{}");
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetPort = (target.address() as { port: number }).port;
    const redirector = http.createServer((_request, response) => {
      response.writeHead(307, { location: `http://127.0.0.1:${targetPort}/v1/chat/completions` });
      response.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    const redirectorPort = (redirector.address() as { port: number }).port;
    try {
      await expect(
        createDefaultProviderRegistry()
          .get("openai_compatible")
          .generate(
            { provider: { providerId: "openai_compatible", model: "m", baseUrl: `http://127.0.0.1:${redirectorPort}/v1`, secretRef: { secretId: "s" } }, messages },
            { resolveSecret: async () => "sk-user-secret" }
          )
      ).rejects.toThrow();
      expect(hits).toEqual([]);
    } finally {
      target.close();
      redirector.close();
    }
  });
});
