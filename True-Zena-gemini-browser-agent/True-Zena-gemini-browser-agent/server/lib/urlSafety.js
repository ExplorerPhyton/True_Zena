// SSRF-safe URL guard for the Gemini browser agent. Every URL the agent is
// about to have Playwright actually navigate to - the initial target and
// any "navigate" action Gemini requests mid-loop - passes through
// assertPublicHttpUrl() first. isPublicHttpUrl() is a cheaper, sync-only
// version used for upstream filtering (e.g. deciding which candidate
// sources are even worth queuing for deep browsing); it is not the final
// gate before a real navigation.
//
// What this blocks: non-http(s) protocols (file://, javascript:, data:,
// chrome://, ...), loopback/private/link-local/reserved IP ranges
// (including the 169.254.169.254 cloud metadata address), and a short
// list of metadata/localhost hostnames - checked both against the literal
// hostname and against every IP it actually resolves to, so a public
// hostname that resolves to a private address is also blocked. Numeric
// hostname tricks (decimal/octal/hex IPv4 forms) are also covered, because
// they're parsed via the platform URL parser first, which normalizes them
// to dotted-quad before any check below ever sees them.
//
// This is a strong, practical mitigation, not a mathematically complete
// one: DNS is resolved at request time, so it narrows but does not fully
// close a DNS-rebinding race (the same class of gap most application-level
// SSRF filters have, short of proxying every socket connection through a
// policy-enforcing egress proxy). IPv6 range coverage below is best-effort
// - the realistic threat for this app (cloud metadata services, internal
// dashboards) is overwhelmingly IPv4.

import dns from "node:dns/promises";
import { httpError } from "./respond.js";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.internal",
  "metadata.azure.com",
]);

const EXTRA_BLOCKED_HOSTS = (process.env.AGENT_BLOCKED_HOSTS || "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

// Cheap, synchronous pre-filter - no DNS lookup, so safe to call on lists
// of candidate URLs before deciding which are even worth pursuing.
export function isPublicHttpUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || EXTRA_BLOCKED_HOSTS.includes(hostname)) return false;
  if (isLiteralIpAddress(hostname) && isPrivateOrReservedIp(hostname)) return false;
  return true;
}

// The real gate. Resolves DNS and checks every returned address. Throws a
// respond.js-style HTTP error (so route handlers can surface it directly)
// rather than returning a boolean, since callers should never silently
// continue past a blocked navigation.
export async function assertPublicHttpUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw httpError(400, `"${rawUrl}" is not a valid URL.`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw httpError(400, `Refusing to open a "${url.protocol}" URL - only http/https are allowed.`);
  }

  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || EXTRA_BLOCKED_HOSTS.includes(hostname)) {
    throw httpError(400, `Refusing to open a blocked host: ${hostname}`);
  }

  if (isLiteralIpAddress(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw httpError(400, `Refusing to open a private/reserved address: ${hostname}`);
    }
    return url;
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    // Unresolvable host - let Playwright's own navigation fail with a
    // clearer network error rather than guessing here.
    return url;
  }

  for (const { address } of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw httpError(400, `Refusing to open ${hostname} - it resolves to a private/reserved address.`);
    }
  }

  return url;
}

function isLiteralIpAddress(hostname) {
  return /^[\d.]+$/.test(hostname) || hostname.includes(":");
}

function isPrivateOrReservedIp(address) {
  return address.includes(":") ? isPrivateOrReservedIpv6(address) : isPrivateOrReservedIpv4(address);
}

function isPrivateOrReservedIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return true; // malformed - fail closed
  }
  const [a, b, c] = parts;

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast (224-239) + reserved/broadcast (240-255)

  return false;
}

function isPrivateOrReservedIpv6(address) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1" || normalized === "::") return true;
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // fc00::/7 unique local
  if (normalized.startsWith("ff")) return true; // ff00::/8 multicast

  // IPv4-mapped (::ffff:a.b.c.d) - check the embedded IPv4 address too.
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateOrReservedIpv4(mapped[1]);

  return false;
}
