/**
 * 13.2 — the SCIM 2.0 part of the Store contract (v75): provisioning tokens, provisioned users (a link from a users row
 * to its SCIM userName and attributes), groups and their members. Both stores run the same SQL through a small
 * executor (`?` placeholders; Postgres numbers them), so the two cannot drift: SQLite in scim-sqlite.ts, Postgres in
 * postgres/scim.ts. Disabling a user is a users-domain write with the last-admin check, so each store implements
 * `setUserDisabled` itself.
 */

/** A role a SCIM group mapping granted: global (projectId null) or in one project. */
export interface ScimGrant {
  projectId: string | null;
  role: string;
  customRoleId: string | null;
  /**
   * The role the user held before SCIM raised it (null: none, so taking the grant back means the default global role
   * `viewer`, or no project membership). Absent on grants recorded before it existed.
   */
  restore?: { role: string; customRoleId: string | null } | null;
}

export interface ScimTokenRecord {
  id: string;
  name: string;
  tokenPrefix: string;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /** The token that replaced this one in a rotation (it works until its grace expiry). */
  supersededBy: string | null;
}

export interface ScimTokenWrite extends ScimTokenRecord {
  tokenHash: string;
}

/** Whether SCIM made the users row (`created`) or linked one that already existed (`adopted`). */
export type ScimUserOrigin = "created" | "adopted";

export interface ScimUserLink {
  userId: string;
  userName: string;
  externalId: string | null;
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
  origin: ScimUserOrigin;
  grants: ScimGrant[];
  createdAt: string;
  updatedAt: string;
}

/** A provisioned user with what the users row says (email, role, disabled). */
export interface ScimUserView extends ScimUserLink {
  email: string;
  role: string;
  disabledAt: string | null;
}

export interface ScimGroupRecord {
  id: string;
  displayName: string;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ScimUserFilterField = "userName" | "externalId" | "id" | "email";
export type ScimGroupFilterField = "displayName" | "externalId" | "id" | "member";

export interface ScimPageRequest<F extends string> {
  filter?: { field: F; value: string } | null;
  /** 0-based. */
  offset: number;
  limit: number;
}

/** What disabling or enabling a user did. */
export type UserDisableOutcome =
  | { status: "updated"; sessionsEnded: number; keysRevoked: number }
  | { status: "not_found" }
  /** A service account: SCIM never manages one. */
  | { status: "service_account" }
  /** The only enabled admin who is a person (who could still sign in): never disabled. */
  | { status: "last_admin" };

export interface ScimStore {
  listScimTokens(): Promise<ScimTokenRecord[]>;
  createScimToken(input: ScimTokenWrite): Promise<void>;
  findScimTokenByPrefix(prefix: string): Promise<ScimTokenWrite | null>;
  /** Revokes a token (and a rotated-out predecessor still in its grace window); false when there is no such live token. */
  revokeScimToken(id: string, now: string): Promise<boolean>;
  /**
   * Rotation: the old token ends at `graceUntil` (never later than its own expiry) and records its successor, and the
   * new token is saved, in one transaction. False when the old token is not live or was already rotated.
   */
  rotateScimToken(input: { id: string; next: ScimTokenWrite; graceUntil: string; now: string }): Promise<boolean>;
  touchScimToken(id: string, now: string): Promise<void>;

  getScimUser(userId: string): Promise<ScimUserView | null>;
  findScimUserByUserName(userName: string): Promise<ScimUserView | null>;
  listScimUsers(request: ScimPageRequest<ScimUserFilterField>): Promise<{ items: ScimUserView[]; total: number }>;
  /** Inserts the link; false when the userName or the user is already linked. */
  createScimUser(link: ScimUserLink): Promise<boolean>;
  /** Updates the link's attributes (not its grants); false when it does not exist or the new userName is taken. */
  updateScimUser(link: ScimUserLink): Promise<boolean>;
  /** Records what the user's groups granted (only grants_json and updated_at change). */
  setScimUserGrants(userId: string, grants: readonly ScimGrant[], updatedAt: string): Promise<void>;
  /**
   * Changes the email of a person's account that SCIM created (only email and updated_at change; service accounts are
   * never touched). `taken` when another account has that email.
   */
  updateScimUserEmail(userId: string, email: string, updatedAt: string): Promise<"updated" | "taken" | "not_found">;
  /** Removes the link and the user's group memberships (the users row stays). */
  deleteScimUser(userId: string): Promise<boolean>;

  getScimGroup(id: string): Promise<ScimGroupRecord | null>;
  listScimGroups(request: ScimPageRequest<ScimGroupFilterField>): Promise<{ items: ScimGroupRecord[]; total: number }>;
  /** False when the display name is taken. */
  createScimGroup(group: ScimGroupRecord): Promise<boolean>;
  /** False when it does not exist or the new display name is taken. */
  updateScimGroup(group: ScimGroupRecord): Promise<boolean>;
  /** Removes the group and its memberships. */
  deleteScimGroup(id: string): Promise<boolean>;
  listScimGroupMembers(groupId: string): Promise<Array<{ userId: string; userName: string }>>;
  /** Member counts per group id. */
  countScimGroupMembers(groupIds: readonly string[]): Promise<Map<string, number>>;
  listScimGroupsOfUser(userId: string): Promise<ScimGroupRecord[]>;
  /** Changes the members; ids that are not provisioned users are skipped. Returns the ids actually added. */
  addScimGroupMembers(groupId: string, userIds: readonly string[], now: string): Promise<string[]>;
  removeScimGroupMembers(groupId: string, userIds: readonly string[]): Promise<number>;
  removeAllScimGroupMembers(groupId: string): Promise<string[]>;

  /**
   * Disables (`disabled: true`) or enables a person. Disabling also ends their sign-in sessions (break-glass sessions
   * excepted) with reason `admin` and revokes their API keys, in the same transaction; it refuses the only enabled
   * admin who is a person.
   */
  setUserDisabled(userId: string, input: { disabled: boolean; now: string }): Promise<UserDisableOutcome>;
}

type Row = Record<string, unknown>;

export interface ScimSqlStatement {
  sql: string;
  params: unknown[];
  stopUnlessChanged?: boolean;
}

/** The SQL both stores run: `?` placeholders. */
export interface ScimSqlExecutor {
  all(sql: string, params?: unknown[]): Promise<Row[]>;
  /** Resolves with the rows changed. */
  run(sql: string, params?: unknown[]): Promise<number>;
  /**
   * Runs the statements in order in one transaction (a write transaction on SQLite); resolves with each one's changes.
   * A statement marked `stopUnlessChanged` that changes nothing ends the batch there (the later ones do not run).
   */
  batch(statements: ReadonlyArray<ScimSqlStatement>): Promise<number[]>;
}

/** A unique constraint refused a write (SQLite SQLITE_CONSTRAINT_UNIQUE / PRIMARYKEY, Postgres 23505). */
export function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

const str = (value: unknown): string => (typeof value === "string" ? value : value instanceof Date ? value.toISOString() : String(value ?? ""));
const strOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : str(value));

/** The key a userName or display name is unique by: case-insensitive, as identity providers compare them. */
export function scimNameKey(value: string): string {
  return value.trim().toLowerCase();
}

export function parseScimGrants(raw: unknown): ScimGrant[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const grants: ScimGrant[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.role !== "string") continue;
      const restore = record.restore && typeof record.restore === "object" ? (record.restore as Record<string, unknown>) : null;
      grants.push({
        projectId: typeof record.projectId === "string" ? record.projectId : null,
        role: record.role,
        customRoleId: typeof record.customRoleId === "string" ? record.customRoleId : null,
        ...(restore && typeof restore.role === "string"
          ? { restore: { role: restore.role, customRoleId: typeof restore.customRoleId === "string" ? restore.customRoleId : null } }
          : record.restore === null
            ? { restore: null }
            : {})
      });
    }
    return grants;
  } catch {
    return [];
  }
}

const TOKEN_COLUMNS = "id, name, token_prefix, token_hash, created_by, created_at, expires_at, revoked_at, last_used_at, superseded_by";

function tokenFromRow(row: Row): ScimTokenWrite {
  return {
    id: str(row.id),
    name: str(row.name),
    tokenPrefix: str(row.token_prefix),
    tokenHash: str(row.token_hash),
    createdBy: strOrNull(row.created_by),
    createdAt: str(row.created_at),
    expiresAt: strOrNull(row.expires_at),
    revokedAt: strOrNull(row.revoked_at),
    lastUsedAt: strOrNull(row.last_used_at),
    supersededBy: strOrNull(row.superseded_by)
  };
}

const USER_VIEW_COLUMNS = `s.user_id, s.user_name, s.external_id, s.display_name, s.given_name, s.family_name, s.origin, s.grants_json,
  s.created_at, s.updated_at, u.email, u.role, u.disabled_at`;
const USER_VIEW_FROM = "scim_users s JOIN users u ON u.id = s.user_id";

function userViewFromRow(row: Row): ScimUserView {
  return {
    userId: str(row.user_id),
    userName: str(row.user_name),
    externalId: strOrNull(row.external_id),
    displayName: strOrNull(row.display_name),
    givenName: strOrNull(row.given_name),
    familyName: strOrNull(row.family_name),
    origin: row.origin === "adopted" ? "adopted" : "created",
    grants: parseScimGrants(row.grants_json),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    email: str(row.email),
    role: str(row.role),
    disabledAt: strOrNull(row.disabled_at)
  };
}

const GROUP_COLUMNS = "id, display_name, external_id, created_at, updated_at";

function groupFromRow(row: Row): ScimGroupRecord {
  return {
    id: str(row.id),
    displayName: str(row.display_name),
    externalId: strOrNull(row.external_id),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at)
  };
}

function userFilterSql(filter: ScimPageRequest<ScimUserFilterField>["filter"]): { where: string; params: unknown[] } {
  if (!filter) return { where: "", params: [] };
  switch (filter.field) {
    case "userName":
      return { where: "WHERE s.user_name_key = ?", params: [scimNameKey(filter.value)] };
    case "externalId":
      return { where: "WHERE s.external_id = ?", params: [filter.value] };
    case "id":
      return { where: "WHERE s.user_id = ?", params: [filter.value] };
    case "email":
      return { where: "WHERE lower(u.email) = ?", params: [filter.value.trim().toLowerCase()] };
  }
}

function groupFilterSql(filter: ScimPageRequest<ScimGroupFilterField>["filter"]): { where: string; params: unknown[] } {
  if (!filter) return { where: "", params: [] };
  switch (filter.field) {
    case "displayName":
      return { where: "WHERE g.display_name_key = ?", params: [scimNameKey(filter.value)] };
    case "externalId":
      return { where: "WHERE g.external_id = ?", params: [filter.value] };
    case "id":
      return { where: "WHERE g.id = ?", params: [filter.value] };
    case "member":
      return { where: "WHERE EXISTS (SELECT 1 FROM scim_group_members m WHERE m.group_id = g.id AND m.user_id = ?)", params: [filter.value] };
  }
}

/** The ScimStore methods both stores share (everything but setUserDisabled). */
export function createScimSqlStore(db: ScimSqlExecutor): Omit<ScimStore, "setUserDisabled"> {
  const getUser = async (where: string, params: unknown[]): Promise<ScimUserView | null> => {
    const rows = await db.all(`SELECT ${USER_VIEW_COLUMNS} FROM ${USER_VIEW_FROM} WHERE ${where}`, params);
    return rows[0] ? userViewFromRow(rows[0]) : null;
  };

  return {
    async listScimTokens() {
      const rows = await db.all(`SELECT ${TOKEN_COLUMNS} FROM scim_tokens ORDER BY created_at DESC, id ASC`);
      return rows.map((row) => {
        const { tokenHash: _hash, ...record } = tokenFromRow(row);
        return record;
      });
    },

    async createScimToken(input) {
      await db.run(
        `INSERT INTO scim_tokens (${TOKEN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.name, input.tokenPrefix, input.tokenHash, input.createdBy, input.createdAt, input.expiresAt, input.revokedAt, input.lastUsedAt, input.supersededBy]
      );
    },

    async findScimTokenByPrefix(prefix) {
      const rows = await db.all(`SELECT ${TOKEN_COLUMNS} FROM scim_tokens WHERE token_prefix = ?`, [prefix]);
      return rows[0] ? tokenFromRow(rows[0]) : null;
    },

    async revokeScimToken(id, now) {
      const revoked = await db.run(`UPDATE scim_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, [now, id]);
      if (revoked === 0) return false;
      // Every predecessor still in its rotation grace window ends with the token that replaced it, down the whole chain
      // (A rotated to B rotated to C: revoking C ends B and A). A chain is short; the bound only guards against a cycle.
      let current = id;
      for (let step = 0; step < 100; step += 1) {
        const rows = await db.all(`SELECT id FROM scim_tokens WHERE superseded_by = ?`, [current]);
        const previous = rows[0] ? str(rows[0].id) : null;
        if (!previous) break;
        await db.run(`UPDATE scim_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`, [now, previous, now]);
        current = previous;
      }
      return true;
    },

    async rotateScimToken(input) {
      const next = input.next;
      const [changed] = await db.batch([
        {
          sql: `UPDATE scim_tokens
                   SET superseded_by = ?,
                       expires_at = CASE WHEN expires_at IS NOT NULL AND expires_at < ? THEN expires_at ELSE ? END
                 WHERE id = ? AND revoked_at IS NULL AND superseded_by IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
          params: [next.id, input.graceUntil, input.graceUntil, input.id, input.now],
          stopUnlessChanged: true
        },
        {
          sql: `INSERT INTO scim_tokens (${TOKEN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
          params: [next.id, next.name, next.tokenPrefix, next.tokenHash, next.createdBy, next.createdAt, next.expiresAt]
        }
      ]);
      return (changed ?? 0) > 0;
    },

    async touchScimToken(id, now) {
      await db.run(`UPDATE scim_tokens SET last_used_at = ? WHERE id = ?`, [now, id]);
    },

    async getScimUser(userId) {
      return await getUser("s.user_id = ?", [userId]);
    },

    async findScimUserByUserName(userName) {
      return await getUser("s.user_name_key = ?", [scimNameKey(userName)]);
    },

    async listScimUsers(request) {
      const { where, params } = userFilterSql(request.filter);
      const count = await db.all(`SELECT COUNT(*) AS n FROM ${USER_VIEW_FROM} ${where}`, params);
      const rows = await db.all(
        `SELECT ${USER_VIEW_COLUMNS} FROM ${USER_VIEW_FROM} ${where} ORDER BY s.created_at ASC, s.user_id ASC LIMIT ? OFFSET ?`,
        [...params, request.limit, request.offset]
      );
      return { items: rows.map(userViewFromRow), total: Number(count[0]?.n ?? 0) };
    },

    async createScimUser(link) {
      const changed = await db.run(
        `INSERT INTO scim_users (user_id, user_name, user_name_key, external_id, display_name, given_name, family_name, origin, grants_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        [
          link.userId,
          link.userName,
          scimNameKey(link.userName),
          link.externalId,
          link.displayName,
          link.givenName,
          link.familyName,
          link.origin,
          JSON.stringify(link.grants),
          link.createdAt,
          link.updatedAt
        ]
      );
      return changed > 0;
    },

    async updateScimUser(link) {
      try {
        const changed = await db.run(
          `UPDATE scim_users SET user_name = ?, user_name_key = ?, external_id = ?, display_name = ?, given_name = ?, family_name = ?,
             updated_at = ?
           WHERE user_id = ?`,
          [link.userName, scimNameKey(link.userName), link.externalId, link.displayName, link.givenName, link.familyName, link.updatedAt, link.userId]
        );
        return changed > 0;
      } catch (error) {
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    },

    async setScimUserGrants(userId, grants, updatedAt) {
      await db.run(`UPDATE scim_users SET grants_json = ?, updated_at = ? WHERE user_id = ?`, [JSON.stringify(grants), updatedAt, userId]);
    },

    async updateScimUserEmail(userId, email, updatedAt) {
      try {
        const changed = await db.run(`UPDATE users SET email = ?, updated_at = ? WHERE id = ? AND (kind IS NULL OR kind <> 'service')`, [email, updatedAt, userId]);
        return changed > 0 ? "updated" : "not_found";
      } catch (error) {
        if (isUniqueViolation(error)) return "taken";
        throw error;
      }
    },

    async deleteScimUser(userId) {
      const counts = await db.batch([
        { sql: `DELETE FROM scim_group_members WHERE user_id = ?`, params: [userId] },
        { sql: `DELETE FROM scim_users WHERE user_id = ?`, params: [userId] }
      ]);
      return (counts[1] ?? 0) > 0;
    },

    async getScimGroup(id) {
      const rows = await db.all(`SELECT ${GROUP_COLUMNS} FROM scim_groups WHERE id = ?`, [id]);
      return rows[0] ? groupFromRow(rows[0]) : null;
    },

    async listScimGroups(request) {
      const { where, params } = groupFilterSql(request.filter);
      const count = await db.all(`SELECT COUNT(*) AS n FROM scim_groups g ${where}`, params);
      const rows = await db.all(
        `SELECT ${GROUP_COLUMNS} FROM scim_groups g ${where} ORDER BY g.created_at ASC, g.id ASC LIMIT ? OFFSET ?`,
        [...params, request.limit, request.offset]
      );
      return { items: rows.map(groupFromRow), total: Number(count[0]?.n ?? 0) };
    },

    async createScimGroup(group) {
      const changed = await db.run(
        `INSERT INTO scim_groups (id, display_name, display_name_key, external_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        [group.id, group.displayName, scimNameKey(group.displayName), group.externalId, group.createdAt, group.updatedAt]
      );
      return changed > 0;
    },

    async updateScimGroup(group) {
      try {
        const changed = await db.run(
          `UPDATE scim_groups SET display_name = ?, display_name_key = ?, external_id = ?, updated_at = ? WHERE id = ?`,
          [group.displayName, scimNameKey(group.displayName), group.externalId, group.updatedAt, group.id]
        );
        return changed > 0;
      } catch (error) {
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    },

    async deleteScimGroup(id) {
      const counts = await db.batch([
        { sql: `DELETE FROM scim_group_members WHERE group_id = ?`, params: [id] },
        { sql: `DELETE FROM scim_groups WHERE id = ?`, params: [id] }
      ]);
      return (counts[1] ?? 0) > 0;
    },

    async listScimGroupMembers(groupId) {
      const rows = await db.all(
        `SELECT m.user_id, s.user_name FROM scim_group_members m JOIN scim_users s ON s.user_id = m.user_id
          WHERE m.group_id = ? ORDER BY m.created_at ASC, m.user_id ASC`,
        [groupId]
      );
      return rows.map((row) => ({ userId: str(row.user_id), userName: str(row.user_name) }));
    },

    async countScimGroupMembers(groupIds) {
      const counts = new Map<string, number>();
      if (groupIds.length === 0) return counts;
      const marks = groupIds.map(() => "?").join(", ");
      const rows = await db.all(
        `SELECT group_id, COUNT(*) AS n FROM scim_group_members WHERE group_id IN (${marks}) GROUP BY group_id`,
        [...groupIds]
      );
      for (const row of rows) counts.set(str(row.group_id), Number(row.n ?? 0));
      return counts;
    },

    async listScimGroupsOfUser(userId) {
      const rows = await db.all(
        `SELECT g.id, g.display_name, g.external_id, g.created_at, g.updated_at
           FROM scim_groups g JOIN scim_group_members m ON m.group_id = g.id
          WHERE m.user_id = ? ORDER BY g.display_name_key ASC, g.id ASC`,
        [userId]
      );
      return rows.map(groupFromRow);
    },

    async addScimGroupMembers(groupId, userIds, now) {
      const requested = [...new Set(userIds)];
      if (requested.length === 0) return [];
      // Only provisioned users join, and only an existing group takes members.
      const group = await db.all(`SELECT id FROM scim_groups WHERE id = ?`, [groupId]);
      if (group.length === 0) return [];
      const known = new Set<string>();
      for (let start = 0; start < requested.length; start += 200) {
        const chunk = requested.slice(start, start + 200);
        const rows = await db.all(`SELECT user_id FROM scim_users WHERE user_id IN (${chunk.map(() => "?").join(", ")})`, chunk);
        for (const row of rows) known.add(str(row.user_id));
      }
      const ids = requested.filter((id) => known.has(id));
      if (ids.length === 0) return [];
      const counts = await db.batch(
        ids.map((userId) => ({
          sql: `INSERT INTO scim_group_members (group_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
          params: [groupId, userId, now]
        }))
      );
      return ids.filter((_id, index) => (counts[index] ?? 0) > 0);
    },

    async removeScimGroupMembers(groupId, userIds) {
      const ids = [...new Set(userIds)];
      if (ids.length === 0) return 0;
      const counts = await db.batch(ids.map((userId) => ({ sql: `DELETE FROM scim_group_members WHERE group_id = ? AND user_id = ?`, params: [groupId, userId] })));
      return counts.reduce((sum, count) => sum + count, 0);
    },

    async removeAllScimGroupMembers(groupId) {
      const rows = await db.all(`SELECT user_id FROM scim_group_members WHERE group_id = ?`, [groupId]);
      const ids = rows.map((row) => str(row.user_id));
      if (ids.length > 0) {
        await db.batch(ids.map((userId) => ({ sql: `DELETE FROM scim_group_members WHERE group_id = ? AND user_id = ?`, params: [groupId, userId] })));
      }
      return ids;
    }
  };
}

/** The SCIM tables as SQLite creates them (Postgres: migration v75). */
export const SQLITE_SCIM_SCHEMA = `
  CREATE TABLE IF NOT EXISTS scim_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_prefix TEXT NOT NULL UNIQUE,
    token_hash TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    last_used_at TEXT,
    superseded_by TEXT
  );
  CREATE TABLE IF NOT EXISTS scim_users (
    user_id TEXT PRIMARY KEY,
    user_name TEXT NOT NULL,
    user_name_key TEXT NOT NULL UNIQUE,
    external_id TEXT,
    display_name TEXT,
    given_name TEXT,
    family_name TEXT,
    origin TEXT NOT NULL DEFAULT 'created',
    grants_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scim_users_external_id ON scim_users(external_id);
  CREATE TABLE IF NOT EXISTS scim_groups (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    display_name_key TEXT NOT NULL UNIQUE,
    external_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scim_groups_external_id ON scim_groups(external_id);
  CREATE TABLE IF NOT EXISTS scim_group_members (
    group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_scim_group_members_user ON scim_group_members(user_id);
`;
