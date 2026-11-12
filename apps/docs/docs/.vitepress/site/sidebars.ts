// Sidebars for the knowledge hub's sections, built from the pages on disk when the config loads.
import type { DefaultTheme } from "vitepress";
import { hasIndex, pagesIn, text, type SourcePage } from "./content.js";
import { GLOSSARY_TOPICS, RECIPE_KEYS } from "./taxonomy.js";
import { TRACKS } from "./tracks.js";

const titleOf = (page: SourcePage) => text(page.frontmatter.sidebarTitle) || text(page.frontmatter.title) || page.heading || page.slug;

export function learnSidebar(): DefaultTheme.SidebarItem[] {
  const pages = new Map(pagesIn("learn", true).map((page) => [page.relativePath, page]));
  const listed = new Set(TRACKS.flatMap((track) => track.pages.map((slug) => `learn/${track.id}/${slug}.md`)));
  for (const file of pages.keys()) {
    if (!listed.has(file)) console.warn(`[learn] ${file} is in no track: list its slug in a track in .vitepress/site/tracks.ts`);
  }
  const groups: DefaultTheme.SidebarItem[] = [];
  for (const track of TRACKS) {
    const items = track.pages
      .map((slug) => pages.get(`learn/${track.id}/${slug}.md`))
      .filter((page): page is SourcePage => page !== undefined)
      .map((page) => ({ text: titleOf(page), link: `/learn/${track.id}/${page.slug}` }));
    if (items.length === 0) continue;
    groups.push({
      text: track.title,
      ...(hasIndex(`learn/${track.id}`) ? { link: `/learn/${track.id}/` } : {}),
      collapsed: false,
      items
    });
  }
  return [{ text: "Learn", items: [{ text: "All tracks", link: "/learn/" }, { text: "Glossary", link: "/glossary/" }] }, ...groups];
}

export function glossarySidebar(): DefaultTheme.SidebarItem[] {
  const terms = pagesIn("glossary").map((page) => ({ text: text(page.frontmatter.term) || titleOf(page), link: `/glossary/${page.slug}`, topic: text(page.frontmatter.topic) }));
  const byName = (a: { text: string }, b: { text: string }) => a.text.localeCompare(b.text, "en", { sensitivity: "base" });
  const groups = GLOSSARY_TOPICS.map((topic) => ({
    text: topic.label,
    collapsed: false,
    items: terms.filter((term) => term.topic === topic.id).sort(byName).map(({ text: label, link }) => ({ text: label, link }))
  })).filter((group) => group.items.length > 0);
  const other = terms.filter((term) => !GLOSSARY_TOPICS.some((topic) => topic.id === term.topic));
  for (const term of other) console.warn(`[glossary] glossary/${term.link.split("/").at(-1)}.md has no known "topic" (${GLOSSARY_TOPICS.map((topic) => topic.id).join(", ")})`);
  if (other.length > 0) groups.push({ text: "Other", collapsed: false, items: other.sort(byName).map(({ text: label, link }) => ({ text: label, link })) });
  return [{ text: "Glossary", items: [{ text: "A–Z index", link: "/glossary/" }, { text: "Learn", link: "/learn/" }] }, ...groups];
}

export function recipesSidebar(): DefaultTheme.SidebarItem[] {
  const recipes = pagesIn("recipes").map((page) => ({ text: titleOf(page), link: `/recipes/${page.slug}`, keys: text(page.frontmatter.keys) }));
  const groups = RECIPE_KEYS.map((group) => ({
    text: group.label,
    collapsed: false,
    items: recipes.filter((recipe) => recipe.keys === group.id).map(({ text: label, link }) => ({ text: label, link }))
  })).filter((group) => group.items.length > 0);
  return [{ text: "Recipes", items: [{ text: "All recipes", link: "/recipes/" }, { text: "Pattern library", link: "/patterns/" }] }, ...groups];
}

export interface PostSummary {
  slug: string;
  title: string;
  description: string;
  date: string;
  author: string;
}

/** Blog posts, newest first. A post needs `date: YYYY-MM-DD` and an `author`, or the build fails. */
export function blogPosts(): PostSummary[] {
  return pagesIn("blog")
    .map((page) => {
      const date = text(page.frontmatter.date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`[blog] blog/${page.slug}.md needs "date: YYYY-MM-DD" in its frontmatter`);
      if (!text(page.frontmatter.author)) throw new Error(`[blog] blog/${page.slug}.md needs an "author" in its frontmatter`);
      return { slug: page.slug, title: text(page.frontmatter.title) || page.heading, description: text(page.frontmatter.description), date, author: text(page.frontmatter.author) };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

export function blogSidebar(): DefaultTheme.SidebarItem[] {
  const posts = blogPosts();
  const years = [...new Set(posts.map((post) => post.date.slice(0, 4)))];
  return [
    { text: "Blog", items: [{ text: "All posts", link: "/blog/" }] },
    ...years.map((year) => ({ text: year, collapsed: false, items: posts.filter((post) => post.date.startsWith(year)).map((post) => ({ text: post.title, link: `/blog/${post.slug}` })) }))
  ];
}
