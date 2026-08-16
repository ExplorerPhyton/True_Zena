import { factRules, verdictMeta } from "./factRules";

const SAMPLE_TEXT =
  "Australia's capital is Sydney. Vaccines cause autism. The Great Wall of China is visible from the Moon. Climate change is a hoax. Addis Ababa is the capital of Ethiopia.";

const checkableSignals = [
  /\b(is|are|was|were|has|have|causes?|caused|will|can|cannot|never|always)\b/i,
  /\b\d+(\.\d+)?\s?%?\b/,
  /\b(capital|vaccine|covid|climate|earth|moon|space|virus|study|research|government)\b/i,
  /\b(hoax|fake|cure|treat|visible|proves?|linked|risk|rate)\b/i,
];

const opinionSignals = [
  /^\s*(i think|i feel|in my opinion|maybe|probably)\b/i,
  /\b(best|worst|beautiful|boring|annoying|love|hate)\b/i,
];

const claimTypeRules = [
  {
    test: (claim) => /\b\d+(\.\d+)?\s?%?\b/.test(claim),
    type: "Statistical claim",
    reason:
      "This contains a specific number. The local verifier did not find a matching trusted rule, so the number should be checked against a primary dataset.",
    correction: "Verify the statistic against the original report, government dataset, or peer-reviewed study.",
  },
  {
    test: (claim) => /\b(causes?|caused by|linked to|because of|leads to)\b/i.test(claim),
    type: "Causal claim",
    reason:
      "This makes a cause-and-effect claim. Causal claims need stronger evidence than correlation or anecdote.",
    correction: "Look for controlled studies, official guidance, or systematic reviews before repeating the claim.",
  },
  {
    test: (claim) => /"[^"]+"|'[^']+'/.test(claim),
    type: "Quote claim",
    reason:
      "This appears to quote someone. The local verifier cannot confirm whether the wording and attribution are accurate.",
    correction: "Check the original speech, transcript, publication, or verified account.",
  },
  {
    test: (claim) => /\b(always|never|everyone|no one|all|none)\b/i.test(claim),
    type: "Absolute claim",
    reason:
      "This uses absolute language. Claims with words like always, never, all, or none are often missing exceptions or context.",
    correction: "Rewrite with precise scope and evidence.",
  },
];

export function getSampleText() {
  return SAMPLE_TEXT;
}

export function analyzeText(input, evidenceText = "") {
  const sentences = splitIntoSentences(input);
  const claims = sentences
    .map((sentence, index) => ({
      id: `claim-${index + 1}`,
      text: sentence,
      checkable: isCheckable(sentence),
    }))
    .filter((claim) => claim.text.length > 0);

  const evaluatedClaims = claims
    .filter((claim) => claim.checkable)
    .slice(0, 12)
    .map((claim, index) => evaluateClaim(claim, index, evidenceText));

  const skipped = claims.filter((claim) => !claim.checkable).map((claim) => claim.text);
  const summary = makeSummary(evaluatedClaims);
  const reply = makeReply(evaluatedClaims);

  return {
    claims: evaluatedClaims,
    skipped,
    summary,
    reply,
    empty: input.trim().length === 0,
  };
}

function splitIntoSentences(input) {
  return input
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|[\n\r]+|(?:\s+-\s+)/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function isCheckable(sentence) {
  if (sentence.length < 8) return false;
  if (sentence.endsWith("?")) return false;
  if (opinionSignals.some((signal) => signal.test(sentence))) return false;
  return checkableSignals.some((signal) => signal.test(sentence));
}

function evaluateClaim(claim, index, evidenceText) {
  const matchedRule = factRules.find((rule) => rule.test(claim.text));

  if (matchedRule) {
    const result = matchedRule.result(claim.text);
    const meta = verdictMeta[result.verdict] ?? verdictMeta.context;
    return {
      ...claim,
      index: index + 1,
      topic: matchedRule.topic,
      confidence: result.confidence ?? meta.score,
      ...result,
    };
  }

  const evidenceInference = inferClaimFromEvidence(claim.text, evidenceText);
  if (evidenceInference) {
    return {
      ...claim,
      index: index + 1,
      topic: "Open web",
      ...evidenceInference,
    };
  }

  const heuristic = claimTypeRules.find((rule) => rule.test(claim.text));
  const base = heuristic ?? {
    type: "General factual claim",
    reason:
      "The claim looks factual, but the local verifier does not have enough trusted evidence to judge it.",
    correction: "Check a primary source or reputable fact-checking organization before sharing it.",
  };

  return {
    ...claim,
    index: index + 1,
    topic: "Open web",
    verdict: heuristic ? "unsupported" : "context",
    confidence: heuristic ? verdictMeta.unsupported.score : verdictMeta.context.score,
    type: base.type,
    reason: base.reason,
    correction: base.correction,
    evidence: [],
  };
}

function inferClaimFromEvidence(claimText, evidenceText) {
  if (!evidenceText || !evidenceText.trim()) return null;

  const claimWords = normalize(claimText)
    .split(" ")
    .filter((word) => word.length > 2);
  if (claimWords.length === 0) return null;

  const sentences = splitIntoSentences(evidenceText);
  let trueScore = 0;
  let falseScore = 0;
  let contextScore = 0;

  const claimNegated = hasNegation(claimText);

  for (const sentence of sentences) {
    const normalized = normalize(sentence);
    const sentenceWords = new Set(normalized.split(" "));
    const matchCount = claimWords.filter((word) => sentenceWords.has(word)).length;
    if (matchCount < Math.max(2, Math.floor(claimWords.length * 0.4))) continue;

    const supports = hasSupportingPhrase(sentence);
    const contradicts = hasContradictingPhrase(sentence);
    const weak = hasWeakPhrase(sentence);
    const sentenceNegated = hasNegation(sentence);

    if (claimNegated) {
      if (sentenceNegated && !supports) {
        trueScore += 1;
      } else if (!sentenceNegated && (supports || contradicts)) {
        falseScore += 1;
      }
    } else {
      if (supports && !contradicts) {
        trueScore += 1;
      }
      if (sentenceNegated && !supports) {
        falseScore += 1;
      }
    }

    if (weak) contextScore += 1;
  }

  if (trueScore > falseScore && trueScore >= 1) {
    return {
      verdict: "true",
      confidence: Math.min(84, 60 + trueScore * 8),
      type: "Evidence-backed claim",
      reason: "The web evidence gathered by True Zena's browser agent appears to support this claim via multiple matching sentences.",
      correction: "The claim is likely supported by the evidence found, but verify the original source before sharing.",
      evidence: [],
    };
  }

  if (falseScore > trueScore && falseScore >= 1) {
    return {
      verdict: "false",
      confidence: Math.min(84, 60 + falseScore * 8),
      type: "Evidence-backed claim",
      reason: "The web evidence gathered by True Zena's browser agent appears to contradict this claim in the retrieved text.",
      correction: "The claim does not match the evidence found, so revise it or cite a reliable source that supports it.",
      evidence: [],
    };
  }

  if (contextScore > 0) {
    return {
      verdict: "context",
      confidence: Math.min(68, 50 + contextScore * 6),
      type: "Evidence-seeking claim",
      reason: "The gathered web evidence is ambiguous or qualified, so the claim needs more precise sourcing.",
      correction: "Use a clearer source or qualified language when sharing this claim.",
      evidence: [],
    };
  }

  return null;
}

const negationPatterns = /\b(no|not|never|cannot|can't|doesn't|does not|didn't|did not|isn't|is not|wasn't|was not|aren't|are not|ain't)\b/i;
const supportPatterns = /\b(is|are|was|were|does|do|did|can|could|will|likely|confirmed|officially|reported|recognized|known as|supports?|supported|proves?|proven|evidence?)\b/i;
const contradictionPatterns = /\b(false|incorrect|wrong|debunk(?:ed|s)?|myth|unsupported|unproven|disproved|not true|not accurate|no evidence|never|none)\b/i;
const weakPatterns = /\b(may|might|could|possibly|unclear|insufficient evidence|not enough evidence|unknown|uncertain|still|however|although|but)\b/i;

function hasNegation(text) {
  return negationPatterns.test(text);
}

function hasSupportingPhrase(text) {
  const lower = text.toLowerCase();
  if (/\bnot a myth\b/i.test(lower) || /\bnot false\b/i.test(lower) || /\bnot incorrect\b/i.test(lower) || /\bnot wrong\b/i.test(lower)) {
    return true;
  }
  return supportPatterns.test(text) && !/\bnot\s+(a\s+)?(myth|false|incorrect|wrong|untrue)\b/i.test(lower);
}

function hasContradictingPhrase(text) {
  const lower = text.toLowerCase();
  if (/\bnot a myth\b/i.test(lower) || /\bnot false\b/i.test(lower) || /\bnot incorrect\b/i.test(lower) || /\bnot wrong\b/i.test(lower)) {
    return false;
  }
  return contradictionPatterns.test(text);
}

function hasWeakPhrase(text) {
  return weakPatterns.test(text);
}

function makeSummary(claims) {
  const counts = claims.reduce(
    (acc, claim) => {
      acc[claim.verdict] = (acc[claim.verdict] ?? 0) + 1;
      return acc;
    },
    { true: 0, false: 0, misleading: 0, unsupported: 0, context: 0 }
  );

  const risky = counts.false + counts.misleading;
  const unsupported = counts.unsupported + counts.context;

  let headline = "No checkable claims found";
  if (claims.length > 0) {
    if (risky > 0) headline = `${risky} claim${risky === 1 ? "" : "s"} need correction`;
    else if (unsupported > 0) headline = `${unsupported} claim${unsupported === 1 ? "" : "s"} need evidence`;
    else headline = "Claims look consistent with trusted rules";
  }

  return {
    total: claims.length,
    risky,
    unsupported,
    counts,
    headline,
  };
}

function makeReply(claims) {
  const target = claims.find((claim) => claim.verdict === "false") ??
    claims.find((claim) => claim.verdict === "misleading") ??
    claims.find((claim) => claim.verdict === "unsupported");

  if (!target) {
    return "I checked the factual claims here and did not find a clear falsehood in the local verifier. I would still compare any important numbers or quotes against primary sources.";
  }

  if (target.verdict === "unsupported") {
    return `I would be careful with this claim: "${target.text}" The checker could not verify it from trusted evidence, so it is better to ask for the original source before sharing it.`;
  }

  return `I checked this claim: "${target.text}" It looks ${target.verdict}. ${target.reason} A clearer version would be: ${target.correction}`;
}
