import { DefaultAgentRuntime } from "./default-agent-runtime";

export * from "./types";
export * from "./default-agent-runtime";

export function createDefaultAgentRuntime(): DefaultAgentRuntime {
  return new DefaultAgentRuntime();
}