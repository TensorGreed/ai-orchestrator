// Every blog post for the index on /blog/, newest first.
import { createContentLoader } from "vitepress";

export interface PostSummary {
  slug: string;
  url: string;
  title: string;
  description: string;
  /** YYYY-MM-DD */
  date: string;
  author: string;
}

declare const data: PostSummary[];
export { data };

const isoDate = (value: unknown) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "").slice(0, 10));

export default createContentLoader("blog/*.md", {
  transform(raw): PostSummary[] {
    return raw
      .filter((page) => !page.url.endsWith("/"))
      .map((page) => ({
        slug: page.url.replace(/^.*\/blog\//, "").replace(/\.html$/, ""),
        url: page.url,
        title: String(page.frontmatter.title ?? ""),
        description: String(page.frontmatter.description ?? ""),
        date: isoDate(page.frontmatter.date),
        author: String(page.frontmatter.author ?? "")
      }))
      .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
  }
});
