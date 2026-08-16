import { createServer } from "node:http";
import { sendJson } from "./lib/respond.js";
import { handleFactCheckVideo } from "./routes/factCheckVideo.js";
import { handleFactCheckText } from "./routes/factCheckText.js";
import { handleEvidenceCheck } from "./routes/evidenceCheck.js";

const ROUTES = {
  "/api/fact-check-video": { POST: handleFactCheckVideo },
  "/api/fact-check-text": { POST: handleFactCheckText },
  "/api/gemini-evidence": { POST: handleEvidenceCheck },
};

export function startServer() {
  const port = Number(process.env.PORT) || 8787;
  const corsOrigin = process.env.CORS_ORIGIN || "*";

  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    let pathname;
    try {
      pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
    } catch {
      sendJson(res, 400, { error: "Invalid request URL." });
      return;
    }

    const routeKey = `${req.method} ${pathname}`;
    const methodHandlers = ROUTES[pathname];

    if (!methodHandlers) {
      if (pathname === "/api/health") {
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 404, { error: `No route for ${routeKey}.` });
      return;
    }

    const handler = methodHandlers[req.method];
    if (!handler) {
      res.setHeader("Allow", Object.keys(methodHandlers).join(", "));
      sendJson(res, 405, { error: `${pathname} does not support ${req.method}.` });
      return;
    }

    try {
      await handler(req, res);
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      // eslint-disable-next-line no-console
      console.error(`[server] ${routeKey} failed:`, error?.message || error);
      if (!res.headersSent) {
        sendJson(res, statusCode, { error: error?.message || "Internal server error." });
      }
    }
  });

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`True Zena API server listening on http://127.0.0.1:${port}`);
  });

  return server;
}
