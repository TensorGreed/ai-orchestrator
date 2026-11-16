/**
 * 13.2 — SCIM provisioning: creates, updates, deactivates and deprovisions users, keeps groups and their members, and
 * turns group membership into roles through the admin's mappings (sso_group_mappings with provider `scim`).
 *
 * Users
 *   - A new SCIM user is linked to the L2M account with its email (primary email, else first email, else a userName
 *     that is an address). An account that exists already is adopted (`origin: adopted`) when SCIM_LINK_EXISTING_USERS
 *     allows it (default: anyone but admins; else 409 uniqueness), else one is created with the viewer role and an
 *     unusable random password: people sign in through SSO. Service accounts are never touched.
 *   - Only an account SCIM created follows later email changes; an adopted account keeps its L2M email (an identity
 *     provider cannot move an existing account, an admin's for instance, onto another address).
 *   - `active: false` disables the account: it cannot sign in (break-glass excepted), its sessions end and its API
 *     keys are revoked at once. `active: true` enables it again (revoked keys stay revoked).
 *   - DELETE deprovisions: the account is disabled the same way, the roles its groups granted are taken back, and the
 *     SCIM link and memberships go. The account and its history stay (a data-subject deletion removes it).
 *   - The only enabled admin who is a person is never disabled (400 `mutability`); break-glass recovers a deployment
 *     whose admins were all disabled otherwise.
 *
 * Groups
 *   - Members are provisioned users. A group grants nothing unless a mapping names it (by display name, SCIM id or
 *     externalId). A global mapping sets the user's role (the highest mapped role wins); a project mapping sets the
 *     user's role in that project.
 *   - SCIM only raises a role it did not set (a mapping never lowers a role an admin gave), and records what it set
 *     and the role it replaced. When the user leaves the group (or the mapping goes) that earlier role comes back, but
 *     only while the role is still the one SCIM set: once an admin changes it by hand, SCIM leaves it alone for as
 *     long as the mapping applies, and lets go of it when the mapping stops applying. The last enabled admin is never
 *     demoted.
 *   - Every change to one user (attributes, active, roles) runs one at a time on this instance.
 */
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import type { Store } from "../db/store.js";
import { scimNameKey, type ScimGrant, type ScimGroupRecord, type ScimUserLink, type ScimUserView } from "../db/scim-store.js";
import { hashPassword, isServiceAccountEmail, type UserRole } from "./auth-service.js";
import { isProjectRole, type ProjectRole } from "./rbac-service.js";
import { roleRank } from "./key-scopes.js";
import { SerialByKey } from "./serial-by-key.js";
import {
  applyGroupPatch,
  applyUserPatch,
  draftEmail,
  ScimError,
  type ScimGroupDraft,
  type ScimGroupFilter,
  type ScimPatchOperation,
  type ScimUserDraft,
  type ScimUserFilter
} from "./scim-protocol.js";

/** Who made a change: the SCIM token, for the audit log. */
export interface ScimActor {
  tokenId: string;
  tokenName: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface ScimAuditEvent {
  eventType: string;
  action: string;
  outcome?: "success" | "failure";
  resourceType: "user" | "scim_group";
  resourceId: string;
  metadata: Record<string, unknown>;
}

export interface ScimProvisioningDeps {
  store: Store;
  /** SCIM_LINK_EXISTING_USERS: which existing accounts a new SCIM user with their email links to (default non_admin). */
  linkExisting?: "none" | "non_admin" | "all";
  /** rbacService.addMember: checks a custom role exists. */
  addProjectMember: (input: { userId: string; projectId: string; role: ProjectRole | "custom"; customRoleId: string | null }) => Promise<void>;
  audit: (actor: ScimActor, event: ScimAuditEvent) => Promise<void>;
  log?: { warn: (fields: Record<string, unknown>, message: string) => void };
  now?: () => number;
}

export interface ScimGroupView extends ScimGroupRecord {
  members: Array<{ userId: string; userName: string }>;
}

type Mapping = Awaited<ReturnType<Store["listSsoGroupMappings"]>>[number];

const USER_ROLES: readonly UserRole[] = ["admin", "builder", "operator", "viewer"];
const isUserRole = (value: string): value is UserRole => (USER_ROLES as readonly string[]).includes(value);
const PROJECT_ROLE_RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, project_admin: 3 };

/** The mappings that name a group: by display name, SCIM id or externalId (exact). */
export function mappingsForGroups(groups: readonly ScimGroupRecord[], mappings: readonly Mapping[]): Mapping[] {
  const names = new Set<string>();
  for (const group of groups) {
    names.add(group.displayName);
    names.add(group.id);
    if (group.externalId) names.add(group.externalId);
  }
  return mappings.filter((mapping) => names.has(mapping.groupName));
}

/**
 * The roles a user's groups grant: the highest mapped global role, and per project the highest built-in project role
 * (a custom role only when no built-in role is mapped there; the first by mapping id then).
 */
export function desiredScimGrants(groups: readonly ScimGroupRecord[], mappings: readonly Mapping[]): ScimGrant[] {
  let global: UserRole | null = null;
  const projects = new Map<string, ScimGrant>();
  const matched = [...mappingsForGroups(groups, mappings)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const mapping of matched) {
    if (!mapping.projectId) {
      if (isUserRole(mapping.role) && (!global || roleRank(mapping.role) > roleRank(global))) global = mapping.role;
      continue;
    }
    const current = projects.get(mapping.projectId);
    if (isProjectRole(mapping.role)) {
      const rank = PROJECT_ROLE_RANK[mapping.role];
      const currentRank = current && isProjectRole(current.role) ? PROJECT_ROLE_RANK[current.role] : 0;
      if (rank > currentRank) projects.set(mapping.projectId, { projectId: mapping.projectId, role: mapping.role, customRoleId: null });
    } else if (mapping.customRoleId && !current) {
      projects.set(mapping.projectId, { projectId: mapping.projectId, role: "custom", customRoleId: mapping.customRoleId });
    }
  }
  return [...(global ? [{ projectId: null, role: global, customRoleId: null }] : []), ...projects.values()];
}

const sameGrant = (a: { role: string; customRoleId: string | null }, b: { role: string; customRoleId: string | null }) =>
  a.role === b.role && (a.customRoleId ?? null) === (b.customRoleId ?? null);

export class ScimProvisioningService {
  private readonly store: Store;
  private readonly serial = new SerialByKey();
  private readonly now: () => number;

  constructor(private readonly deps: ScimProvisioningDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  async getUser(id: string): Promise<ScimUserView> {
    const user = await this.store.getScimUser(id);
    if (!user) throw new ScimError(404, `User ${id} not found`);
    return user;
  }

  async listUsers(filter: ScimUserFilter | null, offset: number, limit: number) {
    return await this.store.listScimUsers({ filter, offset, limit });
  }

  async groupsOfUser(userId: string): Promise<ScimGroupRecord[]> {
    return await this.store.listScimGroupsOfUser(userId);
  }

  /** The draft a stored user reads as (for PATCH). */
  draftOf(user: ScimUserView): ScimUserDraft {
    return {
      userName: user.userName,
      externalId: user.externalId,
      displayName: user.displayName,
      givenName: user.givenName,
      familyName: user.familyName,
      emails: [{ value: user.email, type: "work", primary: true }],
      active: !user.disabledAt
    };
  }

  async createUser(actor: ScimActor, draft: ScimUserDraft): Promise<ScimUserView> {
    if (await this.store.findScimUserByUserName(draft.userName)) {
      throw new ScimError(409, `A user with userName '${draft.userName}' already exists`, "uniqueness");
    }
    const email = this.emailFor(draft);
    return await this.serial.run(`email:${email}`, async () => {
      const existing = await this.store.getUserByEmail(email);
      if (existing && existing.kind !== "human") throw new ScimError(409, "This email belongs to a service account", "uniqueness");
      if (existing && (await this.store.getScimUser(existing.id))) {
        throw new ScimError(409, `The account for ${email} is already provisioned under another userName`, "uniqueness");
      }
      if (existing) {
        const policy = this.deps.linkExisting ?? "non_admin";
        if (policy === "none" || (policy === "non_admin" && existing.role === "admin")) {
          throw new ScimError(409, `An account for ${email} exists already and is not linked to SCIM (SCIM_LINK_EXISTING_USERS)`, "uniqueness");
        }
      }
      const now = this.iso();
      let userId: string;
      let origin: ScimUserLink["origin"];
      if (existing) {
        userId = existing.id;
        origin = "adopted";
      } else {
        userId = `usr_${nanoid(12)}`;
        origin = "created";
        // People provisioned here sign in through SSO; the random password is never shown.
        await this.store.saveUser({ id: userId, email, passwordHash: hashPassword(crypto.randomBytes(24).toString("base64url")), role: "viewer" });
      }
      const linked = await this.store.createScimUser({
        userId,
        userName: draft.userName,
        externalId: draft.externalId,
        displayName: draft.displayName,
        givenName: draft.givenName,
        familyName: draft.familyName,
        origin,
        grants: [],
        createdAt: now,
        updatedAt: now
      });
      if (!linked) {
        if (origin === "created") await this.store.deleteUser(userId);
        throw new ScimError(409, `A user with userName '${draft.userName}' already exists`, "uniqueness");
      }
      // Active only once the link exists, so a refused or lost insert changes nothing about the account.
      const wasActive = !existing?.disabledAt;
      if (draft.active !== wasActive) {
        try {
          await this.serial.run(`user:${userId}`, async () => await this.setActive(actor, userId, draft.active, { refuseLastAdmin: true }));
        } catch (error) {
          // The only enabled admin cannot be disabled: the link is undone, so the request changes nothing.
          await this.store.deleteScimUser(userId);
          if (origin === "created") await this.store.deleteUser(userId);
          throw error;
        }
      }
      await this.deps.audit(actor, {
        eventType: "scim.user.create",
        action: "create",
        resourceType: "user",
        resourceId: userId,
        metadata: { userName: draft.userName, email, origin, active: draft.active, ...(draft.externalId ? { externalId: draft.externalId } : {}) }
      });
      return await this.getUser(userId);
    });
  }

  /** PUT: the draft replaces what is stored. */
  async replaceUser(actor: ScimActor, id: string, draft: ScimUserDraft): Promise<ScimUserView> {
    return await this.serial.run(`user:${id}`, async () => await this.applyUserDraft(actor, await this.getUser(id), draft));
  }

  async patchUser(actor: ScimActor, id: string, operations: readonly ScimPatchOperation[]): Promise<ScimUserView> {
    return await this.serial.run(`user:${id}`, async () => {
      const current = await this.getUser(id);
      return await this.applyUserDraft(actor, current, applyUserPatch(this.draftOf(current), operations));
    });
  }

  async deleteUser(actor: ScimActor, id: string): Promise<void> {
    await this.serial.run(`user:${id}`, async () => {
      const current = await this.getUser(id);
      const outcome = await this.setActive(actor, id, false, { refuseLastAdmin: true, audit: false });
      const groups = await this.store.listScimGroupsOfUser(id);
      const taken = await this.syncGrantsNow(actor, id, []);
      await this.store.deleteScimUser(id);
      await this.deps.audit(actor, {
        eventType: "scim.user.deprovision",
        action: "delete",
        resourceType: "user",
        resourceId: id,
        metadata: {
          userName: current.userName,
          email: current.email,
          sessionsEnded: outcome.sessionsEnded,
          keysRevoked: outcome.keysRevoked,
          groupsLeft: groups.map((group) => group.displayName),
          rolesTakenBack: taken.removed
        }
      });
    });
  }

  private emailFor(draft: ScimUserDraft): string {
    const email = draftEmail(draft);
    if (!email) throw new ScimError(400, "The user needs an email address: an email, or a userName that is one", "invalidValue");
    if (isServiceAccountEmail(email)) throw new ScimError(400, "This email domain is reserved for service accounts", "invalidValue");
    return email;
  }

  private async applyUserDraft(actor: ScimActor, current: ScimUserView, draft: ScimUserDraft): Promise<ScimUserView> {
    const changed: string[] = [];
    // Checks first, so a request refused with 400 or 409 changes nothing.
    let newEmail: string | null = null;
    if (current.origin === "created") {
      const email = this.emailFor(draft);
      if (email !== current.email.toLowerCase()) {
        const holder = await this.store.getUserByEmail(email);
        if (holder && holder.id !== current.userId) throw new ScimError(409, `Another account already uses ${email}`, "uniqueness");
        newEmail = email;
      }
    }
    if (scimNameKey(draft.userName) !== scimNameKey(current.userName)) {
      const holder = await this.store.findScimUserByUserName(draft.userName);
      if (holder && holder.userId !== current.userId) throw new ScimError(409, `A user with userName '${draft.userName}' already exists`, "uniqueness");
    }
    // Then active: when the only enabled admin would be disabled, nothing else changes either.
    const wasActive = !current.disabledAt;
    if (draft.active !== wasActive) await this.setActive(actor, current.userId, draft.active, { refuseLastAdmin: true });

    if (newEmail) {
      // Only the email changes (never the role or password read earlier); a race for the address answers 409.
      const outcome = await this.store.updateScimUserEmail(current.userId, newEmail, this.iso());
      if (outcome === "taken") throw new ScimError(409, `Another account already uses ${newEmail}`, "uniqueness");
      if (outcome === "not_found") throw new ScimError(404, `User ${current.userId} not found`);
      changed.push("email");
    }

    const fields: Array<keyof ScimUserDraft & keyof ScimUserLink> = ["userName", "externalId", "displayName", "givenName", "familyName"];
    for (const field of fields) if (draft[field] !== current[field]) changed.push(field);
    if (changed.some((field) => field !== "email")) {
      const updated = await this.store.updateScimUser({
        ...current,
        userName: draft.userName,
        externalId: draft.externalId,
        displayName: draft.displayName,
        givenName: draft.givenName,
        familyName: draft.familyName,
        updatedAt: this.iso()
      });
      if (!updated) throw new ScimError(409, `A user with userName '${draft.userName}' already exists`, "uniqueness");
    }
    if (changed.length > 0) {
      await this.deps.audit(actor, {
        eventType: "scim.user.update",
        action: "update",
        resourceType: "user",
        resourceId: current.userId,
        metadata: { userName: draft.userName, changed }
      });
    }
    return await this.getUser(current.userId);
  }

  /** Disables or enables the account; audited as scim.user.deactivate / scim.user.reactivate. */
  private async setActive(
    actor: ScimActor,
    userId: string,
    active: boolean,
    options: { refuseLastAdmin?: boolean; audit?: boolean }
  ): Promise<{ sessionsEnded: number; keysRevoked: number }> {
    const outcome = await this.store.setUserDisabled(userId, { disabled: !active, now: this.iso() });
    if (outcome.status === "not_found") throw new ScimError(404, `User ${userId} not found`);
    if (outcome.status === "service_account") throw new ScimError(400, "Service accounts are not provisioned through SCIM", "mutability");
    if (outcome.status === "last_admin") {
      await this.deps.audit(actor, {
        eventType: "scim.user.deactivate",
        action: "update",
        outcome: "failure",
        resourceType: "user",
        resourceId: userId,
        metadata: { reason: "last_admin" }
      });
      throw new ScimError(
        400,
        "This is the only enabled admin who can sign in; make another admin first, or use a break-glass sign-in",
        "mutability"
      );
    }
    if (options.audit !== false) {
      await this.deps.audit(actor, {
        eventType: active ? "scim.user.reactivate" : "scim.user.deactivate",
        action: "update",
        resourceType: "user",
        resourceId: userId,
        metadata: active ? {} : { sessionsEnded: outcome.sessionsEnded, keysRevoked: outcome.keysRevoked }
      });
    }
    return { sessionsEnded: outcome.sessionsEnded, keysRevoked: outcome.keysRevoked };
  }

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------

  async getGroup(id: string): Promise<ScimGroupView> {
    const group = await this.store.getScimGroup(id);
    if (!group) throw new ScimError(404, `Group ${id} not found`);
    return { ...group, members: await this.store.listScimGroupMembers(id) };
  }

  async listGroups(filter: ScimGroupFilter | null, offset: number, limit: number) {
    return await this.store.listScimGroups({ filter, offset, limit });
  }

  async membersOf(groupId: string) {
    return await this.store.listScimGroupMembers(groupId);
  }

  async createGroup(actor: ScimActor, draft: ScimGroupDraft): Promise<ScimGroupView> {
    const now = this.iso();
    const group: ScimGroupRecord = { id: `scg_${nanoid(16)}`, displayName: draft.displayName, externalId: draft.externalId, createdAt: now, updatedAt: now };
    if (!(await this.store.createScimGroup(group))) {
      throw new ScimError(409, `A group named '${draft.displayName}' already exists`, "uniqueness");
    }
    const added = await this.setMembers(group.id, [], draft.members);
    await this.deps.audit(actor, {
      eventType: "scim.group.create",
      action: "create",
      resourceType: "scim_group",
      resourceId: group.id,
      metadata: { displayName: group.displayName, members: added.added.length, ...(draft.externalId ? { externalId: draft.externalId } : {}) }
    });
    await this.syncUsers(actor, added.added);
    return await this.getGroup(group.id);
  }

  async replaceGroup(actor: ScimActor, id: string, draft: ScimGroupDraft): Promise<ScimGroupView> {
    return await this.serial.run(`group:${id}`, async () => await this.applyGroupDraft(actor, await this.getGroup(id), draft));
  }

  async patchGroup(actor: ScimActor, id: string, operations: readonly ScimPatchOperation[]): Promise<ScimGroupView> {
    return await this.serial.run(`group:${id}`, async () => {
      const current = await this.getGroup(id);
      const draft = applyGroupPatch(
        { displayName: current.displayName, externalId: current.externalId, members: current.members.map((member) => member.userId) },
        operations
      );
      return await this.applyGroupDraft(actor, current, draft);
    });
  }

  async deleteGroup(actor: ScimActor, id: string): Promise<void> {
    await this.serial.run(`group:${id}`, async () => {
      const current = await this.getGroup(id);
      await this.store.deleteScimGroup(id);
      await this.deps.audit(actor, {
        eventType: "scim.group.delete",
        action: "delete",
        resourceType: "scim_group",
        resourceId: id,
        metadata: { displayName: current.displayName, members: current.members.length }
      });
      await this.syncUsers(actor, current.members.map((member) => member.userId));
    });
  }

  private async applyGroupDraft(actor: ScimActor, current: ScimGroupView, draft: ScimGroupDraft): Promise<ScimGroupView> {
    const renamed = draft.displayName !== current.displayName || draft.externalId !== current.externalId;
    if (renamed) {
      const updated = await this.store.updateScimGroup({ ...current, displayName: draft.displayName, externalId: draft.externalId, updatedAt: this.iso() });
      if (!updated) throw new ScimError(409, `A group named '${draft.displayName}' already exists`, "uniqueness");
    }
    const members = await this.setMembers(current.id, current.members.map((member) => member.userId), draft.members);
    if (renamed || members.added.length > 0 || members.removed.length > 0) {
      await this.deps.audit(actor, {
        eventType: "scim.group.update",
        action: "update",
        resourceType: "scim_group",
        resourceId: current.id,
        metadata: {
          displayName: draft.displayName,
          ...(renamed ? { previousDisplayName: current.displayName } : {}),
          membersAdded: members.added,
          membersRemoved: members.removed,
          ...(members.unknown.length > 0 ? { unknownMembers: members.unknown.length } : {})
        }
      });
    }
    // A rename can change which mappings name the group, so every member is checked then.
    const affected = renamed ? [...new Set([...draft.members, ...members.removed])] : [...members.added, ...members.removed];
    await this.syncUsers(actor, affected);
    return await this.getGroup(current.id);
  }

  /** Moves the group's members from `before` to `after`; ids that are not provisioned users are not added. */
  private async setMembers(groupId: string, before: readonly string[], after: readonly string[]): Promise<{ added: string[]; removed: string[]; unknown: string[] }> {
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const toAdd = [...afterSet].filter((id) => !beforeSet.has(id));
    const toRemove = [...beforeSet].filter((id) => !afterSet.has(id));
    const added = toAdd.length > 0 ? await this.store.addScimGroupMembers(groupId, toAdd, this.iso()) : [];
    if (toRemove.length > 0) await this.store.removeScimGroupMembers(groupId, toRemove);
    return { added, removed: toRemove, unknown: toAdd.filter((id) => !added.includes(id)) };
  }

  // -------------------------------------------------------------------------
  // Roles from groups
  // -------------------------------------------------------------------------

  /** Re-applies every provisioned user's grants (after a SCIM mapping is created or deleted). */
  async resyncAll(actor: ScimActor): Promise<number> {
    let offset = 0;
    let count = 0;
    for (;;) {
      const page = await this.store.listScimUsers({ offset, limit: 200 });
      await this.syncUsers(actor, page.items.map((user) => user.userId));
      count += page.items.length;
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) return count;
    }
  }

  private async syncUsers(actor: ScimActor, userIds: readonly string[]): Promise<void> {
    for (const userId of new Set(userIds)) {
      try {
        await this.syncGrants(actor, userId);
      } catch (error) {
        // One user's grants failing (a mapping to a deleted custom role, say) never fails the group change.
        this.deps.log?.warn({ userId, reason: error instanceof Error ? error.message : String(error) }, "SCIM role sync failed for a user");
      }
    }
  }

  /** Applies the roles the user's groups grant now, and takes back what SCIM granted that they no longer do. */
  async syncGrants(actor: ScimActor, userId: string): Promise<void> {
    // The same key as every other change to this user, so a grant write never interleaves with an update.
    await this.serial.run(`user:${userId}`, async () => {
      if (!(await this.store.getScimUser(userId))) return;
      await this.syncGrantsNow(actor, userId, null);
    });
  }

  /** True when a project grant is no higher than the role SCIM found (a built-in role ranked at or below it). */
  private atOrBelow(want: { role: string; customRoleId: string | null }, restore: { role: string; customRoleId: string | null } | null): boolean {
    if (!restore) return false;
    if (sameGrant(want, restore)) return true;
    return isProjectRole(want.role) && isProjectRole(restore.role) && PROJECT_ROLE_RANK[want.role] <= PROJECT_ROLE_RANK[restore.role];
  }

  private async setProjectRole(userId: string, projectId: string, grant: { role: string; customRoleId: string | null }): Promise<void> {
    await this.deps.addProjectMember({
      userId,
      projectId,
      role: isProjectRole(grant.role) ? grant.role : "custom",
      customRoleId: isProjectRole(grant.role) ? null : grant.customRoleId
    });
  }

  private async syncGrantsNow(actor: ScimActor, userId: string, groupsOverride: ScimGroupRecord[] | null): Promise<{ added: ScimGrant[]; removed: ScimGrant[] }> {
    const link = await this.store.getScimUser(userId);
    const stored = await this.store.getUserById(userId);
    if (!link || !stored) return { added: [], removed: [] };
    const groups = groupsOverride ?? (await this.store.listScimGroupsOfUser(userId));
    const desired = desiredScimGrants(groups, await this.store.listSsoGroupMappings("scim"));
    const previous = link.grants;
    const kept: ScimGrant[] = [];
    const added: ScimGrant[] = [];
    const removed: ScimGrant[] = [];

    // Global role.
    const wantGlobal = desired.find((grant) => grant.projectId === null) ?? null;
    const hadGlobal = previous.find((grant) => grant.projectId === null) ?? null;
    if (hadGlobal && stored.role !== hadGlobal.role) {
      // An admin changed the role SCIM set: SCIM leaves it while the mapping applies (so it is not raised again) and
      // lets go when it stops applying.
      if (wantGlobal) kept.push(hadGlobal);
    } else if (hadGlobal) {
      if (wantGlobal && wantGlobal.role === hadGlobal.role) {
        kept.push(hadGlobal);
      } else {
        // Never below the role SCIM found: a lower mapping still applying gives the earlier role back, not less.
        const restoreRole = hadGlobal.restore?.role ?? "viewer";
        const raises = wantGlobal !== null && roleRank(wantGlobal.role as UserRole) > roleRank(restoreRole as UserRole);
        const target = raises ? wantGlobal!.role : restoreRole;
        const outcome = target === stored.role || !isUserRole(target) ? "same" : await this.store.updateUserRoleKeepingAdmin(userId, target);
        if (outcome === "last_admin") {
          kept.push(hadGlobal);
        } else if (raises) {
          const grant = { ...wantGlobal!, restore: hadGlobal.restore ?? null };
          kept.push(grant);
          added.push(grant);
        } else {
          removed.push(hadGlobal);
        }
      }
    } else if (wantGlobal && roleRank(wantGlobal.role as UserRole) > roleRank(stored.role as UserRole)) {
      // Raised only: a mapping never lowers a role SCIM did not set (an adopted admin in an "everyone" group, say).
      const outcome = await this.store.updateUserRoleKeepingAdmin(userId, wantGlobal.role as UserRole);
      if (outcome === "updated") {
        const grant = { ...wantGlobal, restore: { role: stored.role, customRoleId: null } };
        kept.push(grant);
        added.push(grant);
      }
    }

    // Project roles.
    const projectIds = new Set<string>();
    for (const grant of [...desired, ...previous]) if (grant.projectId !== null) projectIds.add(grant.projectId);
    for (const projectId of projectIds) {
      const want = desired.find((grant) => grant.projectId === projectId) ?? null;
      const had = previous.find((grant) => grant.projectId === projectId) ?? null;
      const current = await this.store.getProjectRole(userId, projectId);
      try {
        if (had && !(current && sameGrant(current, had))) {
          if (want) kept.push(had);
        } else if (had) {
          if (want && sameGrant(want, had)) {
            kept.push(had);
          } else if (want && !this.atOrBelow(want, had.restore ?? null)) {
            if (!(await this.store.getProject(projectId))) continue;
            await this.setProjectRole(userId, projectId, want);
            const grant = { ...want, restore: had.restore ?? null };
            kept.push(grant);
            added.push(grant);
          } else {
            // The groups no longer grant more than the role SCIM found: that role comes back (or no membership).
            if (had.restore) await this.setProjectRole(userId, projectId, had.restore);
            else await this.store.removeProjectRole(userId, projectId);
            removed.push(had);
          }
        } else if (want) {
          if (!(await this.store.getProject(projectId))) continue;
          const raises =
            !current ||
            (isProjectRole(current.role) && isProjectRole(want.role) && PROJECT_ROLE_RANK[want.role] > PROJECT_ROLE_RANK[current.role]);
          if (!raises) continue;
          await this.setProjectRole(userId, projectId, want);
          const grant = { ...want, restore: current ? { role: current.role, customRoleId: current.customRoleId ?? null } : null };
          kept.push(grant);
          added.push(grant);
        }
      } catch (error) {
        if (had && want) kept.push(had);
        this.deps.log?.warn({ userId, projectId, reason: error instanceof Error ? error.message : String(error) }, "SCIM project role not applied");
      }
    }

    const changed = JSON.stringify(previous) !== JSON.stringify(kept);
    if (changed) await this.store.setScimUserGrants(userId, kept, this.iso());
    if (added.length > 0 || removed.length > 0) {
      await this.deps.audit(actor, {
        eventType: "scim.user.roles_synced",
        action: "update",
        resourceType: "user",
        resourceId: userId,
        metadata: { added, removed, groups: groups.map((group) => group.displayName) }
      });
    }
    return { added, removed };
  }
}
