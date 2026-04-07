import { defineConfig } from "vitepress";

export default defineConfig({
  title: "AI Orchestrator Docs",
  description: "Documentation for AI Orchestrator visual workflow automation platform",
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "Quickstart", link: "/getting-started/quickstart" },
      { text: "Architecture", link: "/architecture/overview" },
      { text: "Nodes", link: "/nodes/core-nodes" },
      { text: "API", link: "/api/endpoints" }
    ],
    sidebar: [
      {
        text: "Getting Started",
        items: [
          { text: "Quickstart", link: "/getting-started/quickstart" },
          { text: "Environment", link: "/getting-started/environment" }
        ]
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
        items: [{ text: "Agent Loop", link: "/runtime/agent-loop" }]
      },
      {
        text: "Nodes",
        items: [
          { text: "Core Nodes", link: "/nodes/core-nodes" },
          { text: "Azure Nodes", link: "/nodes/azure-nodes" }
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
          { text: "MCP", link: "/extensions/mcp" }
        ]
      },
      {
        text: "API",
        items: [{ text: "Endpoints", link: "/api/endpoints" }]
      },
      {
        text: "Operations",
        items: [
          { text: "Testing + Quality Gates", link: "/operations/testing-and-quality" },
          { text: "Troubleshooting", link: "/troubleshooting/common-issues" }
        ]
      }
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/your-org/ai-orchestrator" }
    ]
  }
});
