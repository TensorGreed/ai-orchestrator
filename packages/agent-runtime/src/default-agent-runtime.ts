import type { AgentRunRequest, AgentRunState, ChatMessage } from "@ai-orchestrator/shared";
import type { AgentRuntimeAdapter, AgentRuntimeContext, AgentToolRuntime, InternalToolResult } from "./types";
import { createToolErrorResult } from "./types";

function normalizeMaxMessages(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return 20;
  }
  return Math.floor(value);
}

function normalizeStoredMessages(messages: ChatMessage[], maxMessages: number): ChatMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "tool")
    .slice(-maxMessages);
}

export class DefaultAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "default-agent-runtime";

  async run(request: AgentRunRequest, tools: AgentToolRuntime, context: AgentRuntimeContext): Promise<AgentRunState> {
    const providerAdapter = context.providerRegistry.get(request.provider.providerId);
    const memoryEnabled = Boolean(context.memoryStore && request.sessionId);
    const memoryNamespace = request.memory?.namespace?.trim() || "default";
    const memoryMaxMessages = normalizeMaxMessages(request.memory?.maxMessages);
    const persistToolMessages = request.memory?.persistToolMessages !== false;

    let memoryMessages: ChatMessage[] = [];
    if (memoryEnabled && request.sessionId) {
      const loaded = await context.memoryStore!.loadMessages(memoryNamespace, request.sessionId);
      memoryMessages = normalizeStoredMessages(loaded, memoryMaxMessages);
    }

    const messages: ChatMessage[] = [{ role: "system", content: request.systemPrompt }, ...memoryMessages, { role: "user", content: request.userPrompt }];

    const steps: AgentRunState["steps"] = [];
    let lastAssistantMessage = "";

    const persistConversation = async () => {
      if (!memoryEnabled || !request.sessionId || !context.memoryStore) {
        return;
      }

      const persistable = messages
        .filter((message, index) => !(index === 0 && message.role === "system"))
        .filter((message) => (persistToolMessages ? true : message.role !== "tool"))
        .slice(-memoryMaxMessages);

      await context.memoryStore.saveMessages(memoryNamespace, request.sessionId, persistable);
    };

    try {
      for (let iteration = 1; iteration <= request.maxIterations; iteration += 1) {
        const modelResponse = await providerAdapter.generate(
          {
            provider: request.provider,
            messages,
            tools: request.toolCallingEnabled ? tools.tools : []
          },
          {
            resolveSecret: context.resolveSecret
          }
        );

        lastAssistantMessage = modelResponse.content;
        const requestedTools = request.toolCallingEnabled ? modelResponse.toolCalls : [];

        if (requestedTools.length > 0) {
          messages.push({
            role: "assistant",
            content: modelResponse.content,
            toolCalls: requestedTools
          });

          const toolResults: InternalToolResult[] = [];

          for (const call of requestedTools) {
            try {
              const output = await tools.invokeTool(call.name, call.arguments);
              toolResults.push({
                toolCallId: call.id,
                toolName: call.name,
                output
              });

              messages.push({
                role: "tool",
                content: JSON.stringify({ ok: true, output }),
                toolCallId: call.id,
                name: call.name
              });
            } catch (error) {
              const toolError = createToolErrorResult(call, error);
              toolResults.push(toolError);
              messages.push({
                role: "tool",
                content: JSON.stringify({ ok: false, error: toolError.error }),
                toolCallId: call.id,
                name: call.name
              });
            }
          }

          steps.push({
            iteration,
            modelOutput: modelResponse.content,
            requestedTools,
            toolResults
          });

          continue;
        }

        messages.push({ role: "assistant", content: modelResponse.content });
        steps.push({
          iteration,
          modelOutput: modelResponse.content,
          requestedTools: [],
          toolResults: []
        });

        const result: AgentRunState = {
          finalAnswer: modelResponse.content,
          stopReason: "final_answer",
          iterations: iteration,
          messages,
          steps
        };
        await persistConversation();
        return result;
      }

      const result: AgentRunState = {
        finalAnswer: lastAssistantMessage || "Agent stopped after reaching iteration limit.",
        stopReason: "max_iterations",
        iterations: request.maxIterations,
        messages,
        steps
      };
      await persistConversation();
      return result;
    } catch (error) {
      const result: AgentRunState = {
        finalAnswer: error instanceof Error ? error.message : "Agent runtime failed",
        stopReason: "error",
        iterations: steps.length,
        messages,
        steps
      };
      await persistConversation();
      return result;
    }
  }
}
