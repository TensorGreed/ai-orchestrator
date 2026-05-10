/**
 * Chart rendering helper.
 *
 * Wraps Vega-Lite + Vega so a workflow `chart` node can render a JSON
 * spec (the same dialect Altair, Streamlit, and Observable use) into a
 * server-side SVG string. Pure-JS — no Cairo / native canvas / Python
 * deps. The SVG composes naturally with `pdf_output` since that node
 * already runs Chromium for HTML→PDF.
 *
 * Why Vega-Lite specifically:
 *   - It's the lingua franca of declarative charting. Operators can
 *     paste specs verbatim from the Vega Editor, Altair docs, or any
 *     LLM that knows the format.
 *   - One spec covers bar / line / area / pie / scatter / heatmap /
 *     histogram / boxplot / faceted small-multiples — no per-chart-type
 *     node explosion.
 *   - `vega` exposes `View.toSVG()` for headless rendering. No DOM, no
 *     browser, no native canvas.
 *
 * Tradeoffs:
 *   - Spec compilation is CPU-bound. Render time scales with data size;
 *     for >50k data points, downsample upstream first.
 *   - PNG output isn't shipped here — it would need `node-canvas`
 *     (native bindings, platform-fragile). SVG embedded in HTML covers
 *     both screen + PDF use cases.
 */

import * as vega from "vega";
import * as vegaLite from "vega-lite";
import type { TopLevelSpec } from "vega-lite";

export interface ChartRenderOptions {
  /** Vega-Lite top-level spec. Use {@link injectData} to merge data at runtime. */
  spec: TopLevelSpec | Record<string, unknown>;
  /**
   * Optional per-render data. When provided, replaces / fills `spec.data.values`.
   * Lets callers keep a static spec and feed dynamic rows in.
   */
  data?: unknown[];
  /**
   * Render width / height. Vega-Lite respects these as defaults but a
   * spec may override per-encoding. Pass them through verbatim.
   */
  width?: number;
  height?: number;
  /**
   * Vega config theme (background colour, axis style, etc.). Useful for
   * consistent branding across many charts.
   */
  config?: Record<string, unknown>;
}

export interface ChartRenderResult {
  svg: string;
  /** data: URL for embedding directly in HTML <img> tags or PDF templates. */
  dataUrl: string;
  /** Resolved (data-injected, merged) spec — useful for debugging. */
  resolvedSpec: Record<string, unknown>;
}

/**
 * Compile a Vega-Lite spec to Vega, render to SVG, and return both the
 * raw SVG string and a base64 data URL ready for `<img src="...">`.
 *
 * Throws on spec / data errors with a description that mentions which
 * stage failed (compile vs parse vs render). The dispatcher in executor.ts
 * surfaces the error to the workflow as a node failure.
 */
export async function renderChart(options: ChartRenderOptions): Promise<ChartRenderResult> {
  const merged = injectData(options.spec, options.data, options.width, options.height);

  let vegaSpec: vega.Spec;
  try {
    // Compile is loose at runtime — the spec is validated by Vega-Lite. We
    // double-cast through `unknown` because TopLevelSpec is a deeply-nested
    // discriminated union that can't be narrowed from a generic record.
    vegaSpec = vegaLite.compile(merged as unknown as TopLevelSpec).spec;
  } catch (err) {
    throw new Error(`vega-lite compile failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let view: vega.View;
  try {
    const runtime = vega.parse(vegaSpec, options.config);
    view = new vega.View(runtime, { renderer: "none" });
  } catch (err) {
    throw new Error(`vega parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let svg: string;
  try {
    svg = await view.toSVG();
  } catch (err) {
    throw new Error(`vega render failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    view.finalize();
  }

  return {
    svg,
    dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`,
    resolvedSpec: merged
  };
}

/**
 * Merge runtime data + dimensions into a Vega-Lite spec.
 *
 * Conventions:
 *   - When the spec has no `data` block, we inject `{ data: { values } }`.
 *   - When the spec already has `data.values`, runtime data overrides.
 *   - When the spec has `data.url` or `data.name`, runtime data is
 *     ignored (the spec wants its own data source — respect it).
 *
 * width/height fill the top level of the spec only when omitted, so
 * specs that set their own dimensions / encoding-driven sizes win.
 */
export function injectData(
  spec: TopLevelSpec | Record<string, unknown>,
  data: unknown[] | undefined,
  width: number | undefined,
  height: number | undefined
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(spec as Record<string, unknown>) };

  if (Array.isArray(data)) {
    const existingData = next.data as Record<string, unknown> | undefined;
    if (!existingData) {
      next.data = { values: data };
    } else if (existingData.url == null && existingData.name == null) {
      next.data = { ...existingData, values: data };
    }
  }

  if (typeof width === "number" && next.width == null) next.width = width;
  if (typeof height === "number" && next.height == null) next.height = height;

  return next;
}
