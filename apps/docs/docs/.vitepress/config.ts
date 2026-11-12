import { copyFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { hasIndex, readingMinutes, SRC_DIR } from "./site/content.js";
import { FEED_PATH, writeFeed } from "./site/feed.js";
import { breadcrumbsOf, pageKindOf } from "./site/sections.js";
import { pageHeadTags, type HubPageData } from "./site/seo.js";
import { blogSidebar, glossarySidebar, learnSidebar, recipesSidebar } from "./site/sidebars.js";

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
  glossary: ["title", "description", "term"],
  recipe: ["title", "description"],
  post: ["title", "description", "date", "author"],
  "hub-index": ["title", "description"]
};

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
  sitemap: { hostname: "https://lsquarem.com/docs/" },
  // Generated table pulled into product/importing-from-another-builder.md with @include; not a page of its own.
  srcExclude: ["product/external-import-coverage.md"],
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
    const name = String(pageData.frontmatter.term ?? pageData.frontmatter.sidebarTitle ?? pageData.title ?? "");
    const extra: HubPageData = { breadcrumbs: breadcrumbsOf(pageData.relativePath, name, hasIndex) };
    if (kind === "learn" || kind === "post" || kind === "recipe") {
      extra.readingMinutes = readingMinutes(readFileSync(path.join(SRC_DIR, pageData.filePath), "utf8"));
    }
    return extra;
  },
  // Per page: canonical URL, share tags with its own title, description and image, and JSON-LD.
  // The 404 page is kept out of search results instead.
  transformHead({ pageData, title, description }) {
    return pageHeadTags(pageData, title, description);
  },
  buildEnd(siteConfig) {
    writeFeed(siteConfig.outDir);
  },
  themeConfig: {
    nav: [
      { text: "← lsquarem.com", link: "https://lsquarem.com/", target: "_self" },
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
      { text: "Learn", link: "/learn/", activeMatch: "^/learn/" },
      { text: "Recipes", link: "/recipes/", activeMatch: "^/recipes/" },
      { text: "Glossary", link: "/glossary/", activeMatch: "^/glossary/" },
      { text: "Blog", link: "/blog/", activeMatch: "^/blog/" },
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
