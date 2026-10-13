/** Google auth for the Worker only. Never return secrets to the browser. */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const VISION_SCOPE = "https://www.googleapis.com/auth/cloud-vision";

let cache = { key: "", token: "", exp: 0 };

export function clearTokenCache() {
  cache = { key: "", token: "", exp: 0 };
}

export function pemToArrayBuffer(pem) {
  const b64 = String(pem || "")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  if (!b64) throw new Error("pem");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function b64urlBytes(bytes) {
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

function b64urlJson(obj) {
  return b64urlBytes(new TextEncoder().encode(JSON.stringify(obj)));
}

export function parseServiceAccount(raw) {
  const text = String(raw || "").trim().replace(/^\uFEFF/, "");
  const sa = JSON.parse(text);
  if (!sa || typeof sa.client_email !== "string" || typeof sa.private_key !== "string") {
    throw new Error("sa");
  }
  if (!sa.private_key.includes("BEGIN PRIVATE KEY")) throw new Error("sa");
  return sa;
}

export async function signServiceAccountJwt(sa, nowSeconds) {
  const header = b64urlJson({ alg: "RS256", typ: "JWT" });
  const claim = b64urlJson({
    iss: sa.client_email,
    scope: VISION_SCOPE,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  });
  const unsigned = header + "." + claim;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  return unsigned + "." + b64urlBytes(sig);
}

async function serviceAccountHeader(raw, fetchImpl, nowSeconds) {
  const sa = parseServiceAccount(raw);
  if (cache.key === sa.client_email && cache.token && cache.exp > nowSeconds + 60) {
    return { ok: true, headers: { authorization: "Bearer " + cache.token } };
  }
  const assertion = await signServiceAccountJwt(sa, nowSeconds);
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: assertion,
    }),
    redirect: "error",
  });
  if (!res.ok) return { ok: false, error: "auth_error" };
  const data = await res.json();
  if (!data || typeof data.access_token !== "string" || !data.access_token) {
    return { ok: false, error: "auth_error" };
  }
  const ttl = Number(data.expires_in) || 3600;
  cache = {
    key: sa.client_email,
    token: data.access_token,
    exp: nowSeconds + ttl,
  };
  return { ok: true, headers: { authorization: "Bearer " + data.access_token } };
}

/**
 * Service account wins when GOOGLE_VISION_SERVICE_ACCOUNT is non-empty.
 * Otherwise uses GOOGLE_VISION_API_KEY as a header (not a query string).
 */
export async function visionAuth(env, fetchImpl, nowSeconds) {
  const now = Number.isFinite(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000);
  const saRaw = env && env.GOOGLE_VISION_SERVICE_ACCOUNT;
  if (saRaw && String(saRaw).trim()) {
    try {
      return await serviceAccountHeader(String(saRaw), fetchImpl, now);
    } catch (e) {
      return { ok: false, error: "auth_error" };
    }
  }
  const key = env && env.GOOGLE_VISION_API_KEY && String(env.GOOGLE_VISION_API_KEY).trim();
  if (key) return { ok: true, headers: { "x-goog-api-key": key } };
  return { ok: false, error: "not_configured" };
}
