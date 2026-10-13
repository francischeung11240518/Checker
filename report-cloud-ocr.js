/* Internal cloud OCR gate. Production default is OFF.
   Francis can opt in with ?cloudOcr=1 or localStorage.
   The Vision API key never lives in this file. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CheckerCloudOcr = api;
})(typeof window !== "undefined" ? window : null, function (root) {
  const FLAG_KEY = "pricewatch-internal-cloud-ocr";
  const URL_KEY = "pricewatch-cloud-ocr-url";
  /** Pages production build must keep this false. */
  const INTERNAL_CLOUD_OCR = false;
  const MAX_UPLOAD_BYTES = 900000;

  let enabledFlag = false;

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  function clampCrop(crop) {
    const minSide = 0.18;
    const maxSide = 0.85;
    let w = Number(crop && crop.w);
    let h = Number(crop && crop.h);
    let x = Number(crop && crop.x);
    let y = Number(crop && crop.y);
    if (!isFinite(w)) w = 0.72;
    if (!isFinite(h)) h = 0.56;
    if (!isFinite(x)) x = 0.14;
    if (!isFinite(y)) y = 0.34;
    w = clamp(w, minSide, maxSide);
    h = clamp(h, minSide, maxSide);
    x = clamp(x, 0, 1 - w);
    y = clamp(y, 0, 1 - h);
    return { x: x, y: y, w: w, h: h };
  }

  function defaultCrop() {
    // Taller than the old box (bottom was 0.80) so the name line under the
    // price falls inside the yellow box. 0.72 × 0.56 is still under half the frame.
    return clampCrop({ x: 0.14, y: 0.32, w: 0.72, h: 0.56 });
  }

  function nudgeCrop(crop, dx, dy, dw, dh) {
    const c = clampCrop(crop);
    return clampCrop({
      x: c.x + (Number(dx) || 0) - (Number(dw) || 0) / 2,
      y: c.y + (Number(dy) || 0) - (Number(dh) || 0) / 2,
      w: c.w + (Number(dw) || 0),
      h: c.h + (Number(dh) || 0),
    });
  }

  function localOcrWeak(ocr) {
    if (!ocr || ocr.failed) return true;
    if (ocr.price == null) return true;
    if (ocr.confidence === "low") return true;
    return false;
  }

  function shouldOfferCloud(opts) {
    if (!opts || !opts.flagOn) return false;
    if (opts.photoKind === "receipt") return false;
    if (opts.sensitive) return false;
    if (!opts.hasCrop) return false;
    return localOcrWeak(opts.ocr);
  }

  function isWorkerUrlAllowed(url) {
    let parsed;
    try {
      parsed = new URL(url);
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

  function readFlag(search, storageGet) {
    const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
    const raw = params.get("cloudOcr");
    if (raw === "0" || raw === "off" || raw === "false") return { enabled: false, persist: "off" };
    if (raw === "1" || raw === "on" || raw === "true") return { enabled: true, persist: "on" };
    let stored = "";
    try {
      stored = storageGet ? storageGet(FLAG_KEY) || "" : "";
    } catch (e) {
      stored = "";
    }
    if (stored === "1") return { enabled: true, persist: "" };
    return { enabled: INTERNAL_CLOUD_OCR, persist: "" };
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

  function workerUrlFrom(search, storageGet) {
    const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
    const fromQuery = String(params.get("cloudOcrUrl") || "").trim();
    if (fromQuery && isWorkerUrlAllowed(fromQuery)) return fromQuery;
    return readWorkerUrl(storageGet);
  }

  /** Same offer coverage as report-shared.js parseOcr. */
  const OFFER_RE = /買\s*第?\s*\d+\s*件\s*半\s*價|第\s*[二2]\s*件\s*半\s*價|買\s*\d+\s*件[^\n]{0,18}|買\s*\d+\s*送\s*\d+|第\s*[二2]\s*件[^\n]{0,12}|\d{1,2}\s*%\s*off|\d+\s*for\s*\$?\s*\d+(?:[.,]\d{1,2})?|減\s*\$?\s*\d+(?:[.,]\d{1,2})?/i;

  function collapseCjkSpaces(s) {
    return String(s || "")
      .replace(/([\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, "$1")
      .replace(/(\d)[ \t]+(?=[\u4e00-\u9fff])/g, "$1");
  }

  function cjkCount(s) {
    return (String(s || "").match(/[\u4e00-\u9fff]/g) || []).length;
  }

  function cleanName(value) {
    let cleaned = collapseCjkSpaces(String(value || ""))
      .replace(/\d{6,}/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const match = OFFER_RE.exec(cleaned);
    if (match) {
      const before = cleaned.slice(0, match.index).trim();
      if (cjkCount(before) >= 2 || /[A-Za-z]{3,}/.test(before)) cleaned = before;
      else return "";
    }
    return cleaned.slice(0, 40);
  }

  function cleanOffer(value) {
    return collapseCjkSpaces(String(value || ""))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
  }

  function storageGet(key) {
    try {
      return root.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      root.localStorage.setItem(key, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  function storageDel(key) {
    try {
      root.localStorage.removeItem(key);
    } catch (e) {}
  }

  function syncFromLocation() {
    const search = root && root.location ? root.location.search : "";
    const decision = readFlag(search, storageGet);
    if (decision.persist === "on") storageSet(FLAG_KEY, "1");
    if (decision.persist === "off") storageDel(FLAG_KEY);
    enabledFlag = decision.enabled;
    return enabledFlag;
  }

  function enabled() {
    return enabledFlag;
  }

  function disable() {
    storageDel(FLAG_KEY);
    enabledFlag = false;
    if (root && root.history && root.location) {
      const params = new URLSearchParams(root.location.search);
      params.delete("cloudOcr");
      params.delete("cloudOcrUrl");
      const next = params.toString();
      const path = root.location.pathname + (next ? "?" + next : "") + (root.location.hash || "");
      root.history.replaceState(null, "", path);
    }
  }

  function workerUrl() {
    const search = root && root.location ? root.location.search : "";
    return workerUrlFrom(search, storageGet);
  }

  async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunk = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunk) {
      const slice = bytes.subarray(i, Math.min(bytes.length, i + chunk));
      const arr = new Array(slice.length);
      for (let j = 0; j < slice.length; j++) arr[j] = slice[j];
      binary += String.fromCharCode.apply(null, arr);
    }
    return btoa(binary);
  }

  async function postCrop(url, blob, fetchImpl) {
    const fetchFn = fetchImpl || (root && root.fetch ? root.fetch.bind(root) : null);
    if (!isWorkerUrlAllowed(url) || !fetchFn) return { ok: false, error: "bad_url" };
    if (!blob || typeof blob.arrayBuffer !== "function") return { ok: false, error: "bad_image" };
    if (blob.size > MAX_UPLOAD_BYTES) return { ok: false, error: "too_large" };
    let imageBase64 = "";
    try {
      imageBase64 = await blobToBase64(blob);
    } catch (e) {
      return { ok: false, error: "bad_image" };
    }
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 20000) : null;
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          consent: true,
          mimeType: "image/jpeg",
          imageBase64: imageBase64,
        }),
        signal: ctrl ? ctrl.signal : undefined,
      });
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        data = null;
      }
      if (!res.ok || !data || data.ok !== true) {
        return { ok: false, error: (data && data.error) || "upstream", data: data };
      }
      return { ok: true, data: data };
    } catch (e) {
      return { ok: false, error: "network" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function cropToBlob(blob, crop) {
    const c = clampCrop(crop);
    return new Promise(function (resolve) {
      if (!root || !root.document || !blob) {
        resolve(null);
        return;
      }
      const url = root.URL.createObjectURL(blob);
      const img = new root.Image();
      img.onload = function () {
        try {
          const sx = Math.round(c.x * img.width);
          const sy = Math.round(c.y * img.height);
          const sw = Math.max(1, Math.round(c.w * img.width));
          const sh = Math.max(1, Math.round(c.h * img.height));
          const maxEdge = 960;
          const scale = Math.min(1, maxEdge / Math.max(sw, sh));
          const canvas = root.document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(sw * scale));
          canvas.height = Math.max(1, Math.round(sh * scale));
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
          root.URL.revokeObjectURL(url);
          canvas.toBlob(function (out) { resolve(out || null); }, "image/jpeg", 0.8);
        } catch (e) {
          root.URL.revokeObjectURL(url);
          resolve(null);
        }
      };
      img.onerror = function () {
        root.URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  return {
    FLAG_KEY: FLAG_KEY,
    URL_KEY: URL_KEY,
    INTERNAL_CLOUD_OCR: INTERNAL_CLOUD_OCR,
    MAX_UPLOAD_BYTES: MAX_UPLOAD_BYTES,
    clampCrop: clampCrop,
    defaultCrop: defaultCrop,
    nudgeCrop: nudgeCrop,
    localOcrWeak: localOcrWeak,
    shouldOfferCloud: shouldOfferCloud,
    isWorkerUrlAllowed: isWorkerUrlAllowed,
    readFlag: readFlag,
    readWorkerUrl: readWorkerUrl,
    workerUrlFrom: workerUrlFrom,
    cleanName: cleanName,
    cleanOffer: cleanOffer,
    syncFromLocation: syncFromLocation,
    enabled: enabled,
    disable: disable,
    workerUrl: workerUrl,
    postCrop: postCrop,
    cropToBlob: cropToBlob,
  };
});
