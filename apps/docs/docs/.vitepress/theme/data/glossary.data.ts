// Every glossary term for the theme: the A–Z index, <Term> tooltips and related-terms boxes.
import { createContentLoader } from "vitepress";

export interface GlossaryTerm {
  slug: string;
  url: string;
  term: string;
  /** The page's description: one plain sentence that defines the term. */
  definition: string;
  related: string[];
}

declare const data: GlossaryTerm[];
export { data };

export default createContentLoader("glossary/*.md", {
  transform(raw): GlossaryTerm[] {
    return raw
      .filter((page) => !page.url.endsWith("/"))
      .map((page) => ({
        slug: page.url.replace(/^.*\/glossary\//, "").replace(/\.html$/, ""),
        url: page.url,
        term: String(page.frontmatter.term ?? page.frontmatter.title ?? ""),
        definition: String(page.frontmatter.description ?? ""),
        related: Array.isArray(page.frontmatter.related) ? page.frontmatter.related.map(String) : []
      }))
      .sort((a, b) => a.term.localeCompare(b.term, "en", { sensitivity: "base" }));
  }
});
