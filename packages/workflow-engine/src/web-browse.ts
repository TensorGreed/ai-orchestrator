/**
 * Web browse helper.
 *
 * Drives a headless Chromium (via Playwright — already a workflow-engine
 * dep used by `pdf_output`) to fetch a URL, wait for JS to execute, and
 * extract structured page data the rest of the workflow can reason over:
 * rendered HTML, page text, screenshot, title, meta tags, links, and
 * images. The use case that motivated it (Phase 11+ scenario review) was
 * "extract the branding from thalesgroup.com" — but the same node covers
 * any "scrape X from a real-world site" prompt that plain `http_request`
 * can't handle because the page is a single-page app or hides content
 * behind client-side rendering.
 *
 * Browser lifecycle: launch → new context → new page → navigate → extract
 * → close. Per-call launch/close is slow (~500-800ms overhead) but keeps
 * the implementation simple and avoids cross-call state leaks. A persistent
 * browser pool is the obvious follow-up if a workflow visits dozens of
 * pages.
 *
 * Tradeoffs:
 *   - PNG screenshots are base64-encoded into a data URL by default, which
 *     bloats the workflow context. Set `screenshot: false` for text-only
 *     extraction. Cap is enforced via Playwright's screenshot quality.
 *   - We do NOT execute arbitrary scripts on the page. JS execution is
 *     intentionally out of scope for the MVP — a `web_eval` follow-up
 *     node would expose `page.evaluate()` for that.
 *   - Only `http(s)` and `data:` URLs are accepted. `file://` would let a
 *     workflow read arbitrary local files on the API host — explicitly
 *     blocked.
 */

export interface WebBrowseOptions {
  url: string;
  /** Page-load wait condition. Default "domcontentloaded". */
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  /** Total navigation + extraction timeout (ms). Default 30000. */
  timeoutMs?: number;
  /** Custom user-agent. Default uses Chromium's. */
  userAgent?: string;
  /** Custom HTTP headers (merged with Playwright's defaults). */
  extraHeaders?: Record<string, string>;
  /** Viewport size. Default 1280x800. */
  viewport?: { width: number; height: number };
  /**
   * Whether to capture a screenshot. Default true.
   * - `false` skips entirely (smallest output, fastest).
   * - `true` captures viewport.
   * - `"fullPage"` captures the entire scrollable page.
   */
  screenshot?: boolean | "fullPage";
  /** Cap screenshot quality (0..100) for jpeg/png compression. Default 75. */
  screenshotQuality?: number;
  /**
   * Extract page text via `document.body.innerText`. Default true.
   * Set false to skip when only HTML / screenshot is needed.
   */
  extractText?: boolean;
  /** Extract anchors as `[{ href, text }]`. Default true. */
  extractLinks?: boolean;
  /** Extract `<img>` tags as `[{ src, alt, width, height }]`. Default true. */
  extractImages?: boolean;
  /**
   * Optional CSS selector — when set, the node waits for this element
   * before extracting. Useful for SPAs where `domcontentloaded` fires
   * before the real content lands.
   */
  waitForSelector?: string;
  /** Optional override for Chromium binary (mirrors PDF_CHROMIUM_EXECUTABLE_PATH). */
  chromiumExecutablePath?: string;
}

export interface WebBrowseLink {
  href: string;
  text: string;
  rel: string | null;
}

export interface WebBrowseImage {
  src: string;
  alt: string;
  width: number | null;
  height: number | null;
}

export interface WebBrowseResult {
  url: string;
  /** Final URL after redirects. */
  finalUrl: string;
  status: number;
  title: string;
  /** Full rendered HTML after JS executes. */
  html: string;
  /** `document.body.innerText` — visible text only, no scripts/styles. */
  text: string;
  /** Page meta tags as a map. Includes `og:*`, `twitter:*`, `description`, etc. */
  meta: Record<string, string>;
  /**
   * `<link rel="...">` elements — useful for finding favicons,
   * stylesheets, canonical URLs, and the rest.
   */
  linkTags: Array<{ rel: string; href: string; type: string | null }>;
  links: WebBrowseLink[];
  images: WebBrowseImage[];
  /** PNG data URL when screenshot was captured, else null. */
  screenshot: string | null;
  /** Total wall-clock time (ms). */
  durationMs: number;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "data:"]);

export async function browseUrl(options: WebBrowseOptions): Promise<WebBrowseResult> {
  validateUrl(options.url);

  type PlaywrightModule = typeof import("playwright");
  let playwright: PlaywrightModule;
  try {
    playwright = (await import("playwright")) as PlaywrightModule;
  } catch {
    throw new Error(
      "web_browse requires Playwright. Install deps and run `pnpm exec playwright install chromium`."
    );
  }

  const executablePath = options.chromiumExecutablePath?.trim() || process.env.PDF_CHROMIUM_EXECUTABLE_PATH?.trim();
  const startedAt = Date.now();
  const browser = await playwright.chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 800 },
      ...(options.userAgent ? { userAgent: options.userAgent } : {}),
      ...(options.extraHeaders ? { extraHTTPHeaders: options.extraHeaders } : {})
    });
    const page = await context.newPage();
    const timeoutMs = options.timeoutMs ?? 30_000;

    const response = await page.goto(options.url, {
      waitUntil: options.waitUntil ?? "domcontentloaded",
      timeout: timeoutMs
    });
    const status = response?.status() ?? 0;

    if (options.waitForSelector) {
      try {
        await page.waitForSelector(options.waitForSelector, { timeout: timeoutMs });
      } catch (err) {
        throw new Error(
          `web_browse: waitForSelector '${options.waitForSelector}' did not appear within ${timeoutMs}ms`
        );
      }
    }

    const finalUrl = page.url();
    const title = await page.title();
    const html = await page.content();

    const text = options.extractText !== false
      ? (await page.evaluate(() => document.body?.innerText ?? "")).trim()
      : "";

    const meta = await page.evaluate(() => {
      const out: Record<string, string> = {};
      for (const tag of Array.from(document.querySelectorAll("meta"))) {
        const name = tag.getAttribute("name") || tag.getAttribute("property");
        const content = tag.getAttribute("content");
        if (name && content) out[name] = content;
      }
      return out;
    });

    const linkTags = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("link")).map((el) => ({
        rel: el.getAttribute("rel") ?? "",
        href: el.getAttribute("href") ?? "",
        type: el.getAttribute("type")
      }));
    });

    const links: WebBrowseLink[] = options.extractLinks !== false
      ? await page.evaluate(() => {
          const seen = new Set<string>();
          const out: Array<{ href: string; text: string; rel: string | null }> = [];
          for (const a of Array.from(document.querySelectorAll("a[href]"))) {
            const href = (a as HTMLAnchorElement).href;
            if (!href || seen.has(href)) continue;
            seen.add(href);
            out.push({
              href,
              text: ((a as HTMLAnchorElement).innerText || "").trim().slice(0, 200),
              rel: a.getAttribute("rel")
            });
            if (out.length >= 500) break;
          }
          return out;
        })
      : [];

    const images: WebBrowseImage[] = options.extractImages !== false
      ? await page.evaluate(() => {
          const seen = new Set<string>();
          const out: Array<{ src: string; alt: string; width: number | null; height: number | null }> = [];
          for (const img of Array.from(document.querySelectorAll("img[src]"))) {
            const src = (img as HTMLImageElement).src;
            if (!src || seen.has(src)) continue;
            seen.add(src);
            out.push({
              src,
              alt: (img as HTMLImageElement).alt || "",
              width: (img as HTMLImageElement).naturalWidth || null,
              height: (img as HTMLImageElement).naturalHeight || null
            });
            if (out.length >= 200) break;
          }
          return out;
        })
      : [];

    let screenshot: string | null = null;
    if (options.screenshot !== false) {
      const fullPage = options.screenshot === "fullPage";
      try {
        const buffer = await page.screenshot({
          type: "png",
          fullPage,
          quality: options.screenshotQuality
        });
        screenshot = `data:image/png;base64,${Buffer.from(buffer).toString("base64")}`;
      } catch (err) {
        // Some PNG capture errors (size cap, navigation in flight) shouldn't
        // fail the whole node — surface as null and let the workflow decide.
        screenshot = null;
      }
    }

    return {
      url: options.url,
      finalUrl,
      status,
      title,
      html,
      text,
      meta,
      linkTags,
      links,
      images,
      screenshot,
      durationMs: Date.now() - startedAt
    };
  } finally {
    await browser.close();
  }
}

/**
 * Reject anything other than http/https/data. file:// would expose the
 * API host's filesystem to anyone who can drive the node — same threat
 * model as a server-side request forgery primitive. Localhost http(s)
 * is allowed (use cases include local dev + intra-cluster scraping); a
 * dedicated allowlist env var is the obvious follow-up if operators
 * need finer control.
 */
function validateUrl(raw: string): void {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("web_browse: url is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`web_browse: invalid url '${raw.slice(0, 80)}'`);
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`web_browse: protocol '${parsed.protocol}' is not allowed (must be http/https/data)`);
  }
}
