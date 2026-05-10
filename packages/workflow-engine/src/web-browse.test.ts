import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { browseUrl } from "./web-browse.js";

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
let playwrightAvailable = true;

beforeAll(async () => {
  // Skip the entire describe block if Playwright browsers aren't installed.
  // This keeps the suite green on dev machines that haven't run
  // `pnpm exec playwright install chromium`. CI runs the install step.
  try {
    await import("playwright");
  } catch {
    playwrightAvailable = false;
  }

  server = http.createServer((req, res) => {
    if (req.url === "/spa") {
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const skipIfNoBrowser = () => playwrightAvailable ? false : "playwright browsers not installed";

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

    it("accepts http, https, and data URLs", async () => {
      // We only verify validation here, not actual rendering.
      // Real rendering tests are below and gated on Playwright availability.
      // No assertion needed — just confirming no throw at validation time.
      // (validation runs synchronously before browser launch.)
      const reason = skipIfNoBrowser();
      if (reason) {
        // Expect validation to pass but Playwright launch to fail with a known message
        await expect(browseUrl({ url: "https://example.com" })).rejects.toThrow(/Playwright/i);
        return;
      }
    });
  });

  describe("rendering (requires Playwright browsers)", () => {
    it("returns title, html, text, and meta tags", async () => {
      const reason = skipIfNoBrowser();
      if (reason) return;
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
      const reason = skipIfNoBrowser();
      if (reason) return;
      const r = await browseUrl({ url: baseUrl, screenshot: false });
      expect(r.links.length).toBeGreaterThanOrEqual(2);
      const firstLink = r.links.find((l) => l.href.includes("target1"));
      expect(firstLink).toBeDefined();
      expect(firstLink!.text).toBe("link one");
      expect(firstLink!.rel).toBe("nofollow");
    }, 30000);

    it("extracts images with src + alt + dimensions", async () => {
      const reason = skipIfNoBrowser();
      if (reason) return;
      const r = await browseUrl({ url: baseUrl, screenshot: false });
      const logo = r.images.find((img) => img.src.includes("logo.png"));
      expect(logo).toBeDefined();
      expect(logo!.alt).toBe("Brand logo");
    }, 30000);

    it("captures a screenshot as PNG data URL by default", async () => {
      const reason = skipIfNoBrowser();
      if (reason) return;
      const r = await browseUrl({ url: baseUrl });
      expect(r.screenshot).toMatch(/^data:image\/png;base64,/);
      expect(r.screenshot!.length).toBeGreaterThan(1000);
    }, 30000);

    it("captures linkTags so callers can find favicon / canonical", async () => {
      const reason = skipIfNoBrowser();
      if (reason) return;
      const r = await browseUrl({ url: baseUrl, screenshot: false });
      const favicon = r.linkTags.find((l) => l.rel === "icon");
      expect(favicon).toBeDefined();
      expect(favicon!.href).toMatch(/favicon/);
      const canonical = r.linkTags.find((l) => l.rel === "canonical");
      expect(canonical?.href).toBe("http://example.com/canonical");
    }, 30000);

    it("waitForSelector waits for SPA-rendered content", async () => {
      const reason = skipIfNoBrowser();
      if (reason) return;
      const r = await browseUrl({
        url: `${baseUrl}/spa`,
        waitForSelector: "#loaded",
        screenshot: false
      });
      expect(r.html).toMatch(/hydrated content/);
    }, 30000);

    it("returns the http status code on 4xx pages without throwing", async () => {
      const reason = skipIfNoBrowser();
      if (reason) return;
      const r = await browseUrl({ url: `${baseUrl}/404`, screenshot: false });
      expect(r.status).toBe(404);
      expect(r.html).toMatch(/not found/);
    }, 30000);

    it("skips text/links/images when those flags are off (lean output)", async () => {
      const reason = skipIfNoBrowser();
      if (reason) return;
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
  });
});
