/**
 * 13.2 — SCIM 2.0 (RFC 7643 / RFC 7644) wire shapes: schema URNs, the error type, the filter subset the server
 * supports, and PATCH applied to a plain draft of a user or a group. Pure functions; the provisioning service applies
 * the drafts.
 *
 * Supported filters: `<attribute> eq "<value>"` for Users (`userName`, `externalId`, `id`, `emails.value`,
 * `emails[value eq "…"]`) and Groups (`displayName`, `externalId`, `id`, `members.value`). Anything else answers 400
 * `invalidFilter`.
 *
 * PATCH accepts the forms identity providers commonly send: `op` in any letter case; an operation without `path`
 * whose value is an object (keys may be dotted, as `name.givenName`, or carry the core schema URN); `active` as a
 * boolean or the strings "true" / "false"; value filters on multi-valued attributes (`emails[type eq "work"].value`,
 * `members[value eq "<id>"]`); member removal by path filter or by a value list. Attributes this server does not keep
 * (phone numbers, addresses, the enterprise extension, …) are accepted and ignored.
 */

export const SCIM_SCHEMA_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_SCHEMA_GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCIM_SCHEMA_ENTERPRISE_USER = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
export const SCIM_SCHEMA_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_SCHEMA_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCIM_SCHEMA_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
export const SCIM_SCHEMA_SERVICE_PROVIDER_CONFIG = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
export const SCIM_SCHEMA_RESOURCE_TYPE = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
export const SCIM_SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema";

export const SCIM_CONTENT_TYPE = "application/scim+json";

/** Page size when the client asks for none, and the most one page returns. */
export const SCIM_DEFAULT_PAGE_SIZE = 100;
export const SCIM_MAX_PAGE_SIZE = 200;
/** Most operations one PATCH request may carry, and most members one request may name. */
export const SCIM_MAX_PATCH_OPERATIONS = 100;
export const SCIM_MAX_MEMBERS_PER_REQUEST = 10_000;
/** The most members one group keeps (checked as each PATCH operation is applied). */
export const SCIM_MAX_GROUP_MEMBERS = 50_000;
/** The highest startIndex read; past it a list is empty anyway, and the database is never handed a huge offset. */
export const SCIM_MAX_START_INDEX = 1_000_000_000;

export type ScimErrorType =
  | "invalidFilter"
  | "tooMany"
  | "uniqueness"
  | "mutability"
  | "invalidSyntax"
  | "invalidPath"
  | "noTarget"
  | "invalidValue"
  | "invalidVers"
  | "sensitive";

/** An error answered in the SCIM error format (RFC 7644 §3.12). */
export class ScimError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly scimType?: ScimErrorType
  ) {
    super(detail);
    this.name = "ScimError";
  }
}

export function scimErrorBody(status: number, detail: string, scimType?: ScimErrorType): Record<string, unknown> {
  return { schemas: [SCIM_SCHEMA_ERROR], status: String(status), ...(scimType ? { scimType } : {}), detail };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type ScimUserFilter = { field: "userName" | "externalId" | "id" | "email"; value: string };
export type ScimGroupFilter = { field: "displayName" | "externalId" | "id" | "member"; value: string };

const FILTER_PATTERN = /^\s*([A-Za-z][A-Za-z0-9._:-]*)\s+eq\s+("(?:[^"\\]|\\.)*")\s*$/i;

function filterString(quoted: string): string {
  try {
    const value: unknown = JSON.parse(quoted);
    if (typeof value === "string") return value;
  } catch {
    // falls through
  }
  throw new ScimError(400, "The filter value is not a valid string", "invalidFilter");
}

function stripCoreUrn(attribute: string, urn: string): string {
  const prefix = `${urn.toLowerCase()}:`;
  return attribute.toLowerCase().startsWith(prefix) ? attribute.slice(prefix.length) : attribute;
}

/** The supported filter form, `attr eq "value"` (the attribute may carry the core schema URN). Null for an empty filter. */
function parseEqFilter(filter: string | undefined, urn: string): { attribute: string; value: string } | null {
  if (filter === undefined || filter.trim() === "") return null;
  if (filter.length > 1000) throw new ScimError(400, "The filter is too long", "invalidFilter");
  const match = FILTER_PATTERN.exec(filter);
  if (!match) throw new ScimError(400, 'Only filters of the form <attribute> eq "<value>" are supported', "invalidFilter");
  return { attribute: stripCoreUrn(match[1]!, urn).toLowerCase(), value: filterString(match[2]!) };
}

export function parseScimUserFilter(filter: string | undefined): ScimUserFilter | null {
  if (filter !== undefined) {
    // `emails[value eq "x"]` (a value filter with no comparison after it) reads as emails.value eq "x".
    const bracketOnly = /^\s*emails\s*\[\s*value\s+eq\s+("(?:[^"\\]|\\.)*")\s*\]\s*$/i.exec(filter);
    if (bracketOnly) return { field: "email", value: filterString(bracketOnly[1]!) };
  }
  const parsed = parseEqFilter(filter, SCIM_SCHEMA_USER);
  if (!parsed) return null;
  switch (parsed.attribute) {
    case "username":
      return { field: "userName", value: parsed.value };
    case "externalid":
      return { field: "externalId", value: parsed.value };
    case "id":
      return { field: "id", value: parsed.value };
    case "emails.value":
    case "emails":
      return { field: "email", value: parsed.value };
    default:
      throw new ScimError(400, `Filtering Users by '${parsed.attribute}' is not supported`, "invalidFilter");
  }
}

export function parseScimGroupFilter(filter: string | undefined): ScimGroupFilter | null {
  const parsed = parseEqFilter(filter, SCIM_SCHEMA_GROUP);
  if (!parsed) return null;
  switch (parsed.attribute) {
    case "displayname":
      return { field: "displayName", value: parsed.value };
    case "externalid":
      return { field: "externalId", value: parsed.value };
    case "id":
      return { field: "id", value: parsed.value };
    case "members.value":
    case "members":
      return { field: "member", value: parsed.value };
    default:
      throw new ScimError(400, `Filtering Groups by '${parsed.attribute}' is not supported`, "invalidFilter");
  }
}

/** startIndex (1-based, default 1) and count (default SCIM_DEFAULT_PAGE_SIZE, capped at SCIM_MAX_PAGE_SIZE) as offset and limit. */
export function parseScimPage(query: { startIndex?: unknown; count?: unknown }): { startIndex: number; offset: number; limit: number } {
  const int = (value: unknown): number | null => {
    if (value === undefined || value === null || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : NaN;
  };
  const start = int(query.startIndex);
  const count = int(query.count);
  if (Number.isNaN(start) || Number.isNaN(count)) throw new ScimError(400, "startIndex and count must be integers", "invalidValue");
  if (start !== null && start > SCIM_MAX_START_INDEX) throw new ScimError(400, `startIndex must be at most ${SCIM_MAX_START_INDEX}`, "invalidValue");
  // RFC 7644 §3.4.2.4: a startIndex below 1 is read as 1, a negative count as 0.
  const startIndex = start === null || start < 1 ? 1 : start;
  const limit = count === null ? SCIM_DEFAULT_PAGE_SIZE : Math.min(Math.max(0, count), SCIM_MAX_PAGE_SIZE);
  return { startIndex, offset: startIndex - 1, limit };
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export interface ScimEmail {
  value: string;
  type: string | null;
  primary: boolean;
}

/** What the server keeps of a SCIM User. */
export interface ScimUserDraft {
  userName: string;
  externalId: string | null;
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
  emails: ScimEmail[];
  active: boolean;
}

/** What the server keeps of a SCIM Group; members are user ids. */
export interface ScimGroupDraft {
  displayName: string;
  externalId: string | null;
  members: string[];
}

const MAX_TEXT = 256;

function text(value: unknown, attribute: string, options: { required?: boolean } = {}): string | null {
  if (value === undefined || value === null) {
    if (options.required) throw new ScimError(400, `${attribute} is required`, "invalidValue");
    return null;
  }
  if (typeof value !== "string") throw new ScimError(400, `${attribute} must be a string`, "invalidValue");
  const trimmed = value.trim();
  if (trimmed === "") {
    if (options.required) throw new ScimError(400, `${attribute} is required`, "invalidValue");
    return null;
  }
  if (trimmed.length > MAX_TEXT) throw new ScimError(400, `${attribute} is longer than ${MAX_TEXT} characters`, "invalidValue");
  return trimmed;
}

/** A SCIM boolean: true / false, or the strings "true" / "false" in any case (some providers send strings). */
export function scimBoolean(value: unknown, attribute: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true") return true;
    if (lowered === "false") return false;
  }
  throw new ScimError(400, `${attribute} must be a boolean`, "invalidValue");
}

function parseEmails(value: unknown): ScimEmail[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.length > 20) throw new ScimError(400, "Too many emails", "invalidValue");
  const emails: ScimEmail[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") throw new ScimError(400, "Each email must be an object with a value", "invalidValue");
    const record = entry as Record<string, unknown>;
    const address = text(record.value, "emails.value");
    if (!address) continue;
    emails.push({
      value: address,
      type: text(record.type, "emails.type"),
      primary: record.primary === undefined ? false : scimBoolean(record.primary, "emails.primary")
    });
  }
  return emails;
}

function objectOf(value: unknown, attribute: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ScimError(400, `${attribute} must be an object`, "invalidValue");
  return value as Record<string, unknown>;
}

/** A User resource from a POST or PUT body (unknown attributes ignored). */
export function userDraftFromResource(body: unknown): ScimUserDraft {
  const resource = objectOf(body, "The request body");
  const name = resource.name === undefined || resource.name === null ? {} : objectOf(resource.name, "name");
  return {
    userName: text(resource.userName, "userName", { required: true })!,
    externalId: text(resource.externalId, "externalId"),
    displayName: text(resource.displayName, "displayName"),
    givenName: text(name.givenName, "name.givenName"),
    familyName: text(name.familyName, "name.familyName"),
    emails: parseEmails(resource.emails),
    active: resource.active === undefined || resource.active === null ? true : scimBoolean(resource.active, "active")
  };
}

function memberIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.length > SCIM_MAX_MEMBERS_PER_REQUEST) throw new ScimError(400, `At most ${SCIM_MAX_MEMBERS_PER_REQUEST} members per request`, "tooMany");
  const ids = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") throw new ScimError(400, "Each member must be an object with a value", "invalidValue");
    ids.add(text((entry as Record<string, unknown>).value, "members.value", { required: true })!);
  }
  return [...ids];
}

/** A Group resource from a POST or PUT body (unknown attributes ignored). */
export function groupDraftFromResource(body: unknown): ScimGroupDraft {
  const resource = objectOf(body, "The request body");
  return {
    displayName: text(resource.displayName, "displayName", { required: true })!,
    externalId: text(resource.externalId, "externalId"),
    members: memberIds(resource.members)
  };
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

export type ScimPatchOp = "add" | "replace" | "remove";

export interface ScimPatchOperation {
  op: ScimPatchOp;
  path: string | null;
  value: unknown;
}

/** The Operations of a PatchOp body, with `op` normalised. */
export function parsePatchBody(body: unknown): ScimPatchOperation[] {
  const request = objectOf(body, "The request body");
  if (Array.isArray(request.schemas) && !request.schemas.includes(SCIM_SCHEMA_PATCH)) {
    throw new ScimError(400, `A PATCH body must name the ${SCIM_SCHEMA_PATCH} schema`, "invalidSyntax");
  }
  const operations = request.Operations ?? request.operations;
  if (!Array.isArray(operations) || operations.length === 0) throw new ScimError(400, "A PATCH body needs a non-empty Operations list", "invalidSyntax");
  if (operations.length > SCIM_MAX_PATCH_OPERATIONS) throw new ScimError(400, `At most ${SCIM_MAX_PATCH_OPERATIONS} operations per PATCH`, "tooMany");
  return operations.map((raw) => {
    const operation = objectOf(raw, "Each operation");
    const op = typeof operation.op === "string" ? operation.op.trim().toLowerCase() : "";
    if (op !== "add" && op !== "replace" && op !== "remove") throw new ScimError(400, `Unsupported op '${String(operation.op)}'`, "invalidSyntax");
    const path = typeof operation.path === "string" && operation.path.trim() !== "" ? operation.path.trim() : null;
    if (operation.path !== undefined && operation.path !== null && typeof operation.path !== "string") {
      throw new ScimError(400, "path must be a string", "invalidPath");
    }
    if (op === "remove" && path === null) throw new ScimError(400, "A remove operation needs a path", "noTarget");
    if (op !== "remove" && operation.value === undefined) throw new ScimError(400, `An ${op} operation needs a value`, "invalidValue");
    return { op, path, value: operation.value };
  });
}

/** A path with the resource's own core schema URN taken off; null for an extension schema's attribute (ignored). */
function corePath(path: string, urn: string): string | null {
  const lowered = path.toLowerCase();
  const prefix = `${urn.toLowerCase()}:`;
  if (lowered.startsWith(prefix)) return path.slice(prefix.length);
  if (lowered.startsWith("urn:")) return null;
  return path;
}

const VALUE_FILTER = /^([A-Za-z]+)\[\s*([A-Za-z]+)\s+eq\s+("(?:[^"\\]|\\.)*"|true|false)\s*\](?:\.([A-Za-z]+))?$/i;

function filterValue(raw: string): string | boolean {
  if (raw.toLowerCase() === "true") return true;
  if (raw.toLowerCase() === "false") return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
  } catch {
    // falls through
  }
  throw new ScimError(400, "Invalid value in a path filter", "invalidPath");
}

function emailMatches(email: ScimEmail, attribute: string, wanted: string | boolean): boolean {
  switch (attribute.toLowerCase()) {
    case "type":
      return typeof wanted === "string" && (email.type ?? "").toLowerCase() === wanted.toLowerCase();
    case "value":
      return typeof wanted === "string" && email.value.toLowerCase() === wanted.toLowerCase();
    case "primary":
      return email.primary === (typeof wanted === "boolean" ? wanted : wanted.toLowerCase() === "true");
    default:
      throw new ScimError(400, `Unsupported email filter on '${attribute}'`, "invalidPath");
  }
}

function applyUserAttribute(draft: ScimUserDraft, op: ScimPatchOp, rawPath: string, value: unknown): void {
  const path = corePath(rawPath, SCIM_SCHEMA_USER);
  if (path === null) return;
  const filtered = VALUE_FILTER.exec(path);
  if (filtered) {
    const [, attribute, filterAttribute, rawValue, subAttribute] = filtered;
    if (attribute!.toLowerCase() !== "emails") return;
    const wanted = filterValue(rawValue!);
    const matches = draft.emails.filter((email) => emailMatches(email, filterAttribute!, wanted));
    if (op === "remove") {
      if (subAttribute && subAttribute.toLowerCase() !== "value") return;
      draft.emails = draft.emails.filter((email) => !matches.includes(email));
      return;
    }
    const sub = (subAttribute ?? "value").toLowerCase();
    if (sub === "value") {
      const address = text(value, "emails.value", { required: true })!;
      if (matches.length > 0) {
        for (const email of matches) email.value = address;
      } else {
        draft.emails.push({
          value: address,
          type: filterAttribute!.toLowerCase() === "type" && typeof wanted === "string" ? wanted : null,
          primary: filterAttribute!.toLowerCase() === "primary" && wanted === true
        });
      }
    } else if (sub === "primary") {
      const primary = scimBoolean(value, "emails.primary");
      for (const email of matches) email.primary = primary;
    } else if (sub === "type") {
      const type = text(value, "emails.type");
      for (const email of matches) email.type = type;
    }
    return;
  }
  switch (path.toLowerCase()) {
    case "username":
      if (op === "remove") throw new ScimError(400, "userName cannot be removed", "mutability");
      draft.userName = text(value, "userName", { required: true })!;
      return;
    case "externalid":
      draft.externalId = op === "remove" ? null : text(value, "externalId");
      return;
    case "displayname":
      draft.displayName = op === "remove" ? null : text(value, "displayName");
      return;
    case "active":
      if (op === "remove") throw new ScimError(400, "active cannot be removed", "mutability");
      draft.active = scimBoolean(value, "active");
      return;
    case "name":
      if (op === "remove") {
        draft.givenName = null;
        draft.familyName = null;
        return;
      }
      {
        const name = objectOf(value, "name");
        if (op === "replace" || "givenName" in name) draft.givenName = text(name.givenName, "name.givenName");
        if (op === "replace" || "familyName" in name) draft.familyName = text(name.familyName, "name.familyName");
      }
      return;
    case "name.givenname":
      draft.givenName = op === "remove" ? null : text(value, "name.givenName");
      return;
    case "name.familyname":
      draft.familyName = op === "remove" ? null : text(value, "name.familyName");
      return;
    case "emails":
      if (op === "remove") {
        draft.emails = [];
      } else if (op === "replace") {
        draft.emails = parseEmails(value);
      } else {
        for (const email of parseEmails(value)) {
          const existing = draft.emails.find((entry) => entry.value.toLowerCase() === email.value.toLowerCase());
          if (existing) Object.assign(existing, email);
          else draft.emails.push(email);
        }
      }
      return;
    default:
      // Attributes this server does not keep (title, phoneNumbers, addresses, …) are accepted and ignored.
      return;
  }
}

/** Applies PATCH operations to a copy of a user draft. */
export function applyUserPatch(current: ScimUserDraft, operations: readonly ScimPatchOperation[]): ScimUserDraft {
  const draft: ScimUserDraft = { ...current, emails: current.emails.map((email) => ({ ...email })) };
  for (const operation of operations) {
    if (operation.path !== null) {
      applyUserAttribute(draft, operation.op, operation.path, operation.value);
      continue;
    }
    // No path: the value is an object of attributes (dotted keys allowed), each applied with the operation's op.
    const value = objectOf(operation.value, "value");
    for (const [key, attributeValue] of Object.entries(value)) {
      if (key === "schemas" || key === "id" || key === "meta") continue;
      applyUserAttribute(draft, operation.op, key, attributeValue);
    }
  }
  return draft;
}

function applyGroupAttribute(draft: ScimGroupDraft, op: ScimPatchOp, rawPath: string, value: unknown): void {
  const path = corePath(rawPath, SCIM_SCHEMA_GROUP);
  if (path === null) return;
  const filtered = VALUE_FILTER.exec(path);
  if (filtered) {
    const [, attribute, filterAttribute, rawValue, subAttribute] = filtered;
    if (attribute!.toLowerCase() !== "members") throw new ScimError(400, `Unsupported path '${rawPath}'`, "invalidPath");
    if (filterAttribute!.toLowerCase() !== "value" || subAttribute) throw new ScimError(400, `Unsupported path '${rawPath}'`, "invalidPath");
    if (op !== "remove") throw new ScimError(400, "A member filter path only takes remove", "invalidPath");
    const wanted = filterValue(rawValue!);
    draft.members = draft.members.filter((id) => id !== wanted);
    return;
  }
  switch (path.toLowerCase()) {
    case "displayname":
      if (op === "remove") throw new ScimError(400, "displayName cannot be removed", "mutability");
      draft.displayName = text(value, "displayName", { required: true })!;
      return;
    case "externalid":
      draft.externalId = op === "remove" ? null : text(value, "externalId");
      return;
    case "members":
      if (op === "replace") {
        draft.members = memberIds(value);
      } else if (op === "add") {
        const present = new Set(draft.members);
        for (const id of memberIds(value)) {
          if (present.has(id)) continue;
          present.add(id);
          draft.members.push(id);
        }
      } else if (value === undefined || value === null) {
        draft.members = [];
      } else {
        // A remove with a value list (a form some providers send instead of a path filter).
        const removed = new Set(memberIds(value));
        draft.members = draft.members.filter((id) => !removed.has(id));
      }
      return;
    default:
      return;
  }
}

function assertGroupSize(draft: ScimGroupDraft): void {
  if (draft.members.length > SCIM_MAX_GROUP_MEMBERS) throw new ScimError(400, `A group has at most ${SCIM_MAX_GROUP_MEMBERS} members`, "tooMany");
}

/** Applies PATCH operations to a copy of a group draft. */
export function applyGroupPatch(current: ScimGroupDraft, operations: readonly ScimPatchOperation[]): ScimGroupDraft {
  const draft: ScimGroupDraft = { ...current, members: [...current.members] };
  for (const operation of operations) {
    if (operation.path !== null) {
      applyGroupAttribute(draft, operation.op, operation.path, operation.value);
      assertGroupSize(draft);
      continue;
    }
    const value = objectOf(operation.value, "value");
    for (const [key, attributeValue] of Object.entries(value)) {
      if (key === "schemas" || key === "id" || key === "meta") continue;
      applyGroupAttribute(draft, operation.op, key, attributeValue);
      assertGroupSize(draft);
    }
    assertGroupSize(draft);
  }
  return draft;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The email a user draft names: the primary email, else the first, else the userName when it is an address. */
export function draftEmail(draft: ScimUserDraft): string | null {
  const candidates = [draft.emails.find((email) => email.primary)?.value, draft.emails[0]?.value, draft.userName];
  for (const candidate of candidates) {
    if (candidate && EMAIL_PATTERN.test(candidate)) return candidate.trim().toLowerCase();
  }
  return null;
}
