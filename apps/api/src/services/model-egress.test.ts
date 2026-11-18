import http, { type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDefaultEmbeddingRegistry,
  createDefaultProviderRegistry,
  createGatedEmbeddingRegistry,
  createGatedProviderRegistry
} from "@ai-orchestrator/provider-sdk";
import type { DnsResolver } from "@ai-orchestrator/guard-sdk";
import { createModelEgress } from "./model-egress.js";

const servers: http.Server[] = [];
const messages = [{ role: "user" as const, content: "hi" }];
const withSecret = { resolveSecret: async () => "sk-user-secret" };
const secretRef = { secretId: "s" };

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function modelServer(status = 200): Promise<{ port: number; seen: Array<{ url: string; headers: IncomingHttpHeaders }> }> {
  const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url ?? "", headers: request.headers });
    request.resume();
    if (status >= 300 && status < 400) {
      response.writeHead(status, { location: "http://169.254.169.254/latest/meta-data/" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify((request.url ?? "").includes("embeddings") ? { data: [{ embedding: [0.5], index: 0 }] } : { choices: [{ message: { content: "pinned ok" }, finish_reason: "stop" }] })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { port: (server.address() as { port: number }).port, seen };
}

/** A resolver that answers `first` for its first `times` lookups and `then` afterwards (a rebinding name). */
function rebindingResolver(first: string, times: number, then: string): DnsResolver & { calls: string[] } {
  const calls: string[] = [];
  const resolver = (async (host: string) => {
    calls.push(host);
    return [calls.length <= times ? first : then];
  }) as DnsResolver & { calls: string[] };
  resolver.calls = calls;
  return resolver;
}

function registryWith(egress: ReturnType<typeof createModelEgress>) {
  return createGatedProviderRegistry(createDefaultProviderRegistry(), async (call, context) => await egress.contextFor(call.provider, context));
}

describe("model egress pins model calls to the checked address", () => {
  it("a name that rebinds to a private address between the check and the connect never reaches it", async () => {
    const target = await modelServer();
    // The check (and guardedFetch's own check) see a public address; the connect-time lookup gets loopback. Without
    // pinning the client would resolve "localhost" itself and reach the server.
    const resolver = rebindingResolver("93.184.215.14", 2, "127.0.0.1");
    const egress = createModelEgress({ guard: { denyPrivate: true, allowlist: [] }, resolver, env: {} });
    await expect(
      registryWith(egress)
        .get("openai_compatible")
        .generate({ provider: { providerId: "openai_compatible", model: "m", baseUrl: `http://localhost:${target.port}/v1`, secretRef, extra: { maxRetries: 0 } }, messages }, withSecret)
    ).rejects.toThrow(/loopback|blocked/i);
    expect(target.seen).toEqual([]);
    expect(resolver.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("connects through the vetted address and keeps the host name in the Host header (and so for TLS SNI)", async () => {
    const target = await modelServer();
    // Only this resolver knows the name, so a request that arrives proves the connection used the pinned lookup.
    const resolver = rebindingResolver("127.0.0.1", 99, "127.0.0.1");
    const egress = createModelEgress({ guard: { denyPrivate: false, allowlist: [] }, resolver, env: {} });
    const answer = await registryWith(egress)
      .get("openai_compatible")
      .generate({ provider: { providerId: "openai_compatible", model: "m", baseUrl: `http://model.internal.test:${target.port}/v1`, secretRef }, messages }, withSecret);
    expect(answer.content).toBe("pinned ok");
    expect(target.seen).toHaveLength(1);
    expect(target.seen[0]!.headers.host).toBe(`model.internal.test:${target.port}`);
    expect(target.seen[0]!.headers.authorization).toBe("Bearer sk-user-secret");
  });

  it("a stream is pinned too", async () => {
    const target = await modelServer();
    const resolver = rebindingResolver("93.184.215.14", 2, "127.0.0.1");
    const egress = createModelEgress({ guard: { denyPrivate: true, allowlist: [] }, resolver, env: {} });
    const stream = registryWith(egress)
      .get("openai_compatible")
      .generateStream!({ provider: { providerId: "openai_compatible", model: "m", baseUrl: `http://localhost:${target.port}/v1`, secretRef, extra: { maxRetries: 0 } }, messages }, withSecret);
    await expect((async () => { for await (const chunk of stream) void chunk; })()).rejects.toThrow(/loopback|blocked/i);
    expect(target.seen).toEqual([]);
  });

  it("a pinned stream is read to the end", async () => {
    const target = await modelServer();
    const egress = createModelEgress({ guard: { denyPrivate: false, allowlist: [] }, resolver: rebindingResolver("127.0.0.1", 99, "127.0.0.1"), env: {} });
    const chunks: string[] = [];
    for await (const chunk of registryWith(egress)
      .get("openai_compatible")
      .generateStream!({ provider: { providerId: "openai_compatible", model: "m", baseUrl: `http://model.internal.test:${target.port}/v1`, secretRef }, messages }, withSecret)) {
      if (chunk.type === "text_delta") chunks.push(chunk.textDelta);
    }
    expect(chunks.join("")).toBe("pinned ok");
    expect(target.seen[0]!.headers.host).toBe(`model.internal.test:${target.port}`);
  });

  it("refuses a redirect instead of following it", async () => {
    const target = await modelServer(307);
    const egress = createModelEgress({ guard: { denyPrivate: false, allowlist: [] }, resolver: rebindingResolver("127.0.0.1", 99, "127.0.0.1"), env: {} });
    await expect(
      registryWith(egress)
        .get("openai_compatible")
        .generate({ provider: { providerId: "openai_compatible", model: "m", baseUrl: `http://model.internal.test:${target.port}/v1`, secretRef }, messages }, withSecret)
    ).rejects.toThrow(/redirect/);
    expect(target.seen).toHaveLength(1);
  });

  it("embedding calls are checked and pinned the same way", async () => {
    const target = await modelServer();
    const resolver = rebindingResolver("93.184.215.14", 2, "127.0.0.1");
    const egress = createModelEgress({ guard: { denyPrivate: true, allowlist: [] }, resolver, env: {} });
    const embeddings = createGatedEmbeddingRegistry(createDefaultEmbeddingRegistry(), async (call, context) => await egress.contextFor(call.provider, context));
    await expect(
      embeddings.get("ollama").embed({ provider: { providerId: "ollama", model: "e", baseUrl: `http://localhost:${target.port}/v1`, extra: { maxRetries: 0 } }, input: ["x"] }, withSecret)
    ).rejects.toThrow(/loopback|blocked/i);
    const direct = createGatedEmbeddingRegistry(createDefaultEmbeddingRegistry(), async (call, context) => await egress.contextFor(call.provider, context));
    await expect(
      direct.get("ollama").embed({ provider: { providerId: "ollama", model: "e", baseUrl: `http://127.0.0.1:${target.port}/v1`, extra: { maxRetries: 0 } }, input: ["x"] }, withSecret)
    ).rejects.toThrow(/OUTBOUND_DENY_PRIVATE/);
    expect(target.seen).toEqual([]);
  });

  it("leaves the operator's environment endpoints and provider defaults unpinned", async () => {
    const target = await modelServer();
    const egress = createModelEgress({ guard: { denyPrivate: true, allowlist: [] }, resolver: rebindingResolver("127.0.0.1", 99, "127.0.0.1"), env: { OLLAMA_BASE_URL: `http://127.0.0.1:${target.port}/v1` } });
    const context = await egress.contextFor({ baseUrl: `http://127.0.0.1:${target.port}/v1` }, withSecret);
    expect(context).toBe(withSecret);
    expect(await egress.contextFor({}, withSecret)).toBe(withSecret);
    const answer = await registryWith(egress)
      .get("ollama")
      .generate({ provider: { providerId: "ollama", model: "m", baseUrl: `http://127.0.0.1:${target.port}/v1` }, messages }, withSecret);
    expect(answer.content).toBe("pinned ok");
  });

  it("checks extra.endpoint as well as the base URL", async () => {
    const egress = createModelEgress({ guard: { denyPrivate: false, allowlist: [] }, resolver: rebindingResolver("127.0.0.1", 99, "127.0.0.1"), env: {} });
    await expect(egress.contextFor({ extra: { endpoint: "http://169.254.169.254" } }, withSecret)).rejects.toThrow(/link local|metadata/i);
  });
});
