// Structured output contract for the Gemini browser agent
// (server/services/geminiBrowserAgent.js), plus the system prompts for
// its three stages: research, triage, and synthesis. Kept in its own file
// - separate from server/lib/promptSchema.js - because it is a genuinely
// different feature with a different verdict system: promptSchema.js
// backs the video/text claim-extraction pipeline (TRUE/FALSE/MISLEADING/
// UNVERIFIED, one entry per claim found in a transcript), while this one
// backs the standalone web-evidence investigation for one pasted claim,
// using the four-value bracketed verdict set requested for that feature
// specifically.

export const EVIDENCE_VERDICTS = [
  "[VERIFIED TRUE]",
  "[FALSE / MISLEADING]",
  "[UNVERIFIED / INSUFFICIENT DATA]",
  "[SATIRE / CONTEXT NEEDED]",
];

// Who published a source, not what it says. Deliberately more granular
// than the "official / academic / news / fact-check / established" prose
// list in the brief, so the UI can show a meaningful label per source
// instead of collapsing everything into "reputable" vs "not."
export const SOURCE_TYPES = [
  "official", // government or the organization the claim is directly about
  "academic", // universities, peer-reviewed research, research institutions
  "news", // established news organizations
  "fact_check", // established fact-checking organizations
  "primary", // the original document/dataset/statement itself
  "secondary", // reporting or analysis about a primary source
  "opinion", // op-eds, commentary, punditry
  "user_generated", // social media, forums, blogs - only authoritative if the claim is about that post itself
  "satire", // satirical publications
  "unknown", // couldn't be confidently classified
];

export const EVIDENCE_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: EVIDENCE_VERDICTS,
      description: "Exactly one True Zena verdict for the claim as a whole.",
    },
    confidence: { type: "string", enum: ["High", "Medium", "Low"] },
    summary: { type: "string", description: "2-4 sentence plain-language summary of what the evidence shows." },
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          publisher: { type: "string", description: "Site or organization name. Empty string if unknown." },
          publishedAt: { type: "string", description: "ISO date if known, otherwise an empty string. Never guess a date." },
          sourceType: { type: "string", enum: SOURCE_TYPES },
          relevance: { type: "string", description: "One sentence: why this source matters to the claim." },
          evidence: {
            type: "string",
            description: "What this specific source shows, paraphrased in plain language. Never a long verbatim quote.",
          },
        },
        required: ["url", "title", "sourceType", "relevance", "evidence"],
      },
    },
    contradictions: {
      type: "array",
      items: { type: "string" },
      description: "Real disagreements between sources, if any. Empty array if sources agree.",
    },
    missingContext: {
      type: "array",
      items: { type: "string" },
      description: "Context a reader would need to correctly interpret the claim, if any is missing.",
    },
  },
  required: ["verdict", "confidence", "summary", "sources", "contradictions", "missingContext"],
};

// Small structured schema for the triage pass between research and deep
// browsing: decide which (if any) candidate sources actually need a real
// interactive browser visit, versus already having been adequately read
// via URL Context.
export const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    candidateSources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string" },
          title: { type: "string" },
        },
        required: ["url"],
      },
    },
    needsDeepBrowsing: {
      type: "array",
      description: "At most 2 URLs whose key evidence was genuinely inaccessible from a static read.",
      items: {
        type: "object",
        properties: {
          url: { type: "string" },
          reason: { type: "string", description: "Why a static read wasn't enough - e.g. behind a search form, paginated, tab content, dynamic dashboard." },
        },
        required: ["url", "reason"],
      },
    },
  },
  required: ["candidateSources", "needsDeepBrowsing"],
};

const SOURCE_PRIORITY = `Prioritize sources in this order: (1) official government sources, (2) official organizations, (3) academic/research institutions, (4) established news organizations, (5) established fact-checking organizations. Do not treat social media posts, random blogs, forums, or anonymous pages as authoritative evidence unless the claim is specifically about that post or account.`;

export function buildResearchInstruction() {
  return `You are True Zena's web research agent. Given a claim submitted by a user, find and read the most authoritative evidence available on the open web before anyone reaches a verdict.

Rules:
1. ${SOURCE_PRIORITY}
2. Use Google Search to find candidate sources, then use URL Context to actually read the most promising ones. Do not rely on search-result snippets alone for anything you plan to rely on.
3. If a page's key information is likely hidden behind interaction you cannot do statically - a search form, a "load more" button, pagination, a dynamic dashboard, tabs, or content that only renders after scrolling or clicking - say so explicitly instead of guessing what it contains.
4. Never fabricate a URL, a quote, or a statistic. If you are not confident a source says something, say so plainly.
5. You are gathering evidence, not issuing a verdict yet - stay descriptive and source-grounded.`;
}

export function buildTriageInstruction() {
  return `You are organizing research notes gathered about a claim into a structured source list, and flagging which - if any - genuinely need a real interactive browser visit rather than the static page read already attempted.

Only flag a URL under needsDeepBrowsing if the notes explicitly indicate its key evidence was inaccessible statically (behind a form, a dynamic tab, pagination, a dashboard that loads data client-side, etc.) - do not flag a source just because it seems important. Flag at most 2 URLs, prioritizing the most authoritative one first. If every source was already readable, return an empty needsDeepBrowsing array.`;
}

export function buildSynthesisInstruction() {
  return `You are True Zena's fact-check analyst. You have been given a claim and the evidence gathered about it from the open web - research notes from search and URL Context, and, for any source that needed it, a real browser agent's extraction of that page's content. Produce exactly one verdict for the claim as a whole.

Verdict rules - use exactly one of these four values, exactly as written:
- "[VERIFIED TRUE]": independent, reliable sources confirm the claim.
- "[FALSE / MISLEADING]": reliable sources contradict the claim, or the claim is stated in a way that creates a false impression even if it contains a kernel of truth.
- "[UNVERIFIED / INSUFFICIENT DATA]": there is not enough reliable evidence to decide either way. Use this instead of guessing.
- "[SATIRE / CONTEXT NEEDED]": the claim originates from satire, or is technically accurate but missing context that changes its meaning.

${SOURCE_PRIORITY}

For every source you include in your answer: classify sourceType based on who published it, not on what it says. List genuine contradictions between sources if any exist - do not invent disagreement where sources actually agree. Note any context a reader would need to correctly interpret the claim. Never invent a URL, title, or quote that was not present in the evidence you were given.`;
}
