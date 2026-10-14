/* Internal photo-upload gate. Production default is OFF.
   Francis opts in with ?pilot=1. This file does not call Vision or Tesseract.
   The admin key never lives here. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CheckerPhotoUpload = api;
})(typeof window !== "undefined" ? window : null, function () {
  const FLAG_KEY = "pricewatch-internal-photo-upload";
  const URL_KEY = "pricewatch-photo-upload-url";
  /** Pages production build must keep this false. */
  const INTERNAL_PHOTO_UPLOAD = false;
  const MAX_UPLOAD_BYTES = 4000000;
  /** Under the existing vision-ocr image cap so a direct upload can be prefetched later. */
  const MAX_DIRECT_BYTES = 800000;
  const MAX_EDGE = 1600;
  const DIRECT_TYPES = {
    "image/jpeg": true,
    "image/png": true,
    "image/webp": true,
    "image/gif": true,
  };

  function readFlag(search, storageGet) {
    const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
    const raw = params.get("pilot");
    if (raw === "0" || raw === "off" || raw === "false") return { enabled: false, persist: "off" };
    if (raw === "1" || raw === "on" || raw === "true") return { enabled: true, persist: "on" };
    let stored = "";
    try {
      stored = storageGet ? storageGet(FLAG_KEY) || "" : "";
    } catch (e) {
      stored = "";
    }
    if (stored === "1") return { enabled: true, persist: "" };
    return { enabled: INTERNAL_PHOTO_UPLOAD, persist: "" };
  }

  function isWorkerUrlAllowed(url) {
    let parsed;
    try {
      parsed = new URL(String(url || "").trim());
    } catch (e) {
      return false;
    }
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname;
    if (parsed.protocol === "http:") {
      return host === "localhost" || host === "127.0.0.1";
    }
    if (parsed.protocol !== "https:") return false;
    if (host === "localhost" || host === "127.0.0.1") return true;
    if (!/^[a-z0-9.-]+$/.test(host)) return false;
    const parts = host.split(".");
    if (parts.length < 3) return false;
    if (parts.slice(-2).join(".") !== "workers.dev") return false;
    return parts.slice(0, -2).every(function (part) { return part.length > 0; });
  }

  function readWorkerUrl(storageGet) {
    let raw = "";
    try {
      raw = storageGet ? storageGet(URL_KEY) || "" : "";
    } catch (e) {
      raw = "";
    }
    raw = String(raw || "").trim();
    return isWorkerUrlAllowed(raw) ? raw : "";
  }

  /** Query URL is used for this visit only. It is not written to localStorage. */
  function workerUrlFrom(search, storageGet) {
    const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
    const fromQuery = String(params.get("uploadUrl") || "").trim();
    if (fromQuery && isWorkerUrlAllowed(fromQuery)) return fromQuery;
    return readWorkerUrl(storageGet);
  }

  function normalizeContact(nickname, email) {
    const name = String(nickname == null ? "" : nickname).replace(/[\u0000-\u001f\u007f]/g, "").trim();
    const mail = String(email == null ? "" : email).replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (name.length > 40 || mail.length > 120) return { error: "bad_contact" };
    if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return { error: "bad_contact" };
    return { nickname: name, email: mail };
  }

  function shouldReencode(type, byteLength) {
    if (!DIRECT_TYPES[String(type || "")]) return true;
    return Number(byteLength) > MAX_DIRECT_BYTES;
  }

  function fitEdge(width, height, maxEdge) {
    let w = Math.max(1, Math.floor(Number(width) || 1));
    let h = Math.max(1, Math.floor(Number(height) || 1));
    const edge = Math.max(w, h);
    const max = Math.max(1, Math.floor(Number(maxEdge) || MAX_EDGE));
    if (edge <= max) return { w: w, h: h };
    const scale = max / edge;
    return {
      w: Math.max(1, Math.round(w * scale)),
      h: Math.max(1, Math.round(h * scale)),
    };
  }

  return {
    FLAG_KEY: FLAG_KEY,
    URL_KEY: URL_KEY,
    INTERNAL_PHOTO_UPLOAD: INTERNAL_PHOTO_UPLOAD,
    MAX_UPLOAD_BYTES: MAX_UPLOAD_BYTES,
    MAX_DIRECT_BYTES: MAX_DIRECT_BYTES,
    MAX_EDGE: MAX_EDGE,
    readFlag: readFlag,
    isWorkerUrlAllowed: isWorkerUrlAllowed,
    workerUrlFrom: workerUrlFrom,
    normalizeContact: normalizeContact,
    shouldReencode: shouldReencode,
    fitEdge: fitEdge,
  };
});
