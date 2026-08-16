// Caches AI fact-check results locally so a repeated query (the same
// video link, the same pasted transcript) resolves instantly without a
// network round-trip - the "instant offline lookups for repeated
// queries" requirement from the low-bandwidth mode.
//
// Implementation note: this project's own brief suggested Capacitor
// Preferences/Storage. Capacitor apps built with the default config (as
// this one is - capacitor.config.json has no server.androidScheme
// override) are served from a real https://localhost origin specifically
// so standard Web Storage APIs work correctly, so plain localStorage is
// reliable here on both web and the packaged Android app, with zero
// extra native dependencies to install and sync. If this app later needs
// storage that survives a user clearing the WebView's site data,
// @capacitor/preferences (native SharedPreferences/UserDefaults) is a
// drop-in upgrade - swap the three functions below for its get/set/remove
// calls without touching any call site.

const PREFIX = "truezena:ai-cache:";
const MAX_ENTRIES = 30;

export function cacheKeyFor(mode, input) {
  // Doesn't need to be cryptographic - just stable and cheap for the
  // same (mode, input) pair so repeated lookups hit the same slot.
  const source = `${mode}:${input}`;
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  return `${mode}:${hash}`;
}

export function getCached(key) {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.value ?? null;
  } catch {
    return null;
  }
}

export function setCached(key, value) {
  try {
    pruneOldestIfFull();
    window.localStorage.setItem(PREFIX + key, JSON.stringify({ value, cachedAt: Date.now() }));
  } catch {
    // Storage can throw when full or unavailable (e.g. private
    // browsing). Caching is a nicety on top of a working network path,
    // never something the rest of the app should depend on succeeding.
  }
}

export function clearCache() {
  try {
    cacheKeys().forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // best effort
  }
}

function cacheKeys() {
  return Object.keys(window.localStorage).filter((key) => key.startsWith(PREFIX));
}

function pruneOldestIfFull() {
  const keys = cacheKeys();
  if (keys.length < MAX_ENTRIES) return;

  const entries = keys.map((key) => {
    try {
      return { key, cachedAt: JSON.parse(window.localStorage.getItem(key))?.cachedAt || 0 };
    } catch {
      return { key, cachedAt: 0 };
    }
  });

  entries
    .sort((a, b) => a.cachedAt - b.cachedAt)
    .slice(0, entries.length - MAX_ENTRIES + 1)
    .forEach((entry) => window.localStorage.removeItem(entry.key));
}
