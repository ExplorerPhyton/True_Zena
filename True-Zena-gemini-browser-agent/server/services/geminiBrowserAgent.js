// The Gemini browser agent - True Zena's real web-investigation engine
// for the text checker's evidence search.
//
// Pipeline for one investigateClaim() call:
//
//   1. RESEARCH   - one Interactions API call with the google_search and
//                   url_context tools enabled. Gemini decides what to
//                   search for and which pages are worth reading; URL
//                   Context does the actual fetching for anything static.
//   2. TRIAGE     - a small structured call (reusing the existing
//                   generateJSON/generateContent client) turns the
//                   research notes into a source list and flags at most a
//                   couple of URLs whose key evidence genuinely needs a
//                   real interactive browser visit (behind a search form,
//                   pagination, a client-rendered dashboard, etc).
//   3. DEEP BROWSE - for each flagged URL: launch Chromium, navigate, and
//                   run an explicit loop - screenshot -> Gemini (Computer
//                   Use tool) -> action -> Playwright executes it ->
//                   screenshot -> repeat - until Gemini returns a final
//                   answer or a step/time budget runs out. This is the
//                   real browser-executor loop the brief asks for; it is
//                   only invoked when step 2 decided it's actually needed.
//   4. SYNTHESIS  - one structured-output call (generateJSON) turns the
//                   claim plus everything gathered into exactly one True
//                   Zena verdict, with per-source classification,
//                   contradictions, and missing context.
//
// Every external call in here is bounded: MAX_DEEP_SOURCES caps how many
// pages get the expensive interactive treatment, MAX_STEPS_PER_SOURCE caps
// the action loop per page, and TOTAL_TIMEOUT_MS is an overall wall-clock
// budget checked between stages and loop iterations so a slow page can
// never hang the request indefinitely. A per-source failure never aborts
// the whole investigation - see browseSource()'s catch.

import { chromium } from "playwright";
import { httpError } from "../lib/respond.js";
import { isGeminiConfigured, generateJSON } from "../lib/gemini.js";
import { createInteraction, functionCalls, modelText, urlCitations, urlContextResults } from "../lib/geminiInteractions.js";
import { assertPublicHttpUrl, isPublicHttpUrl } from "../lib/urlSafety.js";
import {
  EVIDENCE_SCHEMA,
  TRIAGE_SCHEMA,
  buildResearchInstruction,
  buildTriageInstruction,
  buildSynthesisInstruction,
} from "../lib/evidenceSchema.js";

const MAX_STEPS_PER_SOURCE = clampInt(process.env.AGENT_MAX_STEPS, 10, 1, 25);
const MAX_DEEP_SOURCES = clampInt(process.env.AGENT_MAX_DEEP_SOURCES, 2, 0, 5);
const NAV_TIMEOUT_MS = clampInt(process.env.AGENT_NAVIGATION_TIMEOUT_MS, 20000, 3000, 60000);
const ACTION_TIMEOUT_MS = clampInt(process.env.AGENT_ACTION_TIMEOUT_MS, 8000, 1000, 30000);
const TOTAL_TIMEOUT_MS = clampInt(process.env.AGENT_TOTAL_TIMEOUT_MS, 90000, 15000, 240000);
const HEADLESS = process.env.AGENT_HEADLESS !== "false";
const VIEWPORT = { width: 1280, height: 800 };

export async function investigateClaim({ claim, onProgress = () => {}, signal } = {}) {
  if (!isGeminiConfigured()) {
    return {
      configured: false,
      summary: "Gemini is not connected yet. Add GEMINI_API_KEY to .env.local.",
    };
  }
  if (!claim?.trim()) {
    throw httpError(400, "Paste text before checking it.");
  }

  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const searchQueries = [claim.trim().slice(0, 300)];
  const browserActions = [];
  let agentSteps = 0;

  const checkCancelled = () => {
    if (signal?.aborted) throw httpError(499, "The investigation was cancelled.");
  };

  // ---- Stage 1: research (Google Search grounding + URL Context) --------
  onProgress("searching", "Searching the web for this claim.");
  const research = await createInteraction({
    input: claim,
    tools: [{ type: "url_context" }, { type: "google_search" }],
    systemInstruction: buildResearchInstruction(),
    signal,
  });

  const researchNotes = modelText(research);
  const citations = urlCitations(research);
  const fetchResults = summarizeFetchResults(urlContextResults(research));

  onProgress("reading_page", "Reading through what search and URL Context found.");
  checkCancelled();

  // ---- Stage 2: triage - which sources (if any) need real interaction? --
  const triage = await generateJSON({
    systemInstruction: buildTriageInstruction(),
    parts: [{ text: JSON.stringify({ claim, researchNotes, citations, fetchResults }) }],
    schema: TRIAGE_SCHEMA,
  }).catch(() => ({ candidateSources: citations, needsDeepBrowsing: [] }));

  const candidateSources =
    Array.isArray(triage.candidateSources) && triage.candidateSources.length > 0
      ? triage.candidateSources
      : citations;

  const needsDeepBrowsing = (Array.isArray(triage.needsDeepBrowsing) ? triage.needsDeepBrowsing : [])
    .filter((entry) => isPublicHttpUrl(entry?.url))
    .slice(0, MAX_DEEP_SOURCES);

  // ---- Stage 3: deep browsing for sources that genuinely need it --------
  const deepExtracts = [];
  if (needsDeepBrowsing.length > 0 && Date.now() < deadline) {
    checkCancelled();
    onProgress(
      "opening_source",
      `Opening ${needsDeepBrowsing.length} source${needsDeepBrowsing.length === 1 ? "" : "s"} that need interactive browsing.`
    );

    const browser = await chromium.launch({ headless: HEADLESS });
    try {
      for (const target of needsDeepBrowsing) {
        if (Date.now() >= deadline || signal?.aborted) break;

        const extract = await browseSource({
          url: target.url,
          reason: target.reason,
          claim,
          browser,
          deadline,
          signal,
          onProgress,
          onAction: (action) => {
            browserActions.push(action);
            agentSteps += 1;
          },
        });
        if (extract) deepExtracts.push(extract);
      }
    } finally {
      await browser.close().catch(() => {});
    }
  }

  // ---- Stage 4: cross-check + synthesize the final verdict --------------
  checkCancelled();
  onProgress("collecting_evidence", "Collecting everything gathered so far.");
  onProgress("cross_checking", "Cross-checking sources against each other.");
  onProgress("analyzing", "Analyzing the evidence and drafting a verdict.");

  const synthesis = await generateJSON({
    systemInstruction: buildSynthesisInstruction(),
    parts: [{ text: JSON.stringify({ claim, researchNotes, candidateSources, deepExtracts }) }],
    schema: EVIDENCE_SCHEMA,
  });

  onProgress("complete", "Investigation complete.");

  return {
    configured: true,
    claim,
    ...synthesis,
    searchQueries,
    browserActions,
    agentSteps,
  };
}

// --- Stage 3 detail: one source, one Playwright page, one agent loop -------

async function browseSource({ url, reason, claim, browser, deadline, signal, onProgress, onAction }) {
  try {
    await assertPublicHttpUrl(url);
  } catch (error) {
    return { url, title: url, evidence: "", error: error.message };
  }

  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);

  try {
    onProgress("opening_source", `Opening ${url}`);
    await gotoWithRetry(page, url);
    onAction({ source: url, action: "navigate", detail: `Opened ${url}` });

    let screenshot = await page.screenshot({ type: "png" });
    let interaction = await createInteraction({
      input: [
        {
          type: "text",
          text: [
            `Investigate this page to find evidence relevant to the claim: "${claim}".`,
            reason ? `Why this page needs interaction: ${reason}` : "",
            "Extract the relevant factual evidence and give it as your final text response - do not click around aimlessly. Stop and answer as soon as you have enough information, or if the page turns out not to contain relevant evidence.",
          ]
            .filter(Boolean)
            .join(" "),
        },
        { type: "image", data: screenshot.toString("base64"), mime_type: "image/png" },
      ],
      tools: [{ type: "computer_use", environment: "browser", enable_prompt_injection_detection: true }],
      signal,
    });

    for (let step = 0; step < MAX_STEPS_PER_SOURCE; step += 1) {
      if (Date.now() >= deadline || signal?.aborted) break;

      const calls = functionCalls(interaction);
      if (calls.length === 0) break; // Gemini returned a final text answer instead of another action

      const results = [];
      for (const call of calls) {
        onProgress("navigating", describeAction(call));

        const safety = call.arguments?.safety_decision;
        if (safety?.decision && !["allowed", "regular"].includes(safety.decision)) {
          // No human is in the loop for this unattended, read-only
          // evidence job, so True Zena never auto-confirms a
          // require_confirmation action (cookie/consent dialogs, logins,
          // anything transactional). Skip it and record why instead.
          results.push({
            name: call.name,
            callId: call.id,
            result: { skipped: true, reason: `Blocked by Gemini safety policy: ${safety.explanation || safety.decision}` },
          });
          continue;
        }

        const outcome = await executeComputerUseAction(page, call, signal).catch((error) => ({ error: error.message }));
        onAction({ source: url, action: call.name, detail: describeAction(call) });
        results.push({ name: call.name, callId: call.id, result: outcome });
      }

      screenshot = await page.screenshot({ type: "png" }).catch(() => screenshot);
      interaction = await createInteraction({
        previousInteractionId: interaction.id,
        input: buildFunctionResponses(page, results, screenshot),
        tools: [{ type: "computer_use", environment: "browser", enable_prompt_injection_detection: true }],
        signal,
      });
    }

    const extractedText = modelText(interaction);
    return {
      url,
      title: await page.title().catch(() => url),
      evidence: extractedText || "The browser agent opened this page but did not return a readable summary.",
    };
  } catch (error) {
    return { url, title: url, evidence: "", error: error.message };
  } finally {
    await context.close().catch(() => {});
  }
}

async function gotoWithRetry(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  } catch (firstError) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    } catch {
      throw httpError(502, `Could not open ${url}: ${firstError.message}`);
    }
  }
}

// Maps one Gemini Computer Use function_call onto real Playwright calls.
// Coordinates arrive normalized to a 0-999 box regardless of actual
// viewport size (per the Computer Use contract) and are scaled back up
// here. Unknown/unsupported action names degrade to a warning result
// rather than throwing, so one unexpected action name can't kill the loop.
async function executeComputerUseAction(page, call, signal) {
  if (signal?.aborted) throw new Error("cancelled");

  const { name } = call;
  const args = call.arguments || {};
  const viewport = page.viewportSize() || VIEWPORT;
  const x = args.x !== undefined ? denormalize(args.x, viewport.width) : undefined;
  const y = args.y !== undefined ? denormalize(args.y, viewport.height) : undefined;

  switch (name) {
    case "click":
    case "click_at":
      await page.mouse.click(x, y);
      break;
    case "double_click":
      await page.mouse.dblclick(x, y);
      break;
    case "triple_click":
      await page.mouse.click(x, y, { clickCount: 3 });
      break;
    case "middle_click":
      await page.mouse.click(x, y, { button: "middle" });
      break;
    case "right_click":
      await page.mouse.click(x, y, { button: "right" });
      break;
    case "mouse_down":
      await page.mouse.move(x, y);
      await page.mouse.down();
      break;
    case "mouse_up":
      await page.mouse.up();
      break;
    case "move":
    case "hover_at":
      await page.mouse.move(x, y);
      break;
    case "type":
    case "type_text_at": {
      if (x !== undefined && y !== undefined) await page.mouse.click(x, y);
      await page.keyboard.type(String(args.text ?? ""));
      if (args.press_enter) await page.keyboard.press("Enter");
      break;
    }
    case "drag_and_drop": {
      const startX = denormalize(args.start_x ?? args.x, viewport.width);
      const startY = denormalize(args.start_y ?? args.y, viewport.height);
      const endX = denormalize(args.end_x ?? args.destination_x, viewport.width);
      const endY = denormalize(args.end_y ?? args.destination_y, viewport.height);
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(endX, endY);
      await page.mouse.up();
      break;
    }
    case "wait":
    case "wait_5_seconds":
      await page.waitForTimeout(Math.min(5, Number(args.seconds) || 1) * 1000);
      break;
    case "press_key":
    case "key_down":
      await page.keyboard.press(normalizeKey(args.key));
      break;
    case "key_up":
      break; // Playwright's press() is a full down+up already; nothing to release.
    case "hotkey":
    case "key_combination": {
      const keys = Array.isArray(args.keys) ? args.keys : String(args.keys || "").split("+");
      await page.keyboard.press(keys.map(normalizeKey).join("+"));
      break;
    }
    case "take_screenshot":
      break; // the caller screenshots after every step regardless
    case "scroll":
    case "scroll_at":
    case "scroll_document": {
      const magnitude = Number(args.magnitude_in_pixels ?? args.magnitude) || 400;
      const deltaX = args.direction === "left" ? -magnitude : args.direction === "right" ? magnitude : 0;
      const deltaY = args.direction === "down" ? magnitude : args.direction === "up" ? -magnitude : 0;
      if (x !== undefined && y !== undefined) await page.mouse.move(x, y);
      await page.mouse.wheel(deltaX, deltaY);
      // mouse.wheel() dispatches the event and returns immediately, but the
      // browser's compositor applies the actual scroll asynchronously -
      // without this, a screenshot taken right after can still show the
      // pre-scroll position. Confirmed by testing against a real page.
      await page.waitForTimeout(150);
      break;
    }
    case "go_back":
      await page.goBack({ timeout: NAV_TIMEOUT_MS }).catch(() => {});
      break;
    case "go_forward":
      await page.goForward({ timeout: NAV_TIMEOUT_MS }).catch(() => {});
      break;
    case "reload":
      // Not part of Gemini's current predefined action set (it would use
      // navigate to the same URL instead), kept for forward compatibility.
      await page.reload({ timeout: NAV_TIMEOUT_MS }).catch(() => {});
      break;
    case "navigate": {
      // Re-validated here, not just at the initial jump-off: this URL was
      // chosen by the model mid-loop from page content it just read, so it
      // gets the same SSRF check as any other navigation target.
      await assertPublicHttpUrl(args.url);
      await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      break;
    }
    case "open_web_browser":
    case "open_app":
      break; // already open
    default:
      return { warning: `Unsupported action "${name}" was ignored.` };
  }

  return { url: page.url() };
}

function buildFunctionResponses(page, results, screenshot) {
  const currentUrl = page.url();
  const screenshotBase64 = screenshot.toString("base64");
  return results.map(({ name, callId, result }) => ({
    type: "function_result",
    name,
    call_id: callId,
    result: [
      { type: "text", text: JSON.stringify({ url: currentUrl, ...result }) },
      { type: "image", data: screenshotBase64, mime_type: "image/png" },
    ],
  }));
}

function describeAction(call) {
  const intent = call.arguments?.intent;
  if (intent) return intent;
  switch (call.name) {
    case "navigate":
      return `Going to ${call.arguments?.url || "a new page"}`;
    case "type":
    case "type_text_at":
      return `Typing "${truncate(call.arguments?.text, 40)}"`;
    case "click":
    case "click_at":
      return "Clicking on the page";
    case "scroll":
    case "scroll_document":
    case "scroll_at":
      return "Scrolling the page";
    case "go_back":
      return "Going back";
    case "go_forward":
      return "Going forward";
    case "wait":
    case "wait_5_seconds":
      return "Waiting for the page to settle";
    default:
      return `Performing "${call.name}"`;
  }
}

function normalizeKey(key) {
  const map = { return: "Enter", esc: "Escape", cmd: "Meta", command: "Meta", ctrl: "Control", del: "Delete" };
  const trimmed = String(key || "").trim();
  return map[trimmed.toLowerCase()] || trimmed;
}

function summarizeFetchResults(steps) {
  return steps
    .map((step) => ({
      url: step.url || step.retrieved_url || step.url_metadata?.retrieved_url || step.url_metadata?.url,
      status: step.status || step.url_metadata?.url_retrieval_status,
    }))
    .filter((entry) => entry.url);
}

function denormalize(value, span) {
  return Math.max(0, Math.min(span - 1, Math.round((Number(value) / 1000) * span)));
}

function truncate(text, max) {
  const str = String(text || "");
  return str.length > max ? `${str.slice(0, max)}...` : str;
}

function clampInt(rawValue, fallback, min, max) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
