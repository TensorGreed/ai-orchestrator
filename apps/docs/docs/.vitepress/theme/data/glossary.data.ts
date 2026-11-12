// Every glossary term for the theme: the A–Z index, <Term> tooltips and related-terms boxes.
// Terms with a page come from glossary/*.md; index-only terms (no page yet) from site/glossary-entries.ts.
import { createContentLoader } from "vitepress";
import { INDEX_ENTRIES } from "../../site/glossary-entries.js";

export interface GlossaryTerm {
  slug: string;
  url: string;
  /** Docs path to link to (no base): the term's page, or its entry on the A–Z index. */
  href: string;
  /** False for an index-only term: it has an entry on /glossary/ but no page. */
  hasPage: boolean;
  term: string;
  /** The page's description: one plain sentence that defines the term. */
  definition: string;
  related: string[];
  /** One of GLOSSARY_TOPICS. */
  topic: string;
  /** Index-only terms: the docs page that covers the matching L2M feature, if any. */
  docs?: string;
}

declare const data: GlossaryTerm[];
export { data };

export default createContentLoader("glossary/*.md", {
  transform(raw): GlossaryTerm[] {
    const pages: GlossaryTerm[] = raw
      .filter((page) => !page.url.endsWith("/"))
      .map((page) => {
        const slug = page.url.replace(/^.*\/glossary\//, "").replace(/\.html$/, "");
        return {
          slug,
          url: page.url,
          href: `/glossary/${slug}`,
          hasPage: true,
          term: String(page.frontmatter.term ?? page.frontmatter.title ?? ""),
          definition: String(page.frontmatter.definition ?? page.frontmatter.description ?? ""),
          related: Array.isArray(page.frontmatter.related) ? page.frontmatter.related.map(String) : [],
          topic: String(page.frontmatter.topic ?? "")
        };
      });
    // A page wins over an index entry with the same slug (the term was promoted).
    const withPage = new Set(pages.map((page) => page.slug));
    const entries: GlossaryTerm[] = INDEX_ENTRIES.filter((entry) => !withPage.has(entry.slug)).map((entry) => ({
      slug: entry.slug,
      url: `/glossary/#${entry.slug}`,
      href: `/glossary/#${entry.slug}`,
      hasPage: false,
      term: entry.term,
      definition: entry.definition,
      related: [],
      topic: entry.topic,
      ...(entry.docs ? { docs: entry.docs } : {})
    }));
    return [...pages, ...entries].sort((a, b) => a.term.localeCompare(b.term, "en", { sensitivity: "base" }));
  }
});
