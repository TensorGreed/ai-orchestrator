import type { LLMCallResponse, LLMProviderConfig, ProviderDefinition, ToolCall } from "@ai-orchestrator/shared";
import type { LLMProviderAdapter, ProviderCallRequest, ProviderExecutionContext, ProviderTestResult } from "../types";
import { resilientFetch } from "../resilient-fetch";

interface GeminiPart {
  text?: string;
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: { name: string; content: unknown };
  };
  inlineData?: { mimeType: string; data: string };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
  }>;
}

function sanitizeSchemaForGemini(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const s = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(s)) {
    if (key === "default" || key === "examples" || key === "$schema" || key === "additionalProperties") {
      continue;
    }
    result[key] = value;
  }

  if (result.type === "array" && !result.items) {
    result.items = { type: "string" };
  }

  if (result.items && typeof result.items === "object") {
    result.items = sanitizeSchemaForGemini(result.items);
  }

  if (result.properties && typeof result.properties === "object") {
    const cleaned: Record<string, unknown> = {};
    for (const [propKey, propValue] of Object.entries(result.properties as Record<string, unknown>)) {
      cleaned[propKey] = sanitizeSchemaForGemini(propValue);
    }
    result.properties = cleaned;
  }

  return result;
}

export class GeminiProviderAdapter implements LLMProviderAdapter {
  readonly definition: ProviderDefinition = {
    id: "gemini",
    label: "Gemini",
    supportsTools: true,
    configSchema: {
      type: "object",
      properties: {
        model: { type: "string", default: "gemini-2.5-flash" },
        secretRef: { type: "object", properties: { secretId: { type: "string" } } }
      },
      required: ["model"]
    }
  };

  async generate(request: ProviderCallRequest, context: ProviderExecutionContext): Promise<LLMCallResponse> {
    const apiKey = (await context.resolveSecret(request.provider.secretRef)) || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("Gemini requires API key via secretRef or GEMINI_API_KEY env var");
    }

    const rawModel = request.provider.model || "gemini-2.5-flash";
    const model = rawModel.replace(/^models\//, "");
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    let systemInstruction: { parts: GeminiPart[] } | undefined;
    const contents: GeminiContent[] = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        systemInstruction = {
          parts: [{ text: msg.content }]
        };
      } else if (msg.role === "assistant") {
         if (msg.toolCalls && msg.toolCalls.length > 0) {
           contents.push({
             role: "model",
             parts: msg.toolCalls.map(tc => ({ functionCall: { name: tc.name, args: typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments } }))
           });
         } else {
           contents.push({
             role: "model",
             parts: [{ text: msg.content }]
           });
         }
      } else if (msg.role === "tool") {
         contents.push({
           role: "user",
           parts: [{
             functionResponse: {
               name: msg.name || "tool",
               response: { name: msg.name || "tool", content: msg.content }
             }
           }]
         });
      } else {
        const parts: GeminiPart[] = [{ text: msg.content }];
        if (msg.images && msg.images.length > 0) {
          for (const img of msg.images) {
            (parts as Array<Record<string, unknown>>).push({
              inlineData: {
                mimeType: img.mimeType,
                data: img.data
              }
            });
          }
        }
        contents.push({
          role: "user",
          parts
        });
      }
    }

    // Tools
    let toolsObj: unknown = undefined;
    if (request.tools && request.tools.length > 0) {
      toolsObj = [{
        functionDeclarations: request.tools.map(t => ({
          name: t.name,
          description: t.description || "",
          parameters: sanitizeSchemaForGemini(t.inputSchema || { type: "object", properties: {} })
        }))
      }];
    }

    const requestBody = {
      systemInstruction,
      contents,
      tools: toolsObj,
      generationConfig: {
        temperature: request.provider.temperature ?? 0.2,
        maxOutputTokens: request.provider.maxTokens ?? 1024
      }
    };

    console.warn(`[Gemini] POST models/${model}:generateContent | messages=${contents.length} tools=${request.tools?.length ?? 0} key=${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`);

    const response = await resilientFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody)
    }, { timeoutMs: 60_000, maxRetries: 3, provider: "gemini" });

    if (!response.ok) {
      const body = await response.text();
      console.warn(`[Gemini] ERROR ${response.status} for model=${model}:`, body.slice(0, 500));
      let message = body;
      try {
        const parsed = JSON.parse(body);
        if (parsed?.error?.message) {
          message = parsed.error.message.split("\n")[0];
        }
      } catch { /* use raw body */ }
      throw new Error(`Gemini request failed (${response.status}): ${message}`);
    }

    const json = (await response.json()) as GeminiResponse;
    const parts = json.candidates?.[0]?.content?.parts || [];
    
    let content = "";
    const toolCalls: ToolCall[] = [];

    for (const part of parts) {
      if (part.text) {
        content += part.text;
      }
      if (part.functionCall) {
        toolCalls.push({
           id: "call_" + Math.random().toString(36).substring(2, 9),
           name: part.functionCall.name,
           arguments: part.functionCall.args
        });
      }
    }

    return {
      content,
      toolCalls,
      raw: json
    };
  }

  async testConnection(provider: LLMProviderConfig, context: ProviderExecutionContext): Promise<ProviderTestResult> {
    const apiKey = (await context.resolveSecret(provider.secretRef)) || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { ok: false, message: "Gemini requires an API key via secret or GEMINI_API_KEY env var." };
    }

    const rawModel = provider.model || "gemini-2.5-flash";
    const model = rawModel.replace(/^models\//, "");
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}?key=${apiKey}`;
    const startedAt = Date.now();
    const response = await resilientFetch(endpoint, {
      method: "GET",
      headers: { "content-type": "application/json" }
    }, { timeoutMs: 15_000, maxRetries: 1, provider: "gemini" });

    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      const body = await response.text();
      let message = body;
      try {
        const parsed = JSON.parse(body);
        if (parsed?.error?.message) {
          message = parsed.error.message.split("\n")[0];
        }
      } catch { /* use raw body */ }
      return { ok: false, message: `Gemini connection failed (${response.status}): ${message}` };
    }

    const json = await response.json() as { displayName?: string; name?: string };
    return {
      ok: true,
      message: `Connection successful — model: ${json.displayName || json.name || model}`,
      latencyMs
    };
  }
}