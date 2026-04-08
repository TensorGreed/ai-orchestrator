import type { LLMCallResponse, ProviderDefinition, ToolCall } from "@ai-orchestrator/shared";
import type { LLMProviderAdapter, ProviderCallRequest, ProviderExecutionContext } from "../types";
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

export class GeminiProviderAdapter implements LLMProviderAdapter {
  readonly definition: ProviderDefinition = {
    id: "gemini",
    label: "Gemini",
    supportsTools: true,
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

    const model = request.provider.model || "gemini-2.0-flash";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    let systemInstruction: { role: "system"; parts: GeminiPart[] } | undefined;
    const contents: GeminiContent[] = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        systemInstruction = {
          role: "system",
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
        contents.push({
          role: "user",
          parts: [{ text: msg.content }]
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
          parameters: t.inputSchema || { type: "object", properties: {} }
        }))
      }];
    }

    const response = await resilientFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction,
        contents,
        tools: toolsObj,
        generationConfig: {
          temperature: request.provider.temperature ?? 0.2,
          maxOutputTokens: request.provider.maxTokens ?? 1024
        }
      })
    }, { timeoutMs: 60_000, maxRetries: 3, provider: "gemini" });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini request failed (${response.status}): ${body}`);
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
}