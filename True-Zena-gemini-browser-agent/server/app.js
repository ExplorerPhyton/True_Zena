import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendJson } from "./lib/respond.js";
import { handleFactCheckVideo } from "./routes/factCheckVideo.js";
import { handleFactCheckText } from "./routes/factCheckText.js";
import { handleEvidenceCheck } from "./routes/evidenceCheck.js";

const ROUTES = {
  "/api/fact-check-video": { POST: handleFactCheckVideo },
  "/api/fact-check-text": { POST: handleFactCheckText },
  "/api/gemini-evidence": { POST: handleEvidenceCheck },
};

// The built frontend (vite build output) lives one level up, in /dist.
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(here, "..", "dist");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

// Serves a file from dist/, falling back to index.html for client-side
// routing (any GET that isn't an API call and doesn't match a real file).
async function serveStatic(req, res, pathname) {
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(DIST_DIR, safePath === "/" ? "" : safePath);

  try {
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
  } catch {
    // No exact file match -> fall back to index.html so client-side
    // routes (e.g. /some/app/route) still load the SPA shell.
    filePath = path.join(DIST_DIR, "index.html");
  }

  try {
    const ext = path.extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME_TYPES[ext] || "application/octet-stream");
    createReadStream(filePath)
      .on("error", () => {
        if (!res.headersSent) {
          sendJson(res, 404, { error: "Not found." });
        }
      })
      .pipe(res);
  } catch (error) {
    sendJson(res, 500, { error: error?.message  "Failed to serve file." });
  }
}

export function startServer() {
  const port = Number(process.env.PORT)  8787;
  const corsOrigin = process.env.CORS_ORIGIN  "*";

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
      pathname = new URL(req.url, http://${req.headers.host || "localhost"}).pathname;
    } catch {
      sendJson(res, 400, { error: "Invalid request URL." });
      return;
    }

    const routeKey = ${req.method} ${pathname};
    const methodHandlers = ROUTES[pathname];

    if (!methodHandlers) {
      if (pathname === "/api/health") {
        sendJson(res, 200, { ok: true });
        return;
      }
      // Anything that isn't a known /api route: serve the built frontend
      // instead of a JSON 404, so GET / and client-side routes work.
      if (req.method === "GET" && !pathname.startsWith("/api/")) {
        await serveStatic(req, res, pathname);
        return;
      }
      sendJson(res, 404, { error: No route for ${routeKey}. });
      return;
    }

    const handler = methodHandlers[req.method];
    if (!handler) {
      res.setHeader("Allow", Object.keys(methodHandlers).join(", "));
      sendJson(res, 405, { error: ${pathname} does not support ${req.method}. });
      return;
    }
[8/16/2026 10:09 PM] Nati: try {
      await handler(req, res);
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      // eslint-disable-next-line no-console
      console.error([server] ${routeKey} failed:, error?.message || error);
      if (!res.headersSent) {
        sendJson(res, statusCode, { error: error?.message || "Internal server error." });
      }
    }
  });

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(True Zena API server listening on http://127.0.0.1:${port});
  });

  return server;
}