// Client for the Gemini Interactions API (v1beta/interactions) - Google's
// current, generally-available surface for tool-using and agentic work.
// Google Search grounding, URL Context, and Computer Use all live here;
// the older generateContent endpoint remains fully supported (Google's own
// docs say so explicitly) but new tools launch on Interactions going
// forward, which is why the browser agent is built on this rather than
// generateContent. The Files-API + generateContent client in ./gemini.js
// is untouched and still backs the existing claim-extraction pipeline -
// this module is additive, not a replacement for that.
//
// Kept dependency-free (raw fetch, same style as gemini.js) rather than
// pulling in the @google/genai SDK, so the only new *runtime* dependency
// this feature adds to the project is Playwright itself.

import { httpError } from "./respond.js";
import { apiKeyOrThrow, geminiAgentModel } from "./gemini.js";

const API_ROOT = "https://generativelanguage.googleapis.com";
const INTERACTIONS_URL = `${API_ROOT}/v1beta/interactions`;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// Creates one Interaction (one "turn"). Pass previousInteractionId to
// continue a prior interaction using Google's server-side state
// management instead of resending the whole conversation history - this
// is what lets the browser-agent loop send just the latest screenshot on
// each step rather than every screenshot taken so far.
//
// Retries once on a transient failure (429/500/502/503/504) after a short
// delay before giving up - the same "don't take down the whole
// investigation over one flaky response" spirit as the rest of this app's
// error handling. `signal` is an optional AbortSignal so an in-progress
// investigation can be cancelled if the client disconnects (see
// server/routes/evidenceCheck.js).
export async function createInteraction({
  model = geminiAgentModel(),
  input,
  tools,
  systemInstruction,
  previousInteractionId,
  store = true,
  signal,
} = {}) {
  const apiKey = apiKeyOrThrow();

  const body = {
    model,
    input,
    ...(tools ? { tools } : {}),
    ...(systemInstruction ? { system_instruction: systemInstruction } : {}),
    ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
    store,
  };

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal?.aborted) throw httpError(499, "The investigation was cancelled.");

    let response;
    try {
      response = await fetch(INTERACTIONS_URL, {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw httpError(499, "The investigation was cancelled.");
      lastError = httpError(502, `Could not reach Gemini: ${error.message}`);
      continue;
    }

    if (response.ok) return response.json();

    lastError = httpError(
      response.status === 429 ? 429 : 502,
      `Gemini Interactions request failed (${response.status}): ${await safeText(response)}`
    );

    if (!RETRYABLE_STATUS.has(response.status) || attempt === 1) break;
    await sleep(800);
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- small helpers for reading the `steps[]` envelope -----------------------
// Every Interaction response is a chronological list of steps: model
// reasoning/text (`model_output`), tool calls the client must execute
// (`function_call`), and tool-retrieval metadata (`url_context_result`).
// These helpers pull out just what each caller needs instead of every
// call site re-walking the array by hand.

export function functionCalls(interaction) {
  return (interaction?.steps ?? []).filter((step) => step.type === "function_call");
}

export function modelText(interaction) {
  return (interaction?.steps ?? [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

// url_citation annotations are how the URL Context / Google Search tools
// report the real source URLs behind a response, the same way
// groundingMetadata.groundingChunks does for generateContent grounding
// (see gemini.js: groundedEvidence) - reading them back rather than
// trusting the model to type out a URL from memory.
export function urlCitations(interaction) {
  const citations = [];
  for (const step of interaction?.steps ?? []) {
    if (step.type !== "model_output") continue;
    for (const block of step.content ?? []) {
      for (const annotation of block.annotations ?? []) {
        if (annotation.type === "url_citation" && annotation.url) {
          citations.push({ url: annotation.url, title: annotation.title || annotation.url });
        }
      }
    }
  }
  return dedupeByUrl(citations);
}

export function urlContextResults(interaction) {
  return (interaction?.steps ?? []).filter((step) => step.type === "url_context_result");
}

function dedupeByUrl(entries) {
  return [...new Map(entries.map((entry) => [entry.url, entry])).values()];
}

async function safeText(response) {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return "(no response body)";
  }
}
