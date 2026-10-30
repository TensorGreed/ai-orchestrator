import { describe, expect, it } from "vitest";
import { parseToolArgumentSummary, type ToolArgumentSummary } from "@ai-orchestrator/shared";
import {
  hashToolArgumentValue,
  isSafeToolArgumentToken,
  isSensitiveToolArgumentKey,
  looksRandomToolArgument,
  looksRandomToolArgumentKey,
  summarizeToolArguments,
  toolArgumentKeySegments,
  toolArgumentLengthBucket,
  TOOL_ARGUMENT_SUMMARY_LIMITS,
  type ToolArgumentDetector
} from "./tool-argument-summary";

/**
 * A stand-in for the production-capture DLP scan (the API injects the real
 * one; apps/api tests it end to end): emails, 13-19 digit runs, `sk-` keys
 * and `+` phone numbers.
 */
const fakeDetect: ToolArgumentDetector = (text) => {
  const classes: string[] = [];
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(text)) classes.push("email");
  if (/\b\d{13,19}\b/.test(text.replace(/[ -]/g, ""))) classes.push("card_number");
  if (/\bsk-[A-Za-z0-9]{10,}/.test(text)) classes.push("credential");
  if (/\+\d{10,14}\b/.test(text)) classes.push("phone");
  return classes;
};

const hashKey = new Uint8Array(32).fill(7);
const h = (value: string | number | boolean) => hashToolArgumentValue(value, hashKey);
const summarize = (args: unknown, inputSchema?: unknown) => summarizeToolArguments(args, { detect: fakeDetect, hashKey, inputSchema });

/** Every string in the summary, to check that no argument text leaked. */
function allText(summary: ToolArgumentSummary): string {
  return JSON.stringify(summary);
}

/** Every raw string value the summary stores. */
function keptStrings(summary: ToolArgumentSummary): string[] {
  return Object.values(summary.fields).flatMap((field) => (field.values ?? []).filter((value): value is string => typeof value === "string"));
}

describe("summarizeToolArguments: kept values", () => {
  it("keeps null, booleans, small numbers and safe tokens", () => {
    const summary = summarize({ state: "open", per_page: 30, draft: false, milestone: null, region: "us-east-1" });
    expect(summary).toEqual({
      v: 2,
      fields: {
        draft: { type: "boolean", values: [false] },
        milestone: { type: "null" },
        per_page: { type: "number", values: [30], min: 30, max: 30 },
        region: { type: "string", values: ["us-east-1"] },
        state: { type: "string", values: ["open"] }
      }
    });
  });

  it("is deterministic and independent of key order", () => {
    const a = summarize({ b: 1, a: { y: "x", x: [3, 1, 2], z: "Not A Token" } });
    const b = summarize({ a: { z: "Not A Token", x: [2, 3, 1], y: "x" }, b: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a.fields)).toEqual(["a", "a.x", "a.x[]", "a.y", "a.z", "b"]);
  });

  it("keeps the empty string and normalises -0", () => {
    const summary = summarize({ s: "", n: -0, tiny: -0.00001 });
    expect(summary.fields.s).toEqual({ type: "string", values: [""] });
    expect(summary.fields.n).toEqual({ type: "number", values: [0], min: 0, max: 0 });
    expect(summary.fields.tiny).toEqual({ type: "number", values: [0], min: 0, max: 0 });
  });

  it("drops non-finite numbers but keeps their type", () => {
    expect(summarize({ n: Number.NaN }).fields.n).toEqual({ type: "number" });
    expect(summarize({ n: Infinity }).fields.n).toEqual({ type: "number" });
  });

  it("keeps a schema enum value even when it is not a token", () => {
    const schema = { type: "object", properties: { mode: { enum: ["Fast and loose", "slow"] }, kind: { anyOf: [{ const: "x y" }, { type: "string" }] } } };
    const summary = summarize({ mode: "Fast and loose", kind: "x y", other: "Fast and loose" }, schema);
    expect(summary.fields.mode).toEqual({ type: "string", values: ["Fast and loose"] });
    expect(summary.fields.kind).toEqual({ type: "string", values: ["x y"] });
    expect(summary.fields.other).toEqual({ type: "string", hashes: [h("Fast and loose")], len: "9-32" });
  });

  it("reads enums through array items and additionalProperties", () => {
    const schema = {
      properties: {
        labels: { type: "array", items: { enum: ["bug fix", "needs review"] } },
        meta: { type: "object", additionalProperties: { enum: ["very high"] } }
      }
    };
    const summary = summarize({ labels: ["bug fix", "needs review", "free text here"], meta: { level: "very high" } }, schema);
    expect(summary.fields["labels[]"]).toEqual({ type: "string", count: 3, values: ["bug fix", "needs review"], hashes: [h("free text here")], len: "9-32" });
    expect(summary.fields["meta.level"]).toEqual({ type: "string", values: ["very high"] });
  });

  it("ignores a hostile schema", () => {
    const schema = { properties: { __proto__: { enum: ["a b"] }, x: 5 }, anyOf: "nope", items: [1] };
    expect(() => summarize({ x: "a b", list: ["a b"] }, schema)).not.toThrow();
    expect(summarize({ x: "a b" }, schema).fields.x).toEqual({ type: "string", hashes: [h("a b")], len: "1-8" });
  });

  it("rounds kept numbers to four decimals and hides seven or more integer digits", () => {
    const summary = summarize({ ratio: 3.14159265, big: 999_999.5, card: 4111111111111111.5, id: 123456789.25, acct: 12345678, dob: 19850315, phone7: 5551234, neg: -2_000_000 });
    expect(summary.fields.ratio).toEqual({ type: "number", values: [3.1416], min: 3.1416, max: 3.1416 });
    expect(summary.fields.big).toEqual({ type: "number", values: [999_999.5], min: 999_999.5, max: 999_999.5 });
    expect(summary.fields.card).toEqual({ type: "number", mag: 15, hashes: [h(4111111111111111.5)], classes: ["card_number"] });
    expect(summary.fields.id).toEqual({ type: "number", mag: 8, hashes: [h(123456789.25)] });
    expect(summary.fields.acct).toEqual({ type: "number", mag: 7, hashes: [h(12345678)] });
    expect(summary.fields.dob).toEqual({ type: "number", mag: 7, hashes: [h(19850315)] });
    expect(summary.fields.phone7).toEqual({ type: "number", mag: 6, hashes: [h(5551234)] });
    expect(summary.fields.neg).toEqual({ type: "number", mag: 6, hashes: [h(-2_000_000)] });
    expect(allText(summary)).not.toMatch(/4111111111111111|123456789|12345678|19850315|5551234/);
  });

  it("rounds coordinates under location keys to one decimal", () => {
    const summary = summarize({ lat: 51.501364, lon: -0.14189, geo: { x: 12.3456 }, location: { latitude: 40.7128, longitude: -74.006 } });
    expect(summary.fields.lat?.values).toEqual([51.5]);
    expect(summary.fields.lon?.values).toEqual([-0.1]);
    expect(summary.fields["geo.x"]?.values).toEqual([12.3]);
    expect(summary.fields["location.latitude"]?.values).toEqual([40.7]);
    expect(summary.fields["location.longitude"]?.values).toEqual([-74]);
    expect(allText(summary)).not.toMatch(/501364|14189|3456|7128|006/);
  });
});

describe("summarizeToolArguments: sensitive paths", () => {
  it("hides values under every credential key the shared pattern misses (H1)", () => {
    const keys = ["pass", "pw", "pwd", "passphrase", "pin", "otp", "totp", "mfa_code", "signature", "sig", "session", "sid", "bearer", "private", "jwt", "cookie", "nonce", "apiKey"];
    const summary = summarize(Object.fromEntries(keys.map((key) => [key, "hunter2"])));
    for (const key of keys) {
      expect(summary.fields[key], key).toEqual({ type: "string", hashes: [h("hunter2")], len: "1-8" });
    }
    expect(allText(summary)).not.toContain("hunter2");
  });

  it("inherits sensitivity into nested objects and arrays (H2)", () => {
    const summary = summarize({ password: { value: "hunter2", n: 5, ok: true }, auth: [{ v: "hunter2" }], message: { name: "Alice", parts: ["Bob"] } });
    expect(summary.fields["password.value"]).toEqual({ type: "string", hashes: [h("hunter2")], len: "1-8" });
    expect(summary.fields["password.n"]).toEqual({ type: "number", mag: 0, hashes: [h(5)] });
    expect(summary.fields["password.ok"]).toEqual({ type: "boolean", hashes: [h(true)] });
    expect(summary.fields["auth[].v"]?.values).toBeUndefined();
    expect(summary.fields["message.name"]?.values).toBeUndefined();
    expect(summary.fields["message.parts[]"]?.values).toBeUndefined();
    expect(allText(summary)).not.toMatch(/hunter2|Alice|Bob/);
  });

  it("hides people's names under keys that only contain a people word (H3)", () => {
    const summary = summarize({
      customer: "alice",
      recipient_name: "alice",
      reviewerLogin: "jsmith",
      owner: "jsmith",
      name: "alice",
      senderEmail: "x",
      firstName: "alice",
      to: ["bob"],
      Customer_Id: "bob",
      firstname: "alice",
      lastname: "smith",
      surname: "smith",
      fullname: "alice-smith",
      nickname: "bob",
      givenname: "alice",
      familyname: "smith",
      displayname: "bob",
      userid: "jsmith",
      emailaddress: "x",
      phonenumber: "x",
      accountno: "x",
      accountnumber: "x",
      ownerid: "jsmith"
    });
    for (const [path, field] of Object.entries(summary.fields)) {
      expect(field.values, path).toBeUndefined();
      expect(field.prefixes, path).toBeUndefined();
    }
    expect(allText(summary)).not.toMatch(/alice|jsmith|"bob"|smith/);
  });

  it("matches sensitive stems inside joined and all-lower-case keys (M-A)", () => {
    for (const key of ["firstname", "lastname", "surname", "fullname", "nickname", "givenname", "displayname", "userid", "emailaddress", "phonenumber", "accountno", "zipcode", "filename", "hostname"]) {
      expect(isSensitiveToolArgumentKey(key), key).toBe(true);
    }
    for (const key of ["state", "per_page", "region", "kind", "mode", "ref", "labels", "branch", "namespace", "podNamespace"]) {
      expect(isSensitiveToolArgumentKey(key), key).toBe(false);
    }
  });

  it("keeps values under the documented safe segments only (M-A)", () => {
    const summary = summarize({ namespace: "kube-system", pod_namespace: "default", rename: "x" });
    expect(summary.fields.namespace?.values).toEqual(["kube-system"]);
    expect(summary.fields.pod_namespace?.values).toEqual(["default"]);
    expect(summary.fields.rename?.values).toBeUndefined();
  });

  it("hashes codes, written as numbers or strings, with their magnitude (M-B)", () => {
    const summary = summarize({
      security_code: 123,
      verification_code: 482913,
      code: 482913,
      postal_code: 90210,
      zip: 90210,
      pin: 1234,
      otp: "482913",
      cvc: 123,
      cvv: 123,
      passcode: 9999,
      verificationCode: "abc123",
      country_code: "us"
    });
    expect(summary.fields.security_code).toEqual({ type: "number", mag: 2, hashes: [h(123)] });
    expect(summary.fields.verification_code).toEqual({ type: "number", mag: 5, hashes: [h(482913)] });
    expect(summary.fields.postal_code).toEqual({ type: "number", mag: 4, hashes: [h(90210)] });
    for (const [path, field] of Object.entries(summary.fields)) {
      expect(field.values, path).toBeUndefined();
      expect(field.min, path).toBeUndefined();
      expect(field.hashes, path).toHaveLength(1);
    }
    expect(allText(summary)).not.toMatch(/482913|90210|abc123|"us"|9999/);
  });

  it("keeps numbers only under the exact token-budget keys", () => {
    const summary = summarize({
      max_tokens: 1024,
      MAX_OUTPUT_TOKENS: 2048,
      max_completion_tokens: 512,
      token_limit: 4096,
      num_tokens: 7,
      token: 1024,
      maxTokens: 1024,
      max_tokens_extra: 1024,
      auth: { max_tokens: 1 },
      big: { max_tokens: 12345678 },
      strings: { max_tokens: "1024" },
      flags: { max_tokens: true },
      nested: { max_tokens: { n: 3 } }
    });
    expect(summary.fields.max_tokens).toEqual({ type: "number", values: [1024], min: 1024, max: 1024 });
    expect(summary.fields.MAX_OUTPUT_TOKENS?.values).toEqual([2048]);
    expect(summary.fields.max_completion_tokens?.values).toEqual([512]);
    expect(summary.fields.token_limit?.values).toEqual([4096]);
    expect(summary.fields.num_tokens?.values).toEqual([7]);
    for (const path of ["token", "maxTokens", "max_tokens_extra", "auth.max_tokens", "strings.max_tokens", "flags.max_tokens", "nested.max_tokens.n"]) {
      expect(summary.fields[path]?.values, path).toBeUndefined();
      expect(summary.fields[path]?.hashes, path).toHaveLength(1);
    }
    expect(summary.fields["big.max_tokens"]).toEqual({ type: "number", mag: 7, hashes: [h(12345678)] });
  });

  it("never keeps first.last shaped values with trailing digits or a one-letter tail (L-A)", () => {
    const summary = summarize({ tag: "john.smith1", x: "john.s", version: "v1.2", python: "python3.11" });
    expect(summary.fields.tag?.values).toBeUndefined();
    expect(summary.fields.x?.values).toBeUndefined();
    expect(summary.fields.version?.values).toEqual(["v1.2"]);
    expect(summary.fields.python?.values).toEqual(["python3.11"]);
    expect(allText(summary)).not.toMatch(/john/);
  });

  it("keeps a schema enum value only up to 64 characters (review nit 3)", () => {
    const long = "x".repeat(65);
    const summary = summarize({ pick: "Alice Smith", other: long }, { properties: { pick: { enum: ["Alice Smith"] }, other: { enum: [long] } } });
    expect(summary.fields.pick?.values).toEqual(["Alice Smith"]);
    expect(summary.fields.other?.values).toBeUndefined();
    expect(summary.fields.other?.hashes).toEqual([h(long)]);
  });

  it("never keeps first.last shaped values, even under a plain key (H3)", () => {
    const summary = summarize({ ref: "john.smith", file: "config.yaml", version: "v1.2" });
    expect(summary.fields.ref).toEqual({ type: "string", hashes: [h("john.smith")], len: "9-32" });
    expect(summary.fields.file?.values).toBeUndefined();
    expect(summary.fields.version).toEqual({ type: "string", values: ["v1.2"] });
  });

  it("lets a sensitive key beat a schema enum (L1)", () => {
    const summary = summarize({ password: "hunter2", nested: { secret: "b" } }, { properties: { password: { enum: ["hunter2"] }, nested: { properties: { secret: { const: "b" } } } } });
    expect(summary.fields.password).toEqual({ type: "string", hashes: [h("hunter2")], len: "1-8" });
    expect(summary.fields["nested.secret"]?.values).toBeUndefined();
  });

  it("keeps no prefix under a sensitive path", () => {
    const summary = summarize({ email: "jane@example.com", contact: { url: "https://example.com/u/jane" }, owner_repo: "jane/dotfiles" });
    for (const field of Object.values(summary.fields)) expect(field.prefixes).toBeUndefined();
    expect(allText(summary)).not.toMatch(/jane|example/);
  });

  it("splits keys into segments on case, separators and digits", () => {
    expect(toolArgumentKeySegments("recipientEmail2_addr-line.x")).toEqual(["recipient", "email", "addr", "line", "x"]);
    expect(toolArgumentKeySegments("HTTPHeaders")).toEqual(["http", "headers"]);
    expect(isSensitiveToolArgumentKey("x2faCode")).toBe(true);
    expect(isSensitiveToolArgumentKey("x2fa")).toBe(false);
    expect(isSensitiveToolArgumentKey("mfaCode")).toBe(true);
    expect(isSensitiveToolArgumentKey("emails")).toBe(true);
    expect(isSensitiveToolArgumentKey("per_page")).toBe(false);
    expect(isSensitiveToolArgumentKey("state")).toBe(false);
  });
});

describe("summarizeToolArguments: tokens", () => {
  it("accepts only short lower-case tokens", () => {
    for (const token of ["open", "us-east-1", "pull_request", "v1.2", "n39", "organization", "deadbeef"]) {
      expect(isSafeToolArgumentToken(token), token).toBe(true);
    }
    for (const value of ["Open", "two words", "a@b", "x".repeat(33), "acct-1234", "john.smith", "example.com", "1abc", ""]) {
      expect(isSafeToolArgumentToken(value), value).toBe(false);
    }
  });

  it("treats random-looking tokens as not keepable (L2)", () => {
    for (const value of ["deadbeefcafebabe", "correcthorsebatterystaple", "sk-abc123", "pk_live", "ghp_abc", "xoxb-abc", "glpat-abc", "akiaabc", "abcd1234", "qzxkvbnmtrpl"]) {
      expect(looksRandomToolArgument(value), value).toBe(true);
    }
    for (const value of ["pull_request", "organization", "us-east-1", "deadbeef", "notifications"]) {
      expect(looksRandomToolArgument(value), value).toBe(false);
    }
    const summary = summarize({ a: "deadbeefcafebabe", b: "aGVsbG8gd29ybGQ", c: "sk-abc123", d: "correcthorsebatterystaple" });
    expect(keptStrings(summary)).toEqual([]);
  });

  it("normalises full-width text and counts digits of every script (M4)", () => {
    const summary = summarize({ fullCard: "４１１１１１１１１１１１１１１１", arabic: "٤١١١١١١١", wide: "ｏｐｅｎ", mixed: "v٤١١١" });
    expect(summary.fields.wide).toEqual({ type: "string", values: ["open"] });
    expect(summary.fields.fullCard?.classes).toEqual(["card_number"]);
    for (const path of ["fullCard", "arabic", "mixed"]) expect(summary.fields[path]?.values, path).toBeUndefined();
    expect(allText(summary)).not.toMatch(/４１|٤١/);
  });
});

describe("summarizeToolArguments: identifiers and free text", () => {
  it("reduces identifiers to stable prefixes and hashes them", () => {
    const summary = summarize({
      repo: "octo-org/hello-world",
      url: "https://api.Example.com:8443/v1/items?token=abc#frag",
      basic: "https://user:pw@internal.example.net/x",
      short: "/etc/passwd",
      rel: "./src/index.ts",
      deep: "https://a.b.example.co.uk/x"
    });
    expect(summary.fields.repo).toEqual({ type: "string", hashes: [h("octo-org/hello-world")], prefixes: ["octo-org/"], len: "9-32" });
    expect(summary.fields.url?.prefixes).toEqual(["https://api.example.com"]);
    expect(summary.fields.short?.prefixes).toEqual(["/etc/"]);
    expect(summary.fields.rel?.prefixes).toEqual(["./src/"]);
    expect(summary.fields.deep?.prefixes).toEqual(["https://example.co.uk"]);
    // A URL with credentials in it is flagged (here as an email by the stand-in detector) and kept by class and hash only.
    expect(summary.fields.basic?.prefixes).toBeUndefined();
    const text = allText(summary);
    for (const secret of ["hello-world", "pw@", "token=abc", "passwd", "index.ts", "8443", "a.b."]) {
      expect(text).not.toContain(secret);
    }
  });

  it("drops home directories from file paths (M1)", () => {
    const summary = summarize({
      a: "/home/jdoe/secret.txt",
      b: "/Users/john.smith/projects/x",
      c: "C:\\Users\\jsmith\\Documents\\report.docx",
      d: "/root/notes/a",
      e: "~/projects/a",
      f: "C:\\Documents and Settings\\jdoe\\x\\y",
      g: "/home/jdoe"
    });
    expect(summary.fields.a?.prefixes).toEqual(["~/"]);
    expect(summary.fields.b?.prefixes).toEqual(["~/projects/"]);
    expect(summary.fields.c?.prefixes).toEqual(["~/Documents/"]);
    expect(summary.fields.d?.prefixes).toEqual(["~/notes/"]);
    expect(summary.fields.e?.prefixes).toEqual(["~/projects/"]);
    // A path with spaces is not an identifier: no prefix.
    expect(summary.fields.f?.prefixes).toBeUndefined();
    expect(summary.fields.g?.prefixes).toEqual(["~/"]);
    expect(allText(summary)).not.toMatch(/jdoe|john|jsmith|secret|report/);
  });

  it("reduces URL hosts: IPs, deep subdomains and shared hosting (L4)", () => {
    const summary = summarize({
      ip: "http://10.1.2.3/x",
      ip6: "http://[::1]:8080/x",
      hosted: "https://alice-smith.github.io/x",
      deep: "https://jdoe.dev.corp.example.com/x",
      randomSub: "https://a1b2c3d4e5.example.com/x",
      local: "http://localhost:3000/x"
    });
    expect(summary.fields.ip?.prefixes).toEqual(["http://ip"]);
    expect(summary.fields.ip6?.prefixes).toEqual(["http://ip"]);
    expect(summary.fields.hosted?.prefixes).toEqual(["https://*.github.io"]);
    expect(summary.fields.deep?.prefixes).toEqual(["https://example.com"]);
    expect(summary.fields.randomSub?.prefixes).toEqual(["https://example.com"]);
    expect(summary.fields.local?.prefixes).toEqual(["http://localhost"]);
    expect(allText(summary)).not.toMatch(/10\.1|alice|jdoe|a1b2/);
  });

  it("does not read dates or fractions as repositories (L3)", () => {
    const summary = summarize({ month: "03/1985", frac: "1/2" });
    expect(summary.fields.month).toEqual({ type: "string", hashes: [h("03/1985")], len: "1-8" });
    expect(summary.fields.frac).toEqual({ type: "string", hashes: [h("1/2")], len: "1-8" });
  });

  it("keeps only the registrable domain and class of an email", () => {
    const summary = summarize({ cc_list: ["Jane.Doe@Mail.Example.COM"], reply: "a@b.example.com" });
    expect(summary.fields.reply).toEqual({ type: "string", hashes: [h("a@b.example.com")], prefixes: ["@b.example.com"], classes: ["email"], len: "9-32" });
    // `cc` is a people word: no prefix at all.
    expect(summary.fields["cc_list[]"]).toEqual({ type: "string", hashes: [h("Jane.Doe@Mail.Example.COM")], classes: ["email"], len: "9-32" });
    expect(allText(summary)).not.toContain("Jane");
  });

  it("keeps free text as type, length bucket and hash", () => {
    const summary = summarize({ comment: "Please merge this before Friday", long: "x".repeat(70), title: "release", huge: "y".repeat(3_000) });
    expect(summary.fields.comment).toEqual({ type: "string", hashes: [h("Please merge this before Friday")], len: "9-32" });
    expect(summary.fields.long).toEqual({ type: "string", hashes: [h("x".repeat(70))], len: "33-128" });
    // One token under a people's-words key is still hidden.
    expect(summary.fields.title).toEqual({ type: "string", hashes: [h("release")], len: "1-8" });
    // Past the hash cap only the length bucket is kept.
    expect(summary.fields.huge).toEqual({ type: "string", len: "2049+" });
    expect(allText(summary)).not.toMatch(/Friday|release|xxxx/);
  });

  it("does not keep random-looking ids, hashes or long digit runs", () => {
    const summary = summarize({
      uuid: "550e8400-e29b-41d4-a716-446655440000",
      sha: "9fceb02d0ae598e95dc970b74767f19372d61af8",
      accountish: "acct-0012345678",
      ssnLike: "123-45-6789",
      phoneLike: "020 7946",
      blob: "QWxhZGRpbjpvcGVuIHNlc2FtZQQWxhZGRpbjpvcGVu"
    });
    for (const field of Object.values(summary.fields)) {
      expect(field.values).toBeUndefined();
      expect(field.hashes).toHaveLength(1);
    }
  });

  it("summarises data a detector flags by its class and hash", () => {
    const summary = summarize({ card: "4111 1111 1111 1111", phone: "+14155550100", note: "call me on +14155550100 or mail a@b.co", api: "sk-abcdefghijklmnop" });
    expect(summary.fields.card).toEqual({ type: "string", hashes: [h("4111 1111 1111 1111")], classes: ["card_number"], len: "9-32" });
    expect(summary.fields.phone).toEqual({ type: "string", hashes: [h("+14155550100")], classes: ["phone"], len: "9-32" });
    expect(summary.fields.note?.classes).toEqual(["email", "phone"]);
    expect(summary.fields.api).toEqual({ type: "string", hashes: [h("sk-abcdefghijklmnop")], classes: ["credential"], len: "9-32" });
    expect(allText(summary)).not.toMatch(/4111|4155550100|a@b|sk-abc/);
  });

  it("hashes object keys that are not plain names (M5)", () => {
    const summary = summarize({
      "alice@example.com": "yes",
      "has space": 1,
      "a.b": 2,
      "4111111111111111": 3,
      "550e8400-e29b-41d4-a716-446655440000": 4,
      "9fceb02d0ae598e95dc970b74767f19372d61af8": 5,
      "5551234567": 6,
      "123-45-6789": 7,
      "a1b2c3d4e5f6g7h8": 10,
      Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv: 11,
      a3f2b9c1e7d4f8a2b6c3e9d1f7a4b8c2: 12,
      ok_key: 8,
      perPage: 9,
      includeArchivedRepositories: 13
    });
    const paths = Object.keys(summary.fields);
    expect(paths.filter((path) => !path.startsWith("<k:"))).toEqual(["includeArchivedRepositories", "ok_key", "perPage"]);
    expect(paths).toContain(`<k:${h("a1b2c3d4e5f6g7h8")}>`);
    expect(paths).toContain(`<k:${h("Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv")}>`);
    expect(paths).toContain(`<k:${h("a3f2b9c1e7d4f8a2b6c3e9d1f7a4b8c2")}>`);
    expect(paths).toContain(`<k:${h("alice@example.com")}>`);
    expect(allText(summary)).not.toMatch(/alice|space|4111|550e8400|9fceb02d|5551234567|6789|a1b2c3|Ab1Cd2|a3f2b9/);
  });

  it("checks the whole key, not its digit-split words, for random ids (M-C)", () => {
    for (const key of ["a1b2c3d4e5f6g7h8", "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv", "a3f2b9c1e7d4f8a2b6c3e9d1f7a4b8c2", "ab12cd34", "a3f2b9c1-e7d4-f8a2-b6c3-e9d1f7a4b8c2", "TKlYVFDFZEJzQxqjvGno", "uCfbYrslYHZKEijyEgzB", "dCARfVVVOoMQX", "XMLHttpRequest", "oaXuNNybXEjxVUKd", "GOPbfKMqNhuo", "EfuIjUedANrlGcF"]) {
      expect(looksRandomToolArgumentKey(key), key).toBe(true);
    }
    for (const key of ["perPage", "pageSize", "ok_key", "includeArchivedRepositories", "HTTPHeaders", "getHTTPSUrlForId", "maxPerPageCount", "maxResultsPerPage", "MAX_OUTPUT_TOKENS", "spreadsheetId", "valueInputOption", "threadTs", "sinceSeconds", "xAxisLabel", "v2"]) {
      expect(looksRandomToolArgumentKey(key), key).toBe(false);
    }
  });

  it("checks whole string values for random ids (M-C)", () => {
    const summary = summarize({ a: "a1b2c3d4e5f6g7h8", b: "a3f2b9c1e7d4f8a2b6c3e9d1f7a4b8c2", c: "a3f2b9c1-e7d4-f8a2-b6c3-e9d1f7a4b8c2", d: "ab1cd2ef3gh4" });
    for (const [path, field] of Object.entries(summary.fields)) expect(field.values, path).toBeUndefined();
    expect(allText(summary)).not.toMatch(/a1b2|a3f2|ab1cd2/);
  });

  it("produces the same hash for the same value at any path, and another under another key", () => {
    const summary = summarize({ a: "Same Value", b: ["Same Value"] });
    expect(summary.fields.a?.hashes).toEqual(summary.fields["b[]"]?.hashes);
    const other = summarizeToolArguments({ a: "Same Value" }, { detect: fakeDetect, hashKey: new Uint8Array(32).fill(8) });
    expect(other.fields.a?.hashes).not.toEqual(summary.fields.a?.hashes);
    expect(h("ｏｐｅｎ x")).toBe(h("open x"));
    expect(h(1)).not.toBe(h(2));
    expect(() => hashToolArgumentValue("x", new Uint8Array(8))).toThrow();
  });
});

describe("summarizeToolArguments: arrays and objects", () => {
  it("merges array elements per path with counts", () => {
    const summary = summarize({ files: [{ path: "/repo/a/b.ts", lines: 3 }, { path: "/repo/c/d.ts", lines: 10 }], tags: ["a", 1, null] });
    expect(summary.fields.files).toEqual({ type: "array", items: 2 });
    expect(summary.fields["files[]"]).toEqual({ type: "object", count: 2, keys: 2 });
    expect(summary.fields["files[].path"]).toEqual({
      type: "string",
      count: 2,
      hashes: [h("/repo/a/b.ts"), h("/repo/c/d.ts")].sort(),
      prefixes: ["/repo/"],
      len: "9-32"
    });
    expect(summary.fields["files[].lines"]).toEqual({ type: "number", count: 2, values: [3, 10], min: 3, max: 10 });
    expect(summary.fields["tags[]"]).toEqual({ type: "mixed", types: ["null", "number", "string"], count: 3, values: [1, "a"], min: 1, max: 1 });
  });

  it("drops the value and hash lists past the cap but keeps min and max", () => {
    const values = Array.from({ length: 40 }, (_, index) => index);
    const summary = summarize({ ids: values, refs: values.map((index) => `n${index}`), words: values.map((index) => `Word ${index}`) });
    expect(summary.fields["ids[]"]).toEqual({ type: "number", count: 40, min: 0, max: 39, more: true });
    expect(summary.fields["refs[]"]).toEqual({ type: "string", count: 40, more: true });
    expect(summary.fields["words[]"]).toEqual({ type: "string", count: 40, more: true, len: "1-8" });
  });

  it("summarises a non-object root under $", () => {
    expect(summarize(["a", "b"]).fields).toEqual({ $: { type: "array", items: 2 }, "$[]": { type: "string", count: 2, values: ["a", "b"] } });
    expect(summarize("hello").fields).toEqual({ $: { type: "string", values: ["hello"] } });
    expect(summarize(null)).toEqual({ v: 2, fields: {} });
    expect(summarize(undefined)).toEqual({ v: 2, fields: {} });
  });

  it("handles a __proto__ key as data, without touching prototypes", () => {
    const args = JSON.parse('{"__proto__": {"polluted": "yes"}, "constructor": "x"}') as unknown;
    const summary = summarize(args);
    const proto = `<k:${h("__proto__")}>`;
    expect(Object.keys(summary.fields)).toEqual([proto, `${proto}.polluted`, "constructor"]);
    expect(summary.fields[`${proto}.polluted`]).toEqual({ type: "string", values: ["yes"] });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(parseToolArgumentSummary(JSON.stringify(summary))).toEqual(summary);
  });
});

describe("summarizeToolArguments: adversarial input", () => {
  it("caps depth on deeply nested and cyclic objects", () => {
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let index = 0; index < 500; index += 1) deep = { a: deep };
    const summary = summarize(deep);
    expect(summary.truncated).toBe(true);
    expect(Object.keys(summary.fields).length).toBeLessThanOrEqual(TOOL_ARGUMENT_SUMMARY_LIMITS.maxDepth + 1);

    const cyclic: Record<string, unknown> = { label: "loop" };
    cyclic.self = cyclic;
    cyclic.list = [cyclic, cyclic];
    const cycled = summarize(cyclic);
    expect(cycled.truncated).toBe(true);
    expect(JSON.stringify(cycled).length).toBeLessThan(100_000);
  });

  it("caps paths, keys and array items on huge input", () => {
    const wide = Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`k${index}`, { [`n${index}`]: index }]));
    const summary = summarize(wide);
    expect(summary.truncated).toBe(true);
    expect(Object.keys(summary.fields).length).toBeLessThanOrEqual(TOOL_ARGUMENT_SUMMARY_LIMITS.maxFields);

    const long = summarize({ items: Array.from({ length: 100_000 }, (_, index) => index) });
    expect(long.truncated).toBe(true);
    expect(long.fields.items).toMatchObject({ type: "array", items: 100_000 });
    expect(long.fields["items[]"]?.count).toBe(TOOL_ARGUMENT_SUMMARY_LIMITS.maxArrayItems);
  });

  it("bounds detector work and never keeps an unscanned string", () => {
    let scannedChars = 0;
    const counting: ToolArgumentDetector = (text) => {
      scannedChars += text.length;
      return [];
    };
    // Key `a` and 32 strings of 8191 characters leave 31 characters of budget: key `b` fits, its value does not.
    const token = "word-word-word-word-word-word-wo";
    const args = { a: Array.from({ length: 40 }, () => "y".repeat(8_191)), b: token };
    const summary = summarizeToolArguments(args, { detect: counting, hashKey });
    expect(scannedChars).toBeLessThanOrEqual(TOOL_ARGUMENT_SUMMARY_LIMITS.scanBudgetChars);
    expect(summary.truncated).toBe(true);
    expect(summary.fields["a[]"]).toEqual({ type: "string", count: 40, len: "2049+" });
    // The token in `b` was not scanned, so it is not kept.
    expect(summary.fields.b).toEqual({ type: "string", hashes: [h(token)], len: "9-32" });
    // Without the huge array the same value is kept.
    expect(summarizeToolArguments({ b: token }, { detect: counting, hashKey }).fields.b).toEqual({ type: "string", values: [token] });
  });

  it("treats a detector that throws as not scanned", () => {
    const summary = summarizeToolArguments({ state: "open", n: 5 }, {
      hashKey,
      detect: () => {
        throw new Error("boom");
      }
    });
    // Keys could not be checked either, so both are hashed; the string is not kept.
    expect(summary.fields).toEqual({
      [`<k:${h("n")}>`]: { type: "number", values: [5], min: 5, max: 5 },
      [`<k:${h("state")}>`]: { type: "string", hashes: [h("open")], len: "1-8" }
    });
  });

  it("survives getters that throw, functions, symbols and bigints", () => {
    const hostile = {
      get boom() {
        throw new Error("nope");
      },
      fn: () => 1,
      sym: Symbol("s"),
      big: 10n,
      date: new Date(0),
      missing: undefined
    };
    const summary = summarize(hostile);
    expect(summary.truncated).toBe(true);
    expect(summary.fields.big).toEqual({ type: "number" });
    expect(summary.fields.date).toEqual({ type: "object", keys: 0 });
    expect(summary.fields).not.toHaveProperty("fn");
    expect(summary.fields).not.toHaveProperty("sym");
    expect(summary.fields).not.toHaveProperty("missing");
  });

  it("produces a summary the shared schema accepts, and rejects format 1", () => {
    const summary = summarize({ a: [1, "two", { three: true }], b: "https://x.io/y", c: "free text value", d: 12_345_678 });
    expect(parseToolArgumentSummary(summary)).toEqual(summary);
    expect(parseToolArgumentSummary("not json")).toBeNull();
    expect(parseToolArgumentSummary({ v: 1, fields: {} })).toBeNull();
  });
});

describe("summarizeToolArguments: property check", () => {
  /** Deterministic PRNG (mulberry32), so a failure reproduces. */
  function rng(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("never stores a raw value with four digits, @, whitespace, upper case, or from a sensitive path", () => {
    const random = rng(20261030);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
    const chars = (alphabet: string, min: number, max: number) =>
      Array.from({ length: min + Math.floor(random() * (max - min + 1)) }, () => pick([...alphabet])).join("");
    const generators: Array<() => string> = [
      () => chars("0123456789", 1, 20),
      () => chars("abcdefghijklmnopqrstuvwxyz", 1, 40),
      () => chars("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", 1, 20),
      () => chars("abcdef0123456789", 4, 40),
      () => `${chars("abcdefghij", 1, 8)}@${chars("abcdefghij", 1, 8)}.com`,
      () => `${chars("abcdefghij", 1, 8)} ${chars("abcdefghij", 1, 8)}`,
      () => chars("٠١٢٣٤٥٦٧٨٩０１２３４５６７８９", 4, 16),
      () => chars("abc-_.0123", 1, 32),
      () => `${pick(["sk-", "ghp_", "xoxb-", "glpat-", "AKIA"])}${chars("abcdef012345", 3, 20)}`,
      () => `${pick(["john", "jane", "alice"])}.${pick(["smith", "doe"])}`,
      () => `${pick(["/home/", "/Users/", "C:\\Users\\"])}${chars("abcdefgh", 2, 8)}/${chars("abc", 1, 4)}/x`,
      () => `https://${chars("abc0123", 1, 10)}.${chars("abcdef", 2, 8)}.example.com/${chars("abc", 1, 5)}`
    ];
    const sensitiveKeys = ["password", "userName", "to", "email", "apiKey", "message", "customer_id", "session"];
    const plainKeys = ["state", "kind", "mode", "label", "region", "path", "ref"];
    for (let index = 0; index < 1_000; index += 1) {
      const value = pick(generators)();
      const sensitive = pick(sensitiveKeys);
      const args = { [pick(plainKeys)]: value, [sensitive]: value, nested: { [sensitive]: { inner: value } }, list: [value], map: { [value]: 1 } };
      const summary = summarize(args);
      for (const path of Object.keys(summary.fields)) {
        for (const segment of path.split(/\.|\[\]/)) {
          if (segment === "" || segment.startsWith("<k:")) continue;
          expect(segment, value).not.toMatch(/\p{Nd}{4}|@|\s/u);
          expect(looksRandomToolArgumentKey(segment), `${segment} <- ${value}`).toBe(false);
          // Long camelCase names are kept on purpose, so the value rule's length limit does not apply to keys.
          if (segment.length <= 16) expect(looksRandomToolArgument(segment.toLowerCase()), `${segment} <- ${value}`).toBe(false);
        }
      }
      for (const kept of keptStrings(summary)) {
        expect(kept, value).not.toMatch(/\p{Nd}{4}|@|\s|\p{Lu}/u);
        expect(kept.length).toBeLessThanOrEqual(32);
      }
      for (const [path, field] of Object.entries(summary.fields)) {
        if (path.split(/[.[\]]/).some((segment) => segment !== "" && !segment.startsWith("<k:") && isSensitiveToolArgumentKey(segment))) {
          expect(field.values, `${path} <- ${value}`).toBeUndefined();
          expect(field.prefixes, `${path} <- ${value}`).toBeUndefined();
        }
        for (const prefix of field.prefixes ?? []) expect(prefix, value).not.toMatch(/\p{Nd}{4}|\s|^[^@]+@/u);
      }
    }
  });
});

describe("toolArgumentLengthBucket", () => {
  it("buckets lengths", () => {
    expect([0, 1, 8, 9, 32, 33, 128, 129, 512, 513, 2048, 2049].map(toolArgumentLengthBucket)).toEqual([
      "0",
      "1-8",
      "1-8",
      "9-32",
      "9-32",
      "33-128",
      "33-128",
      "129-512",
      "129-512",
      "513-2048",
      "513-2048",
      "2049+"
    ]);
  });
});
