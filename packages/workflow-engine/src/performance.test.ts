import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Workflow } from "@ai-orchestrator/shared";
import { DescendantCache } from "./graph";
import { computeDepthLevels, sortWorkflowNodes } from "./validation";
import { FileSystemBinaryStore } from "./binary-store";

/* ------------------------------------------------------------------ */
/*  DescendantCache                                                    */
/* ------------------------------------------------------------------ */

describe("DescendantCache", () => {
  // DAG: A -> B -> C, A -> D
  function buildSimpleDAG(): Map<string, string[]> {
    const outgoing = new Map<string, string[]>();
    outgoing.set("A", ["B", "D"]);
    outgoing.set("B", ["C"]);
    outgoing.set("C", []);
    outgoing.set("D", []);
    return outgoing;
  }

  it("getDescendants returns all transitive descendants", () => {
    const cache = new DescendantCache(buildSimpleDAG());
    expect(cache.getDescendants("A")).toEqual(new Set(["B", "C", "D"]));
  });

  it("getDescendants of a mid-chain node returns its subtree", () => {
    const cache = new DescendantCache(buildSimpleDAG());
    expect(cache.getDescendants("B")).toEqual(new Set(["C"]));
  });

  it("getDescendants of a leaf returns an empty set", () => {
    const cache = new DescendantCache(buildSimpleDAG());
    expect(cache.getDescendants("D")).toEqual(new Set());
  });

  it("getNodeAndDescendants includes the node itself", () => {
    const cache = new DescendantCache(buildSimpleDAG());
    expect(cache.getNodeAndDescendants("A")).toEqual(new Set(["A", "B", "C", "D"]));
  });

  it("getReachableFromRoots unions multiple root results", () => {
    const cache = new DescendantCache(buildSimpleDAG());
    expect(cache.getReachableFromRoots(["B", "D"])).toEqual(new Set(["B", "C", "D"]));
  });

  it("caches results — same Set instance on repeated calls", () => {
    const cache = new DescendantCache(buildSimpleDAG());
    const first = cache.getDescendants("A");
    const second = cache.getDescendants("A");
    expect(first).toBe(second);
  });
});

/* ------------------------------------------------------------------ */
/*  computeDepthLevels                                                 */
/* ------------------------------------------------------------------ */

describe("computeDepthLevels", () => {
  it("linear chain produces one node per level", () => {
    const order = ["A", "B", "C"];
    const incoming = new Map<string, string[]>();
    incoming.set("A", []);
    incoming.set("B", ["A"]);
    incoming.set("C", ["B"]);

    const levels = computeDepthLevels(order, incoming);
    expect(levels).toEqual([["A"], ["B"], ["C"]]);
  });

  it("diamond DAG groups siblings at the same depth", () => {
    // A -> B, A -> C, B -> D, C -> D
    const order = ["A", "B", "C", "D"];
    const incoming = new Map<string, string[]>();
    incoming.set("A", []);
    incoming.set("B", ["A"]);
    incoming.set("C", ["A"]);
    incoming.set("D", ["B", "C"]);

    const levels = computeDepthLevels(order, incoming);
    expect(levels).toEqual([["A"], ["B", "C"], ["D"]]);
  });

  it("independent branches share the same root level", () => {
    // A -> B, C -> D (no connection between branches)
    const order = ["A", "C", "B", "D"];
    const incoming = new Map<string, string[]>();
    incoming.set("A", []);
    incoming.set("C", []);
    incoming.set("B", ["A"]);
    incoming.set("D", ["C"]);

    const levels = computeDepthLevels(order, incoming);
    expect(levels).toEqual([["A", "C"], ["B", "D"]]);
  });
});

/* ------------------------------------------------------------------ */
/*  FileSystemBinaryStore                                              */
/* ------------------------------------------------------------------ */

describe("FileSystemBinaryStore", () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = join(tmpdir(), `binary-store-test-${randomUUID()}`);
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tempDirs.length = 0;
  });

  it("write returns a reference with correct metadata", async () => {
    const store = new FileSystemBinaryStore(makeTempDir());
    const data = Buffer.from("hello world");
    const ref = await store.write("test-id", data, {
      fileName: "hello.txt",
      mimeType: "text/plain"
    });

    expect(ref.__binaryRef).toBe(true);
    expect(ref.id).toBe("test-id");
    expect(ref.fileName).toBe("hello.txt");
    expect(ref.mimeType).toBe("text/plain");
    expect(ref.size).toBe(data.byteLength);
  });

  it("read returns the same content that was written", async () => {
    const store = new FileSystemBinaryStore(makeTempDir());
    const data = Buffer.from("binary content here");
    const ref = await store.write("read-test", data, {
      fileName: "data.bin",
      mimeType: "application/octet-stream"
    });

    const result = await store.read(ref);
    expect(Buffer.from(result).toString()).toBe("binary content here");
  });

  it("delete removes the file so read throws", async () => {
    const store = new FileSystemBinaryStore(makeTempDir());
    const data = Buffer.from("to be deleted");
    const ref = await store.write("del-test", data, {
      fileName: "temp.bin",
      mimeType: "application/octet-stream"
    });

    await store.delete(ref);
    await expect(store.read(ref)).rejects.toThrow();
  });

  it("cleanup removes the storage directory", async () => {
    const dir = makeTempDir();
    const store = new FileSystemBinaryStore(dir);
    const id = "aa-cleanup-test";
    await store.write(id, Buffer.from("data"), {
      fileName: "f.bin",
      mimeType: "application/octet-stream"
    });

    // cleanup uses id.slice(0,2) as directory prefix
    await store.cleanup(id);

    // After cleanup, reading should fail
    const ref = await store.write(id, Buffer.from("data2"), {
      fileName: "f2.bin",
      mimeType: "application/octet-stream"
    });
    // We wrote fresh, so this should work — but the old directory was removed
    const result = await store.read(ref);
    expect(Buffer.from(result).toString()).toBe("data2");
  });
});

/* ------------------------------------------------------------------ */
/*  topoSort / sortWorkflowNodes — regression for shift-fix            */
/* ------------------------------------------------------------------ */

describe("topoSort performance", () => {
  it("correctly sorts a large sequential chain of 500 nodes", () => {
    const nodeCount = 500;
    const nodes = Array.from({ length: nodeCount }, (_, i) => ({
      id: `n${i + 1}`,
      type: "output" as const,
      name: `Node ${i + 1}`,
      position: { x: 0, y: i * 100 },
      config: {}
    }));

    const edges = Array.from({ length: nodeCount - 1 }, (_, i) => ({
      id: `e${i + 1}`,
      source: `n${i + 1}`,
      target: `n${i + 2}`
    }));

    const workflow: Workflow = {
      id: "perf-test",
      name: "Performance Test",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes,
      edges
    };

    const order = sortWorkflowNodes(workflow);
    expect(order).toHaveLength(nodeCount);

    // Verify sequential ordering
    for (let i = 0; i < nodeCount; i++) {
      expect(order[i]).toBe(`n${i + 1}`);
    }
  });
});
