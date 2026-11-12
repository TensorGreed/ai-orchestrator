// The blog's Atom feed, written at build time to <outDir>/blog/feed.xml (https://lsquarem.com/docs/blog/feed.xml).
// With no posts it is still a valid feed with no entries.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { blogPosts } from "./sidebars.js";
import { docsUrl } from "./sections.js";

export const FEED_PATH = "/blog/feed.xml";

const escapeXml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function atomFeed(now = new Date()): string {
  const posts = blogPosts();
  const feedUrl = docsUrl(FEED_PATH);
  const updated = posts.length > 0 ? `${posts[0].date}T00:00:00Z` : now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    "  <title>L2M blog</title>",
    "  <subtitle>Releases, design notes and field reports on running and governing MCP agents.</subtitle>",
    `  <id>${escapeXml(docsUrl("/blog/"))}</id>`,
    `  <link rel="alternate" type="text/html" href="${escapeXml(docsUrl("/blog/"))}"/>`,
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(feedUrl)}"/>`,
    `  <updated>${updated}</updated>`,
    "  <author><name>TensorGreed</name><uri>https://tensorgreed.com</uri></author>",
    `  <icon>${escapeXml(docsUrl("/favicon.svg"))}</icon>`
  ];
  for (const post of posts) {
    const url = docsUrl(`/blog/${post.slug}`);
    lines.push(
      "  <entry>",
      `    <title>${escapeXml(post.title)}</title>`,
      `    <id>${escapeXml(url)}</id>`,
      `    <link rel="alternate" type="text/html" href="${escapeXml(url)}"/>`,
      `    <published>${post.date}T00:00:00Z</published>`,
      `    <updated>${post.date}T00:00:00Z</updated>`,
      `    <author><name>${escapeXml(post.author)}</name></author>`,
      `    <summary>${escapeXml(post.description)}</summary>`,
      "  </entry>"
    );
  }
  lines.push("</feed>", "");
  return lines.join("\n");
}

export function writeFeed(outDir: string): void {
  const target = path.join(outDir, FEED_PATH);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, atomFeed());
}
