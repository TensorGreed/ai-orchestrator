import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

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
        "/health": {
          target: `http://${targetHost}:${targetPort}`,
          changeOrigin: true
        }
      }
    }
  };
});
