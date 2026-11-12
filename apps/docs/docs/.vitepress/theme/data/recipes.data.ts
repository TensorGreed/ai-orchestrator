// Every recipe for the card grid on /recipes/.
import { createContentLoader } from "vitepress";

export interface RecipeSummary {
  slug: string;
  url: string;
  title: string;
  description: string;
  tags: string[];
  nodeCount: number;
  demo: boolean;
}

declare const data: RecipeSummary[];
export { data };

export default createContentLoader("recipes/*.md", {
  transform(raw): RecipeSummary[] {
    return raw
      .filter((page) => !page.url.endsWith("/"))
      .map((page) => ({
        slug: page.url.replace(/^.*\/recipes\//, "").replace(/\.html$/, ""),
        url: page.url,
        title: String(page.frontmatter.title ?? ""),
        description: String(page.frontmatter.description ?? ""),
        tags: Array.isArray(page.frontmatter.tags) ? page.frontmatter.tags.map(String) : [],
        nodeCount: Number(page.frontmatter.nodeCount ?? 0),
        demo: typeof page.frontmatter.demo === "string" && page.frontmatter.demo !== ""
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }
});
