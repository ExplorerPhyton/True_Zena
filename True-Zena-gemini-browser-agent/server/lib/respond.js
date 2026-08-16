// Small, dependency-free HTTP helpers shared by every route module.
// Kept in the same style as the dev-only proxy middleware that used to
// live in vite.config.js, so the codebase has one consistent
// request/response pattern instead of mixing in a framework for a
// handful of routes.

export function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

// Reads and JSON-parses a request body, with a size cap so a very large or
// slow-drip request body can't tie up memory or a connection indefinitely.
// The original vite.config.js version had no such cap.
export function readJsonBody(req, maxBytes = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(httpError(413, "Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(httpError(400, "Invalid JSON body."));
      }
    });

    req.on("error", reject);
  });
}

// Attaches a statusCode to an Error so the top-level server can translate
// it into the right HTTP response without every route re-implementing
// try/catch status mapping.
export function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
