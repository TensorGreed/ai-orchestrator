import { defineConfig } from "vitepress";

export default defineConfig({
  title: "L2M",
  description: "The MCP-native agent runtime — visual workflow builder, multi-agent Swarm, and a VS Code surface.",
  // Served as a subpath under lsquarem.com — the marketing landing lives at
  // the root, the VitePress build is mounted at /docs/. The Pages deployment
  // workflow at .github/workflows/pages.yml merges both into a single
  // artifact before publishing.
  base: "/docs/",
  cleanUrls: true,
  sitemap: { hostname: "https://lsquarem.com/docs/" },
  themeConfig: {
    nav: [
      { text: "← lsquarem.com", link: "https://lsquarem.com/" },
      { text: "Why", link: "/why" },
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
        text: "Patterns",
        items: [{ text: "Pattern library", link: "/patterns/" }]
      },
      {
        text: "Product",
        items: [{ text: "Workflow Editor", link: "/product/workflow-editor" }]
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
          { text: "Secure Webhooks", link: "/security/secure-webhooks" }
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
          { text: "Troubleshooting", link: "/troubleshooting/common-issues" }
        ]
      }
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/TensorGreed/ai-orchestrator" }
    ]
  }
});
