// Sidebars for the knowledge hub's sections, built from the pages on disk when the config loads.
import type { DefaultTheme } from "vitepress";
import { list, pagesIn, text, type SourcePage } from "./content.js";
import { LEVEL_LABELS, TRACKS } from "./tracks.js";

const titleOf = (page: SourcePage) => text(page.frontmatter.title) || page.heading || page.slug;

export function learnSidebar(): DefaultTheme.SidebarItem[] {
  const pages = new Map(pagesIn("learn").map((page) => [page.slug, page]));
  const inTrack = new Set(TRACKS.flatMap((track) => track.pages));
  for (const slug of pages.keys()) {
    if (!inTrack.has(slug)) console.warn(`[learn] learn/${slug}.md is in no track: add it to a track in .vitepress/site/tracks.ts`);
  }
  for (const track of TRACKS) {
    for (const slug of track.pages) if (!pages.has(slug)) throw new Error(`[learn] track "${track.id}" lists "${slug}", but learn/${slug}.md does not exist`);
  }
  return [
    { text: "All tracks", link: "/learn/" },
    ...TRACKS.map((track) => ({
      text: `${track.title} · ${LEVEL_LABELS[track.level]}`,
      collapsed: false,
      items: track.pages.map((slug) => ({ text: text(pages.get(slug)!.frontmatter.sidebarTitle) || titleOf(pages.get(slug)!), link: `/learn/${slug}` }))
    }))
  ];
}

export function glossarySidebar(): DefaultTheme.SidebarItem[] {
  const terms = pagesIn("glossary")
    .map((page) => ({ text: text(page.frontmatter.term) || titleOf(page), link: `/glossary/${page.slug}` }))
    .sort((a, b) => a.text.localeCompare(b.text, "en", { sensitivity: "base" }));
  return [{ text: "A–Z index", link: "/glossary/" }, { text: "Terms", items: terms }];
}

export function recipesSidebar(): DefaultTheme.SidebarItem[] {
  const recipes = pagesIn("recipes").map((page) => ({ text: titleOf(page), link: `/recipes/${page.slug}`, tags: list(page.frontmatter.tags) }));
  return [{ text: "All recipes", link: "/recipes/" }, { text: "Recipes", items: recipes.map(({ text: label, link }) => ({ text: label, link })) }];
}

export interface PostSummary {
  slug: string;
  title: string;
  description: string;
  date: string;
  author: string;
}

/** Blog posts, newest first. A post needs a `date: YYYY-MM-DD`; a post without one fails the build. */
export function blogPosts(): PostSummary[] {
  return pagesIn("blog")
    .map((page) => {
      const date = text(page.frontmatter.date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`[blog] blog/${page.slug}.md needs "date: YYYY-MM-DD" in its frontmatter`);
      if (!text(page.frontmatter.author)) throw new Error(`[blog] blog/${page.slug}.md needs an "author" in its frontmatter`);
      return { slug: page.slug, title: titleOf(page), description: text(page.frontmatter.description), date, author: text(page.frontmatter.author) };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

export function blogSidebar(): DefaultTheme.SidebarItem[] {
  const posts = blogPosts().slice(0, 12);
  return [{ text: "All posts", link: "/blog/" }, ...(posts.length > 0 ? [{ text: "Recent posts", items: posts.map((post) => ({ text: post.title, link: `/blog/${post.slug}` })) }] : [])];
}
