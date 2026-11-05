/** JWT helpers. Session tokens are HMAC. Provider tokens are RS256. */

export function b64urlBytes(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    const slice = arr.subarray(i, Math.min(arr.length, i + chunk));
    const copy = new Array(slice.length);
    for (let j = 0; j < slice.length; j++) copy[j] = slice[j];
    binary += String.fromCharCode.apply(null, copy);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function b64urlToBytes(text) {
  const s = String(text || "");
  if (!s || /[^A-Za-z0-9_-]/.test(s)) return null;
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  let binary;
  try {
    binary = atob(b64);
  } catch (e) {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function b64urlJson(obj) {
  return b64urlBytes(new TextEncoder().encode(JSON.stringify(obj)));
}

export function bytesToUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (e) {
    return "";
  }
}

export function timingSafeEqual(a, b) {
  const left = a instanceof Uint8Array ? a : new Uint8Array(a || []);
  const right = b instanceof Uint8Array ? b : new Uint8Array(b || []);
  const len = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < len; i++) {
    diff |= (left[i] || 0) ^ (right[i] || 0);
  }
  return diff === 0;
}

export function decodeJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  if (!parts[0] || !parts[1] || !parts[2]) return null;
  const headerBytes = b64urlToBytes(parts[0]);
  const payloadBytes = b64urlToBytes(parts[1]);
  const signature = b64urlToBytes(parts[2]);
  if (!headerBytes || !payloadBytes || !signature) return null;
  let header;
  let payload;
  try {
    header = JSON.parse(bytesToUtf8(headerBytes));
    payload = JSON.parse(bytesToUtf8(payloadBytes));
  } catch (e) {
    return null;
  }
  if (!header || typeof header !== "object" || !payload || typeof payload !== "object") return null;
  return {
    header: header,
    payload: payload,
    signingInput: parts[0] + "." + parts[1],
    signature: signature,
  };
}

export async function signHmacJwt(secret, payload) {
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const body = b64urlJson(payload);
  const unsigned = header + "." + body;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned));
  return unsigned + "." + b64urlBytes(sig);
}

export async function verifyHmacJwt(secret, token) {
  const decoded = decodeJwt(token);
  if (!decoded) return null;
  if (!decoded.header || decoded.header.alg !== "HS256") return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(decoded.signingInput)
  );
  if (!timingSafeEqual(decoded.signature, new Uint8Array(expected))) return null;
  return decoded.payload;
}

export async function verifyRs256(decoded, jwk) {
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decoded.signature,
    new TextEncoder().encode(decoded.signingInput)
  );
}
