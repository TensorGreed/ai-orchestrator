import { copyFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { firstPublished, hasIndex, pageExists, pageSocialCard, pagesIn, readingMinutes, SRC_DIR, text } from "./site/content.js";
import { FEED_PATH, writeFeed } from "./site/feed.js";
import { INDEX_ENTRIES } from "./site/glossary-entries.js";
import { breadcrumbsOf, defaultFolderLabel, docsUrl, hubSectionOf, pageKindOf, type Crumb } from "./site/sections.js";
import { pageHeadTags, type HubPageData } from "./site/seo.js";
import { blogPosts, blogSidebar, glossarySidebar, learnSidebar, recipesSidebar } from "./site/sidebars.js";
import { LEVEL_LABELS, trackById, TRACKS } from "./site/tracks.js";

const BLOG_IS_EMPTY = blogPosts().length === 0;

// One consent script serves the landing and the docs. It lives with the landing (repo-root
// docs/site-consent.js); copy it into public/ so VitePress serves it in dev and ships it in the
// build at /docs/site-consent.js (public/site-consent.js is generated and git-ignored).
copyFileSync(
  fileURLToPath(new URL("../../../../docs/site-consent.js", import.meta.url)),
  fileURLToPath(new URL("../public/site-consent.js", import.meta.url))
);

/** Frontmatter every page of a knowledge-hub section must carry; the build stops without it. */
const REQUIRED_FRONTMATTER: Record<string, string[]> = {
  learn: ["title", "description", "level"],
  glossary: ["title", "description", "term", "topic"],
  recipe: ["title", "description", "keys"],
  post: ["title", "description", "date", "author"],
  "hub-index": ["title", "description"],
  "track-index": ["title", "description"]
};

/** Breadcrumb label of a folder: a Learn track's short title, else the section's label. */
function folderLabel(folder: string): string {
  const track = folder.startsWith("learn/") ? trackById(folder.slice("learn/".length)) : undefined;
  return track?.shortTitle ?? defaultFolderLabel(folder);
}

const crumbOf = (relativePath: string, name: string): Crumb => ({ name, url: docsUrl(`/${relativePath.replace(/\.md$/, "")}`) });

/** The pages an index lists, for its CollectionPage, DefinedTermSet or Blog JSON-LD. */
function partsOf(relativePath: string): Crumb[] {
  const titleOf = (page: { frontmatter: Record<string, string | string[]>; heading: string }) => text(page.frontmatter.title) || page.heading;
  if (relativePath === "learn/index.md" || /^learn\/[^/]+\/index\.md$/.test(relativePath)) {
    const only = relativePath === "learn/index.md" ? null : relativePath.split("/")[1];
    const pages = new Map(pagesIn("learn", true).map((page) => [page.relativePath, page]));
    return TRACKS.filter((track) => only === null || track.id === only).flatMap((track) =>
      track.pages.map((slug) => pages.get(`learn/${track.id}/${slug}.md`)).filter((page) => page !== undefined).map((page) => crumbOf(page.relativePath, titleOf(page)))
    );
  }
  if (relativePath === "glossary/index.md") return pagesIn("glossary").map((page) => crumbOf(page.relativePath, text(page.frontmatter.term) || titleOf(page)));
  if (relativePath === "recipes/index.md") return pagesIn("recipes").map((page) => crumbOf(page.relativePath, titleOf(page)));
  if (relativePath === "blog/index.md") return blogPosts().map((post) => crumbOf(`blog/${post.slug}.md`, post.title));
  return [];
}

export default defineConfig({
  title: "L2M",
  description: "Documentation for L2M, the open-source, self-hosted studio and runtime to build, run and govern MCP agents.",
  lang: "en",
  // Served as a subpath under lsquarem.com — the marketing landing lives at
  // the root, the VitePress build is mounted at /docs/. The Pages deployment
  // workflow at .github/workflows/pages.yml merges both into a single
  // artifact before publishing.
  base: "/docs/",
  cleanUrls: true,
  // An empty blog index is thin content: it stays out of the sitemap and search until the first post.
  sitemap: { hostname: "https://lsquarem.com/docs/", transformItems: (items) => (BLOG_IS_EMPTY ? items.filter((item) => item.url !== "blog/") : items) },
  // Generated table pulled into product/importing-from-another-builder.md with @include; not a page of its own.
  srcExclude: ["product/external-import-coverage.md"],
  // The local search index (about 1 MB) is one chunk, loaded only when the search box opens.
  vite: { build: { chunkSizeWarningLimit: 1200 } },
  // "Last updated" on every page, and dateModified in its JSON-LD (from git).
  lastUpdated: true,
  head: [
    ["script", { src: "/docs/site-consent.js", defer: "" }],
    ["link", { rel: "icon", type: "image/svg+xml", href: "/docs/favicon.svg" }],
    ["link", { rel: "alternate", type: "application/atom+xml", title: "L2M blog", href: `/docs${FEED_PATH}` }],
    ["meta", { name: "theme-color", content: "#07090f" }],
    ["meta", { property: "og:site_name", content: "L2M" }]
  ],
  // Every page gets its breadcrumb trail (shown by the theme, and in its JSON-LD); guides and posts
  // also get a reading time. Pages of the knowledge hub must carry their section's frontmatter.
  transformPageData(pageData) {
    const kind = pageKindOf(pageData.relativePath);
    const missing = (REQUIRED_FRONTMATTER[kind] ?? []).filter((key) => pageData.frontmatter[key] === undefined || pageData.frontmatter[key] === "");
    if (missing.length > 0 && !pageData.isNotFound) {
      throw new Error(`${pageData.relativePath}: add ${missing.map((key) => `"${key}"`).join(", ")} to the frontmatter (templates: docs/.vitepress/templates/)`);
    }
    const fmIn = pageData.frontmatter as Record<string, unknown>;
    if (fmIn.level !== undefined && !(String(fmIn.level) in LEVEL_LABELS)) {
      throw new Error(`${pageData.relativePath}: "level" must be one of ${Object.keys(LEVEL_LABELS).join(", ")} (got "${String(fmIn.level)}")`);
    }
    // Glossary slugs: `about` feeds the JSON-LD, so a missing term is dropped (with a warning) rather
    // than left as a dangling reference; `related` terms not written yet are skipped where shown.
    if (typeof fmIn.about === "string" && !pageExists(`/glossary/${fmIn.about}`)) {
      console.warn(`[glossary] ${pageData.relativePath}: "about: ${fmIn.about}" names no glossary page yet; left out of the JSON-LD`);
      delete pageData.frontmatter.about;
    }
    if (Array.isArray(fmIn.related) && !pageData.relativePath.startsWith("glossary/")) {
      const indexOnly = new Set(INDEX_ENTRIES.map((entry) => entry.slug));
      const absent = fmIn.related.map(String).filter((slug) => !pageExists(`/glossary/${slug}`) && !indexOnly.has(slug));
      if (absent.length > 0) console.warn(`[glossary] ${pageData.relativePath}: related terms not written yet (skipped): ${absent.join(", ")}`);
    }
    // Breadcrumbs use the short label (sidebar title, term, section or track name), not the SEO title.
    const section = hubSectionOf(pageData.relativePath);
    const fm = pageData.frontmatter as Record<string, unknown>;
    const name =
      kind === "hub-index" && section
        ? section.label
        : kind === "track-index"
          ? folderLabel(pageData.relativePath.replace(/\/index\.md$/, ""))
          : kind === "docs-index"
            ? defaultFolderLabel(pageData.relativePath.replace(/\/index\.md$/, ""))
            : String(fm.sidebarTitle ?? fm.term ?? pageData.title ?? "");
    const extra: HubPageData = { breadcrumbs: breadcrumbsOf(pageData.relativePath, name, hasIndex, folderLabel) };
    if (kind === "learn" || kind === "post" || kind === "recipe") {
      extra.readingMinutes = readingMinutes(readFileSync(path.join(SRC_DIR, pageData.filePath), "utf8"));
    }
    if (kind === "learn" || kind === "glossary" || kind === "recipe" || kind === "docs") {
      const published = firstPublished(pageData.filePath);
      if (published) extra.datePublished = published;
    }
    if (kind === "hub-index" || kind === "track-index") extra.hasPart = partsOf(pageData.relativePath);
    const card = pageSocialCard(pageData.relativePath);
    if (card) extra.socialCard = card;
    // Learn guides get their own "next in this track" link (TrackNav); the theme's sidebar-order links would cross tracks.
    if (kind === "learn") {
      pageData.frontmatter.prev = false;
      pageData.frontmatter.next = false;
    }
    return extra;
  },
  // Per page: canonical URL, share tags with its own title, description and image, and JSON-LD.
  // The 404 page is kept out of search results instead.
  transformHead({ pageData, title, description }) {
    const tags = pageHeadTags(pageData, title, description);
    if (BLOG_IS_EMPTY && pageData.relativePath === "blog/index.md") tags.push(["meta", { name: "robots", content: "noindex" }]);
    return tags;
  },
  buildEnd(siteConfig) {
    writeFeed(siteConfig.outDir);
  },
  themeConfig: {
    nav: [
      { text: "← lsquarem.com", link: "https://lsquarem.com/", target: "_self" },
      { text: "Learn", link: "/learn/", activeMatch: "^/learn/" },
      { text: "Glossary", link: "/glossary/", activeMatch: "^/glossary/" },
      { text: "Recipes", link: "/recipes/", activeMatch: "^/recipes/" },
      { text: "Blog", link: "/blog/", activeMatch: "^/blog/" },
      {
        text: "Docs",
        activeMatch: "^/(?!learn/|glossary/|recipes/|blog/)",
        items: [
          { text: "Docs home", link: "/" },
          { text: "Why L2M", link: "/why" },
          { text: "Quickstart", link: "/getting-started/build-your-first-mcp-agent" },
          { text: "Guides", link: "/guides/" },
          { text: "Patterns", link: "/patterns/" },
          { text: "Architecture", link: "/architecture/overview" },
          { text: "Nodes", link: "/nodes/core-nodes" },
          { text: "API", link: "/api/endpoints" }
        ]
      },
      { text: "Live demo", link: "https://lsquarem.com/demo/", target: "_self" }
    ],
    search: { provider: "local" },
    // Each knowledge-hub section has its own sidebar; every other page shares the docs sidebar.
    sidebar: {
      "/learn/": learnSidebar(),
      "/glossary/": glossarySidebar(),
      "/recipes/": recipesSidebar(),
      "/blog/": blogSidebar(),
      "/": [
      {
        text: "Concepts",
        items: [
          { text: "Learn: guided tracks", link: "/learn/" },
          { text: "Glossary", link: "/glossary/" },
          { text: "Recipes", link: "/recipes/" }
        ]
      },
      {
        text: "Introduction",
        items: [
          { text: "Why L2M?", link: "/why" }
        ]
      },
      {
        text: "Getting Started",
        items: [
          { text: "Build your first MCP agent in 5 min", link: "/getting-started/build-your-first-mcp-agent" },
          { text: "Quickstart", link: "/getting-started/quickstart" },
          { text: "Environment", link: "/getting-started/environment" },
          { text: "VS Code Extension", link: "/getting-started/vscode-extension" }
        ]
      },
      {
        text: "Guides",
        items: [
          { text: "All guides", link: "/guides/" },
          { text: "Run a self-hosted MCP gateway", link: "/guides/self-hosted-mcp-gateway" },
          { text: "Govern MCP tools", link: "/guides/govern-mcp-tools" },
          { text: "Least privilege from real runs", link: "/guides/least-privilege-from-real-runs" },
          { text: "Test MCP servers in CI", link: "/guides/test-mcp-servers-in-ci" },
          { text: "CI for AI agents", link: "/guides/ci-for-ai-agents" },
          { text: "Human approval for agent tool calls", link: "/guides/human-approval-for-agent-tool-calls" }
        ]
      },
      {
        text: "Patterns",
        items: [{ text: "Pattern library", link: "/patterns/" }]
      },
      {
        text: "Product",
        items: [
          { text: "Workflow Editor", link: "/product/workflow-editor" },
          { text: "Importing from another builder", link: "/product/importing-from-another-builder" },
          { text: "MCP server registry", link: "/product/mcp-server-registry" },
          { text: "MCP control plane", link: "/product/mcp-control-plane" },
          { text: "MCP tool-call telemetry", link: "/product/mcp-tool-call-telemetry" },
          { text: "MCP tool policy", link: "/product/mcp-tool-policy" },
          { text: "MCP gateway", link: "/product/mcp-gateway" },
          { text: "/v1 AI gateway", link: "/product/ai-gateway" },
          { text: "Budgets", link: "/product/budgets" },
          { text: "MCP onboarding and catalog", link: "/product/mcp-onboarding" },
          { text: "Testing MCP workflows", link: "/product/testing-mcp-workflows" },
          { text: "Golden runs and replay", link: "/product/golden-runs" },
          { text: "Golden sets and replay jobs", link: "/product/golden-sets" },
          { text: "Production capture", link: "/product/production-capture" },
          { text: "Release gate and publish", link: "/product/release-gate" },
          { text: "Replay in CI and the release gate", link: "/product/replay-and-release-gate" },
          { text: "Approval gates", link: "/product/approvals" },
          { text: "Content rules engine", link: "/product/content-rules-engine" },
          { text: "Content rules in workflows", link: "/product/content-rules" },
          { text: "Output checks", link: "/product/content-rules-output-checks" },
          { text: "Rule set simulation", link: "/product/content-rules-simulation" },
          { text: "Content rules benchmark", link: "/product/content-rules-benchmark" },
          { text: "Data labels and destinations", link: "/product/data-labels-and-destinations" }
        ]
      },
      {
        text: "Architecture",
        items: [{ text: "Overview", link: "/architecture/overview" }]
      },
      {
        text: "Runtime",
        items: [
          { text: "Agent Loop", link: "/runtime/agent-loop" },
          { text: "Expose a Workflow as an MCP Tool", link: "/runtime/workflow-as-mcp-tool" },
          { text: "Built-in Agent Tools", link: "/runtime/built-in-agent-tools" },
          { text: "Workflow Tool", link: "/runtime/workflow-tool" }
        ]
      },
      {
        text: "Nodes",
        items: [
          { text: "Core Nodes", link: "/nodes/core-nodes" },
          { text: "Azure Nodes", link: "/nodes/azure-nodes" },
          { text: "Chart (Vega-Lite)", link: "/nodes/chart" },
          { text: "Web Browse (Playwright)", link: "/nodes/web-browse" },
          { text: "Knowledge Bases (built-in)", link: "/nodes/knowledge-bases" },
          { text: "Vector Stores", link: "/nodes/vector-stores" },
          {
            text: "Reference (auto-generated)",
            collapsed: true,
            items: [
              { text: "Overview", link: "/nodes/reference/" },
              { text: "Input", link: "/nodes/reference/input" },
              { text: "LLM", link: "/nodes/reference/llm" },
              { text: "Agent", link: "/nodes/reference/agent" },
              { text: "MCP", link: "/nodes/reference/mcp" },
              { text: "RAG", link: "/nodes/reference/rag" },
              { text: "Connector", link: "/nodes/reference/connector" },
              { text: "Utility", link: "/nodes/reference/utility" },
              { text: "Output", link: "/nodes/reference/output" }
            ]
          }
        ]
      },
      {
        text: "Security",
        items: [
          { text: "Auth + RBAC", link: "/security/auth-rbac" },
          { text: "Service Accounts + API Keys", link: "/security/service-accounts" },
          { text: "Secrets", link: "/security/secrets" },
          { text: "Secure Webhooks", link: "/security/secure-webhooks" },
          { text: "Audit Bundles", link: "/security/audit-bundles" },
          { text: "Code Execution", link: "/security/code-execution" },
          { text: "Outbound URL checks", link: "/security/outbound-url-checks" },
          { text: "Model Allowlists", link: "/security/model-allowlists" },
          { text: "Network Controls", link: "/security/network-controls" },
          { text: "Data-subject requests", link: "/security/data-subject-requests" }
        ]
      },
      {
        text: "Extensions",
        items: [
          { text: "Providers", link: "/extensions/providers" },
          { text: "Connectors", link: "/extensions/connectors" },
          { text: "MCP", link: "/extensions/mcp" },
          { text: "Community Nodes", link: "/extensions/community-nodes" }
        ]
      },
      {
        text: "API",
        items: [{ text: "Endpoints", link: "/api/endpoints" }]
      },
      {
        text: "Operations",
        items: [
          { text: "CI Pipeline", link: "/operations/ci" },
          { text: "Testing + Quality Gates", link: "/operations/testing-and-quality" },
          { text: "Observability (OTel, metrics, traces)", link: "/operations/observability" },
          { text: "Postgres", link: "/operations/postgres" },
          { text: "Queue and workers", link: "/operations/queue-and-workers" },
          { text: "Cluster operations", link: "/operations/cluster" },
          { text: "Verify a release", link: "/operations/verify-a-release" },
          { text: "Backup and recovery", link: "/operations/backup-and-recovery" },
          { text: "Data retention", link: "/operations/data-retention" },
          { text: "Legal holds", link: "/operations/legal-hold" },
          { text: "Scaling", link: "/operations/scaling" },
          { text: "Troubleshooting", link: "/troubleshooting/common-issues" }
        ]
      }
      ]
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/TensorGreed/ai-orchestrator" }
    ]
  }
});
