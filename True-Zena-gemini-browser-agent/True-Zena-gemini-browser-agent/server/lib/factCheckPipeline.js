// Two-pass pipeline shared by the video and text fact-check routes:
//
//   Pass 1 - generateJSON(): extract claims + verdicts as structured JSON
//            matching FACT_CHECK_SCHEMA (Part 4 of the brief).
//   Pass 2 - groundedEvidence(): for claims that came back FALSE or
//            MISLEADING, run a small number of Google-Search-grounded
//            lookups in parallel and attach real source links
//            (Part 3.2). Capped at MAX_EVIDENCE_LOOKUPS so one request
//            can't fan out into dozens of search calls.
//
// Kept in one place so factCheckVideo.js and factCheckText.js only differ
// in how they build the input `parts`, not in how they score/enrich them.

import { FACT_CHECK_SCHEMA, buildEvidencePrompt } from "./promptSchema.js";
import { generateJSON, groundedEvidence } from "./gemini.js";

const MAX_EVIDENCE_LOOKUPS = 5;
const NEEDS_EVIDENCE = new Set(["FALSE", "MISLEADING"]);

export async function runFactCheckPipeline({ systemInstruction, parts }) {
  const result = await generateJSON({ systemInstruction, parts, schema: FACT_CHECK_SCHEMA });
  const claims = Array.isArray(result.claimsToVerify) ? result.claimsToVerify : [];

  let evidenceBudget = MAX_EVIDENCE_LOOKUPS;
  const withEvidence = await Promise.all(
    claims.map(async (claim) => {
      const verdict = String(claim.verdict || "").toUpperCase();
      if (!NEEDS_EVIDENCE.has(verdict) || evidenceBudget <= 0) {
        return { ...claim, evidenceLinks: Array.isArray(claim.evidenceLinks) ? claim.evidenceLinks : [] };
      }
      evidenceBudget -= 1;

      const evidenceLinks = await groundedEvidence({
        prompt: buildEvidencePrompt(claim.claimEnglish || claim.claim),
      }).catch(() => []);

      return { ...claim, evidenceLinks };
    })
  );

  return { ...result, claimsToVerify: withEvidence };
}
