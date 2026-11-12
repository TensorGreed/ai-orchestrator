// Every Learn guide for the theme: the track cards on /learn/ and next / previous in track.
import { createContentLoader } from "vitepress";
import { readingMinutes } from "../../site/content.js";

export interface LearnGuide {
  slug: string;
  url: string;
  title: string;
  description: string;
  level: string;
  readingMinutes: number;
}

declare const data: LearnGuide[];
export { data };

export default createContentLoader("learn/*.md", {
  includeSrc: true,
  transform(raw): LearnGuide[] {
    return raw
      .filter((page) => !page.url.endsWith("/"))
      .map((page) => ({
        slug: page.url.replace(/^.*\/learn\//, "").replace(/\.html$/, ""),
        url: page.url,
        title: String(page.frontmatter.sidebarTitle ?? page.frontmatter.title ?? ""),
        description: String(page.frontmatter.description ?? ""),
        level: String(page.frontmatter.level ?? ""),
        readingMinutes: readingMinutes(page.src ?? "")
      }));
  }
});
