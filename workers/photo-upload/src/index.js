/**
 * Internal price-tag photo queue.
 * The browser uploads a photo. This Worker stores it and waits for an admin.
 * It does not run OCR in the browser, does not send email, and does not write the product database.
 * Optional prefill calls the existing checker-vision-ocr worker (DOCUMENT_TEXT_DETECTION lives there).
 */
import { decodeImageBase64, sniffMime, bytesToBase64 } from "../../vision-ocr/src/parse.js";
import { killSwitchEnabled, maxImageBytes, originAllowed } from "../../vision-ocr/src/quota.js";
import { adminKeyMatches } from "./auth.js";
import { clipText, normalizeContact } from "./contact.js";
import { ocrEndpoint } from "./url.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

const MESSAGES = {
  upload_disabled: "價牌上載未開放。",
  origin: "來源網址不在允許清單。",
  payload_too_large: "圖片太大。",
  unsupported_type: "只接受 jpeg、png、webp 或 gif。",
  bad_request: "請求不正確。",
  bad_contact: "暱稱或電郵格式不正確。兩項都可以留空。",
  rate_limited: "上傳太密，請稍後再試。",
  method: "不支援呢個方法。",
  not_found: "搵唔到呢筆上載。",
  admin_unconfigured: "未設定管理員金鑰。",
  unauthorized: "管理員金鑰不正確。",
  conflict: "呢筆已經處理過。",
  note_required: "拒絕要寫低原因。系統唔會通知用家。",
  ocr_unconfigured: "未設定 Vision OCR 位址。請把 VISION_OCR_URL 指去已部署嘅 checker-vision-ocr。",
  ocr_image_too_large: "呢張相比現有雲端認字上限大，未能預填。可以人手填。",
  ocr_upstream: "雲端認字暫時未能使用。",
  image_missing: "搵唔到原圖。",
  store_unconfigured: "未設定儲存（R2 或 KV）。",
  store_failed: "儲存失敗，請稍後再試。",
  upstream: "暫時未能處理。",
};

const PUBLISH_NEXT = "未寫入產品庫。下一步先人手合併到每日價格資料。呢個骨架唔會自動上架，亦唔會改消委會價。";

function corsHeaders(origin) {
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    "access-control-allow-headers": "content-type, x-admin-key",
    "access-control-max-age": "600",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    }, corsHeaders(origin)),
  });
}

function audit(entry) {
  console.log(JSON.stringify({
    audit: "photo-upload",
    ts: new Date().toISOString(),
    ok: entry.ok === true,
    op: entry.op || "",
    error: entry.error ? String(entry.error) : "",
    id: entry.id || "",
    bytes: Number(entry.bytes) || 0,
    status: entry.status || "",
  }));
}

function fail(error, status, origin, extra) {
  audit({
    ok: false,
    op: extra && extra.op || "",
    error: error,
    id: extra && extra.id || "",
    bytes: extra && extra.bytes || 0,
  });
  return json({
    ok: false,
    error: error,
    message: MESSAGES[error] || MESSAGES.upstream,
  }, status, origin);
}

function storageReady(env) {
  return !!(
    env
    && env.SUBMISSIONS
    && typeof env.SUBMISSIONS.get === "function"
    && typeof env.SUBMISSIONS.put === "function"
    && typeof env.SUBMISSIONS.list === "function"
    && typeof env.SUBMISSIONS.delete === "function"
    && env.PHOTOS
    && typeof env.PHOTOS.put === "function"
    && typeof env.PHOTOS.get === "function"
  );
}

function visionMaxBytes(env) {
  const n = Number(env && env.VISION_OCR_MAX_BYTES);
  if (!Number.isFinite(n) || n <= 0) return 900000;
  return Math.floor(n);
}

function isUuid(id) {
  return UUID_RE.test(String(id || ""));
}

async function requireAdmin(request, env, origin) {
  const key = env && env.ADMIN_KEY ? String(env.ADMIN_KEY) : "";
  if (!key.trim()) return fail("admin_unconfigured", 503, origin, { op: "admin" });
  const provided = request.headers.get("x-admin-key") || "";
  const ok = await adminKeyMatches(provided, key);
  if (!ok) return fail("unauthorized", 401, origin, { op: "admin" });
  return null;
}

function toAdminItem(rec, detail) {
  const item = {
    id: rec.id,
    createdAt: rec.createdAt,
    nickname: rec.nickname || "",
    email: rec.email || "",
    status: rec.status,
    contentType: rec.contentType || "",
    byteLength: Number(rec.byteLength) || 0,
    productName: rec.productName || "",
    price: rec.price || "",
    offer: rec.offer || "",
    adminNote: rec.adminNote || "",
  };
  if (detail) {
    item.rawText = rec.rawText || "";
    item.ocrAt = rec.ocrAt || "";
    item.ocrError = rec.ocrError || "";
    item.publishStub = rec.publishStub || null;
    item.notified = false;
  }
  return item;
}

async function readRecord(env, id) {
  if (!isUuid(id)) return null;
  const raw = await env.SUBMISSIONS.get("sub:" + id);
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw);
    if (!rec || rec.id !== id) return null;
    return rec;
  } catch (e) {
    return null;
  }
}

async function writeRecord(env, rec) {
  await env.SUBMISSIONS.put("sub:" + rec.id, JSON.stringify(rec));
}

async function listPrefix(env, prefix) {
  const names = [];
  let cursor = undefined;
  let pages = 0;
  do {
    pages += 1;
    const page = await env.SUBMISSIONS.list({ prefix: prefix, cursor: cursor, limit: 100 });
    const keys = page && page.keys ? page.keys : [];
    for (let i = 0; i < keys.length; i++) names.push(keys[i].name);
    cursor = page && !page.list_complete ? page.cursor : "";
  } while (cursor && pages < 20);
  return names;
}

function maxBodyBytes(env) {
  const image = maxImageBytes(env);
  return Math.max(image + 8192, Math.floor(image * 1.4 + 16384));
}

async function readUpload(request, env) {
  const maxImage = maxImageBytes(env);
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
    if (buf.byteLength > maxImage) return { error: "payload_too_large" };
    const bytes = new Uint8Array(buf);
    const mime = sniffMime(bytes);
    if (!mime) return { error: "unsupported_type" };
    return { bytes: bytes, mime: mime, nickname: form.get("nickname"), email: form.get("email") };
  }
  if (!ctype.includes("application/json")) return { error: "bad_request" };
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
  if (decoded.bytes.byteLength > maxImage) return { error: "payload_too_large" };
  return {
    bytes: decoded.bytes,
    mime: decoded.mime,
    nickname: body.nickname,
    email: body.email,
  };
}

async function allowUpload(env, request, now) {
  const cap = Math.max(1, Math.floor(Number(env && env.UPLOADS_PER_MINUTE) || 8));
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const minute = Math.floor(now.getTime() / 60000);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(ip) + "|" + String(minute))
  );
  const hex = Array.from(new Uint8Array(digest).subarray(0, 8)).map(function (b) {
    return b.toString(16).padStart(2, "0");
  }).join("");
  const key = "rate:" + minute + ":" + hex;
  const current = Number(await env.SUBMISSIONS.get(key)) || 0;
  if (current >= cap) return false;
  await env.SUBMISSIONS.put(key, String(current + 1), { expirationTtl: 120 });
  return true;
}

function health(env, origin) {
  const ocrUrl = env && env.VISION_OCR_URL ? String(env.VISION_OCR_URL).trim() : "";
  return json({
    ok: true,
    service: "checker-photo-upload",
    uploadEnabled: killSwitchEnabled(env && env.UPLOAD_ENABLED),
    ocrConfigured: !!ocrEndpoint(ocrUrl),
    storage: {
      kv: !!(env && env.SUBMISSIONS && typeof env.SUBMISSIONS.get === "function"),
      r2: !!(env && env.PHOTOS && typeof env.PHOTOS.put === "function"),
    },
  }, 200, origin);
}

async function upload(request, env, now, origin) {
  if (!killSwitchEnabled(env && env.UPLOAD_ENABLED)) {
    return fail("upload_disabled", 403, origin, { op: "upload" });
  }
  if (!storageReady(env)) return fail("store_unconfigured", 503, origin, { op: "upload" });
  let allowed = false;
  try {
    allowed = await allowUpload(env, request, now);
  } catch (e) {
    return fail("store_failed", 503, origin, { op: "upload" });
  }
  if (!allowed) return fail("rate_limited", 429, origin, { op: "upload" });

  const payload = await readUpload(request, env || {});
  if (payload.error) {
    const status = payload.error === "payload_too_large" ? 413 : 400;
    return fail(payload.error, status, origin, { op: "upload", bytes: payload.bytes ? payload.bytes.byteLength : 0 });
  }
  const contact = normalizeContact(payload.nickname, payload.email);
  if (contact.error) return fail(contact.error, 400, origin, { op: "upload", bytes: payload.bytes.byteLength });

  const id = crypto.randomUUID();
  const createdAt = now.toISOString();
  const ext = EXT[payload.mime] || "img";
  const imageKey = "photos/" + id + "." + ext;
  const rec = {
    id: id,
    createdAt: createdAt,
    nickname: contact.nickname,
    email: contact.email,
    imageKey: imageKey,
    contentType: payload.mime,
    byteLength: payload.bytes.byteLength,
    status: "pending",
    adminNote: "",
    productName: "",
    price: "",
    offer: "",
    rawText: "",
    ocrAt: "",
    ocrError: "",
    publishStub: null,
  };
  try {
    await env.PHOTOS.put(imageKey, payload.bytes, {
      httpMetadata: { contentType: payload.mime },
    });
    await writeRecord(env, rec);
    await env.SUBMISSIONS.put("pending:" + id, createdAt);
  } catch (e) {
    try {
      if (typeof env.PHOTOS.delete === "function") await env.PHOTOS.delete(imageKey);
    } catch (ignore) { /* orphan image is preferable to a thrown response */ }
    return fail("store_failed", 503, origin, { op: "upload", id: id, bytes: payload.bytes.byteLength });
  }
  audit({ ok: true, op: "upload", id: id, bytes: payload.bytes.byteLength, status: "pending" });
  return json({
    ok: true,
    id: id,
    createdAt: createdAt,
    status: "pending",
    message: "已上傳。管理員會睇，你唔使再做。",
  }, 201, origin);
}

async function listSubmissions(request, env, url, origin) {
  const denied = await requireAdmin(request, env, origin);
  if (denied) return denied;
  if (!storageReady(env)) return fail("store_unconfigured", 503, origin, { op: "list" });
  const status = String(url.searchParams.get("status") || "pending");
  if (status !== "pending" && status !== "approved" && status !== "rejected" && status !== "all") {
    return fail("bad_request", 400, origin, { op: "list" });
  }
  let records = [];
  if (status === "pending") {
    const names = await listPrefix(env, "pending:");
    for (let i = 0; i < names.length; i++) {
      const id = names[i].slice("pending:".length);
      const rec = await readRecord(env, id);
      if (rec && rec.status === "pending") records.push(rec);
    }
  } else {
    const names = await listPrefix(env, "sub:");
    for (let i = 0; i < names.length; i++) {
      const id = names[i].slice("sub:".length);
      const rec = await readRecord(env, id);
      if (!rec) continue;
      if (status === "all" || rec.status === status) records.push(rec);
    }
  }
  records.sort(function (a, b) {
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
  const truncated = records.length > 50;
  const items = records.slice(0, 50).map(function (rec) { return toAdminItem(rec, false); });
  return json({ ok: true, status: status, truncated: truncated, items: items }, 200, origin);
}

async function oneSubmission(request, env, id, origin) {
  const denied = await requireAdmin(request, env, origin);
  if (denied) return denied;
  if (!storageReady(env)) return fail("store_unconfigured", 503, origin, { op: "get" });
  const rec = await readRecord(env, id);
  if (!rec) return fail("not_found", 404, origin, { op: "get" });
  return json({ ok: true, item: toAdminItem(rec, true) }, 200, origin);
}

async function imageResponse(request, env, id, origin) {
  const denied = await requireAdmin(request, env, origin);
  if (denied) return denied;
  if (!storageReady(env)) return fail("store_unconfigured", 503, origin, { op: "image" });
  const rec = await readRecord(env, id);
  if (!rec) return fail("not_found", 404, origin, { op: "image", id: id });
  const obj = await env.PHOTOS.get(rec.imageKey);
  if (!obj) return fail("image_missing", 404, origin, { op: "image", id: id });
  const mime = (obj.httpMetadata && obj.httpMetadata.contentType) || rec.contentType || "application/octet-stream";
  const body = obj.body != null ? obj.body : await obj.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: Object.assign({
      "content-type": mime,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    }, corsHeaders(origin)),
  });
}

async function readJsonBody(request) {
  const declared = Number(request.headers.get("content-length") || "0");
  if (declared > 32768) return { error: "payload_too_large" };
  const buf = await request.arrayBuffer();
  if (buf.byteLength > 32768) return { error: "payload_too_large" };
  try {
    const body = JSON.parse(new TextDecoder().decode(buf) || "null");
    if (!body || typeof body !== "object") return { error: "bad_request" };
    return { body: body };
  } catch (e) {
    return { error: "bad_request" };
  }
}

async function enqueuePublish(env, stub) {
  const raw = await env.SUBMISSIONS.get("publish-queue");
  let list = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch (e) {
      list = [];
    }
  }
  list.push(stub);
  if (list.length > 200) list = list.slice(list.length - 200);
  await env.SUBMISSIONS.put("publish-queue", JSON.stringify(list));
  await env.SUBMISSIONS.put("publish:" + stub.id, JSON.stringify(stub));
}

function applyFields(rec, body) {
  rec.productName = clipText(body.productName, 80);
  rec.price = clipText(body.price, 32);
  rec.offer = clipText(body.offer, 80);
  rec.adminNote = clipText(body.adminNote, 500);
}

async function patchSubmission(request, env, id, now, origin) {
  const denied = await requireAdmin(request, env, origin);
  if (denied) return denied;
  if (!storageReady(env)) return fail("store_unconfigured", 503, origin, { op: "patch", id: id });
  const rec = await readRecord(env, id);
  if (!rec) return fail("not_found", 404, origin, { op: "patch", id: id });
  const parsed = await readJsonBody(request);
  if (parsed.error) {
    const status = parsed.error === "payload_too_large" ? 413 : 400;
    return fail(parsed.error, status, origin, { op: "patch", id: id });
  }
  const action = String(parsed.body.action || "");
  if (action !== "approve" && action !== "reject" && action !== "save") {
    return fail("bad_request", 400, origin, { op: "patch", id: id });
  }
  if (rec.status !== "pending") return fail("conflict", 409, origin, { op: "patch", id: id });
  applyFields(rec, parsed.body);
  let publishStub = null;
  let queued = false;
  if (action === "reject") {
    if (!rec.adminNote) return fail("note_required", 400, origin, { op: "reject", id: id });
    rec.status = "rejected";
    rec.reviewedAt = now.toISOString();
  } else if (action === "approve") {
    rec.status = "approved";
    rec.reviewedAt = now.toISOString();
    publishStub = {
      id: rec.id,
      approvedAt: rec.reviewedAt,
      productName: rec.productName,
      price: rec.price,
      offer: rec.offer,
      nickname: rec.nickname,
      email: rec.email,
      imageKey: rec.imageKey,
      source: "photo-upload",
      nextStep: PUBLISH_NEXT,
    };
    rec.publishStub = publishStub;
  }
  try {
    await writeRecord(env, rec);
    if (action !== "save") await env.SUBMISSIONS.delete("pending:" + id);
    if (publishStub) {
      await enqueuePublish(env, publishStub);
      queued = true;
    }
  } catch (e) {
    return fail("store_failed", 503, origin, { op: action, id: id });
  }
  audit({ ok: true, op: action, id: id, status: rec.status });
  return json({
    ok: true,
    item: toAdminItem(rec, true),
    publishStub: publishStub,
    queued: queued,
    notified: false,
  }, 200, origin);
}

async function triggerOcr(request, env, id, fetchImpl, now, origin) {
  const denied = await requireAdmin(request, env, origin);
  if (denied) return denied;
  if (!storageReady(env)) return fail("store_unconfigured", 503, origin, { op: "ocr", id: id });
  const rec = await readRecord(env, id);
  if (!rec) return fail("not_found", 404, origin, { op: "ocr", id: id });
  if (rec.status !== "pending") return fail("conflict", 409, origin, { op: "ocr", id: id });
  const endpoint = ocrEndpoint(env && env.VISION_OCR_URL);
  if (!endpoint) return fail("ocr_unconfigured", 503, origin, { op: "ocr", id: id });
  const obj = await env.PHOTOS.get(rec.imageKey);
  if (!obj || typeof obj.arrayBuffer !== "function") {
    return fail("image_missing", 404, origin, { op: "ocr", id: id });
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if (bytes.byteLength > visionMaxBytes(env)) {
    rec.ocrError = MESSAGES.ocr_image_too_large;
    rec.ocrAt = now.toISOString();
    await writeRecord(env, rec);
    return fail("ocr_image_too_large", 413, origin, { op: "ocr", id: id, bytes: bytes.byteLength });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 20000);
  let upstream;
  try {
    upstream = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      signal: ctrl.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        consent: true,
        mimeType: rec.contentType,
        imageBase64: bytesToBase64(bytes),
      }),
    });
  } catch (e) {
    rec.ocrError = MESSAGES.ocr_upstream;
    rec.ocrAt = now.toISOString();
    try { await writeRecord(env, rec); } catch (ignore) { /* still report upstream */ }
    return fail("ocr_upstream", 502, origin, { op: "ocr", id: id, bytes: bytes.byteLength });
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await upstream.json();
  } catch (e) {
    data = null;
  }
  if (!upstream.ok || !data || data.ok !== true) {
    const detail = data && data.message ? String(data.message).slice(0, 200) : MESSAGES.ocr_upstream;
    rec.ocrError = detail;
    rec.ocrAt = now.toISOString();
    try { await writeRecord(env, rec); } catch (ignore) { /* still report upstream */ }
    audit({ ok: false, op: "ocr", error: "ocr_upstream", id: id, bytes: bytes.byteLength });
    return json({
      ok: false,
      error: "ocr_upstream",
      message: detail,
      item: toAdminItem(rec, true),
    }, 502, origin);
  }
  const filled = [];
  if (data.productName) {
    rec.productName = clipText(data.productName, 80);
    filled.push("productName");
  }
  if (data.price) {
    rec.price = clipText(String(data.price), 32);
    filled.push("price");
  }
  if (data.offer) {
    rec.offer = clipText(data.offer, 80);
    filled.push("offer");
  }
  rec.rawText = "";
  rec.ocrError = "";
  rec.ocrAt = now.toISOString();
  await writeRecord(env, rec);
  audit({ ok: true, op: "ocr", id: id, bytes: bytes.byteLength, status: rec.status });
  return json({
    ok: true,
    filled: filled,
    rawText: "",
    ocrVia: "checker-vision-ocr",
    item: toAdminItem(rec, true),
  }, 200, origin);
}

async function publishQueue(request, env, origin) {
  const denied = await requireAdmin(request, env, origin);
  if (denied) return denied;
  if (!storageReady(env)) return fail("store_unconfigured", 503, origin, { op: "queue" });
  const raw = await env.SUBMISSIONS.get("publish-queue");
  let items = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) items = parsed;
    } catch (e) {
      items = [];
    }
  }
  return json({ ok: true, items: items }, 200, origin);
}

export async function handleRequest(request, env, deps) {
  const fetchImpl = (deps && deps.fetch) || fetch;
  const now = (deps && deps.now) instanceof Date ? deps.now : new Date();
  const originHeader = request.headers.get("origin") || "";
  const originCheck = originAllowed(originHeader);
  const corsOrigin = originHeader && originCheck.ok ? originHeader : "";

  if (request.method === "OPTIONS") {
    if (originHeader && !originCheck.ok) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders(corsOrigin) });
  }
  if (originHeader && !originCheck.ok) return fail("origin", 403, "");

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (path === "/" && request.method === "GET") return health(env, corsOrigin);
    if (path === "/upload" && request.method === "POST") return upload(request, env, now, corsOrigin);
    if (path === "/submissions" && request.method === "GET") return listSubmissions(request, env, url, corsOrigin);
    if (path === "/publish-queue" && request.method === "GET") return publishQueue(request, env, corsOrigin);

    const image = path.match(/^\/submissions\/([^/]+)\/image$/);
    if (image) {
      if (request.method !== "GET") return fail("method", 405, corsOrigin, { op: "image" });
      return imageResponse(request, env, decodeURIComponent(image[1]), corsOrigin);
    }
    const ocr = path.match(/^\/submissions\/([^/]+)\/ocr$/);
    if (ocr) {
      if (request.method !== "POST") return fail("method", 405, corsOrigin, { op: "ocr" });
      return triggerOcr(request, env, decodeURIComponent(ocr[1]), fetchImpl, now, corsOrigin);
    }
    const one = path.match(/^\/submissions\/([^/]+)$/);
    if (one) {
      const id = decodeURIComponent(one[1]);
      if (request.method === "GET") return oneSubmission(request, env, id, corsOrigin);
      if (request.method === "PATCH") return patchSubmission(request, env, id, now, corsOrigin);
      return fail("method", 405, corsOrigin);
    }
    if (path === "/upload" || path === "/submissions" || path === "/publish-queue" || path === "/") {
      return fail("method", 405, corsOrigin);
    }
    return fail("not_found", 404, corsOrigin);
  } catch (e) {
    console.error(JSON.stringify({ audit: "photo-upload", ok: false, error: "exception" }));
    return fail("upstream", 500, corsOrigin);
  }
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
