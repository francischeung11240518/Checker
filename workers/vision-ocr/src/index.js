/**
 * Internal Checker Vision OCR proxy.
 * Processes a cropped price-tag image and discards it.
 * Does not write the image to R2, KV, or disk. KV stores quota counters only.
 * Audit lines are counts and status — never the image or the API secret.
 */
import { visionAuth } from "./auth.js";
import { decodeImageBase64, parseVisionResponse, sniffMime, bytesToBase64 } from "./parse.js";
import {
  consentAccepted,
  dailyCap,
  hkQuotaKeys,
  killSwitchEnabled,
  maxBodyBytes,
  maxImageBytes,
  monthlyPlan,
  originAllowed,
} from "./quota.js";

const VISION_URL = "https://vision.googleapis.com/v1/images:annotate";

const MESSAGES = {
  kill_switch: "雲端認字已關閉，請用本機或人手填。",
  daily_quota: "今日雲端認字次數已滿。",
  monthly_quota: "本月雲端認字已接近預算上限，已停止。",
  consent_required: "未有同意，拒絕上傳。",
  payload_too_large: "圖片太大。",
  origin: "來源網址不在允許清單。",
  not_configured: "雲端認字未設定金鑰。",
  upstream: "雲端認字暫時未能使用。",
  bad_request: "請求不正確。",
  unsupported_type: "只接受 jpeg、png、webp 或 gif。",
  quota_unconfigured: "未設定用量計數，已拒絕呼叫。",
  auth_error: "雲端認字授權失敗。",
  method: "只接受 POST。",
};

function corsHeaders(origin) {
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    }, corsHeaders(origin)),
  });
}

export function audit(entry) {
  const line = {
    audit: "vision-ocr",
    ts: new Date().toISOString(),
    ok: entry.ok === true,
    error: entry.error ? String(entry.error) : "",
    bytes: Number(entry.bytes) || 0,
    dayCount: entry.dayCount == null ? null : Number(entry.dayCount),
    monthCount: entry.monthCount == null ? null : Number(entry.monthCount),
  };
  console.log(JSON.stringify(line));
}

function fail(error, status, origin, extra) {
  audit({
    ok: false,
    error: error,
    bytes: extra && extra.bytes || 0,
    dayCount: extra && extra.dayCount,
    monthCount: extra && extra.monthCount,
  });
  return json({
    ok: false,
    error: error,
    message: MESSAGES[error] || MESSAGES.upstream,
  }, status, origin);
}

function configured(env) {
  return !!(
    (env && env.GOOGLE_VISION_API_KEY && String(env.GOOGLE_VISION_API_KEY).trim())
    || (env && env.GOOGLE_VISION_SERVICE_ACCOUNT && String(env.GOOGLE_VISION_SERVICE_ACCOUNT).trim())
  );
}

async function readCount(kv, key) {
  const value = await kv.get(key);
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

async function reserve(env, now) {
  const keys = hkQuotaKeys(now);
  const plan = monthlyPlan(env);
  const cap = dailyCap(env);
  const day = await readCount(env.QUOTA, keys.dayKey);
  const month = await readCount(env.QUOTA, keys.monthKey);
  if (day >= cap) return { ok: false, error: "daily_quota", day: day, month: month };
  if (month >= plan.monthlyUnitLimit) {
    return { ok: false, error: "monthly_quota", day: day, month: month };
  }
  const nextDay = day + 1;
  const nextMonth = month + 1;
  await env.QUOTA.put(keys.dayKey, String(nextDay), { expirationTtl: 60 * 60 * 24 * 3 });
  await env.QUOTA.put(keys.monthKey, String(nextMonth), { expirationTtl: 60 * 60 * 24 * 40 });
  return { ok: true, day: nextDay, month: nextMonth };
}

async function readPayload(request, env) {
  const maxBody = maxBodyBytes(env);
  const declared = Number(request.headers.get("content-length") || "0");
  if (declared > maxBody) return { error: "payload_too_large" };
  const ctype = String(request.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("multipart/form-data")) {
    let form;
    try {
      form = await request.formData();
    } catch (e) {
      return { error: "bad_request" };
    }
    const file = form.get("image");
    if (!file || typeof file.arrayBuffer !== "function") return { error: "bad_request" };
    const buf = await file.arrayBuffer();
    if (buf.byteLength > maxImageBytes(env)) return { error: "payload_too_large" };
    const bytes = new Uint8Array(buf);
    const mime = sniffMime(bytes);
    if (!mime) return { error: "unsupported_type" };
    return {
      consent: form.get("consent"),
      consentSource: "multipart",
      bytes: bytes,
      base64: bytesToBase64(bytes),
    };
  }
  const buf = await request.arrayBuffer();
  if (buf.byteLength > maxBody) return { error: "payload_too_large" };
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(buf) || "null");
  } catch (e) {
    return { error: "bad_request" };
  }
  if (!body || typeof body !== "object") return { error: "bad_request" };
  const decoded = decodeImageBase64(body.imageBase64, body.mimeType);
  if (decoded.error) return decoded;
  if (decoded.bytes.byteLength > maxImageBytes(env)) return { error: "payload_too_large" };
  return {
    consent: body.consent,
    consentSource: "json",
    bytes: decoded.bytes,
    base64: decoded.base64,
  };
}

async function callVision(env, base64, fetchImpl) {
  const auth = await visionAuth(env, fetchImpl);
  if (!auth.ok) return auth;
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 15000);
  try {
    const res = await fetchImpl(VISION_URL, {
      method: "POST",
      redirect: "error",
      signal: ctrl.signal,
      headers: Object.assign({ "content-type": "application/json" }, auth.headers),
      body: JSON.stringify({
        requests: [{
          image: { content: base64 },
          // One billable text feature. Dense Chinese shelf tags use document
          // OCR; languageHints are not a second unit. Do not also send TEXT_DETECTION.
          features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 50 }],
          imageContext: { languageHints: ["zh-Hant", "en"] },
        }],
      }),
    });
    if (!res.ok) return { ok: false, error: "upstream" };
    const data = await res.json();
    return { ok: true, data: data };
  } catch (e) {
    return { ok: false, error: "upstream" };
  } finally {
    clearTimeout(timer);
  }
}

export async function handleRequest(request, env, deps) {
  const fetchImpl = (deps && deps.fetch) || fetch;
  const now = (deps && deps.now) || new Date();
  const originHeader = request.headers.get("origin") || "";
  const originCheck = originAllowed(originHeader);
  const corsOrigin = originHeader && originCheck.ok ? originHeader : "";

  if (request.method === "OPTIONS") {
    if (originHeader && !originCheck.ok) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders(corsOrigin) });
  }

  if (originHeader && !originCheck.ok) return fail("origin", 403, "");

  if (request.method === "GET") {
    return json({
      ok: true,
      service: "checker-vision-ocr",
      enabled: killSwitchEnabled(env && env.VISION_OCR_ENABLED),
      configured: configured(env),
    }, 200, corsOrigin);
  }

  if (request.method !== "POST") return fail("method", 405, corsOrigin);

  if (!killSwitchEnabled(env && env.VISION_OCR_ENABLED)) {
    return fail("kill_switch", 403, corsOrigin);
  }

  const payload = await readPayload(request, env || {});
  if (payload.error) {
    const status = payload.error === "payload_too_large" ? 413 : 400;
    return fail(payload.error, status, corsOrigin);
  }
  if (!consentAccepted(payload.consent, payload.consentSource)) {
    return fail("consent_required", 400, corsOrigin, { bytes: payload.bytes.byteLength });
  }
  if (!env || !env.QUOTA || typeof env.QUOTA.get !== "function" || typeof env.QUOTA.put !== "function") {
    return fail("quota_unconfigured", 503, corsOrigin, { bytes: payload.bytes.byteLength });
  }

  let slot;
  try {
    slot = await reserve(env, now);
  } catch (e) {
    return fail("quota_unconfigured", 503, corsOrigin, { bytes: payload.bytes.byteLength });
  }
  if (!slot.ok) {
    const status = 429;
    return fail(slot.error, status, corsOrigin, {
      bytes: payload.bytes.byteLength,
      dayCount: slot.day,
      monthCount: slot.month,
    });
  }

  const vision = await callVision(env, payload.base64, fetchImpl);
  if (!vision.ok) {
    return fail(vision.error || "upstream", vision.error === "not_configured" || vision.error === "auth_error" ? 503 : 502, corsOrigin, {
      bytes: payload.bytes.byteLength,
      dayCount: slot.day,
      monthCount: slot.month,
    });
  }
  const parsed = parseVisionResponse(vision.data);
  audit({
    ok: true,
    bytes: payload.bytes.byteLength,
    dayCount: slot.day,
    monthCount: slot.month,
  });
  return json({
    ok: true,
    productName: parsed.productName || "",
    price: parsed.price || "",
    offer: parsed.offer || "",
  }, 200, corsOrigin);
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
