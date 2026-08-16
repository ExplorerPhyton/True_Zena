// Implements the "Part 4: Structured Output Specification" from the
// project brief, with two deliberate, additive extensions:
//
// 1. The brief's verdict enum is `TRUE | FALSE | UNVERIFIED`, but Part 3.2
//    asks the pipeline to fetch counter-evidence specifically for claims
//    evaluated as FALSE *or MISLEADING*. MISLEADING isn't a reachable
//    verdict under the brief's own enum, which would make that part of
//    the spec dead code. MISLEADING is added as a fourth verdict value
//    (matching the existing local checker's verdictMeta, which already
//    has a `misleading` category) so the evidence step has something to
//    trigger on.
// 2. Part 3.3 asks the UI to show verdicts and claim breakdowns "in both
//    the source language and English." The base schema only has one
//    language slot per string. `summaryEnglish`, `claimEnglish`, and
//    `explanationEnglish` are added so a non-English result still carries
//    an English rendering the UI can show side-by-side. For English
//    input these just mirror the source fields.
//
// Every field name from the original brief is preserved as-is, so any
// consumer expecting exactly that shape still finds it.

export const FACT_CHECK_SCHEMA = {
  type: "object",
  properties: {
    isMisleading: {
      type: "boolean",
      description: "True if the content as a whole is likely to mislead an average viewer.",
    },
    trustScore: {
      type: "number",
      description: "0-100 overall trustworthiness estimate for the content as a whole.",
    },
    detectedLanguage: {
      type: "string",
      description: "Primary language of the source input, e.g. 'Amharic', 'English', 'Oromo'.",
    },
    summary: { type: "string", description: "One or two sentence summary, in the detected language." },
    summaryEnglish: { type: "string", description: "English translation of summary. Same as summary if detectedLanguage is English." },
    claimsToVerify: {
      type: "array",
      items: {
        type: "object",
        properties: {
          timestamp: {
            type: "string",
            description: "MM:SS position in the media where the claim occurs, or the literal string N/A for text input.",
          },
          claim: { type: "string", description: "The claim, quoted or closely paraphrased, in the detected language." },
          claimEnglish: { type: "string", description: "English translation of claim." },
          verdict: {
            type: "string",
            enum: ["TRUE", "FALSE", "MISLEADING", "UNVERIFIED"],
          },
          explanation: { type: "string", description: "Why this verdict, in the detected language." },
          explanationEnglish: { type: "string", description: "English translation of explanation." },
          evidenceLinks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                url: { type: "string" },
              },
              required: ["title", "url"],
            },
          },
        },
        required: ["timestamp", "claim", "verdict", "explanation"],
      },
    },
  },
  required: ["isMisleading", "trustScore", "detectedLanguage", "summary", "claimsToVerify"],
};

const BASE_INSTRUCTIONS = `You are True Zena's misinformation analyst. Review the input and extract every discrete, checkable factual claim, then evaluate each one honestly and conservatively.

Rules:
1. Only extract checkable factual claims - statements that can be shown true or false. Skip opinions, jokes, greetings, and questions.
2. Verdict is one of TRUE, FALSE, MISLEADING, or UNVERIFIED.
   - MISLEADING: has a kernel of truth but is stated so it creates a false impression, omits crucial context, or exaggerates.
   - UNVERIFIED: you do not have enough reliable information to decide. Use this instead of guessing.
3. detectedLanguage is the primary language of the input, written out (e.g. "Amharic", "English", "Oromo", "Tigrinya"), not a code.
4. If detectedLanguage is not English, write summary/claim/explanation in that source language AND fill summaryEnglish/claimEnglish/explanationEnglish with accurate English translations. If detectedLanguage is English, the *English fields can repeat the source fields.
5. trustScore is 0-100 for the content as a whole (100 = fully accurate, 0 = severely misleading). isMisleading is true if an average viewer would likely come away misinformed, even if some individual claims are fine.
6. Leave evidenceLinks as an empty array for every claim - a separate step attaches real sources afterward. Never invent a URL yourself.
7. Do not fabricate statistics, quotes, or attributions. When unsure, say so and use UNVERIFIED.`;

export function buildTextSystemInstruction() {
  return `${BASE_INSTRUCTIONS}
8. This input is plain text (no audio or video), so set every claim's "timestamp" to the literal string "N/A".`;
}

export function buildMediaSystemInstruction() {
  return `${BASE_INSTRUCTIONS}
8. This input is a video, audio, or image file. Wherever the media has a timeline, set "timestamp" to the MM:SS position where the claim is spoken, shown as on-screen text, or otherwise made. If the file is a single still image with no timeline, use "N/A".`;
}

// A compact, deliberately non-JSON prompt for the grounding pass. Gemini's
// Google Search grounding tool and strict responseSchema mode do not
// reliably combine in the same call on 2.x-generation models, so evidence
// lookup runs as a second, separate call per claim and the real source
// URLs are read back from the response's groundingMetadata rather than
// asked for in prose (see server/lib/gemini.js: groundedEvidence).
export function buildEvidencePrompt(claimText) {
  return `Fact-check this specific claim using current, reputable sources: "${claimText}"\n\nBriefly state what the evidence shows in 1-2 sentences.`;
}
