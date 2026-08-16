// Minimal Server-Sent-Events reader for POST requests. The browser's
// built-in EventSource only supports GET (and won't send a JSON body), so
// this reads the streamed fetch() response body by hand and splits it
// into SSE frames instead. Works the same in a normal browser tab and
// inside the Capacitor Android WebView, since both just need fetch() +
// ReadableStream - no extra native plugin required.
//
// Assumes each SSE field (event:/data:) is emitted on a single line with
// no embedded newlines, which is true for every event this app's server
// sends (server/routes/evidenceCheck.js JSON.stringifies each payload
// onto one line before writing it).

export async function postEventStream(url, body, { onEvent } = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error || `Request failed (${response.status}).`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      handleFrame(frame, onEvent);
    }
  }
}

function handleFrame(frame, onEvent) {
  const eventMatch = frame.match(/^event:\s*(.*)$/m);
  const dataMatch = frame.match(/^data:\s*(.*)$/m);
  if (!dataMatch) return;

  let payload;
  try {
    payload = JSON.parse(dataMatch[1]);
  } catch {
    return;
  }

  onEvent?.(eventMatch?.[1]?.trim() || "message", payload);
}
