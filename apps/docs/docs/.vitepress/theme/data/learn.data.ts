// Every Learn guide and track index for the theme: track cards on /learn/, track indexes and
// next / previous in a track.
import { createContentLoader } from "vitepress";
import { readingMinutes } from "../../site/content.js";

export interface LearnGuide {
  /** Docs path: `/learn/agents/what-is-an-ai-agent`. */
  path: string;
  track: string;
  slug: string;
  title: string;
  description: string;
  level: string;
  readingMinutes: number;
}

declare const data: LearnGuide[];
export { data };

export default createContentLoader("learn/*/*.md", {
  includeSrc: true,
  transform(raw): LearnGuide[] {
    return raw
      .filter((page) => !page.url.endsWith("/"))
      .map((page) => {
        const path = page.url.replace(/^\/docs\//, "/").replace(/\.html$/, "");
        const [, , track = "", slug = ""] = path.split("/");
        return {
          path,
          track,
          slug,
          title: String(page.frontmatter.sidebarTitle ?? page.frontmatter.title ?? ""),
          description: String(page.frontmatter.description ?? ""),
          level: String(page.frontmatter.level ?? ""),
          readingMinutes: readingMinutes(page.src ?? "")
        };
      });
  }
});
