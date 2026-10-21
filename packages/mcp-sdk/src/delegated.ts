import type { McpDelegatedUser, McpToolPolicySubject, MCPServerConfig } from "@ai-orchestrator/shared";
import { McpDelegatedCredentialError } from "./errors";

/**
 * Phase 10.7 — delegated credentials: whose OAuth token a call to a
 * `credentialMode: "delegated"` server uses.
 *
 *   - a person started the run (subject source `user`): that person's own
 *     connection, never anyone else's;
 *   - a gateway client (source `client`): the client token's owner;
 *   - an unattended run (webhook, schedule, queue; source `owner`): the
 *     workflow owner's connection, only when the server allows
 *     `delegatedFallback: "owner"`; otherwise the call fails;
 *   - no subject at all: the call fails.
 *
 * There is never a fallback to the server's service credential.
 */
export function resolveDelegatedUser(config: Pick<MCPServerConfig, "credentialMode" | "delegatedFallback" | "label" | "registryServerId" | "serverId">, subject: McpToolPolicySubject | undefined): McpDelegatedUser | undefined {
  if (config.credentialMode !== "delegated") return undefined;
  const label = config.label ?? config.registryServerId ?? config.serverId;
  if (subject?.userId && subject.source === "user") {
    return { userId: subject.userId, source: "user" };
  }
  if (subject?.userId && subject.source === "client") {
    return { userId: subject.userId, source: "client" };
  }
  if (subject?.userId && subject.source === "owner") {
    if (config.delegatedFallback === "owner") {
      return { userId: subject.userId, source: "owner" };
    }
    throw new McpDelegatedCredentialError(
      `MCP server '${label}' uses each user's own account, and this run has no signed-in user (webhook, schedule or queue). An admin can let unattended runs use the workflow owner's connection on the MCP servers page.`
    );
  }
  throw new McpDelegatedCredentialError(
    `MCP server '${label}' uses each user's own account, and this run has no user to act for.`
  );
}

/** Set `delegatedUser` on a delegated server's config from the run subject; other configs pass through. */
export function withDelegatedUser(config: MCPServerConfig, subject: McpToolPolicySubject | undefined): MCPServerConfig {
  if (config.credentialMode !== "delegated") {
    if (!config.delegatedUser) return config;
    const { delegatedUser: _ignored, ...rest } = config;
    return rest;
  }
  return { ...config, delegatedUser: resolveDelegatedUser(config, subject) };
}

/** True for the error a delegated server raises when the user has no usable connection. */
export function isDelegatedCredentialError(error: unknown): error is McpDelegatedCredentialError {
  return error instanceof McpDelegatedCredentialError || (error instanceof Error && error.name === "McpDelegatedCredentialError");
}
