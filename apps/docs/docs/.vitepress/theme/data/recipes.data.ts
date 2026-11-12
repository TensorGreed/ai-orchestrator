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
  /** One of RECIPE_KEYS: what it needs before it runs. */
  keys: string;
  keysNote: string;
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
        demo: typeof page.frontmatter.demo === "string" && page.frontmatter.demo !== "",
        keys: String(page.frontmatter.keys ?? ""),
        keysNote: String(page.frontmatter.keysNote ?? "")
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }
});
