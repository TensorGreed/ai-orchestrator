import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const envDir = path.resolve(__dirname, "../../");
  const env = loadEnv(mode, envDir, "");
  const targetPort = env.API_PORT || 4001;

  return {
    plugins: [react()],
    resolve: {
      extensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json"]
    },
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: `http://localhost:${targetPort}`,
          changeOrigin: true
        },
        "/health": {
          target: `http://localhost:${targetPort}`,
          changeOrigin: true
        }
      }
    }
  };
});
