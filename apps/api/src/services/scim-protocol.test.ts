/**
 * 13.2 — SCIM wire parsing: filters, paging, resource drafts and the PATCH shapes identity providers send (op in any
 * case, operations without a path, string booleans, value-filter paths, member removal by filter or by value list).
 */
import { describe, expect, it } from "vitest";
import {
  applyGroupPatch,
  applyUserPatch,
  draftEmail,
  groupDraftFromResource,
  parsePatchBody,
  parseScimGroupFilter,
  parseScimPage,
  parseScimUserFilter,
  ScimError,
  userDraftFromResource,
  type ScimUserDraft
} from "./scim-protocol.js";

const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

const baseUser = (): ScimUserDraft => ({
  userName: "ada@example.com",
  externalId: "ext-1",
  displayName: "Ada",
  givenName: "Ada",
  familyName: "Lovelace",
  emails: [{ value: "ada@example.com", type: "work", primary: true }],
  active: true
});

function scimErrorOf(fn: () => unknown): ScimError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ScimError) return error;
    throw error;
  }
  throw new Error("expected a ScimError");
}

describe("SCIM filters", () => {
  it("reads the supported user filters, with or without the schema URN", () => {
    expect(parseScimUserFilter('userName eq "ada@example.com"')).toEqual({ field: "userName", value: "ada@example.com" });
    expect(parseScimUserFilter('USERNAME EQ "Ada"')).toEqual({ field: "userName", value: "Ada" });
    expect(parseScimUserFilter('externalId eq "00u1"')).toEqual({ field: "externalId", value: "00u1" });
    expect(parseScimUserFilter('id eq "usr_1"')).toEqual({ field: "id", value: "usr_1" });
    expect(parseScimUserFilter('emails.value eq "a@b.co"')).toEqual({ field: "email", value: "a@b.co" });
    expect(parseScimUserFilter('emails[value eq "a@b.co"]')).toEqual({ field: "email", value: "a@b.co" });
    expect(parseScimUserFilter('urn:ietf:params:scim:schemas:core:2.0:User:userName eq "x"')).toEqual({ field: "userName", value: "x" });
    expect(parseScimUserFilter('userName eq "quo\\"te"')).toEqual({ field: "userName", value: 'quo"te' });
    expect(parseScimUserFilter(undefined)).toBeNull();
    expect(parseScimUserFilter("  ")).toBeNull();
  });

  it("refuses anything else with invalidFilter", () => {
    for (const filter of ['userName sw "a"', 'title eq "x"', 'userName eq "a" and active eq true', "userName eq unquoted", 'emails[type eq "work"].value eq "x"']) {
      const error = scimErrorOf(() => parseScimUserFilter(filter));
      expect(error.status).toBe(400);
      expect(error.scimType).toBe("invalidFilter");
    }
  });

  it("reads the supported group filters", () => {
    expect(parseScimGroupFilter('displayName eq "Engineering"')).toEqual({ field: "displayName", value: "Engineering" });
    expect(parseScimGroupFilter('externalId eq "g1"')).toEqual({ field: "externalId", value: "g1" });
    expect(parseScimGroupFilter('members.value eq "usr_1"')).toEqual({ field: "member", value: "usr_1" });
    expect(scimErrorOf(() => parseScimGroupFilter('userName eq "x"')).scimType).toBe("invalidFilter");
  });

  it("pages with startIndex and count, clamped as RFC 7644 says", () => {
    expect(parseScimPage({})).toEqual({ startIndex: 1, offset: 0, limit: 100 });
    expect(parseScimPage({ startIndex: "3", count: "2" })).toEqual({ startIndex: 3, offset: 2, limit: 2 });
    expect(parseScimPage({ startIndex: "0", count: "-5" })).toEqual({ startIndex: 1, offset: 0, limit: 0 });
    expect(parseScimPage({ count: "100000" }).limit).toBe(200);
    expect(scimErrorOf(() => parseScimPage({ count: "many" })).scimType).toBe("invalidValue");
    expect(scimErrorOf(() => parseScimPage({ startIndex: "1e300" })).scimType).toBe("invalidValue");
  });
});

describe("SCIM resource drafts", () => {
  it("reads a user resource; active defaults to true and may be a string", () => {
    const draft = userDraftFromResource({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: " grace@example.com ",
      name: { givenName: "Grace", familyName: "Hopper" },
      emails: [{ value: "grace@example.com", type: "work", primary: true }],
      phoneNumbers: [{ value: "+1" }]
    });
    expect(draft).toMatchObject({ userName: "grace@example.com", givenName: "Grace", familyName: "Hopper", active: true });
    expect(userDraftFromResource({ userName: "x@y.zz", active: "False" }).active).toBe(false);
    expect(scimErrorOf(() => userDraftFromResource({ name: {} })).scimType).toBe("invalidValue");
    expect(scimErrorOf(() => userDraftFromResource({ userName: "a", active: "maybe" })).scimType).toBe("invalidValue");
  });

  it("finds the email: primary, else first, else a userName that is an address", () => {
    expect(draftEmail({ ...baseUser(), emails: [{ value: "b@x.io", type: null, primary: false }, { value: "P@x.io", type: null, primary: true }] })).toBe("p@x.io");
    expect(draftEmail({ ...baseUser(), emails: [] })).toBe("ada@example.com");
    expect(draftEmail({ ...baseUser(), userName: "ada", emails: [] })).toBeNull();
  });

  it("reads a group resource with members", () => {
    expect(groupDraftFromResource({ displayName: "Eng", members: [{ value: "u1" }, { value: "u2" }, { value: "u1" }] })).toEqual({
      displayName: "Eng",
      externalId: null,
      members: ["u1", "u2"]
    });
    expect(scimErrorOf(() => groupDraftFromResource({ members: [] })).scimType).toBe("invalidValue");
  });
});

describe("SCIM PATCH", () => {
  it("needs the PatchOp schema and a known op, in any case", () => {
    expect(parsePatchBody({ schemas: [PATCH], Operations: [{ op: "Replace", path: "active", value: false }] })).toEqual([
      { op: "replace", path: "active", value: false }
    ]);
    expect(scimErrorOf(() => parsePatchBody({ schemas: ["other"], Operations: [{ op: "add", value: {} }] })).scimType).toBe("invalidSyntax");
    expect(scimErrorOf(() => parsePatchBody({ schemas: [PATCH], Operations: [{ op: "move", value: {} }] })).scimType).toBe("invalidSyntax");
    expect(scimErrorOf(() => parsePatchBody({ schemas: [PATCH], Operations: [] })).scimType).toBe("invalidSyntax");
    expect(scimErrorOf(() => parsePatchBody({ schemas: [PATCH], Operations: [{ op: "remove" }] })).scimType).toBe("noTarget");
  });

  it("deactivates with a path, or with a value object and no path", () => {
    expect(applyUserPatch(baseUser(), parsePatchBody({ schemas: [PATCH], Operations: [{ op: "replace", path: "active", value: false }] })).active).toBe(false);
    expect(applyUserPatch(baseUser(), parsePatchBody({ schemas: [PATCH], Operations: [{ op: "replace", value: { active: false } }] })).active).toBe(false);
    // Booleans sent as strings.
    expect(applyUserPatch(baseUser(), parsePatchBody({ schemas: [PATCH], Operations: [{ op: "Replace", path: "active", value: "False" }] })).active).toBe(false);
  });

  it("applies dotted keys, value-filter paths and ignores attributes it does not keep", () => {
    const patched = applyUserPatch(
      baseUser(),
      parsePatchBody({
        schemas: [PATCH],
        Operations: [
          { op: "Add", value: { "name.givenName": "Augusta", displayName: "Augusta Ada", title: "Countess" } },
          { op: "Replace", path: 'emails[type eq "work"].value', value: "augusta@example.com" },
          { op: "Add", path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department", value: "Math" },
          { op: "Replace", path: "urn:ietf:params:scim:schemas:core:2.0:User:userName", value: "augusta@example.com" },
          { op: "Remove", path: "externalId" }
        ]
      })
    );
    expect(patched).toMatchObject({
      userName: "augusta@example.com",
      displayName: "Augusta Ada",
      givenName: "Augusta",
      familyName: "Lovelace",
      externalId: null,
      emails: [{ value: "augusta@example.com", type: "work", primary: true }]
    });
  });

  it("refuses removing userName or active", () => {
    expect(scimErrorOf(() => applyUserPatch(baseUser(), [{ op: "remove", path: "userName", value: undefined }])).scimType).toBe("mutability");
    expect(scimErrorOf(() => applyUserPatch(baseUser(), [{ op: "remove", path: "active", value: undefined }])).scimType).toBe("mutability");
  });

  it("adds, replaces and removes group members in the common shapes", () => {
    const group = { displayName: "Eng", externalId: null, members: ["u1", "u2"] };
    const ops = (operations: unknown[]) => parsePatchBody({ schemas: [PATCH], Operations: operations });
    expect(applyGroupPatch(group, ops([{ op: "add", path: "members", value: [{ value: "u3" }, { value: "u1" }] }])).members).toEqual(["u1", "u2", "u3"]);
    expect(applyGroupPatch(group, ops([{ op: "remove", path: 'members[value eq "u1"]' }])).members).toEqual(["u2"]);
    // Removal by value list, as some providers send it.
    expect(applyGroupPatch(group, ops([{ op: "Remove", path: "members", value: [{ value: "u2" }] }])).members).toEqual(["u1"]);
    expect(applyGroupPatch(group, ops([{ op: "remove", path: "members" }])).members).toEqual([]);
    expect(applyGroupPatch(group, ops([{ op: "replace", path: "members", value: [{ value: "u9" }] }])).members).toEqual(["u9"]);
    // No path: a rename (an id in the value is ignored) and members.
    expect(applyGroupPatch(group, ops([{ op: "replace", value: { id: "scg_x", displayName: "Engineering" } }]))).toMatchObject({ displayName: "Engineering", members: ["u1", "u2"] });
    expect(applyGroupPatch(group, ops([{ op: "add", value: { members: [{ value: "u4" }] } }])).members).toEqual(["u1", "u2", "u4"]);
    expect(scimErrorOf(() => applyGroupPatch(group, ops([{ op: "add", path: 'members[value eq "u1"]', value: [] }]))).scimType).toBe("invalidPath");
    expect(scimErrorOf(() => applyGroupPatch(group, ops([{ op: "remove", path: "displayName" }]))).scimType).toBe("mutability");
    // Large adds stay linear, and the group size cap applies while operations run.
    const many = (from: number) => Array.from({ length: 10_000 }, (_, index) => ({ value: `m${from + index}` }));
    const big = applyGroupPatch(group, ops(Array.from({ length: 4 }, (_, index) => ({ op: "add", path: "members", value: many(index * 10_000) }))));
    expect(big.members).toHaveLength(40_002);
    expect(scimErrorOf(() => applyGroupPatch(group, ops(Array.from({ length: 6 }, (_, index) => ({ op: "add", path: "members", value: many(index * 10_000) }))))).scimType).toBe("tooMany");
  });
});
