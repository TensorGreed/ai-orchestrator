/**
 * MCP 2026-07-28 protocol foundations shared by the client adapters and the
 * gateway: constants, request `_meta`, HTTP headers and `x-mcp-header`,
 * `resultType`, the Multi Round-Trip Requests engine and era detection.
 * Nothing here changes how existing legacy connections behave.
 */
export * from "./constants";
export * from "./meta";
export * from "./headers";
export * from "./result";
export * from "./mrtr";
export * from "./era";
