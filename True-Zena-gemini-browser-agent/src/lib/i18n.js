// Small static-UI dictionary for the language switcher in the topbar.
// This only covers interface chrome (button labels, section titles) -
// the substantive bilingual content (claim text, verdicts, summaries in
// both Amharic and English) comes from Gemini itself per-response, which
// is far more reliable for nuanced fact-checking language than a fixed
// phrase table could be.
//
// The Amharic strings below are a best effort at common, simple words
// and have not been reviewed by a native speaker - worth a native-speaker
// pass before this ships to real users, especially given how much
// precision matters for a fact-checking product.

export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "EN" },
  { code: "am", label: "አማ" },
];

const STRINGS = {
  en: {
    navAiMedia: "AI Media Check",
    aiPanelTitle: "AI Video & Media Check",
    aiPanelSubtitle: "Paste a video link, or use a lighter option on a slow connection.",
    modeUrl: "Video link",
    modeAudio: "Audio only",
    modeFile: "Photo or audio file",
    modeTranscript: "Transcript",
    urlPlaceholder: "Paste a YouTube, TikTok, X, or Facebook link...",
    transcriptPlaceholder: "Paste a transcript or the text you want checked...",
    filePrompt: "Choose a screenshot or short audio clip",
    checkButton: "Check with AI",
    checkingButton: "Checking...",
    cachedBadge: "Cached result - shown instantly, no data used",
    notConfigured: "AI media checking is not connected yet.",
    trustScore: "Trust score",
    detectedLanguage: "Detected language",
    claimsHeading: "Claims found",
    evidenceHeading: "Evidence",
    englishToggle: "Show English",
    sourceToggle: "Show original",
    noClaims: "No checkable claims found in this media.",
  },
  am: {
    navAiMedia: "በAI ማረጋገጫ",
    aiPanelTitle: "በAI የቪዲዮ እና ሚዲያ ማረጋገጫ",
    aiPanelSubtitle: "የቪዲዮ አገናኝ ይለጥፉ፣ ወይም ግንኙነትዎ ደካማ ከሆነ ቀላል አማራጭ ይጠቀሙ።",
    modeUrl: "የቪዲዮ አገናኝ",
    modeAudio: "ድምጽ ብቻ",
    modeFile: "ፎቶ ወይም ኦዲዮ ፋይል",
    modeTranscript: "ጽሑፍ",
    urlPlaceholder: "የYouTube፣ TikTok፣ X ወይም Facebook አገናኝ ይለጥፉ...",
    transcriptPlaceholder: "ማረጋገጥ የሚፈልጉትን ጽሑፍ ይለጥፉ...",
    filePrompt: "ስክሪንሾት ወይም አጭር ኦዲዮ ይምረጡ",
    checkButton: "በAI አረጋግጥ",
    checkingButton: "በማረጋገጥ ላይ...",
    cachedBadge: "የተቀመጠ ውጤት - ወዲያውኑ ታይቷል፣ ዳታ አልተጠቀመም",
    notConfigured: "የAI ሚዲያ ማረጋገጫ ገና አልተገናኘም።",
    trustScore: "የመተማመኛ ነጥብ",
    detectedLanguage: "የተገኘ ቋንቋ",
    claimsHeading: "የተገኙ መግለጫዎች",
    evidenceHeading: "ማስረጃ",
    englishToggle: "እንግሊዝኛ አሳይ",
    sourceToggle: "የመጀመሪያውን አሳይ",
    noClaims: "በዚህ ሚዲያ ውስጥ የሚረጋገጥ መግለጫ አልተገኘም።",
  },
};

export function translationsFor(lang) {
  return STRINGS[lang] || STRINGS.en;
}
