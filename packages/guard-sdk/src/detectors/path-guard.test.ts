import { describe, expect, it } from "vitest";
import type { GuardFinding } from "../types";
import { checkPath, createPathGuardDetector, type RealpathFn } from "./path-guard";

/** A fake filesystem: `/data/link` points at `/etc`, everything else is itself. */
const fakeRealpath: RealpathFn = async (path) => {
  if (path === "/data/link" || path.startsWith("/data/link/")) return path.replace("/data/link", "/etc");
  if (path === "/data/loop") return "/data/real";
  return path;
};

describe("path guard", () => {
  it("accepts paths inside a root, relative or absolute", async () => {
    expect((await checkPath("/data/reports/q1.csv", { roots: ["/data"], realpath: fakeRealpath })).ok).toBe(true);
    expect((await checkPath("reports/../reports/q1.csv", { roots: ["/data"], realpath: fakeRealpath })).ok).toBe(true);
    expect((await checkPath("/data", { roots: ["/data"], realpath: fakeRealpath })).ok).toBe(true);
  });

  it("blocks traversal, encoded traversal, null bytes and sibling roots", async () => {
    expect((await checkPath("../etc/passwd", { roots: ["/data"], realpath: fakeRealpath })).reason).toBe("traversal");
    expect((await checkPath("/data/../etc/passwd", { roots: ["/data"], realpath: fakeRealpath })).reason).toBe("traversal");
    expect((await checkPath("/data2/file", { roots: ["/data"], realpath: fakeRealpath })).reason).toBe("traversal");
    expect((await checkPath("..%2f..%2fetc/passwd", { roots: ["/data"], realpath: fakeRealpath })).reason).toBe("encoded_traversal");
    expect((await checkPath("/data/file\0.txt", { roots: ["/data"], realpath: fakeRealpath })).reason).toBe("null_byte");
    expect((await checkPath("/data/x", { roots: [], realpath: fakeRealpath })).reason).toBe("no_roots");
    expect((await checkPath("..\\..\\windows\\system32", { roots: ["/data"], realpath: fakeRealpath })).reason).toBe("traversal");
  });

  it("blocks symlink escapes through the injected realpath", async () => {
    const escaped = await checkPath("/data/link/passwd", { roots: ["/data"], realpath: fakeRealpath });
    expect(escaped.ok).toBe(false);
    expect(escaped.reason).toBe("symlink_escape");
    expect(escaped.real).toBe("/etc/passwd");
    const inside = await checkPath("/data/loop", { roots: ["/data"], realpath: fakeRealpath });
    expect(inside.ok).toBe(true);
  });

  it("reports realpath failures as a soft finding", async () => {
    const failing: RealpathFn = async () => {
      throw new Error("EACCES");
    };
    const result = await checkPath("/data/x", { roots: ["/data"], realpath: failing });
    expect(result.reason).toBe("realpath_failed");
  });

  it("detector scans path-like arguments", async () => {
    const detector = createPathGuardDetector({ realpath: fakeRealpath });
    const content = { path: "../../etc/shadow", mode: "r", other: "/data/link/x" };
    const text = JSON.stringify(content);
    const findings = (await detector.detect({ channel: "tool_arguments", content }, { text, options: { roots: ["/data"] }, now: () => 0 })) as GuardFinding[];
    expect(findings.map((f) => f.metadata?.reason)).toEqual(["traversal", "symlink_escape"]);
    expect(text.slice(findings[0]!.spans[0]!.start, findings[0]!.spans[0]!.end)).toBe("../../etc/shadow");
    const clean = (await detector.detect({ channel: "tool_arguments", content: { path: "reports/q1.csv" } }, { text: "", options: { roots: ["/data"] }, now: () => 0 })) as GuardFinding[];
    expect(clean).toEqual([]);
  });
});
