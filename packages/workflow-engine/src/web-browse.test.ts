import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import http from "node:http";
import { chromium } from "playwright";
import { browseUrl } from "./web-browse.js";
import { playwrightWebSocketGuard } from "./outbound-url-guard.js";

/**
 * Resolve the Chromium executable the same way web-browse.ts does:
 * PDF_CHROMIUM_EXECUTABLE_PATH wins, otherwise Playwright's bundled browser.
 * The rendering block is skipped (not failed) when neither exists, so the
 * suite stays green on machines that never ran `playwright install chromium`.
 */
function resolveChromiumExecutable(): string | undefined {
  const fromEnv = process.env.PDF_CHROMIUM_EXECUTABLE_PATH?.trim();
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
  try {
    const bundled = chromium.executablePath();
    return bundled && existsSync(bundled) ? bundled : undefined;
  } catch {
    return undefined;
  }
}

const chromiumExecutable = resolveChromiumExecutable();
const browserAvailable = Boolean(chromiumExecutable);
const skipReason = browserAvailable
  ? ""
  : "no Chromium executable found (set PDF_CHROMIUM_EXECUTABLE_PATH or run `pnpm exec playwright install chromium`)";

/**
 * Spin up an in-process HTTP server with a fixed HTML response so the
 * tests don't need internet access (and don't depend on any third party
 * staying up). Each test points Playwright at this URL.
 */

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Test Page</title>
  <meta name="description" content="A test page for web_browse">
  <meta property="og:title" content="OG Test Page">
  <meta property="og:image" content="http://localhost/cover.png">
  <link rel="icon" href="/favicon.ico" type="image/x-icon">
  <link rel="canonical" href="http://example.com/canonical">
</head>
<body>
  <h1>Welcome</h1>
  <p>The first paragraph contains <a href="https://target1.example.com/" rel="nofollow">link one</a>.</p>
  <p>The second paragraph mentions <a href="https://target2.example.com/about">link two</a>.</p>
  <img src="https://images.example.com/logo.png" alt="Brand logo" width="200" height="80">
  <img src="https://images.example.com/banner.jpg" alt="Banner">
</body>
</html>`;

const SPA_HTML = `<!doctype html>
<html><head><title>SPA</title></head>
<body>
  <div id="root">loading...</div>
  <script>
    setTimeout(() => {
      const el = document.getElementById('root');
      if (el) el.innerHTML = '<div id="loaded">hydrated content</div>';
    }, 50);
  </script>
</body></html>`;

let server: http.Server;
let baseUrl: string;
let upgradeAttempts = 0;

/**
 * Opens a WebSocket to this server and marks the page done when the socket settles (closed or errored), or after a long
 * fallback (a routed close does not always reach the page). A short fixed timer raced the guard's async check on loaded machines.
 */
const wsPage = (port: number) => `<!doctype html><html><head><title>ws</title></head><body><script>
  const ws = new WebSocket('ws://127.0.0.1:${port}/socket');
  const done = () => { if (!document.getElementById('done')) document.body.insertAdjacentHTML('beforeend', '<div id="done">done</div>'); };
  ws.onclose = done;
  ws.onerror = done;
  setTimeout(done, 6000);
</script></body></html>`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/ws-page") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(wsPage((server.address() as { port: number }).port));
    } else if (req.url === "/spa") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(SPA_HTML);
    } else if (req.url === "/404") {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<html><body>not found</body></html>");
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(HTML);
    }
  });
  // Count WebSocket upgrade attempts and refuse them; the page only needs to see the socket close.
  server.on("upgrade", (_request, socket) => {
    upgradeAttempts += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("web_browse", () => {
  describe("validation", () => {
    it("rejects file:// URLs", async () => {
      await expect(browseUrl({ url: "file:///etc/passwd" })).rejects.toThrow(/protocol/i);
    });

    it("rejects empty url", async () => {
      await expect(browseUrl({ url: "" })).rejects.toThrow(/required/i);
    });

    it("rejects malformed urls", async () => {
      await expect(browseUrl({ url: "not a url" })).rejects.toThrow(/invalid url/i);
    });

    it.skipIf(browserAvailable)("accepts http, https, and data URLs at validation time even without a browser", async () => {
      // Validation runs before the browser launch, so the only failure left is the launch itself.
      await expect(browseUrl({ url: "https://example.com" })).rejects.toThrow(/Executable|Playwright|launch/i);
    });
  });

  describe.skipIf(!browserAvailable)(`rendering (requires Playwright browsers)${skipReason ? ` [skipped: ${skipReason}]` : ""}`, () => {
    it("returns title, html, text, and meta tags", async () => {
      const r = await browseUrl({ url: baseUrl, screenshot: false });
      expect(r.status).toBe(200);
      expect(r.title).toBe("Test Page");
      expect(r.html).toMatch(/Welcome/);
      expect(r.text).toMatch(/Welcome/);
      expect(r.meta.description).toBe("A test page for web_browse");
      expect(r.meta["og:title"]).toBe("OG Test Page");
      expect(r.meta["og:image"]).toBe("http://localhost/cover.png");
    }, 30000);

    it("extracts links with text + rel", async () => {
      const r = await browseUrl({ url: baseUrl, screenshot: false });
      expect(r.links.length).toBeGreaterThanOrEqual(2);
      const firstLink = r.links.find((l) => l.href.includes("target1"));
      expect(firstLink).toBeDefined();
      expect(firstLink!.text).toBe("link one");
      expect(firstLink!.rel).toBe("nofollow");
    }, 30000);

    it("extracts images with src + alt + dimensions", async () => {
      const r = await browseUrl({ url: baseUrl, screenshot: false });
      const logo = r.images.find((img) => img.src.includes("logo.png"));
      expect(logo).toBeDefined();
      expect(logo!.alt).toBe("Brand logo");
    }, 30000);

    it("captures a screenshot as PNG data URL by default", async () => {
      const r = await browseUrl({ url: baseUrl });
      expect(r.screenshot).toMatch(/^data:image\/png;base64,/);
      expect(r.screenshot!.length).toBeGreaterThan(1000);
    }, 30000);

    it("captures linkTags so callers can find favicon / canonical", async () => {
      const r = await browseUrl({ url: baseUrl, screenshot: false });
      const favicon = r.linkTags.find((l) => l.rel === "icon");
      expect(favicon).toBeDefined();
      expect(favicon!.href).toMatch(/favicon/);
      const canonical = r.linkTags.find((l) => l.rel === "canonical");
      expect(canonical?.href).toBe("http://example.com/canonical");
    }, 30000);

    it("waitForSelector waits for SPA-rendered content", async () => {
      const r = await browseUrl({
        url: `${baseUrl}/spa`,
        waitForSelector: "#loaded",
        screenshot: false
      });
      expect(r.html).toMatch(/hydrated content/);
    }, 30000);

    it("returns the http status code on 4xx pages without throwing", async () => {
      const r = await browseUrl({ url: `${baseUrl}/404`, screenshot: false });
      expect(r.status).toBe(404);
      expect(r.html).toMatch(/not found/);
    }, 30000);

    it("skips text/links/images when those flags are off (lean output)", async () => {
      const r = await browseUrl({
        url: baseUrl,
        screenshot: false,
        extractText: false,
        extractLinks: false,
        extractImages: false
      });
      expect(r.text).toBe("");
      expect(r.links).toEqual([]);
      expect(r.images).toEqual([]);
      // Title + meta + html still present
      expect(r.title).toBe("Test Page");
      expect(r.html).toMatch(/Welcome/);
    }, 30000);

    it("a WebSocket the guard blocks never reaches the server; an allowed one does", async () => {
      // Under OUTBOUND_DENY_PRIVATE the loopback socket is blocked (the page itself is loaded without a request guard here).
      upgradeAttempts = 0;
      await browseUrl({
        url: `${baseUrl}/ws-page`,
        screenshot: false,
        waitForSelector: "#done",
        timeoutMs: 15000,
        webSocketGuard: playwrightWebSocketGuard({ denyPrivate: true, allowlist: [] })
      });
      expect(upgradeAttempts).toBe(0);
      await browseUrl({
        url: `${baseUrl}/ws-page`,
        screenshot: false,
        waitForSelector: "#done",
        timeoutMs: 15000,
        webSocketGuard: playwrightWebSocketGuard({ denyPrivate: false, allowlist: [] })
      });
      expect(upgradeAttempts).toBe(1);
    }, 45000);

    it("an allowed WebSocket still reaches the server when the guard is slow (loaded machine)", async () => {
      // A loaded CI core can take over a second to resolve the guard check and connect; the page must wait for the socket's outcome, not a fixed timer.
      upgradeAttempts = 0;
      const guard = playwrightWebSocketGuard({ denyPrivate: false, allowlist: [] });
      await browseUrl({
        url: `${baseUrl}/ws-page`,
        screenshot: false,
        waitForSelector: "#done",
        timeoutMs: 15000,
        webSocketGuard: async (ws) => {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          await guard(ws);
        }
      });
      expect(upgradeAttempts).toBe(1);
    }, 30000);
  });
});
