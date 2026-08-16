// True Zena's former third-party web-evidence proxy has been fully
// replaced by the Gemini browser agent. Same request contract as before
// ({ text } in, structured result out) so the only thing that changed on
// the client is which endpoint it calls and how it reads the response -
// but the response itself is now a real Gemini browser-agent
// investigation instead of a fixed third-party scraping workflow.
//
// Supports two response modes on the same endpoint:
//   - Accept: text/event-stream -> live progress events as the
//     investigation runs (Searching / Opening source / Reading page /
//     Navigating / Collecting evidence / Cross-checking / Analyzing /
//     Complete), ending with a `done` event carrying the full result.
//     This is what the React app uses, so a slow multi-source
//     investigation shows real state instead of a frozen spinner.
//   - Anything else -> a single JSON response once the investigation
//     finishes, for any other API consumer that doesn't want to parse SSE.

import { readJsonBody, sendJson } from "../lib/respond.js";
import { investigateClaim } from "../services/geminiBrowserAgent.js";

export async function handleEvidenceCheck(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Use POST for evidence checks." });
    return;
  }

  const { text } = await readJsonBody(req);
  const wantsStream = (req.headers.accept || "").includes("text/event-stream");

  // Lets an in-progress investigation be cancelled if the client goes away
  // (tab closed, request aborted) instead of burning further Gemini calls
  // and Playwright time on a response nobody will read.
  const controller = new AbortController();
  req.on("close", () => controller.abort());

  if (!wantsStream) {
    const result = await investigateClaim({ claim: text, signal: controller.signal });
    sendJson(res, 200, result);
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await investigateClaim({
      claim: text,
      signal: controller.signal,
      onProgress: (stage, detail) => send("progress", { stage, detail }),
    });
    send("done", result);
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    send("error", { error: error?.message || "Internal server error.", statusCode });
  } finally {
    res.end();
  }
}
