// The sections of the docs site and how a page belongs to one. Shared by the config (head tags,
// JSON-LD, breadcrumbs) and the theme (breadcrumbs, headers), so it imports nothing from Node.

export const SITE = "https://lsquarem.com";
export const DOCS_BASE = "/docs/";

/** The knowledge hub's sections, each with its own index page, sidebar and share card. */
export type HubSectionId = "learn" | "glossary" | "recipes" | "blog";

export interface HubSection {
  id: HubSectionId;
  /** Nav and breadcrumb label. */
  label: string;
  /** Path inside the docs site, with leading and trailing slash. */
  path: string;
  /** Share card under /docs/social/, rendered by scripts/social-card/render-sections.mjs. */
  socialImage: string;
  socialImageAlt: string;
}

export const HUB_SECTIONS: Record<HubSectionId, HubSection> = {
  learn: {
    id: "learn",
    label: "Learn",
    path: "/learn/",
    socialImage: "/social/learn.png",
    socialImageAlt: "L2M Learn: guided tracks on MCP agents, tool calling and running agents safely."
  },
  glossary: {
    id: "glossary",
    label: "Glossary",
    path: "/glossary/",
    socialImage: "/social/glossary.png",
    socialImageAlt: "L2M Glossary: the terms behind MCP agents, explained in plain words."
  },
  recipes: {
    id: "recipes",
    label: "Recipes",
    path: "/recipes/",
    socialImage: "/social/recipes.png",
    socialImageAlt: "L2M Recipes: ready-to-import agent workflows with a diagram of every node."
  },
  blog: {
    id: "blog",
    label: "Blog",
    path: "/blog/",
    socialImage: "/social/blog.png",
    socialImageAlt: "The L2M blog: releases, design notes and field reports on MCP agents."
  }
};

/** Labels for the reference sections of the docs, by first path segment. */
export const DOCS_SECTION_LABELS: Record<string, string> = {
  "getting-started": "Getting started",
  guides: "Guides",
  patterns: "Patterns",
  product: "Product",
  architecture: "Architecture",
  runtime: "Runtime",
  nodes: "Nodes",
  security: "Security",
  extensions: "Extensions",
  api: "API",
  operations: "Operations",
  troubleshooting: "Troubleshooting"
};

export type PageKind =
  | "docs-home"
  | "docs"
  | "docs-index"
  | "hub-index"
  | "learn"
  | "glossary"
  | "recipe"
  | "post"
  | "not-found";

/** The hub section a page belongs to, if any. */
export function hubSectionOf(relativePath: string): HubSection | null {
  const first = relativePath.split("/")[0];
  return (HUB_SECTIONS as Record<string, HubSection>)[first] && relativePath.includes("/") ? HUB_SECTIONS[first as HubSectionId] : null;
}

export function pageKindOf(relativePath: string): PageKind {
  if (relativePath === "index.md") return "docs-home";
  if (relativePath === "404.md") return "not-found";
  const section = hubSectionOf(relativePath);
  const isIndex = /(^|\/)index\.md$/.test(relativePath);
  if (section) {
    if (isIndex) return "hub-index";
    return ({ learn: "learn", glossary: "glossary", recipes: "recipe", blog: "post" } as const)[section.id];
  }
  return isIndex ? "docs-index" : "docs";
}

/** The page's path inside the docs site: `foo/index.md` → `/foo/`, `foo.md` → `/foo`. */
export function pagePath(relativePath: string): string {
  return `/${relativePath.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "")}`;
}

/** The page's public URL. */
export function pageUrl(relativePath: string): string {
  return `${SITE}${DOCS_BASE}${pagePath(relativePath).slice(1)}`;
}

/** An absolute URL for a path inside the docs site (`/learn/` → https://lsquarem.com/docs/learn/). */
export function docsUrl(path: string): string {
  return `${SITE}${DOCS_BASE}${path.replace(/^\//, "")}`;
}

export interface Crumb {
  name: string;
  /** Absolute URL. */
  url: string;
}

/**
 * The breadcrumb trail of a page, from the site's home to the page itself.
 * `hasIndex` says whether a folder has an index page (the middle crumb links there; a section
 * without one is left out, so every crumb is a real page).
 */
export function breadcrumbsOf(relativePath: string, title: string, hasIndex: (folder: string) => boolean): Crumb[] {
  const trail: Crumb[] = [{ name: "L2M", url: `${SITE}/` }];
  const section = hubSectionOf(relativePath);
  const kind = pageKindOf(relativePath);
  if (kind === "docs-home") return [...trail, { name: "Docs", url: docsUrl("/") }];
  if (section) {
    trail.push({ name: section.label, url: docsUrl(section.path) });
    if (kind !== "hub-index") trail.push({ name: title, url: pageUrl(relativePath) });
    return trail;
  }
  trail.push({ name: "Docs", url: docsUrl("/") });
  const folders = relativePath.split("/").slice(0, -1);
  for (let depth = 1; depth <= folders.length; depth += 1) {
    const folder = folders.slice(0, depth).join("/");
    const isSelf = kind === "docs-index" && depth === folders.length;
    if (isSelf) break;
    if (hasIndex(folder)) {
      const label = depth === 1 ? (DOCS_SECTION_LABELS[folder] ?? folder) : folders[depth - 1].replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
      trail.push({ name: label, url: docsUrl(`/${folder}/`) });
    }
  }
  trail.push({ name: title, url: pageUrl(relativePath) });
  return trail;
}
