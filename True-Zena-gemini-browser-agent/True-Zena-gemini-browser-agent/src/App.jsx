import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpenCheck,
  Camera,
  CheckCircle2,
  Clipboard,
  Clock,
  Eraser,
  FileSearch,
  FileText,
  Globe2,
  HelpCircle,
  Languages,
  Link2,
  Loader2,
  MessageSquareQuote,
  Mic,
  Music,
  RotateCcw,
  Search,
  SearchCheck,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Video,
  WifiOff,
} from "lucide-react";
import { analyzeText, getSampleText } from "./lib/checker";
import { sourceQuality, verdictMeta } from "./lib/factRules";
import { checkFile, checkTranscript, checkVideoUrl } from "./lib/aiFactCheck";
import { cacheKeyFor, getCached, setCached } from "./lib/offlineCache";
import { SUPPORTED_LANGUAGES, translationsFor } from "./lib/i18n";
import { postEventStream } from "./lib/sse";

const verdictIcons = {
  true: CheckCircle2,
  false: AlertTriangle,
  misleading: TriangleAlert,
  unsupported: HelpCircle,
  context: FileSearch,
};

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

const examples = [
  "Australia's capital is Sydney. Vaccines cause autism. Climate change is a hoax.",
  "The Great Wall of China is visible from the Moon. Humans use only 10% of their brain.",
  "Addis Ababa is the capital of Ethiopia. Canberra is the capital of Australia.",
];

function normalizeExtractedText(value) {
  if (!value) return [];
  if (typeof value === "string") {
    return [value.trim()];
  }
  if (Array.isArray(value)) {
    return value.flatMap(normalizeExtractedText);
  }
  if (typeof value === "object") {
    return Object.values(value).flatMap(normalizeExtractedText);
  }
  return [];
}

// Flattens the Gemini browser agent's structured result (see
// server/lib/evidenceSchema.js) into a plain-text blob for the local
// checker's inferClaimFromEvidence() (src/lib/checker.js) to scan for
// supporting/contradicting phrases against each locally-detected claim.
// Much simpler than the previous third-party evidence service's version
// of this function: that one had to recursively walk an arbitrary,
// vendor-dependent JSON shape and guess what was noise; this one just
// reads the handful of fields the agent's own schema guarantees will be
// there.
function buildEvidenceSummaryText(result) {
  if (!result || result.configured === false || result.error) return "";

  const parts = [];
  if (result.summary) parts.push(result.summary);
  for (const source of result.sources ?? []) {
    if (source?.evidence) parts.push(source.evidence);
  }
  for (const contradiction of result.contradictions ?? []) {
    parts.push(contradiction);
  }

  return parts
    .filter(Boolean)
    .map((note) => note.replace(/\s+/g, " ").trim())
    .join(" ")
    .trim();
}

export default function App() {
  const [text, setText] = useState(getSampleText());
  const [isChecking, setIsChecking] = useState(false);
  const [isEvidenceChecking, setIsEvidenceChecking] = useState(false);
  const [evidenceResult, setEvidenceResult] = useState(null);
  const [evidenceStage, setEvidenceStage] = useState("");
  const [copied, setCopied] = useState(false);
  const [lastCheckedText, setLastCheckedText] = useState(getSampleText());

  const [language, setLanguage] = useState("en");
  const t = translationsFor(language);

  const [mediaMode, setMediaMode] = useState("url");
  const [mediaUrl, setMediaUrl] = useState("");
  const [mediaTranscript, setMediaTranscript] = useState("");
  const [mediaFile, setMediaFile] = useState(null);
  const [aiResult, setAiResult] = useState(null);
  const [isAiChecking, setIsAiChecking] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiFromCache, setAiFromCache] = useState(false);

  const evidenceText = useMemo(() => buildEvidenceSummaryText(evidenceResult), [evidenceResult]);
  const analysis = useMemo(() => analyzeText(lastCheckedText, evidenceText), [lastCheckedText, evidenceText]);

  async function runCheck(nextText = text) {
    setIsChecking(true);
    setIsEvidenceChecking(true);
    setEvidenceResult(null);
    setEvidenceStage("");
    setCopied(false);
    setLastCheckedText(nextText);
    window.setTimeout(() => setIsChecking(false), 380);

    try {
      const result = await runEvidenceCheck(nextText);
      setEvidenceResult(result);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      setEvidenceResult({
        error: "The evidence search request failed.",
        details,
      });
    } finally {
      setIsEvidenceChecking(false);
      setEvidenceStage("");
    }
  }

  // Calls the server-side Gemini browser agent at /api/gemini-evidence,
  // which replaced this app's previous third-party web-evidence service.
  // Streams live progress (Searching / Reading page / Opening source /
  // ... / Complete) over SSE so a multi-source investigation shows real
  // state instead of a frozen spinner; postEventStream resolves with the
  // final structured result once a `done` event arrives. GEMINI_API_KEY
  // never reaches the browser - it's read server-side only, same as every
  // other secret in this app (see .env.local.example).
  async function runEvidenceCheck(textToCheck) {
    let finalResult = null;

    await postEventStream(
      `${API_BASE}/api/gemini-evidence`,
      { text: textToCheck },
      {
        onEvent: (eventName, payload) => {
          if (eventName === "progress") {
            setEvidenceStage(payload.stage);
          } else if (eventName === "done") {
            finalResult = payload;
          } else if (eventName === "error") {
            throw new Error(payload.error || "The evidence check failed.");
          }
        },
      }
    );

    return finalResult;
  }

  async function copyReply() {
    await navigator.clipboard.writeText(analysis.reply);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  function resetSample() {
    const sample = getSampleText();
    setText(sample);
    runCheck(sample);
  }

  // Drives the AI Video & Media Check panel (Part 2/3 of the brief). Checks
  // the local cache first so a repeated query on a slow connection
  // resolves instantly with zero data used (Part 3.4); only calls the
  // network when there is no cached entry yet.
  async function runAiMediaCheck() {
    const cacheInput = mediaMode === "url" || mediaMode === "url-audio" ? mediaUrl.trim() : mediaMode === "transcript" ? mediaTranscript.trim() : mediaFile?.name || "";

    if (mediaMode !== "file" && !cacheInput) {
      setAiError(mediaMode === "transcript" ? "Paste some text first." : "Paste a link first.");
      return;
    }
    if (mediaMode === "file" && !mediaFile) {
      setAiError("Choose a file first.");
      return;
    }

    setAiError("");
    setAiFromCache(false);

    const cacheKey = mediaMode === "file" ? null : cacheKeyFor(mediaMode, cacheInput);
    if (cacheKey) {
      const cached = getCached(cacheKey);
      if (cached) {
        setAiResult(cached);
        setAiFromCache(true);
        return;
      }
    }

    setIsAiChecking(true);
    setAiResult(null);

    try {
      let result;
      if (mediaMode === "url") result = await checkVideoUrl(mediaUrl.trim(), false);
      else if (mediaMode === "url-audio") result = await checkVideoUrl(mediaUrl.trim(), true);
      else if (mediaMode === "transcript") result = await checkTranscript(mediaTranscript.trim());
      else result = await checkFile(mediaFile);

      setAiResult(result);
      if (cacheKey && result?.configured !== false) {
        setCached(cacheKey, result);
      }
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsAiChecking(false);
    }
  }

  useEffect(() => {
    runCheck(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <ShieldCheck size={24} aria-hidden="true" />
          <div>
            <h1>True Zena</h1>
            <p>Search claims, sources, and context</p>
          </div>
        </div>
        <nav className="topbar-links" aria-label="Search sections" >
          <a href="#results">Results</a>
          <a href="#evidence">Evidence</a>
          <a href="#reply">Reply</a>
          <a href="#ai-media">{t.navAiMedia}</a>
        </nav>
        <div className="language-switch" role="group" aria-label="Interface language">
          <Languages size={16} aria-hidden="true" />
          {SUPPORTED_LANGUAGES.map((option) => (
            <button
              key={option.code}
              type="button"
              className={language === option.code ? "lang-active" : ""}
              onClick={() => setLanguage(option.code)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      <main className="workspace">
        <section className="search-stage" aria-label="Claim search">
          <div className="logo-lockup" aria-label="True Zena">
            <span className="logo-part logo-blue">T</span>
            <span className="logo-part logo-red">r</span>
            <span className="logo-part logo-yellow">u</span>
            <span className="logo-part logo-blue">e</span>
            <span className="logo-space" />
            <span className="logo-part logo-green">Z</span>
            <span className="logo-part logo-red">e</span>
            <span className="logo-part logo-yellow">n</span>
            <span className="logo-part logo-blue">a</span>
          </div>

          <div className="search-box">
            <Search size={22} aria-hidden="true" />
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Search a claim, post, headline, statistic, or quote..."
              spellCheck="true"
              rows={1}
              wrap="off"
              aria-label="Search claims"
            />
            <button className="tool-button" type="button" title="Reset sample" onClick={resetSample}>
              <RotateCcw size={18} />
            </button>
            <button className="tool-button" type="button" title="Voice search placeholder">
              <Mic size={18} />
            </button>
          </div>

          <div className="search-actions">
            <button className="primary-button" type="button" onClick={() => runCheck()} disabled={isChecking}>
              {isChecking ? <Loader2 className="spin" size={18} /> : <SearchCheck size={18} />}
              {isChecking ? "Searching" : "True Zena Search"}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                setText("");
                setLastCheckedText("");
              }}
            >
              <Eraser size={18} />
              Clear
            </button>
          </div>

          <div className="example-row" aria-label="Suggested searches">
            <span>Trending checks</span>
            {examples.map((example, index) => (
              <button
                key={example}
                type="button"
                className="example-button"
                onClick={() => {
                  setText(example);
                  runCheck(example);
                }}
              >
                <Sparkles size={15} />
                Sample {index + 1}
              </button>
            ))}
          </div>
        </section>

        <section className="results-pane" id="results" aria-label="Misinformation analysis">
          <div className="result-tabs" aria-label="Result types">
            <button className="tab-active" type="button">
              <Search size={16} />
              All
            </button>
            <button type="button">
              <BookOpenCheck size={16} />
              Sources
            </button>
            <button type="button">
              <Globe2 size={16} />
              Web
            </button>
          </div>
          <SummaryStrip analysis={analysis} />
          <EvidencePanel result={evidenceResult} loading={isEvidenceChecking} stage={evidenceStage} />
          <HighlightedText text={lastCheckedText} claims={analysis.claims} />
          <ReplyBox reply={analysis.reply} copied={copied} onCopy={copyReply} />
          <ClaimList claims={analysis.claims} empty={analysis.empty} skipped={analysis.skipped} />
        </section>

        <AiMediaPanel
          t={t}
          mode={mediaMode}
          onModeChange={(mode) => {
            setMediaMode(mode);
            setAiError("");
          }}
          urlValue={mediaUrl}
          onUrlChange={setMediaUrl}
          transcriptValue={mediaTranscript}
          onTranscriptChange={setMediaTranscript}
          file={mediaFile}
          onFileChange={setMediaFile}
          onSubmit={runAiMediaCheck}
          isChecking={isAiChecking}
          result={aiResult}
          error={aiError}
          fromCache={aiFromCache}
        />
      </main>
    </div>
  );
}

// Live-progress labels for the Gemini browser agent (see onProgress calls
// in server/services/geminiBrowserAgent.js) - kept in the same order the
// stages actually happen in. Simple claims often skip straight from
// "Reading sources" to "Collecting evidence" because no source needed
// interactive browsing; the label list only shows what's actually
// happening, never a step that didn't run.
const AGENT_STAGE_LABELS = {
  searching: "Searching the web",
  reading_page: "Reading sources",
  opening_source: "Opening a source",
  navigating: "Navigating the page",
  collecting_evidence: "Collecting evidence",
  cross_checking: "Cross-checking sources",
  analyzing: "Analyzing the evidence",
  complete: "Complete",
};

function verdictTone(verdict) {
  if (verdict === "[VERIFIED TRUE]") return "true";
  if (verdict === "[FALSE / MISLEADING]") return "false";
  if (verdict === "[SATIRE / CONTEXT NEEDED]") return "misleading";
  return "unsupported"; // [UNVERIFIED / INSUFFICIENT DATA], or anything unrecognized
}

function EvidencePanel({ result, loading, stage }) {
  const sources = result?.sources ?? [];
  const contradictions = result?.contradictions ?? [];
  const missingContext = result?.missingContext ?? [];
  const stageLabel = AGENT_STAGE_LABELS[stage] || "Investigating";

  return (
    <section className="agent-panel" id="evidence">
      <div className="panel-title">
        {loading ? <Loader2 className="spin" size={18} /> : <SearchCheck size={18} />}
        <h3>Evidence search</h3>
      </div>

      {loading ? (
        <p className="muted">{stageLabel} with Gemini's browser agent...</p>
      ) : result?.configured === false ? (
        <p className="muted">{result.summary}</p>
      ) : result?.error ? (
        <>
          <p className="muted">{result.error}</p>
          {result.details && <p className="muted">{result.details}</p>}
        </>
      ) : result ? (
        <>
          <div className="ai-summary-row">
            <span className={`trust-badge trust-${verdictTone(result.verdict)}`}>{result.verdict}</span>
            {result.confidence && <span className="confidence-badge">Confidence: {result.confidence}</span>}
          </div>

          {result.summary && <p className="ai-summary-text">{result.summary}</p>}

          {sources.length > 0 ? (
            <div className="agent-sources">
              {sources.map((source) => (
                <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="agent-source-card">
                  <div className="agent-source-top">
                    <Link2 size={15} />
                    <span className="agent-source-title">{source.title || source.url}</span>
                    {source.sourceType && <span className="source-type-tag">{source.sourceType.replace("_", " ")}</span>}
                  </div>
                  {(source.publisher || source.publishedAt) && (
                    <p className="agent-source-meta">{[source.publisher, source.publishedAt].filter(Boolean).join(" · ")}</p>
                  )}
                  {source.evidence && <p className="agent-source-evidence">{source.evidence}</p>}
                </a>
              ))}
            </div>
          ) : (
            <p className="muted">No outside sources were found for this claim.</p>
          )}

          {contradictions.length > 0 && (
            <div className="agent-note-list">
              <p className="field-label">
                <TriangleAlert size={14} />
                Contradictions
              </p>
              <ul>
                {contradictions.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          )}

          {missingContext.length > 0 && (
            <div className="agent-note-list">
              <p className="field-label">
                <FileSearch size={14} />
                Missing context
              </p>
              <ul>
                {missingContext.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          )}

          {result.agentSteps > 0 && (
            <p className="agent-transparency">
              <Globe2 size={14} />
              The browser agent took {result.agentSteps} action{result.agentSteps === 1 ? "" : "s"} reading sources interactively.
            </p>
          )}
        </>
      ) : (
        <p className="muted">Run a check to search for outside evidence.</p>
      )}
    </section>
  );
}

const AI_MODES = [
  { id: "url", labelKey: "modeUrl", icon: Video },
  { id: "url-audio", labelKey: "modeAudio", icon: Music },
  { id: "file", labelKey: "modeFile", icon: Camera },
  { id: "transcript", labelKey: "modeTranscript", icon: FileText },
];

function AiMediaPanel({
  t,
  mode,
  onModeChange,
  urlValue,
  onUrlChange,
  transcriptValue,
  onTranscriptChange,
  file,
  onFileChange,
  onSubmit,
  isChecking,
  result,
  error,
  fromCache,
}) {
  return (
    <section className="ai-media-panel" id="ai-media" aria-label="AI video and media check">
      <div className="panel-title">
        <Video size={18} />
        <h3>{t.aiPanelTitle}</h3>
      </div>
      <p className="muted">{t.aiPanelSubtitle}</p>

      <div className="mode-row" role="group" aria-label="Input type">
        {AI_MODES.map(({ id, labelKey, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={mode === id ? "mode-chip mode-chip-active" : "mode-chip"}
            onClick={() => onModeChange(id)}
          >
            <Icon size={15} />
            {t[labelKey]}
          </button>
        ))}
      </div>

      <div className="ai-input-row">
        {(mode === "url" || mode === "url-audio") && (
          <input
            type="url"
            className="ai-text-input"
            value={urlValue}
            onChange={(event) => onUrlChange(event.target.value)}
            placeholder={t.urlPlaceholder}
            aria-label={t.modeUrl}
          />
        )}

        {mode === "transcript" && (
          <textarea
            className="ai-textarea-input"
            value={transcriptValue}
            onChange={(event) => onTranscriptChange(event.target.value)}
            placeholder={t.transcriptPlaceholder}
            rows={3}
            aria-label={t.modeTranscript}
          />
        )}

        {mode === "file" && (
          <label className="ai-file-input">
            <Camera size={16} />
            <span>{file ? file.name : t.filePrompt}</span>
            <input type="file" accept="image/*,audio/*" onChange={(event) => onFileChange(event.target.files?.[0] ?? null)} />
          </label>
        )}

        <button className="primary-button" type="button" onClick={onSubmit} disabled={isChecking}>
          {isChecking ? <Loader2 className="spin" size={18} /> : <SearchCheck size={18} />}
          {isChecking ? t.checkingButton : t.checkButton}
        </button>
      </div>

      {error && <p className="ai-error">{error}</p>}

      {fromCache && result && (
        <p className="cached-badge">
          <WifiOff size={14} />
          {t.cachedBadge}
        </p>
      )}

      {result?.configured === false && <p className="muted">{result.summary || t.notConfigured}</p>}

      {result && result.configured !== false && <AiResultView t={t} result={result} />}
    </section>
  );
}

function AiResultView({ t, result }) {
  const claims = Array.isArray(result.claimsToVerify) ? result.claimsToVerify : [];
  const isEnglishSource = String(result.detectedLanguage || "english").toLowerCase() === "english";

  return (
    <div className="ai-result">
      <div className="ai-summary-row">
        <span className={`trust-badge trust-${trustTone(result.trustScore)}`}>{t.trustScore}: {Math.round(result.trustScore ?? 0)}</span>
        {result.detectedLanguage && (
          <span className="language-badge">
            <Languages size={14} />
            {t.detectedLanguage}: {result.detectedLanguage}
          </span>
        )}
      </div>

      {result.summary && <p className="ai-summary-text">{result.summary}</p>}
      {!isEnglishSource && result.summaryEnglish && result.summaryEnglish !== result.summary && (
        <p className="ai-summary-text muted">{result.summaryEnglish}</p>
      )}

      <p className="field-label">{t.claimsHeading}</p>
      {claims.length === 0 ? (
        <p className="muted">{t.noClaims}</p>
      ) : (
        <div className="claim-stack">
          {claims.map((claim, index) => (
            <AiClaimCard key={`${claim.timestamp ?? "na"}-${index}`} claim={claim} isEnglishSource={isEnglishSource} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function trustTone(score) {
  const value = Number(score);
  if (Number.isNaN(value)) return "unsupported";
  if (value >= 70) return "true";
  if (value >= 40) return "misleading";
  return "false";
}

function mapAiVerdict(verdict) {
  const key = String(verdict || "").toLowerCase();
  if (key === "unverified") return "unsupported";
  return verdictMeta[key] ? key : "context";
}

function AiClaimCard({ claim, isEnglishSource, t }) {
  const verdictKey = mapAiVerdict(claim.verdict);
  const meta = verdictMeta[verdictKey];
  const Icon = verdictIcons[verdictKey] ?? HelpCircle;
  const showEnglish = !isEnglishSource && claim.claimEnglish && claim.claimEnglish !== claim.claim;
  const showEnglishExplanation = !isEnglishSource && claim.explanationEnglish && claim.explanationEnglish !== claim.explanation;

  return (
    <article className={`claim-card claim-${verdictKey}`}>
      <div className="claim-topline">
        <span className={`verdict-pill verdict-${verdictKey}`}>
          <Icon size={16} />
          {meta.label}
        </span>
        {claim.timestamp && claim.timestamp !== "N/A" && (
          <span className="timestamp-badge">
            <Clock size={14} />
            {claim.timestamp}
          </span>
        )}
      </div>

      <h3>{claim.claim}</h3>
      {showEnglish && <p className="muted">{claim.claimEnglish}</p>}

      <div>
        <p className="field-label">Why</p>
        <p>{claim.explanation}</p>
        {showEnglishExplanation && <p className="muted">{claim.explanationEnglish}</p>}
      </div>

      {claim.evidenceLinks?.length > 0 && (
        <div className="evidence-list">
          <p className="field-label">{t.evidenceHeading}</p>
          {claim.evidenceLinks.map((link) => (
            <a key={link.url} href={link.url} target="_blank" rel="noreferrer" className="evidence-link">
              <Link2 size={15} />
              <span>{link.title}</span>
            </a>
          ))}
        </div>
      )}
    </article>
  );
}

function SummaryStrip({ analysis }) {
  const { summary } = analysis;

  return (
    <section className="summary-band">
      <div className="summary-main">
        <p className="eyebrow">About this search</p>
        <h2>{summary.headline}</h2>
        <p>{summary.total} checkable result{summary.total === 1 ? "" : "s"} found in the local claim index.</p>
      </div>
      <div className="metric-grid">
        <Metric label="Claims" value={summary.total} />
        <Metric label="False" value={summary.counts.false} tone="false" />
        <Metric label="Misleading" value={summary.counts.misleading} tone="misleading" />
        <Metric label="Unsupported" value={summary.unsupported} tone="unsupported" />
      </div>
    </section>
  );
}

function Metric({ label, value, tone = "neutral" }) {
  return (
    <div className={`metric metric-${tone}`}>
      <span>{value}</span>
      <p>{label}</p>
    </div>
  );
}

function HighlightedText({ text, claims }) {
  const segments = useMemo(() => makeSegments(text, claims), [text, claims]);

  return (
    <section className="highlight-panel">
      <div className="panel-title">
        <FileSearch size={18} />
        <h3>Claim preview</h3>
      </div>
      <div className="highlight-body">
        {segments.length === 0 ? (
          <p className="muted">No text checked yet.</p>
        ) : (
          segments.map((segment) => (
            <span key={segment.key} className={`highlight highlight-${segment.verdict ?? "plain"}`}>
              {segment.text}
            </span>
          ))
        )}
      </div>
    </section>
  );
}

function ReplyBox({ reply, copied, onCopy }) {
  return (
    <section className="reply-box" id="reply">
      <div className="panel-title">
        <MessageSquareQuote size={18} />
        <h3>Suggested reply</h3>
      </div>
      <p>{reply}</p>
      <button className="copy-button" type="button" onClick={onCopy}>
        <Clipboard size={16} />
        {copied ? "Copied" : "Copy"}
      </button>
    </section>
  );
}

function ClaimList({ claims, empty, skipped }) {
  if (empty) {
    return (
      <section className="empty-state">
        <FileSearch size={28} />
        <h3>No text yet</h3>
      </section>
    );
  }

  if (claims.length === 0) {
    return (
      <section className="empty-state">
        <HelpCircle size={28} />
        <h3>No checkable claims found</h3>
        {skipped.length > 0 && <p>{skipped.length} sentence{skipped.length === 1 ? "" : "s"} read as opinion or question.</p>}
      </section>
    );
  }

  return (
    <section className="claim-stack">
      {claims.map((claim) => (
        <ClaimCard key={claim.id} claim={claim} />
      ))}
    </section>
  );
}

function ClaimCard({ claim }) {
  const meta = verdictMeta[claim.verdict] ?? verdictMeta.context;
  const Icon = verdictIcons[claim.verdict] ?? HelpCircle;

  return (
    <article className={`claim-card claim-${claim.verdict}`}>
      <div className="claim-topline">
        <span className={`verdict-pill verdict-${claim.verdict}`}>
          <Icon size={16} />
          {meta.label}
        </span>
        <span className="confidence">{claim.confidence}% confidence</span>
      </div>

      <h3>{claim.text}</h3>
      <p className="result-url">truezena.local/check/{claim.topic.toLowerCase().replace(/\s+/g, "-")}</p>

      <div className="claim-grid">
        <div>
          <p className="field-label">Why</p>
          <p>{claim.reason}</p>
        </div>
        <div>
          <p className="field-label">Correction</p>
          <p>{claim.correction}</p>
        </div>
      </div>

      <div className="claim-meta-row">
        <span>{claim.type}</span>
        <span>{claim.topic}</span>
      </div>

      {claim.evidence.length > 0 ? (
        <div className="evidence-list">
          <p className="field-label">Evidence</p>
          {claim.evidence.map((source) => (
            <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="evidence-link">
              <Link2 size={15} />
              <span>{source.title}</span>
              <strong>{sourceQuality[source.quality]}</strong>
            </a>
          ))}
        </div>
      ) : (
        <div className="evidence-empty">
          <FileSearch size={16} />
          No trusted source matched in the local demo index.
        </div>
      )}
    </article>
  );
}

function makeSegments(text, claims) {
  if (!text.trim()) return [];

  const claimLookup = new Map(claims.map((claim) => [normalize(claim.text), claim.verdict]));
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence, index) => {
      const trimmed = sentence.trim();
      return {
        key: `${index}-${trimmed}`,
        text: `${trimmed} `,
        verdict: claimLookup.get(normalize(trimmed)),
      };
    })
    .filter((segment) => segment.text.trim().length > 0);
}

function normalize(value) {
  return value.toLowerCase().replace(/[^\w\s%]/g, "").replace(/\s+/g, " ").trim();
}
