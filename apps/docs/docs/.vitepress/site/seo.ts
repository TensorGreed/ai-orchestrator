// Per-page head tags: canonical URL, Open Graph and Twitter cards with the page's own title,
// description and share image, and the page's JSON-LD (BreadcrumbList on every page, plus
// TechArticle, DefinedTerm, DefinedTermSet, CollectionPage or BlogPosting by kind).
import type { HeadConfig, PageData } from "vitepress";
import { docsUrl, hubSectionOf, pageKindOf, pageUrl, SITE, type Crumb } from "./sections.js";
import { LEVEL_LABELS, trackPositionOf, type Level } from "./tracks.js";

// The share card lives with the landing at the site root (source: scripts/social-card/).
export const DEFAULT_SOCIAL_CARD = `${SITE}/assets/social-card.png`;
export const DEFAULT_SOCIAL_CARD_ALT =
  "L2M: run and govern MCP agents, self-hosted. The L2M studio with an agent hub, its chat model, memory and MCP tools, and the run tape of a finished run.";

const ORGANIZATION = { "@type": "Organization", "@id": `${SITE}/#organization`, name: "TensorGreed", url: "https://tensorgreed.com" };
const WEBSITE = { "@type": "WebSite", "@id": `${SITE}/#website`, name: "L2M", url: `${SITE}/` };

/** Extra data the config attaches to every page in transformPageData. */
export interface HubPageData {
  breadcrumbs: Crumb[];
  readingMinutes?: number;
}

const isoDate = (timestamp: number | undefined): string | undefined =>
  timestamp && Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : undefined;

const fmString = (value: unknown): string => (typeof value === "string" ? value : value instanceof Date ? value.toISOString().slice(0, 10) : "");

/** A post's `date` frontmatter as an ISO date. YAML may already have turned it into a Date. */
export function postDate(frontmatter: Record<string, unknown>): string {
  return fmString(frontmatter.date).slice(0, 10);
}

export function socialImageOf(relativePath: string, frontmatter: Record<string, unknown>): { url: string; alt: string } {
  const own = fmString(frontmatter.image);
  if (own) return { url: own.startsWith("http") ? own : docsUrl(own), alt: fmString(frontmatter.imageAlt) || fmString(frontmatter.title) };
  const section = hubSectionOf(relativePath);
  if (section) return { url: docsUrl(section.socialImage), alt: section.socialImageAlt };
  return { url: DEFAULT_SOCIAL_CARD, alt: DEFAULT_SOCIAL_CARD_ALT };
}

export function jsonLdOf(pageData: PageData & Partial<HubPageData>, title: string, description: string): Record<string, unknown> {
  const url = pageUrl(pageData.relativePath);
  const kind = pageKindOf(pageData.relativePath);
  const frontmatter = pageData.frontmatter as Record<string, unknown>;
  const image = socialImageOf(pageData.relativePath, frontmatter).url;
  const modified = isoDate(pageData.lastUpdated);
  const headline = (fmString(frontmatter.title) || pageData.title || title).slice(0, 110);
  const graph: Record<string, unknown>[] = [];

  const crumbs = pageData.breadcrumbs ?? [];
  if (crumbs.length > 0) {
    graph.push({
      "@type": "BreadcrumbList",
      "@id": `${url}#breadcrumbs`,
      itemListElement: crumbs.map((crumb, index) => ({ "@type": "ListItem", position: index + 1, name: crumb.name, item: crumb.url }))
    });
  }

  const article = (type: string, extra: Record<string, unknown> = {}) => ({
    "@type": type,
    "@id": `${url}#article`,
    headline,
    description,
    url,
    mainEntityOfPage: url,
    inLanguage: "en",
    image,
    ...(modified ? { dateModified: modified } : {}),
    isPartOf: WEBSITE,
    publisher: ORGANIZATION,
    ...extra
  });

  switch (kind) {
    case "learn": {
      const position = trackPositionOf(pageData.relativePath.replace(/^learn\//, "").replace(/\.md$/, ""));
      const level = fmString(frontmatter.level) as Level;
      graph.push(
        article("TechArticle", {
          author: ORGANIZATION,
          ...(LEVEL_LABELS[level] ? { proficiencyLevel: LEVEL_LABELS[level] } : {}),
          ...(position ? { articleSection: position.track.title } : {}),
          ...(pageData.readingMinutes ? { timeRequired: `PT${pageData.readingMinutes}M` } : {})
        })
      );
      break;
    }
    case "glossary": {
      const term = fmString(frontmatter.term) || headline;
      graph.push({
        "@type": "DefinedTerm",
        "@id": `${url}#term`,
        name: term,
        description,
        url,
        inDefinedTermSet: { "@type": "DefinedTermSet", "@id": `${docsUrl("/glossary/")}#terms`, name: "L2M glossary", url: docsUrl("/glossary/") }
      });
      break;
    }
    case "recipe":
      // TechArticle, not HowTo: search engines no longer show HowTo rich results, and a recipe is a
      // workflow to import rather than numbered steps.
      graph.push(article("TechArticle", { author: ORGANIZATION, articleSection: "Recipes" }));
      break;
    case "post": {
      const published = postDate(frontmatter);
      const author = fmString(frontmatter.author);
      const authorUrl = fmString(frontmatter.authorUrl);
      graph.push(
        article("BlogPosting", {
          ...(published ? { datePublished: published } : {}),
          ...(published && !modified ? { dateModified: published } : {}),
          author: author ? { "@type": "Person", name: author, ...(authorUrl ? { url: authorUrl } : {}) } : ORGANIZATION
        })
      );
      break;
    }
    case "hub-index":
      if (pageData.relativePath === "glossary/index.md") {
        graph.push({ "@type": "DefinedTermSet", "@id": `${url}#terms`, name: "L2M glossary", description, url, inLanguage: "en", publisher: ORGANIZATION });
      } else if (pageData.relativePath === "blog/index.md") {
        graph.push({ "@type": "Blog", "@id": `${url}#blog`, name: "L2M blog", description, url, inLanguage: "en", publisher: ORGANIZATION });
      } else {
        graph.push({ "@type": "CollectionPage", "@id": `${url}#page`, name: headline, description, url, inLanguage: "en", isPartOf: WEBSITE });
      }
      break;
    case "docs-index":
      graph.push({ "@type": "CollectionPage", "@id": `${url}#page`, name: headline, description, url, inLanguage: "en", isPartOf: WEBSITE });
      break;
    case "docs-home":
      graph.push({ "@type": "WebPage", "@id": `${url}#page`, name: headline, description, url, inLanguage: "en", isPartOf: WEBSITE, about: { "@id": `${SITE}/#software` } });
      break;
    case "docs":
      graph.push(article("TechArticle", { author: ORGANIZATION }));
      break;
    default:
      break;
  }
  return { "@context": "https://schema.org", "@graph": graph };
}

/** The head tags VitePress adds to each page (transformHead). */
export function pageHeadTags(pageData: PageData & Partial<HubPageData>, title: string, description: string): HeadConfig[] {
  if (pageData.isNotFound || pageData.relativePath === "404.md") return [["meta", { name: "robots", content: "noindex" }]];
  const url = pageUrl(pageData.relativePath);
  const kind = pageKindOf(pageData.relativePath);
  const frontmatter = pageData.frontmatter as Record<string, unknown>;
  const image = socialImageOf(pageData.relativePath, frontmatter);
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
  const modified = isoDate(pageData.lastUpdated);
  if (isArticle && modified) tags.push(["meta", { property: "article:modified_time", content: modified }]);
  if (kind === "post" && postDate(frontmatter)) tags.push(["meta", { property: "article:published_time", content: postDate(frontmatter) }]);
  // `<` is escaped so the JSON can never close the script element early.
  tags.push(["script", { type: "application/ld+json" }, JSON.stringify(jsonLdOf(pageData, title, description)).replace(/</g, "\\u003c")]);
  return tags;
}
