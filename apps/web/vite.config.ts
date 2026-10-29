import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * The static demo (`--mode demo`): the API client's transport resolves to the
 * in-browser fake backend and the page boots through the demo entry, which adds
 * the demo banner. Only this mode references `src/demo/`.
 */
function demoMode(): Plugin {
  const transport = path.resolve(__dirname, "src/lib/transport.ts");
  const demoTransport = path.resolve(__dirname, "src/demo/demo-transport.ts");
  return {
    name: "l2m-demo-mode",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || !source.includes("transport")) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved?.id === transport ? demoTransport : null;
    },
    // The demo makes no request off its own origin: fonts fall back to the system stack.
    transform(code, id) {
      if (!id.endsWith("/src/styles/tokens.css")) return null;
      return code.replace(/@import url\("https:\/\/fonts\.googleapis\.com[^"]*"\);\n?/g, "");
    },
    // The demo is an app shell on lsquarem.com/demo/: search engines are asked not to index it
    // (the landing and the docs are the pages to find), and it gets its own title.
    transformIndexHtml: {
      order: "pre",
      handler: (html) =>
        html
          .replace("/src/main.tsx", "/src/demo/demo-main.tsx")
          .replace(
            /<title>[^<]*<\/title>/,
            [
              "<title>L&sup2;M live demo: the studio with recorded runs</title>",
              '<meta name="description" content="The L2M studio running in your browser against recorded runs: no sign-up, no server, nothing leaves your browser." />',
              '<meta name="robots" content="noindex" />'
            ].join("\n    ")
          )
    }
  };
}

export default defineConfig(({ mode }) => {
  const isWidgetBuild = mode === "widget";
  const envDir = path.resolve(__dirname, "../../");
  const env = loadEnv(mode, envDir, "");
  const targetPort = env.API_PORT || env.VITE_API_PORT || 4000;
  const configuredHost = env.VITE_API_HOST || env.API_HOST || "127.0.0.1";
  const targetHost = configuredHost === "0.0.0.0" ? "127.0.0.1" : configuredHost;

  if (isWidgetBuild) {
    return {
      plugins: [react()],
      resolve: {
        extensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json"]
      },
      build: {
        outDir: "dist-widget",
        emptyOutDir: true,
        lib: {
          entry: path.resolve(__dirname, "src/widget/widget-entry.tsx"),
          name: "AIOrchestratorWidget",
          formats: ["iife"],
          fileName: () => "widget.js"
        },
        rollupOptions: {
          output: {
            inlineDynamicImports: true
          }
        }
      }
    };
  }

  if (mode === "demo") {
    return {
      base: "/demo/",
      plugins: [demoMode(), react()],
      // The studio's Docs button: the docs sit next to the demo on the same site.
      define: {
        "import.meta.env.VITE_DOCS_URL": JSON.stringify("/docs/")
      },
      resolve: {
        extensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json"]
      },
      build: {
        outDir: "dist-demo",
        emptyOutDir: true
      },
      preview: {
        port: 4319,
        strictPort: true
      }
    };
  }

  return {
    plugins: [react()],
    resolve: {
      extensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json"]
    },
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: `http://${targetHost}:${targetPort}`,
          changeOrigin: true
        },
        "/webhook": {
          target: `http://${targetHost}:${targetPort}`,
          changeOrigin: true
        },
        "/webhook-test": {
          target: `http://${targetHost}:${targetPort}`,
          changeOrigin: true
        },
        // Phase 10.4 — the MCP gateway endpoint (/mcp/<toolset>).
        "/mcp/": {
          target: `http://${targetHost}:${targetPort}`,
          changeOrigin: true
        },
        "/health": {
          target: `http://${targetHost}:${targetPort}`,
          changeOrigin: true
        }
      }
    }
  };
});
