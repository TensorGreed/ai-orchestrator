import { describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { REPLAY_BLOCKED_LOAD_MARKER } from "@ai-orchestrator/shared";
import { injectData, renderChart } from "./chart.js";

describe("chart", () => {
  describe("injectData", () => {
    it("injects values when the spec has no data block", () => {
      const merged = injectData({ mark: "bar" }, [{ a: 1 }, { a: 2 }], 200, 150);
      expect((merged.data as { values: unknown[] }).values).toHaveLength(2);
      expect(merged.width).toBe(200);
      expect(merged.height).toBe(150);
    });

    it("respects existing data.values when no runtime data is supplied", () => {
      const merged = injectData(
        { mark: "bar", data: { values: [{ a: 1 }] } },
        undefined,
        undefined,
        undefined
      );
      expect((merged.data as { values: unknown[] }).values).toHaveLength(1);
    });

    it("runtime data overrides spec.data.values", () => {
      const merged = injectData(
        { mark: "bar", data: { values: [{ a: 1 }] } },
        [{ a: 9 }, { a: 10 }],
        undefined,
        undefined
      );
      expect((merged.data as { values: Array<{ a: number }> }).values[0]!.a).toBe(9);
      expect((merged.data as { values: unknown[] }).values).toHaveLength(2);
    });

    it("does not override data.url (spec wants its own data source)", () => {
      const merged = injectData(
        { mark: "bar", data: { url: "https://example.com/data.csv" } },
        [{ a: 1 }],
        undefined,
        undefined
      );
      expect((merged.data as { url: string; values?: unknown }).url).toBe("https://example.com/data.csv");
      expect((merged.data as { values?: unknown }).values).toBeUndefined();
    });

    it("does not stamp width/height when the spec already declared them", () => {
      const merged = injectData(
        { mark: "bar", width: 800, height: 600 },
        [{ a: 1 }],
        100,
        100
      );
      expect(merged.width).toBe(800);
      expect(merged.height).toBe(600);
    });
  });

  describe("renderChart", () => {
    it("renders a simple bar chart to SVG", async () => {
      const result = await renderChart({
        spec: {
          $schema: "https://vega.github.io/schema/vega-lite/v5.json",
          mark: "bar",
          encoding: {
            x: { field: "category", type: "nominal" },
            y: { field: "count", type: "quantitative" }
          }
        },
        data: [
          { category: "AWS", count: 12 },
          { category: "Azure", count: 8 },
          { category: "GCP", count: 5 }
        ],
        width: 300,
        height: 200
      });
      expect(result.svg).toMatch(/^<svg/);
      // Three bars → three rect elements (Vega emits more rects for axes/grid,
      // so just check the data labels actually rendered)
      expect(result.svg).toMatch(/AWS/);
      expect(result.svg).toMatch(/Azure/);
      expect(result.svg).toMatch(/GCP/);
    });

    it("returns a base64 SVG data URL ready for <img src>", async () => {
      const result = await renderChart({
        spec: { mark: "point", encoding: { x: { field: "x", type: "quantitative" } } },
        data: [{ x: 1 }, { x: 2 }]
      });
      expect(result.dataUrl.startsWith("data:image/svg+xml;base64,")).toBe(true);
      const decoded = Buffer.from(result.dataUrl.split(",")[1]!, "base64").toString("utf8");
      expect(decoded).toBe(result.svg);
    });

    it("throws with a useful message on a bad spec", async () => {
      await expect(
        renderChart({
          spec: { mark: "not-a-real-mark" } as Record<string, unknown>
        })
      ).rejects.toThrow();
    });

    it("renders a pie/arc chart from grouped data", async () => {
      const result = await renderChart({
        spec: {
          mark: { type: "arc", innerRadius: 40 },
          encoding: {
            theta: { field: "count", type: "quantitative" },
            color: { field: "algorithm", type: "nominal" }
          }
        },
        data: [
          { algorithm: "AES-256", count: 120 },
          { algorithm: "RSA-2048", count: 45 },
          { algorithm: "ECDSA", count: 30 }
        ]
      });
      expect(result.svg).toMatch(/^<svg/);
      expect(result.svg.length).toBeGreaterThan(500);
    });
  });
});

describe("chart offline mode (replays)", () => {
  it("refuses every data load and never contacts the URL, while the default mode still loads it", async () => {
    let hits = 0;
    const server = http.createServer((_request, response) => {
      hits += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ a: "x", b: 1 }]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const spec = { mark: "bar", data: { url: `http://127.0.0.1:${address.port}/exfil?secret=abc` }, encoding: { x: { field: "a", type: "nominal" }, y: { field: "b", type: "quantitative" } } };
    try {
      await expect(renderChart({ spec, offline: true })).rejects.toThrow(REPLAY_BLOCKED_LOAD_MARKER);
      expect(hits).toBe(0);
      await renderChart({ spec });
      expect(hits).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("chart links never crash the process", () => {
  /** Render, then let detached promises settle, and report any rejection nobody handled. */
  async function renderAndCollectUnhandled(options: Parameters<typeof renderChart>[0]) {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const outcome = await renderChart(options).then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error })
      );
      for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      return { outcome, unhandled };
    } finally {
      process.off("unhandledRejection", listener);
    }
  }

  const linkedBars = (href: string) => ({
    mark: "bar",
    data: { values: [{ a: "x", b: 1 }, { a: "y", b: 2 }] },
    encoding: { x: { field: "a", type: "nominal" }, y: { field: "b", type: "quantitative" }, href: { value: href } }
  });

  it("an offline chart with an href renders like a live one, with no unhandled rejection", async () => {
    const offline = await renderAndCollectUnhandled({ spec: linkedBars("https://example.com/"), offline: true });
    expect(offline.unhandled).toEqual([]);
    expect(offline.outcome.ok).toBe(true);
    const live = await renderAndCollectUnhandled({ spec: linkedBars("https://example.com/") });
    expect(live.unhandled).toEqual([]);
    expect(live.outcome.ok && offline.outcome.ok && offline.outcome.result.svg).toBe(live.outcome.ok && live.outcome.result.svg);
  });

  it("an href the loader refuses drops the link instead of crashing, live or offline", async () => {
    for (const offline of [false, true]) {
      const run = await renderAndCollectUnhandled({ spec: linkedBars("javascript:alert(1)"), offline });
      expect(run.unhandled).toEqual([]);
      expect(run.outcome.ok).toBe(true);
      if (run.outcome.ok) expect(run.outcome.result.svg).not.toContain("javascript:");
    }
  });

  it("an offline image mark is a blocked load, not a crash", async () => {
    const run = await renderAndCollectUnhandled({
      spec: { mark: "image", data: { values: [{ u: "https://example.com/a.png", x: 1 }] }, encoding: { url: { field: "u", type: "nominal" }, x: { field: "x", type: "quantitative" } } },
      offline: true
    });
    expect(run.unhandled).toEqual([]);
    expect(run.outcome.ok).toBe(false);
    if (!run.outcome.ok) expect(String(run.outcome.error)).toContain(REPLAY_BLOCKED_LOAD_MARKER);
  });
});
