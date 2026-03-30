import type { LLMCallResponse, ProviderDefinition } from "@ai-orchestrator/shared";
import type { LLMProviderAdapter, ProviderCallRequest, ProviderExecutionContext } from "../types";

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

function flattenMessages(messages: ProviderCallRequest["messages"]): string {
  return messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n")
    .trim();
}

export class GeminiProviderAdapter implements LLMProviderAdapter {
  readonly definition: ProviderDefinition = {
    id: "gemini",
    label: "Gemini",
    supportsTools: false,
    configSchema: {
      type: "object",
      properties: {
        model: { type: "string", default: "gemini-2.0-flash" },
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

    const prompt = flattenMessages(request.messages);
    const model = request.provider.model || "gemini-2.0-flash";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: request.provider.temperature ?? 0.2,
          maxOutputTokens: request.provider.maxTokens ?? 1024
        }
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini request failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as GeminiResponse;
    const content = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";

    return {
      content,
      toolCalls: [],
      raw: json
    };
  }
}