// Per-page head tags: canonical URL, Open Graph and Twitter cards with the page's own title,
// description and share image, and the page's JSON-LD: a BreadcrumbList on every page, plus
// TechArticle (docs pages, Learn guides, recipes), DefinedTerm / DefinedTermSet (glossary),
// BlogPosting / Blog (blog) or CollectionPage (indexes). No FAQPage, HowTo or schema.org Recipe:
// search engines no longer show HowTo results and Recipe is for food.
// The landing's WebSite, Organization and SoftwareApplication nodes are referenced by @id.
import type { HeadConfig, PageData } from "vitepress";
import { docsUrl, hubSectionOf, pageKindOf, pageUrl, SITE, type Crumb } from "./sections.js";
import { INDEX_ENTRIES } from "./glossary-entries.js";
import { LEVEL_LABELS, trackById, type Level } from "./tracks.js";

// The share card lives with the landing at the site root (source: scripts/social-card/).
export const DEFAULT_SOCIAL_CARD = `${SITE}/assets/social-card.png`;
export const DEFAULT_SOCIAL_CARD_ALT =
  "L2M: run and govern MCP agents, self-hosted. The L2M studio with an agent hub, its chat model, memory and MCP tools, and the run tape of a finished run.";

const ORGANIZATION_ID = { "@id": `${SITE}/#organization` };
const WEBSITE_ID = { "@id": `${SITE}/#website` };
const SOFTWARE_ID = { "@id": `${SITE}/#software` };

/** Extra data the config attaches to every page in transformPageData. */
export interface HubPageData {
  breadcrumbs: Crumb[];
  readingMinutes?: number;
  /** ISO date the page was first committed, from git. */
  datePublished?: string;
  /** Index pages: the pages they list. */
  hasPart?: Crumb[];
  /** A per-page share card (docs path), when one was rendered. */
  socialCard?: string;
}

type HubPage = PageData & Partial<HubPageData>;

const isoDate = (timestamp: number | undefined): string | undefined =>
  timestamp && Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : undefined;

const fmString = (value: unknown): string => (typeof value === "string" ? value : value instanceof Date ? value.toISOString().slice(0, 10) : "");

/** A post's `date` frontmatter as an ISO date. YAML may already have turned it into a Date. */
export function postDate(frontmatter: Record<string, unknown>): string {
  return fmString(frontmatter.date).slice(0, 10);
}

export function socialImageOf(page: HubPage): { url: string; alt: string } {
  const frontmatter = page.frontmatter as Record<string, unknown>;
  const own = fmString(frontmatter.image) || page.socialCard || "";
  const title = fmString(frontmatter.title) || page.title;
  if (own) return { url: own.startsWith("http") ? own : docsUrl(own), alt: fmString(frontmatter.imageAlt) || `${title}. L2M, ${hubSectionOf(page.relativePath)?.label ?? "Docs"}.` };
  const section = hubSectionOf(page.relativePath);
  if (section) return { url: docsUrl(section.socialImage), alt: section.socialImageAlt };
  return { url: DEFAULT_SOCIAL_CARD, alt: DEFAULT_SOCIAL_CARD_ALT };
}

export function jsonLdOf(page: HubPage, title: string, description: string): Record<string, unknown> {
  const url = pageUrl(page.relativePath);
  const kind = pageKindOf(page.relativePath);
  const frontmatter = page.frontmatter as Record<string, unknown>;
  const image = socialImageOf(page).url;
  const modified = isoDate(page.lastUpdated);
  const headline = (fmString(frontmatter.title) || page.title || title).slice(0, 110);
  const graph: Record<string, unknown>[] = [];

  // The trail starts at the landing, as on the landing's own pages, so even the docs home has two items.
  const crumbs = page.breadcrumbs && page.breadcrumbs.length > 0 ? [{ name: "L2M", url: `${SITE}/` }, ...page.breadcrumbs] : [];
  if (crumbs.length > 0) {
    graph.push({
      "@type": "BreadcrumbList",
      "@id": `${url}#breadcrumbs`,
      itemListElement: crumbs.map((crumb, index) => ({ "@type": "ListItem", position: index + 1, name: crumb.name, item: crumb.url }))
    });
  }
  const parts = (page.hasPart ?? []).map((part) => ({ "@type": "WebPage", name: part.name, url: part.url }));

  const article = (type: string, extra: Record<string, unknown> = {}) => ({
    "@type": type,
    "@id": `${url}#article`,
    headline,
    description,
    url,
    mainEntityOfPage: url,
    inLanguage: "en",
    image,
    ...(page.datePublished ? { datePublished: page.datePublished } : {}),
    ...(modified ? { dateModified: modified } : {}),
    author: ORGANIZATION_ID,
    publisher: ORGANIZATION_ID,
    isPartOf: WEBSITE_ID,
    ...extra
  });
  const about = fmString(frontmatter.about);
  const aboutTerm = about ? { about: { "@type": "DefinedTerm", "@id": `${docsUrl(`/glossary/${about}`)}#term`, url: docsUrl(`/glossary/${about}`) } } : {};
  const level = LEVEL_LABELS[fmString(frontmatter.level) as Level];

  switch (kind) {
    case "learn": {
      const track = trackById(page.relativePath.split("/")[1] ?? "");
      graph.push(
        article("TechArticle", {
          ...(level ? { proficiencyLevel: level } : {}),
          ...(track ? { articleSection: track.title } : {}),
          ...(page.readingMinutes ? { timeRequired: `PT${page.readingMinutes}M` } : {}),
          ...aboutTerm
        })
      );
      break;
    }
    case "recipe": {
      graph.push(article("TechArticle", { articleSection: "Recipes", proficiencyLevel: level || "Beginner", ...aboutTerm }));
      break;
    }
    case "glossary": {
      const slug = page.relativePath.replace(/^glossary\//, "").replace(/\.md$/, "");
      graph.push({
        "@type": "DefinedTerm",
        "@id": `${url}#term`,
        name: fmString(frontmatter.term) || headline,
        description,
        url,
        termCode: slug,
        inDefinedTermSet: { "@id": `${docsUrl("/glossary/")}#termset` }
      });
      break;
    }
    case "post": {
      const published = postDate(frontmatter);
      const author = fmString(frontmatter.author);
      const authorUrl = fmString(frontmatter.authorUrl);
      graph.push(
        article("BlogPosting", {
          ...(published ? { datePublished: published } : {}),
          ...(published && !modified ? { dateModified: published } : {}),
          author: author && author !== "The L2M team" ? { "@type": "Person", name: author, ...(authorUrl ? { url: authorUrl } : {}) } : ORGANIZATION_ID,
          isPartOf: { "@id": `${docsUrl("/blog/")}#blog` }
        })
      );
      break;
    }
    case "hub-index":
    case "track-index":
    case "docs-index":
      if (page.relativePath === "glossary/index.md") {
        graph.push({
          "@type": "DefinedTermSet",
          "@id": `${url}#termset`,
          name: "L2M glossary",
          description,
          url,
          inLanguage: "en",
          publisher: ORGANIZATION_ID,
          hasDefinedTerm: [
            ...(page.hasPart ?? []).map((part) => ({ "@id": `${part.url}#term` })),
            // Index-only terms are defined on this page itself, under their own anchor.
            ...INDEX_ENTRIES.filter((entry) => !(page.hasPart ?? []).some((part) => part.url.endsWith(`/glossary/${entry.slug}`))).map((entry) => ({
              "@type": "DefinedTerm",
              "@id": `${url}#${entry.slug}`,
              name: entry.term,
              description: entry.definition,
              url: `${url}#${entry.slug}`,
              termCode: entry.slug,
              inDefinedTermSet: { "@id": `${url}#termset` }
            }))
          ]
        });
      } else if (page.relativePath === "blog/index.md") {
        graph.push({
          "@type": "Blog",
          "@id": `${url}#blog`,
          name: "L2M blog",
          description,
          url,
          inLanguage: "en",
          publisher: ORGANIZATION_ID,
          blogPost: (page.hasPart ?? []).map((part) => ({ "@id": `${part.url}#article` }))
        });
      } else {
        graph.push({ "@type": "CollectionPage", "@id": `${url}#page`, name: headline, description, url, inLanguage: "en", isPartOf: WEBSITE_ID, ...(parts.length > 0 ? { hasPart: parts } : {}) });
      }
      break;
    case "docs-home":
      graph.push({ "@type": "WebPage", "@id": `${url}#page`, name: headline, description, url, inLanguage: "en", isPartOf: WEBSITE_ID, about: SOFTWARE_ID });
      break;
    case "docs":
      graph.push(article("TechArticle", { about: SOFTWARE_ID }));
      break;
    default:
      break;
  }
  return { "@context": "https://schema.org", "@graph": graph };
}

/** The head tags VitePress adds to each page (transformHead). */
export function pageHeadTags(page: HubPage, title: string, description: string): HeadConfig[] {
  if (page.isNotFound || page.relativePath === "404.md") return [["meta", { name: "robots", content: "noindex" }]];
  const url = pageUrl(page.relativePath);
  const kind = pageKindOf(page.relativePath);
  const frontmatter = page.frontmatter as Record<string, unknown>;
  const image = socialImageOf(page);
  const isArticle = kind === "learn" || kind === "glossary" || kind === "recipe" || kind === "post" || kind === "docs";
  const tags: HeadConfig[] = [
    ["link", { rel: "canonical", href: url }],
    ["meta", { property: "og:type", content: isArticle ? "article" : "website" }],
    ["meta", { property: "og:url", content: url }],
    ["meta", { property: "og:title", content: title }],
    ["meta", { property: "og:description", content: description }],
    ["meta", { property: "og:image", content: image.url }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { property: "og:image:alt", content: image.alt }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:title", content: title }],
    ["meta", { name: "twitter:description", content: description }],
    ["meta", { name: "twitter:image", content: image.url }],
    ["meta", { name: "twitter:image:alt", content: image.alt }]
  ];
  const modified = isoDate(page.lastUpdated);
  const published = kind === "post" ? postDate(frontmatter) : page.datePublished;
  if (isArticle && published) tags.push(["meta", { property: "article:published_time", content: published }]);
  if (isArticle && modified) tags.push(["meta", { property: "article:modified_time", content: modified }]);
  // `<` is escaped so the JSON can never close the script element early.
  tags.push(["script", { type: "application/ld+json" }, JSON.stringify(jsonLdOf(page, title, description)).replace(/</g, "\\u003c")]);
  return tags;
}
