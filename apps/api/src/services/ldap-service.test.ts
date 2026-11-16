/**
 * The LDAP user filter: the email is escaped as RFC 4515 requires (`\2a`, `\28`, `\29`, `\5c`, `\00`), so it is
 * matched literally. The old form (`\*`, a backslash before the character) is not RFC 4515, and ldapts refuses it as an
 * invalid hex escape, so an email holding one of these characters could never sign in.
 */
import { describe, expect, it } from "vitest";
import type { Store } from "../db/store.js";
import { escapeLdapFilterValue, LdapAuthError, LdapService, type LdapClientLike } from "./ldap-service.js";

/** RFC 4515 value decoding, as a directory (and ldapts' FilterParser) reads it: `\XX` is one byte, a bare `\` is an error. */
function decodeFilterValue(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]!;
    if (char === "*" || char === "(" || char === ")") throw new Error(`unescaped ${char}`);
    if (char !== "\\") {
      out += char;
      continue;
    }
    const hex = value.slice(i + 1, i + 3);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error(`invalid escape \\${hex}`);
    out += String.fromCharCode(parseInt(hex, 16));
    i += 2;
  }
  return out;
}

describe("escapeLdapFilterValue", () => {
  it("escapes the RFC 4515 characters as two hex digits and leaves the rest", () => {
    expect(escapeLdapFilterValue("a*b(c)d\\e\0f")).toBe("a\\2ab\\28c\\29d\\5ce\\00f");
    expect(escapeLdapFilterValue("lia.ä+tag@example.com")).toBe("lia.ä+tag@example.com");
  });

  it("round-trips through RFC 4515 decoding, so a wildcard or nested filter is matched literally", () => {
    for (const email of ["*", "*)(uid=*", "a\\2ab@example.com", ")(|(mail=*", "x\0y@example.com", "$&$'@example.com"]) {
      expect(decodeFilterValue(escapeLdapFilterValue(email))).toBe(email);
    }
    // The old form fails to decode at all.
    expect(() => decodeFilterValue("a\\*b")).toThrow(/invalid escape/);
  });
});

describe("LdapService.authenticate", () => {
  function service(found: Array<Record<string, unknown>>, options: { badPassword?: boolean } = {}) {
    const searches: string[] = [];
    const client = (): LdapClientLike => ({
      async bind(dn: string) {
        if (options.badPassword && dn.startsWith("uid=")) throw Object.assign(new Error("Invalid Credentials"), { name: "InvalidCredentialsError", code: 49 });
      },
      async search(_base: string, query: { filter?: string }) {
        searches.push(query.filter ?? "");
        return { searchEntries: found };
      },
      async unbind() {}
    });
    const ldap = new LdapService({} as Store, {
      enabled: true,
      url: "ldaps://directory.example.test",
      baseDn: "dc=example,dc=test",
      userFilter: "(&(objectClass=person)(mail={{email}}))",
      groupsAttribute: "memberOf"
    }, { loadClient: () => ({ Client: class { constructor() { return client(); } } as never }) });
    return { ldap, searches };
  }

  it("puts the escaped email into the filter, once per placeholder, without replacement patterns", async () => {
    const { ldap, searches } = service([{ dn: "uid=lia,dc=example,dc=test", mail: "lia@example.com" }]);
    await ldap.authenticate("li*a)($&@example.com", "pw");
    expect(searches).toEqual(["(&(objectClass=person)(mail=li\\2aa\\29\\28$&@example.com))"]);
  });

  it("reports an unknown user and a refused password as typed refusals", async () => {
    await expect(service([]).ldap.authenticate("nobody@example.com", "pw")).rejects.toMatchObject({ reason: "user_not_found" });
    const refused = service([{ dn: "uid=lia,dc=example,dc=test" }], { badPassword: true }).ldap.authenticate("lia@example.com", "bad");
    await expect(refused).rejects.toBeInstanceOf(LdapAuthError);
    await expect(refused).rejects.toMatchObject({ reason: "invalid_credentials" });
  });

  /** A directory that records every step this side takes, and refuses every bind but `accept`'s. */
  function recordingService(found: Array<Record<string, unknown>>, accept?: { dn: string; password: string }) {
    const steps: string[] = [];
    const bindDns: string[] = [];
    const client = (): LdapClientLike => {
      steps.push("connect");
      return {
        async bind(dn: string, password: string) {
          steps.push("bind");
          bindDns.push(dn);
          if (accept === undefined || dn !== accept.dn || password !== accept.password) {
            throw Object.assign(new Error("Invalid Credentials"), { name: "InvalidCredentialsError", code: 49 });
          }
        },
        async search() {
          steps.push("search");
          return { searchEntries: found };
        },
        async unbind() {
          steps.push("unbind");
        }
      };
    };
    const ldap = new LdapService({} as Store, {
      enabled: true,
      url: "ldaps://directory.example.test",
      baseDn: "dc=example,dc=test",
      userFilter: "(mail={{email}})",
      groupsAttribute: "memberOf"
    }, { loadClient: () => ({ Client: class { constructor() { return client(); } } as never }) });
    return { ldap, steps, bindDns };
  }

  it("takes the same steps for an unknown user as for a wrong password: a second connection and a refused bind", async () => {
    const unknown = recordingService([]);
    await expect(unknown.ldap.authenticate("nobody@example.com", "pw")).rejects.toMatchObject({ reason: "user_not_found" });
    const wrong = recordingService([{ dn: "uid=lia,dc=example,dc=test" }], { dn: "uid=lia,dc=example,dc=test", password: "right" });
    await expect(wrong.ldap.authenticate("lia@example.com", "bad")).rejects.toMatchObject({ reason: "invalid_credentials" });
    expect(unknown.steps).toEqual(wrong.steps);
    expect(unknown.steps).toEqual(["connect", "search", "unbind", "connect", "bind", "unbind", "unbind"]);
    // The dummy bind names no real entry, and a fresh one each time.
    const again = recordingService([]);
    await again.ldap.authenticate("nobody@example.com", "pw").catch(() => undefined);
    expect(unknown.bindDns[0]).toMatch(/^cn=l2m-no-such-user-[0-9a-f]{24},dc=example,dc=test$/);
    expect(again.bindDns[0]).not.toBe(unknown.bindDns[0]);
  });

  it("refuses an unknown user even when the directory accepts the dummy bind", async () => {
    const accepting = new LdapService({} as Store, {
      enabled: true,
      url: "ldaps://directory.example.test",
      baseDn: "dc=example,dc=test",
      userFilter: "(mail={{email}})",
      groupsAttribute: "memberOf"
    }, {
      loadClient: () => ({
        Client: class {
          constructor() {
            return { bind: async () => undefined, search: async () => ({ searchEntries: [] }), unbind: async () => undefined } satisfies LdapClientLike;
          }
        } as never
      })
    });
    await expect(accepting.authenticate("nobody@example.com", "pw")).rejects.toMatchObject({ reason: "user_not_found" });
  });

  it("still reports an entry without a DN as a directory problem, after the same steps", async () => {
    const broken = recordingService([{ mail: "lia@example.com" }]);
    await expect(broken.ldap.authenticate("lia@example.com", "pw")).rejects.toMatchObject({ reason: "directory_error" });
    expect(broken.steps).toEqual(["connect", "search", "unbind", "connect", "bind", "unbind", "unbind"]);
  });
});
