/** Verify a Google ID token with Google's public JWKS. Apple is not wired in v1. */

import { decodeJwt, verifyRs256 } from "./jwt.js";

const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

let cache = new Map();

export function clearJwksCache() {
  cache = new Map();
}

function cleanEmail(value, verified) {
  const ok = verified === true || verified === "true" || verified === 1 || verified === "1";
  if (!ok) return "";
  const s = String(value == null ? "" : value).trim();
  if (!s || s.length > 320 || /\s/.test(s) || s.indexOf("@") < 1) return "";
  return s;
}

export function cleanName(value) {
  const s = String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!s) return "";
  return Array.from(s).slice(0, 80).join("");
}

function audienceOk(aud, expected) {
  if (!expected) return false;
  if (Array.isArray(aud)) return aud.indexOf(expected) !== -1;
  return aud === expected;
}

async function fetchKeys(url, fetchImpl, nowSeconds) {
  const hit = cache.get(url);
  if (hit && hit.exp > nowSeconds) return hit.keys;
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 8000);
  try {
    const res = await fetchImpl(url, { method: "GET", redirect: "follow", signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const keys = data && Array.isArray(data.keys) ? data.keys : null;
    if (!keys) return null;
    cache.set(url, { exp: nowSeconds + 60 * 60, keys: keys });
    return keys;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function verifyWithJwks(idToken, options) {
  const now = options.now;
  if (!options.audience) return { ok: false, error: "not_configured" };
  const raw = String(idToken || "");
  if (!raw || raw.length > 8000) return { ok: false, error: "bad_token" };
  const decoded = decodeJwt(raw);
  if (!decoded || !decoded.header || decoded.header.alg !== "RS256") {
    return { ok: false, error: "bad_token" };
  }
  const kid = typeof decoded.header.kid === "string" ? decoded.header.kid : "";
  if (!kid) return { ok: false, error: "bad_token" };
  const keys = await fetchKeys(options.jwksUrl, options.fetchImpl, now);
  if (!keys) return { ok: false, error: "upstream" };
  const jwk = keys.find(function (k) {
    return k && k.kid === kid && k.kty === "RSA" && k.n && k.e;
  });
  if (!jwk) return { ok: false, error: "bad_token" };
  let signed = false;
  try {
    signed = await verifyRs256(decoded, jwk);
  } catch (e) {
    return { ok: false, error: "bad_token" };
  }
  if (!signed) return { ok: false, error: "bad_token" };
  const payload = decoded.payload;
  if (options.issuers.indexOf(payload.iss) === -1) return { ok: false, error: "bad_token" };
  if (!audienceOk(payload.aud, options.audience)) return { ok: false, error: "bad_token" };
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp + 30 <= now) return { ok: false, error: "bad_token" };
  const iat = Number(payload.iat);
  if (Number.isFinite(iat) && iat > now + 120) return { ok: false, error: "bad_token" };
  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!sub || sub.length > 255) return { ok: false, error: "bad_token" };
  return {
    ok: true,
    sub: sub,
    email: cleanEmail(payload.email, payload.email_verified),
    name: cleanName(payload.name),
  };
}

export function verifyGoogleIdToken(idToken, clientId, fetchImpl, nowSeconds) {
  return verifyWithJwks(idToken, {
    jwksUrl: GOOGLE_JWKS,
    issuers: GOOGLE_ISSUERS,
    audience: String(clientId || "").trim(),
    fetchImpl: fetchImpl,
    now: nowSeconds,
  });
}
