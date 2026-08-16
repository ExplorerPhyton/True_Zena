import { readJsonBody, sendJson, httpError } from "../lib/respond.js";
import { isGeminiConfigured, uploadFile } from "../lib/gemini.js";
import { buildMediaSystemInstruction, buildTextSystemInstruction } from "../lib/promptSchema.js";
import { runFactCheckPipeline } from "../lib/factCheckPipeline.js";
import { fetchMedia } from "../lib/videoIngest.js";

const MAX_INLINE_FILE_BYTES = 14 * 1024 * 1024; // stays comfortably under Gemini's ~20MB inline request cap once base64-encoded
const MEDIA_PROMPT = "Analyze this media for misinformation and extract every checkable factual claim.";

export async function handleFactCheckVideo(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Use POST for video/media fact-checks." });
    return;
  }

  if (!isGeminiConfigured()) {
    sendJson(res, 200, {
      configured: false,
      summary: "Gemini is not connected yet. Add GEMINI_API_KEY to .env.local.",
    });
    return;
  }

  const body = await readJsonBody(req);
  const mode = body.mode;

  if (mode === "transcript") {
    const result = await handleTranscriptMode(body);
    sendJson(res, 200, result);
    return;
  }

  if (mode === "file") {
    const result = await handleFileMode(body);
    sendJson(res, 200, result);
    return;
  }

  if (mode === "url" || mode === "url-audio") {
    const result = await handleUrlMode(body, mode === "url-audio");
    sendJson(res, 200, result);
    return;
  }

  throw httpError(400, 'mode must be one of "url", "url-audio", "file", or "transcript".');
}

async function handleTranscriptMode({ text }) {
  if (!text?.trim()) {
    throw httpError(400, "Paste a transcript before checking it.");
  }
  const result = await runFactCheckPipeline({
    systemInstruction: buildTextSystemInstruction(),
    parts: [{ text }],
  });
  return { configured: true, sourceType: "transcript", ...result };
}

async function handleFileMode({ fileBase64, fileMimeType }) {
  if (!fileBase64 || !fileMimeType) {
    throw httpError(400, "A file upload needs both fileBase64 and fileMimeType.");
  }

  const buffer = Buffer.from(fileBase64, "base64");
  if (buffer.length === 0) {
    throw httpError(400, "That file appears to be empty.");
  }
  if (buffer.length > MAX_INLINE_FILE_BYTES) {
    throw httpError(
      400,
      `That file is too large for the quick-upload path (limit ~${Math.round(MAX_INLINE_FILE_BYTES / (1024 * 1024))}MB). Try the audio-only or transcript option instead.`
    );
  }

  const result = await runFactCheckPipeline({
    systemInstruction: buildMediaSystemInstruction(),
    parts: [{ text: MEDIA_PROMPT }, { inline_data: { mime_type: fileMimeType, data: buffer.toString("base64") } }],
  });

  return { configured: true, sourceType: "file", ...result };
}

async function handleUrlMode({ url }, audioOnly) {
  if (!url?.trim()) {
    throw httpError(400, "Paste a video link before checking it.");
  }

  const media = await fetchMedia({ url, audioOnly });
  try {
    const uploaded = await uploadFile({
      buffer: media.buffer,
      mimeType: media.mimeType,
      displayName: `truezena-${Date.now()}`,
    });

    const result = await runFactCheckPipeline({
      systemInstruction: buildMediaSystemInstruction(),
      parts: [{ text: MEDIA_PROMPT }, { file_data: { mime_type: uploaded.mimeType, file_uri: uploaded.uri } }],
    });

    return { configured: true, sourceType: audioOnly ? "url-audio" : "url", ...result };
  } finally {
    await media.cleanup();
  }
}
