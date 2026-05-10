import { describe, expect, it } from "vitest";
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
