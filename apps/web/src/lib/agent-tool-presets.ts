import { BUILT_IN_TOOL_PROVIDERS, BUILT_IN_TOOL_PROVIDER_INFO, BUILT_IN_TOOLS_ADAPTER_ID } from "@ai-orchestrator/shared";
import type { PaletteDefinition } from "../components/NodePalette";

/**
 * Phase 6.4 — palette entries for the built-in tools: MCP Tool nodes already
 * pointed at the `l2m-tools` adapter and one provider, exposing all of its
 * tools. A key-based provider still needs a secret picked on the node.
 */
export const BUILT_IN_TOOL_PRESETS: readonly PaletteDefinition[] = BUILT_IN_TOOL_PROVIDERS.map((provider) => {
  const info = BUILT_IN_TOOL_PROVIDER_INFO[provider];
  return {
    presetId: `built-in-tool:${provider}`,
    type: "mcp_tool",
    label: info.label,
    category: "MCP",
    description: `Built-in tool. ${info.description}`,
    sampleConfig: { serverId: BUILT_IN_TOOLS_ADAPTER_ID, toolName: "__all__", connection: { provider } }
  };
});

/** The definitions and the presets, as the palette and the drop handler see them. */
export function withAgentToolPresets<T extends PaletteDefinition>(definitions: readonly T[]): Array<T | PaletteDefinition> {
  return definitions.some((definition) => definition.type === "mcp_tool") ? [...definitions, ...BUILT_IN_TOOL_PRESETS] : [...definitions];
}
