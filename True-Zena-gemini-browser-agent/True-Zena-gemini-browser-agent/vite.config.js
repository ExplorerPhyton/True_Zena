import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// The third-party evidence proxy that used to live here as dev-only
// middleware has moved to server/index.js (see
// server/routes/evidenceCheck.js, now backed by the Gemini browser agent
// in server/services/geminiBrowserAgent.js). Two reasons: (1) it was
// duplicated - src/App.jsx had its own copy that called the third-party
// API directly from the browser with an exposed API key, which this
// project's own security-fix brief asked to resolve, and the
// dev-middleware version here was the "correct" one but was never
// actually reachable from anywhere; (2) configureServer() only runs
// under `vite dev` - it does not exist in the production static build or
// inside the packaged Capacitor Android app, so it could never have
// backed a real deployment anyway. server/index.js is a small,
// dependency-free Node http server that runs the same way in dev,
// production, and behind whatever reverse proxy the app ends up
// deployed with; the proxy below just points the Vite dev server at it
// so `npm run dev` still feels like a single origin.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiPort = env.PORT || "8787";

  return {
    base: "./",
    plugins: [react()],
    server: {
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: true,
        },
      },
    },
  };
});
