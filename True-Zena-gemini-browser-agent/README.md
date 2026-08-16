# True Zena

A React hackathon MVP for checking misinformation at the claim level, with
an optional Gemini-powered video/media checker and Amharic UI support.

## Run locally

Two processes: the API server, and the Vite frontend that proxies `/api/*`
to it.

```bash
npm install
npm run server    # terminal 1 - API server on http://127.0.0.1:8787
npm run dev        # terminal 2 - frontend on http://127.0.0.1:5173
```

Use `npm install` rather than `npm ci` the first time after pulling this
change - `package.json` gained a new dependency (`playwright`) and
`package-lock.json` hasn't been regenerated against it yet (that needs a
real `npm install` run, which wasn't possible in the sandboxed environment
these changes were made in - see the note at the bottom of this file).
`npm install` will update the lockfile; `npm ci` deliberately refuses to
run against a lockfile that doesn't match `package.json`, so it will fail
until that first `npm install` has been run once.

Open `http://127.0.0.1:5173/`.

`npm run dev` alone still loads a working page - the paste-text checker,
its evidence panel, and the reply box all run locally in the browser. The
server is only needed for the Gemini browser agent's web evidence and the
AI Video & Media Check panel; without it, both show a friendly "not
connected yet" instead of an error.

## Environment setup

Copy `.env.local.example` to `.env.local` and fill in whatever you plan to
use. Everything in it is read **server-side only**, by `server/index.js` -
never by the browser. (See the comments in that file for why: a real API
key stored with the `VITE_` prefix gets bundled into the JavaScript shipped
to every visitor.) `.env.production.example` is the same template for a
real deployment.

### Gemini (both the text checker's web evidence and AI Video & Media Check)

```env
GEMINI_API_KEY=your_gemini_api_key_here
```

Get a key at https://aistudio.google.com/apikey. The same key powers both
features below - there's only one Gemini account to set up.

### Gemini browser agent (web evidence for the text checker)

The text checker's evidence panel is powered by a real Gemini browser
agent (`server/services/geminiBrowserAgent.js`), not a third-party
service - it searches the web, reads pages with Gemini's URL Context tool,
and, when a page genuinely needs clicking or scrolling to reveal its
content, drives a real headless Chromium via Playwright and Gemini's
Computer Use tool until it has enough evidence. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full pipeline.

```env
GEMINI_AGENT_MODEL=gemini-3.6-flash
AGENT_MAX_STEPS=10
AGENT_MAX_DEEP_SOURCES=2
AGENT_NAVIGATION_TIMEOUT_MS=20000
AGENT_ACTION_TIMEOUT_MS=8000
AGENT_TOTAL_TIMEOUT_MS=90000
AGENT_HEADLESS=true
```

All optional - the defaults above are what the code falls back to if
unset. See the comments in `.env.local.example` for what each one does.

This feature drives a real browser, so after `npm install` you also need
to download a Chromium binary for Playwright to control (this is separate
from the npm package itself, similar to how yt-dlp/ffmpeg below are
separate from `npm install`):

```bash
npx playwright install chromium
```

### AI Video & Media Check

Checking a video by URL (YouTube, TikTok, X/Twitter, Facebook) also needs
`yt-dlp` and `ffmpeg` installed and on `PATH` (or pointed to via
`YT_DLP_PATH`/`FFMPEG_PATH` in `.env.local`) - these are system tools, not
npm packages, so `npm install` won't install them:

```bash
pip install yt-dlp
# ffmpeg: apt install ffmpeg / brew install ffmpeg / see ffmpeg.org
```

The other input options - audio-only URL, uploading a screenshot or short
audio clip directly, or pasting a transcript - all work without yt-dlp, so
the panel is still useful without it.

## What it does

- Extracts checkable claims from pasted text
- Optionally investigates the claim with a real Gemini browser agent -
  search, page reading, and (when a page needs it) actual interactive
  browsing - and folds what it finds back into the local checker
- Labels claims as likely true, likely false, misleading, unsupported, or needing context
- Explains what is wrong and gives a corrected version
- Links to trusted evidence for built-in fact patterns
- Generates a calm reply the user can send back
- **AI Video & Media Check**: paste a video link, or - on a slow connection
  - submit just the audio, a screenshot, or a transcript instead. Gemini
  extracts claims with MM:SS timestamps and verdicts (true / false /
  misleading / unverified), and for false-or-misleading claims, attaches
  real source links found via Google Search grounding
- Detects the input language (Amharic and others) and shows claim text and
  summaries in both the source language and English; the interface itself
  has an EN/አማ toggle in the top bar
- Recent AI checks are cached on-device, so repeating the same link or
  transcript returns instantly with no network request

## Project layout

```
src/                    frontend (React + Vite)
  lib/checker.js          local rule-based claim checker - no API needed
  lib/factRules.js         built-in fact patterns + trusted sources
  lib/aiFactCheck.js        client for the Gemini video/media endpoints
  lib/sse.js                  POST-based SSE reader for live agent progress
  lib/offlineCache.js          localStorage cache for AI results
  lib/i18n.js                    EN/Amharic interface strings
server/                  API server (plain Node http, no framework)
  routes/                  one handler per endpoint
  lib/gemini.js              Gemini REST client (Files API + generateContent)
  lib/geminiInteractions.js   Gemini Interactions API client (search/URL
                                context/computer use - see ARCHITECTURE.md)
  lib/evidenceSchema.js        structured evidence schema + agent prompts
  lib/urlSafety.js               SSRF guard for everywhere the agent navigates
  lib/videoIngest.js               yt-dlp wrapper
  services/geminiBrowserAgent.js     the browser agent itself (Playwright +
                                       Gemini Computer Use action loop)
android/                 Capacitor Android project (appId com.truezena.app)
```

## A note on the Amharic UI strings

The interface-chrome translations in `src/lib/i18n.js` are a best effort at
common, simple words and haven't been reviewed by a native speaker - worth
a pass before this reaches real users, given how much precision matters
for a fact-checking product. The AI panel's actual claim and summary
translations come from Gemini per response, which is generally more
reliable for nuanced language than a fixed phrase table.

## Building the Android app

```bash
npm run build
npm run cap:sync
npm run cap:open   # opens Android Studio
# or, with the Android SDK/Gradle set up locally:
npm run apk
```

`server/index.js` isn't bundled into the Android app - it needs to be
deployed somewhere reachable from the device for the Gemini browser
agent's evidence search and the AI Video & Media Check to work. The
Android app never launches its own browser or Chromium - all of that runs
server-side, and the app just talks to your deployed server over HTTPS
like any other API call. Set `VITE_API_BASE_URL` to that server's public
URL before running `npm run build` (see `.env.production.example`), and
make sure the deployed server itself has run `npx playwright install
chromium` (see above) - `cap:sync` only syncs the web build into the
Android project, it has no effect on the separate backend deployment.

## Next steps

The original "hackathon upgrade path" here - extract claims with an LLM,
retrieve evidence, compare the claim against evidence only, return the
same verdict card shape - is what `server/` now does for video/media
input. From here, natural next steps are: deploying `server/index.js`
somewhere durable (with Chromium installed for the browser agent, and
enough memory/CPU headroom to run it - see `ARCHITECTURE.md`); swapping
the localStorage cache for `@capacitor/preferences` if the app needs to
survive the user clearing the WebView's site data; and a native-speaker
pass on the Amharic strings.

## A note on how the Browse AI -> Gemini browser agent migration was verified

The environment this migration was built in had no outbound network
access at all (`npm ci`, live Gemini API calls, and Playwright's own
Chromium browsing were all blocked alike), so `npm ci` / `npm run build`
could not be run to completion there and `package-lock.json` was not
regenerated - see the `npm install` note above. What *was* verified in
that environment, for real, before this reached you:

- Every touched file passes syntax validation (`node --check` for plain
  JS, a JSX-aware TypeScript check for `App.jsx`).
- Every relative import across both `server/` and `src/` resolves to a
  real file.
- `server/lib/urlSafety.js`'s SSRF guard was run against 28 real
  cases - safe URLs, blocked protocols, loopback, RFC1918 ranges, IPv6
  loopback, the cloud-metadata address, and a decimal-IP obfuscation
  attempt - using real DNS resolution, not just read for correctness.
- The Computer Use action dispatcher in
  `server/services/geminiBrowserAgent.js` was run against a real headless
  Chromium (a browser binary happened to already be present in that
  sandbox): real click, type, and scroll actions against a real page,
  and a real navigate-to-cloud-metadata attempt confirmed blocked. This
  caught and fixed one real bug - a scroll action wasn't reliably
  reflected in the next screenshot without a short settle wait.
- The full `investigateClaim()` orchestration was run end-to-end with
  Gemini's Interactions API and structured-output calls mocked at the
  network boundary (shaped to match Google's documented response
  schemas), covering: the common no-deep-browsing path, an unsafe
  deep-browse target being filtered before a browser ever launches, a
  normal-looking target reaching a real Chromium launch and failing
  navigation gracefully, a simulated Gemini outage, "not configured," and
  an empty claim - 18 assertions, all passing.
- The SSE route in `server/routes/evidenceCheck.js` was exercised
  end-to-end against the real client-side parser in `src/lib/sse.js` over
  a real local HTTP connection.

What was **not** possible to verify there: an actual `npm ci` /
`npm run build` / Android Gradle build (network- and toolchain-blocked in
that sandbox), and a real Gemini API round-trip (needs a live API key and
network access neither available there). Both are ordinary next steps in
an environment that has npm registry and Gemini API access.

