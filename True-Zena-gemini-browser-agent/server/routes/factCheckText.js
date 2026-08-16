import { readJsonBody, sendJson, httpError } from "../lib/respond.js";
import { isGeminiConfigured } from "../lib/gemini.js";
import { buildTextSystemInstruction } from "../lib/promptSchema.js";
import { runFactCheckPipeline } from "../lib/factCheckPipeline.js";

export async function handleFactCheckText(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Use POST for text fact-checks." });
    return;
  }

  if (!isGeminiConfigured()) {
    sendJson(res, 200, {
      configured: false,
      summary: "Gemini is not connected yet. Add GEMINI_API_KEY to .env.local.",
    });
    return;
  }

  const { text } = await readJsonBody(req);
  if (!text?.trim()) {
    throw httpError(400, "Paste a transcript or some text before checking it.");
  }
  if (text.length > 20000) {
    throw httpError(400, "That text is too long for one check - try trimming it to the key passage.");
  }

  const result = await runFactCheckPipeline({
    systemInstruction: buildTextSystemInstruction(),
    parts: [{ text }],
  });

  sendJson(res, 200, { configured: true, sourceType: "text", ...result });
}
