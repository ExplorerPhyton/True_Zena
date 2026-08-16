# Gemini browser agent architecture

This document covers `server/services/geminiBrowserAgent.js` and the
modules around it - the system that replaced Browse AI/Robots as True
Zena's web-evidence engine. If you're looking for how to run the app day
to day, see `README.md`; this is the "how it actually works" doc.

## Why this exists

True Zena's text checker used to call Browse AI to fetch outside evidence
for a pasted claim. Browse AI ran a pre-trained "robot" against a fixed
site/search workflow and returned whatever that robot had been configured
to scrape. This system replaces that with a Gemini-driven agent that
decides for itself what to search for, which sources are worth reading,
and - only when a page genuinely needs it - actually drives a real browser
to get at content a static fetch can't reach.

## Pipeline

One call to `investigateClaim({ claim })` runs up to four stages. The
first two always run; the third only runs when it's genuinely needed; the
fourth always runs.

```
 claim
   │
   ▼
 1. RESEARCH            Interactions API call with the google_search and
    (always)             url_context tools. Gemini decides what to search
                          for and which pages to actually read; URL
                          Context does the fetching for static pages and
                          returns citations (real URLs, not typed from
                          memory - see groundingMetadata-equivalent
                          annotations).
   │
   ▼
 2. TRIAGE              A small structured call (existing generateJSON/
    (always)             generateContent client - see server/lib/gemini.js)
                          turns the research notes into a source list and
                          flags at most AGENT_MAX_DEEP_SOURCES URLs whose
                          key evidence looks genuinely inaccessible
                          statically (a search form, pagination, a
                          client-rendered dashboard, tabs, etc).
   │
   ▼
 3. DEEP BROWSE         Only runs for flagged URLs. For each one:
    (conditional)          launch Chromium (Playwright, isolated context
                            per source) → navigate → loop:
                              screenshot → Gemini (computer_use tool)
                              → function_call action → validate →
                              execute in Playwright → screenshot →
                              function_result → repeat
                            until Gemini returns a final text answer, a
                            step budget is hit, or the overall time budget
                            runs out. Browser closes in a `finally` no
                            matter how the loop ends.
   │
   ▼
 4. SYNTHESIS           One structured-output call (generateJSON, same
    (always)             pattern as the claim-extraction pipeline) turns
                          the claim + everything gathered into exactly one
                          True Zena verdict: [VERIFIED TRUE],
                          [FALSE / MISLEADING],
                          [UNVERIFIED / INSUFFICIENT DATA], or
                          [SATIRE / CONTEXT NEEDED], with per-source
                          classification, contradictions, and missing
                          context.
   │
   ▼
 structured evidence result → server/routes/evidenceCheck.js →
 SSE progress events + final `done` payload → src/App.jsx `EvidencePanel`
```

For most claims, stage 3 never runs at all - Google Search + URL Context
already cover the large majority of real sources (news articles,
government pages, reference sites), so most investigations are two Gemini
calls plus one synthesis call and never touch Playwright. Stage 3 exists
for the minority of sources that are genuinely behind interaction: a
search box that has to be submitted, a "load more" button, a tab that
swaps in content client-side. That conditional design is deliberate, not
a shortcut - the brief this was built against explicitly asks Gemini to
"decide whether search/page inspection/browser interaction is required"
rather than always doing the most expensive thing.

## Why the Interactions API, not generateContent

Google's Computer Use, URL Context, and (going forward) Google Search
tools are documented against the newer **Interactions API**
(`POST /v1beta/interactions`), which Google's own docs describe as GA and
recommended for all new work as of mid-2026. The existing claim-extraction
pipeline (`server/lib/gemini.js`) uses the older `generateContent`
endpoint, which Google states remains fully supported - so it was left
untouched rather than migrated for its own sake. `server/lib/geminiInteractions.js`
is a small, dependency-free client for the newer endpoint (same
raw-`fetch` style as `gemini.js`, no `@google/genai` SDK dependency added),
used only by the browser agent. The final verdict-synthesis call reuses
the existing `generateJSON` helper from `gemini.js` rather than
reinventing structured output on the new endpoint, since that path was
already implemented, tested, and still valid.

## Security

- **SSRF guard** (`server/lib/urlSafety.js`): every URL Playwright is
  about to navigate to - the initial deep-browse target and any
  `navigate` action Gemini requests mid-loop - is checked for protocol
  (http/https only; blocks `file://`, `javascript:`, `data:`, etc.) and
  resolved via DNS, with every returned address checked against the
  private/loopback/link-local/reserved ranges, including
  `169.254.169.254` (cloud metadata). This is a strong, practical
  mitigation, not a mathematically complete one - see the limitations
  section below.
- **No autonomous consent/transactional actions**: Gemini's Computer Use
  tool returns a `safety_decision` on some actions (cookie/consent
  dialogs, logins, purchases, anything Google's built-in safety policies
  flag as `require_confirmation` or blocked). Because this is an
  unattended, read-only, server-side evidence job with no human in the
  loop, the agent never auto-confirms these - it skips the action, logs
  why, and continues. It only ever reads pages; it never fills in or
  submits a form.
- **Bounded everything**: `AGENT_MAX_STEPS` caps the action loop per
  source, `AGENT_MAX_DEEP_SOURCES` caps how many sources get the
  interactive treatment per request, and `AGENT_TOTAL_TIMEOUT_MS` is an
  overall wall-clock budget checked between stages and loop iterations.
  A source that fails to load or errors mid-loop is caught and reported
  as a partial result - it does not abort the rest of the investigation,
  and the whole request cannot hang indefinitely.
- **Isolated browser context per source**: each deep-browsed source gets
  its own `browser.newContext()` (cookies/storage isolated from any other
  source in the same investigation), closed in a `finally` block.
  Chromium itself launches per-request rather than as a shared long-lived
  pool, matching the isolation the brief asks for.
- **API keys stay server-side**: `GEMINI_API_KEY` is read only inside
  `server/`, never bundled into the Vite build or the Android app - same
  rule the rest of this codebase already follows for every secret.

## Known limitations (genuinely outside easy reach here)

- **DNS-rebinding**: the SSRF guard resolves DNS at request time and
  checks every address returned. It does not (and, short of proxying
  every Playwright socket connection through a policy-enforcing egress
  proxy, realistically cannot from application code alone) close a race
  where a hostname resolves to a public IP at check time and a private
  one at connect time a moment later. This is a known-hard class of
  problem for any application-level SSRF filter, not specific to this
  implementation.
- **IPv6 range coverage is best-effort.** The realistic threat this guard
  defends against (cloud metadata endpoints, internal dashboards) is
  overwhelmingly IPv4; the IPv6 checks cover the common private/link-
  local/multicast ranges but are not exhaustively audited against the
  full IANA special-purpose registry.
- **`url_context_result` field names were not confirmed against a live
  response.** Google's docs describe this step type in prose ("status,
  retrieved URL") without a literal JSON example, unlike every other step
  type used here, which was verified against a documented example. The
  triage stage reads it defensively (a few plausible field-name variants,
  a `.catch()` fallback) and does not depend on it being exactly right -
  worth confirming against a real response during integration testing.
- **No true "select" or "reload" primitives.** Gemini's current Computer
  Use action set doesn't have a distinct dropdown-select action (it
  composes one from click + click, the same way a human would) or a
  literal reload action (it would re-`navigate` to the same URL); the
  executor here mirrors that rather than inventing actions the model was
  never taught to call.
- **Live progress is real, not simulated, but coarse.** The SSE stage
  events map to actual pipeline transitions (see the stage list in
  `src/App.jsx`'s `AGENT_STAGE_LABELS`), not a fake timer - but within
  Stage 3's action loop, individual step detail text comes from Gemini's
  own `intent` field for that action rather than a structured play-by-
  play, by design (the brief asks not to expose raw internal
  implementation details in the UI).
