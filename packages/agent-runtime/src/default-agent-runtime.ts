import type { AgentRunRequest, AgentRunState, ChatMessage } from "@ai-orchestrator/shared";
import type { AgentRuntimeAdapter, AgentRuntimeContext, AgentToolRuntime, InternalToolResult } from "./types";
import { createToolErrorResult } from "./types";

export class DefaultAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "default-agent-runtime";

  async run(request: AgentRunRequest, tools: AgentToolRuntime, context: AgentRuntimeContext): Promise<AgentRunState> {
    const providerAdapter = context.providerRegistry.get(request.provider.providerId);
    const messages: ChatMessage[] = [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.userPrompt }
    ];

    const steps: AgentRunState["steps"] = [];
    let lastAssistantMessage = "";

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

        return {
          finalAnswer: modelResponse.content,
          stopReason: "final_answer",
          iterations: iteration,
          messages,
          steps
        };
      }

      return {
        finalAnswer: lastAssistantMessage || "Agent stopped after reaching iteration limit.",
        stopReason: "max_iterations",
        iterations: request.maxIterations,
        messages,
        steps
      };
    } catch (error) {
      return {
        finalAnswer: error instanceof Error ? error.message : "Agent runtime failed",
        stopReason: "error",
        iterations: steps.length,
        messages,
        steps
      };
    }
  }
}