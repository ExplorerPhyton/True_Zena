// Minimal Gemini Developer API client built on the global fetch that ships
// with Node 22 - no SDK dependency, so there is nothing extra to install
// or version-pin. Talks to generativelanguage.googleapis.com directly.
//
// Covers exactly what this project needs:
//   - uploadFile()      resumable upload to the Files API, for video/audio
//                        pulled down by yt-dlp (can exceed the 20MB inline
//                        request limit)
//   - generateJSON()    generateContent with responseSchema, for the
//                        claim-extraction pass (Part 4 of the brief)
//   - groundedEvidence() generateContent with the Google Search grounding
//                        tool, for the evidence cross-reference pass
//                        (Part 3.2). Kept as a *separate* call from
//                        generateJSON on purpose - see the comment on
//                        groundedEvidence for why.
//
// gemini-2.5-flash is Google's current published shutdown-no-earlier-than
// date for this model family is 2026-10-16, replaced by newer Gemini 3.x
// models. The model id is read from GEMINI_MODEL (falling back to
// gemini-2.5-flash, matching the brief) instead of being hardcoded in
// every call site, so upgrading later is a one-line env change.

import { httpError } from "./respond.js";

const API_ROOT = "https://generativelanguage.googleapis.com";
const UPLOAD_ROOT = `${API_ROOT}/upload/v1beta/files`;

// Route handlers should check isGeminiConfigured() up front and return a
// friendly "not connected yet" response (the same pattern used across
// every AI-backed route in this app) before ever calling into this
// module. This throw is a defensive fallback in case that check is
// skipped, not the primary path. Exported so server/lib/geminiInteractions.js
// (the Interactions-API client used by the browser agent) can reuse the
// exact same key lookup instead of duplicating it.
export function apiKeyOrThrow() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw httpError(500, "GEMINI_API_KEY is not set on the server.");
  }
  return apiKey;
}

export function geminiModel() {
  return process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
}

// Separate, independently-configurable model for the Gemini browser agent
// (server/services/geminiBrowserAgent.js). Kept distinct from GEMINI_MODEL
// above on purpose: GEMINI_MODEL backs the existing claim-extraction/
// grounding pipeline (generateContent + responseSchema, still fully
// supported - no need to touch it), while the browser agent needs a model
// that specifically supports the Computer Use tool. As of this writing
// that's the Gemini 3.x family; gemini-3.6-flash is Google's current
// recommended model for computer use (browser/mobile/desktop actions with
// reasoning intents, configurable safety policies, and prompt-injection
// screenshot scanning). Exposed as an env var, not hardcoded, so it can
// move independently as Google ships newer computer-use-capable models.
export function geminiAgentModel() {
  return process.env.GEMINI_AGENT_MODEL?.trim() || "gemini-3.6-flash";
}

export function isGeminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

// --- Files API: resumable upload + poll until ACTIVE -----------------------

export async function uploadFile({ buffer, mimeType, displayName }) {
  const apiKey = apiKeyOrThrow();

  const startResponse = await fetch(`${UPLOAD_ROOT}`, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(buffer.length),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });

  if (!startResponse.ok) {
    throw httpError(502, `Gemini file upload could not start (${startResponse.status}): ${await safeText(startResponse)}`);
  }

  const uploadUrl = startResponse.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw httpError(502, "Gemini file upload did not return an upload URL.");
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(buffer.length),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: buffer,
  });

  if (!uploadResponse.ok) {
    throw httpError(502, `Gemini file upload failed (${uploadResponse.status}): ${await safeText(uploadResponse)}`);
  }

  const { file } = await uploadResponse.json();
  if (!file?.uri) {
    throw httpError(502, "Gemini file upload response was missing a file URI.");
  }

  return pollFileUntilActive({ apiKey, name: file.name, uri: file.uri, mimeType: file.mimeType || mimeType });
}

async function pollFileUntilActive({ apiKey, name, uri, mimeType, maxAttempts = 20, intervalMs = 2000 }) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(`${API_ROOT}/v1beta/${name}`, {
      headers: { "x-goog-api-key": apiKey },
    });
    if (!response.ok) {
      throw httpError(502, `Could not check Gemini file status (${response.status}).`);
    }
    const file = await response.json();
    if (file.state === "ACTIVE") {
      return { uri, mimeType: file.mimeType || mimeType, name };
    }
    if (file.state === "FAILED") {
      throw httpError(502, "Gemini failed to process the uploaded media.");
    }
    await sleep(intervalMs);
  }
  throw httpError(504, "Gemini is still processing the media - try again shortly.");
}

// --- generateContent: structured JSON claim extraction ---------------------

export async function generateJSON({ systemInstruction, parts, schema }) {
  const apiKey = apiKeyOrThrow();
  const model = geminiModel();

  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
      temperature: 0.2,
    },
  };

  const response = await fetch(`${API_ROOT}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw httpError(response.status === 429 ? 429 : 502, `Gemini request failed (${response.status}): ${await safeText(response)}`);
  }

  const data = await response.json();
  const candidate = data?.candidates?.[0];
  const finishReason = candidate?.finishReason;

  if (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
    throw httpError(502, `Gemini declined to complete this analysis (${finishReason}).`);
  }

  const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  if (!text.trim()) {
    throw httpError(502, "Gemini returned an empty response.");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw httpError(502, "Gemini returned a response that was not valid JSON.");
  }
}

// --- generateContent + Google Search grounding: evidence lookup ------------
//
// Structured output (responseSchema) and the Google Search grounding tool
// are not a reliable combination in the same generateContent call on the
// 2.x-generation Gemini models this project targets - Google's own SDK
// issue tracker documents a 400 INVALID_ARGUMENT when both are set at
// once. So this call intentionally asks a plain-text question with the
// search tool enabled, and reads the *structured* evidence out of
// response.candidates[0].groundingMetadata.groundingChunks (which Gemini
// populates automatically whenever grounding produces sources) rather
// than trusting the model to format URLs correctly inside prose. That
// side-steps the conflict and avoids ever asking the model to type out a
// URL from memory.
export async function groundedEvidence({ prompt, maxSources = 3 }) {
  const apiKey = apiKeyOrThrow();
  const model = geminiModel();

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
  };

  const response = await fetch(`${API_ROOT}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    // Evidence lookup is a "nice to have" enrichment step - failing it
    // should never take down the whole fact-check response.
    return [];
  }

  const data = await response.json();
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];

  const links = chunks
    .map((chunk) => chunk?.web)
    .filter((web) => web?.uri)
    .map((web) => ({ title: web.title || web.uri, url: web.uri }));

  const deduped = [...new Map(links.map((link) => [link.url, link])).values()];
  return deduped.slice(0, maxSources);
}

async function safeText(response) {
  try {
    const text = await response.text();
    return text.slice(0, 400);
  } catch {
    return "(no response body)";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
