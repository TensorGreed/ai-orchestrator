/**
 * Phase 10.4 — client credentials for the MCP gateway.
 *
 * A token looks like `l2m_mcp_<prefix>.<secret>`. Only the prefix (for lookup
 * and display) and the sha256 of the secret are stored, the same scheme API
 * keys use; the full token is returned once, when the client is created.
 *
 * A client's effective role is its own role capped at its creator's current
 * role, so demoting the admin who minted a credential also narrows it.
 */

import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { MCP_POLICY_ROLES, type McpClient, type McpPolicyRole, type McpToolPolicySubject } from "@ai-orchestrator/shared";
import type { SqliteStore } from "../db/database.js";
import { hashSecret } from "./api-key-service.js";

export const MCP_CLIENT_TOKEN_PREFIX = "l2m_mcp_";
const PREFIX_ID_LENGTH = 12;
const SECRET_BYTES = 32;
/** last_used_at is written at most this often per client. */
const TOUCH_INTERVAL_MS = 60_000;

const ROLE_RANK: Record<McpPolicyRole, number> = { viewer: 1, operator: 2, builder: 3, admin: 4 };

export function roleRank(role: McpPolicyRole): number {
  return ROLE_RANK[role];
}

/** The lower of two roles. */
export function capRole(role: McpPolicyRole, cap: McpPolicyRole): McpPolicyRole {
  return ROLE_RANK[role] <= ROLE_RANK[cap] ? role : cap;
}

export function asPolicyRole(value: unknown): McpPolicyRole | null {
  return typeof value === "string" && MCP_POLICY_ROLES.includes(value as McpPolicyRole) ? (value as McpPolicyRole) : null;
}

export type McpClientVerification =
  | { ok: true; client: McpClient }
  | { ok: false; reason: "malformed" | "unknown" | "revoked" | "expired" };

export interface McpClientSubjectStore {
  getUserById(id: string): { id: string; email: string; role: string } | null;
}

/**
 * Policy subject for a gateway call: the client's role capped at its
 * creator's current role; viewer when the creator no longer exists.
 */
export function resolveMcpClientSubject(store: McpClientSubjectStore, client: McpClient): McpToolPolicySubject {
  const creator = client.createdBy ? store.getUserById(client.createdBy) : null;
  const creatorRole = asPolicyRole(creator?.role) ?? "viewer";
  return {
    role: capRole(client.role, creatorRole),
    source: "client",
    clientId: client.id,
    clientName: client.name,
    ...(creator ? { userId: creator.id, email: creator.email } : {})
  };
}

export class McpClientService {
  private readonly lastTouched = new Map<string, number>();

  constructor(private readonly store: SqliteStore) {}

  create(input: {
    name: string;
    toolsetIds: string[];
    role: McpPolicyRole;
    createdBy: string;
    createdByEmail: string;
    expiresAt: string | null;
  }): { client: McpClient; token: string } {
    const tokenPrefix = `${MCP_CLIENT_TOKEN_PREFIX}${nanoid(PREFIX_ID_LENGTH)}`;
    const secret = crypto.randomBytes(SECRET_BYTES).toString("base64url");
    const client = this.store.createMcpClient({
      id: `mcc_${crypto.randomUUID()}`,
      name: input.name,
      tokenPrefix,
      tokenHash: hashSecret(secret),
      toolsetIds: [...new Set(input.toolsetIds)],
      role: input.role,
      createdBy: input.createdBy,
      createdByEmail: input.createdByEmail,
      expiresAt: input.expiresAt
    });
    return { client, token: `${tokenPrefix}.${secret}` };
  }

  verify(rawToken: string, now: Date = new Date()): McpClientVerification {
    const token = rawToken.trim();
    const separator = token.indexOf(".");
    if (!token.startsWith(MCP_CLIENT_TOKEN_PREFIX) || separator <= MCP_CLIENT_TOKEN_PREFIX.length) {
      return { ok: false, reason: "malformed" };
    }
    const prefix = token.slice(0, separator);
    const secret = token.slice(separator + 1);
    if (!secret) return { ok: false, reason: "malformed" };

    const record = this.store.findMcpClientByTokenPrefix(prefix);
    if (!record) return { ok: false, reason: "unknown" };
    const expected = Buffer.from(record.tokenHash, "hex");
    const candidate = Buffer.from(hashSecret(secret), "hex");
    if (expected.length !== candidate.length || !crypto.timingSafeEqual(expected, candidate)) {
      return { ok: false, reason: "unknown" };
    }
    if (record.revokedAt) return { ok: false, reason: "revoked" };
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= now.getTime()) {
      return { ok: false, reason: "expired" };
    }

    const { tokenHash: _hash, ...client } = record;
    const last = this.lastTouched.get(client.id) ?? 0;
    if (now.getTime() - last >= TOUCH_INTERVAL_MS) {
      this.lastTouched.set(client.id, now.getTime());
      const at = now.toISOString();
      this.store.touchMcpClient(client.id, at);
      client.lastUsedAt = at;
    }
    return { ok: true, client };
  }
}
