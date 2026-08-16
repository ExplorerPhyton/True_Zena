// Client for the Gemini-powered video/media fact-check backend
// (server/routes/factCheckVideo.js). Kept separate from the existing
// local checker (src/lib/checker.js) and the Gemini browser agent's
// evidence panel - those keep working exactly as they did before; this
// only backs the new AI Video & Media Check panel.

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

export function checkVideoUrl(url, audioOnly) {
  return postFactCheck("/api/fact-check-video", { mode: audioOnly ? "url-audio" : "url", url });
}

export function checkTranscript(text) {
  return postFactCheck("/api/fact-check-text", { text });
}

export async function checkFile(file) {
  const fileBase64 = await fileToBase64(file);
  return postFactCheck("/api/fact-check-video", {
    mode: "file",
    fileBase64,
    fileMimeType: file.type || "application/octet-stream",
  });
}

async function postFactCheck(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || `The AI check failed (${response.status}).`);
  }
  return data;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });
}
