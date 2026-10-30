import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";

// One consent script serves the landing and the docs. It lives with the landing (repo-root
// docs/site-consent.js); copy it into public/ so VitePress serves it in dev and ships it in the
// build at /docs/site-consent.js (public/site-consent.js is generated and git-ignored).
copyFileSync(
  fileURLToPath(new URL("../../../../docs/site-consent.js", import.meta.url)),
  fileURLToPath(new URL("../public/site-consent.js", import.meta.url))
);

const SITE = "https://lsquarem.com";
// The share card lives with the landing at the site root (source: scripts/social-card/).
const SOCIAL_CARD = `${SITE}/assets/social-card.png`;
const SOCIAL_CARD_ALT = "L2M: run and govern MCP agents, self-hosted. The L2M studio with an agent hub, its chat model, memory and MCP tools, and the run tape of a finished run.";

/** The page's public URL: `/docs/` plus the clean path (`foo/index.md` → `foo/`, `foo.md` → `foo`). */
function pageUrl(relativePath: string): string {
  const clean = relativePath.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "");
  return `${SITE}/docs/${clean}`;
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
  sitemap: { hostname: "https://lsquarem.com/docs/" },
  // Generated table pulled into product/importing-from-another-builder.md with @include; not a page of its own.
  srcExclude: ["product/external-import-coverage.md"],
  head: [
    ["script", { src: "/docs/site-consent.js", defer: "" }],
    ["link", { rel: "icon", type: "image/svg+xml", href: "/docs/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#07090f" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "L2M" }],
    ["meta", { property: "og:image", content: SOCIAL_CARD }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { property: "og:image:alt", content: SOCIAL_CARD_ALT }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image", content: SOCIAL_CARD }],
    ["meta", { name: "twitter:image:alt", content: SOCIAL_CARD_ALT }]
  ],
  // Per page: canonical URL and the share tags that carry its own title and description.
  // The 404 page is kept out of search results instead.
  transformHead({ pageData, title, description }) {
    if (pageData.isNotFound || pageData.relativePath === "404.md") {
      return [["meta", { name: "robots", content: "noindex" }]];
    }
    const url = pageUrl(pageData.relativePath);
    return [
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: description }]
    ];
  },
  themeConfig: {
    nav: [
      { text: "← lsquarem.com", link: "https://lsquarem.com/" },
      { text: "Why", link: "/why" },
      { text: "Live demo", link: "https://lsquarem.com/demo/", target: "_self" },
      { text: "Quickstart", link: "/getting-started/build-your-first-mcp-agent" },
      { text: "Patterns", link: "/patterns/" },
      { text: "Architecture", link: "/architecture/overview" },
      { text: "Nodes", link: "/nodes/core-nodes" },
      { text: "API", link: "/api/endpoints" }
    ],
    sidebar: [
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
          { text: "MCP onboarding and catalog", link: "/product/mcp-onboarding" },
          { text: "Testing MCP workflows", link: "/product/testing-mcp-workflows" },
          { text: "Golden runs and replay", link: "/product/golden-runs" },
          { text: "Golden sets and replay jobs", link: "/product/golden-sets" },
          { text: "Production capture", link: "/product/production-capture" },
          { text: "Release gate and publish", link: "/product/release-gate" },
          { text: "Replay in CI and the release gate", link: "/product/replay-and-release-gate" },
          { text: "Approval gates", link: "/product/approvals" },
          { text: "Guard engine", link: "/product/guard-engine" },
          { text: "Guard in workflows", link: "/product/guard" },
          { text: "Guard policy simulation", link: "/product/guard-simulation" },
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
          { text: "Expose a Workflow as an MCP Tool", link: "/runtime/workflow-as-mcp-tool" }
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
          { text: "Secrets", link: "/security/secrets" },
          { text: "Secure Webhooks", link: "/security/secure-webhooks" },
          { text: "Audit Bundles", link: "/security/audit-bundles" },
          { text: "Code Execution", link: "/security/code-execution" },
          { text: "Outbound URL Guard", link: "/security/outbound-url-guard" }
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
          { text: "Scaling", link: "/operations/scaling" },
          { text: "Troubleshooting", link: "/troubleshooting/common-issues" }
        ]
      }
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/TensorGreed/ai-orchestrator" }
    ]
  }
});
