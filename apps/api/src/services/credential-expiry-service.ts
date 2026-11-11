/**
 * 13.2 — warnings before credentials stop working: the `credential.expiring` notification.
 *
 * The leader sweeps hourly. It announces:
 *   - an API key (personal or a service account's) or a gateway client that expires within CREDENTIAL_EXPIRY_WARNING_DAYS;
 *   - an old API key that a rotation replaced but that is still in use after the rotation, when its grace window ends
 *     within ROTATION_GRACE_WARNING_HOURS (a caller has not switched to the new key yet).
 * A rotated key that nobody uses any more ends quietly. Each credential is announced at most once a day: the claim is
 * a conditional write on the row (`expiry_notified_at`), so it holds across instances, leader changes and restarts.
 * Nothing is claimed or sent while no channel subscribes to the event, so turning a channel on later still announces
 * credentials that expire soon. The alert names the credential (name, prefix, owner), never a secret.
 */
import {
  CREDENTIAL_EXPIRING_EVENT,
  CREDENTIAL_EXPIRY_WARNING_DAYS,
  ROTATION_GRACE_WARNING_HOURS,
  type CredentialExpiryReason,
  type CredentialKind
} from "@ai-orchestrator/shared";
import type { Store } from "../db/store.js";
import type { NotificationEvent } from "./notification-service.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** How often the leader sweeps. */
export const CREDENTIAL_EXPIRY_SWEEP_INTERVAL_MS = HOUR_MS;

export interface CredentialExpiryWarning {
  kind: CredentialKind;
  reason: CredentialExpiryReason;
  id: string;
  name: string;
  /** The first characters of the key or token, safe to display. */
  prefix: string;
  expiresAt: string;
  /** The key's owner (a person's email or a service account's email); the creator for a gateway client. */
  owner: string | null;
}

export interface CredentialExpiryServiceDeps {
  store: Pick<Store, "listApiKeys" | "listMcpClients" | "claimCredentialExpiryNotice" | "getUserById">;
  /** Sends the alert; a failure is the channel's problem (the claim stands, the next day tries again). */
  notify: (event: NotificationEvent) => Promise<unknown>;
  /** Whether any enabled channel takes `credential.expiring` now. */
  subscribed: () => Promise<boolean>;
  /** Only the leader sweeps. */
  isLeader: () => boolean;
}

export class CredentialExpiryService {
  constructor(private readonly deps: CredentialExpiryServiceDeps) {}

  /** The credentials that need a warning at `now` (before the once-a-day claim). */
  async due(now: Date = new Date()): Promise<CredentialExpiryWarning[]> {
    const nowMs = now.getTime();
    const horizon = nowMs + CREDENTIAL_EXPIRY_WARNING_DAYS * DAY_MS;
    const owners = new Map<string, { email: string; service: boolean } | null>();
    const ownerOf = async (userId: string) => {
      if (!owners.has(userId)) {
        const user = await this.deps.store.getUserById(userId);
        owners.set(userId, user ? { email: user.email, service: user.kind === "service" } : null);
      }
      return owners.get(userId) ?? null;
    };
    const warnings: CredentialExpiryWarning[] = [];
    for (const key of await this.deps.store.listApiKeys()) {
      if (key.revokedAt || !key.expiresAt) continue;
      const at = Date.parse(key.expiresAt);
      if (!(at > nowMs && at <= horizon)) continue;
      let reason: CredentialExpiryReason = "expiry";
      if (key.supersededBy) {
        // An old key in its grace window: worth a word only while someone still uses it and the window is closing.
        const usedSinceRotation = Boolean(key.lastUsedAt && key.rotatedAt && Date.parse(key.lastUsedAt) > Date.parse(key.rotatedAt));
        if (!usedSinceRotation || at - nowMs > ROTATION_GRACE_WARNING_HOURS * HOUR_MS) continue;
        reason = "rotation_grace";
      }
      const owner = await ownerOf(key.userId);
      warnings.push({
        kind: owner?.service ? "service_account_key" : "api_key",
        reason,
        id: key.id,
        name: key.name,
        prefix: key.keyPrefix,
        expiresAt: key.expiresAt,
        owner: owner?.email ?? null
      });
    }
    for (const client of await this.deps.store.listMcpClients()) {
      if (client.revokedAt || !client.expiresAt) continue;
      const at = Date.parse(client.expiresAt);
      if (!(at > nowMs && at <= horizon)) continue;
      warnings.push({
        kind: "mcp_client",
        reason: "expiry",
        id: client.id,
        name: client.name,
        prefix: client.tokenPrefix,
        expiresAt: client.expiresAt,
        owner: client.createdByEmail
      });
    }
    return warnings;
  }

  /** One sweep: claims and announces each due credential not announced in the last day. Returns how many were sent. */
  async sweep(now: Date = new Date()): Promise<number> {
    if (!this.deps.isLeader()) return 0;
    if (!(await this.deps.subscribed())) return 0;
    const nowIso = now.toISOString();
    const notBefore = new Date(now.getTime() - DAY_MS).toISOString();
    let sent = 0;
    for (const warning of await this.due(now)) {
      const claimed = await this.deps.store.claimCredentialExpiryNotice(warning.kind === "mcp_client" ? "mcp_client" : "api_key", warning.id, nowIso, notBefore);
      if (!claimed) continue;
      await this.deps.notify({
        type: CREDENTIAL_EXPIRING_EVENT,
        workflowId: "",
        workflowName: "",
        timestamp: nowIso,
        credential: warning
      });
      sent += 1;
    }
    return sent;
  }
}
