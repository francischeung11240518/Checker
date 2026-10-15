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

  const MAX_STORE_NAME = 40;
  const SEED_STORES = [
    { id: "mannings", name: "萬寧", aliases: ["萬寧", "mannings"] },
    { id: "watsons", name: "屈臣氏", aliases: ["屈臣氏", "watsons"] },
    { id: "parknshop", name: "百佳", aliases: ["百佳", "parknshop", "park n shop", "parkn shop"] },
    { id: "wellcome", name: "惠康", aliases: ["惠康", "wellcome"] },
    { id: "aeon", name: "AEON", aliases: ["aeon", "永旺"] },
    { id: "yata", name: "一田", aliases: ["一田", "yata", "一田百貨"] },
    { id: "store759", name: "759阿信屋", aliases: ["759阿信屋", "759", "阿信屋"] },
    { id: "jasons", name: "Market Place", aliases: ["market place", "marketplace", "jasons"] },
    { id: "lungfung", name: "龍豐", aliases: ["龍豐"] },
    { id: "dchfood", name: "大昌", aliases: ["大昌", "大昌食品", "dch food", "dchfood"] },
    { id: "sasa", name: "莎莎", aliases: ["莎莎", "sasa"] },
  ];

  function displayStoreName(value) {
    return String(value == null ? "" : value)
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/[\s\u3000]+/g, " ")
      .trim();
  }

  function normalizeStoreKey(value) {
    return displayStoreName(value).replace(/ /g, "").toLowerCase();
  }

  function storeKeys(store) {
    const keys = [];
    function add(v) {
      const key = normalizeStoreKey(v);
      if (key && keys.indexOf(key) === -1) keys.push(key);
    }
    if (!store) return keys;
    add(store.id);
    add(store.name);
    const aliases = store.aliases || [];
    for (let i = 0; i < aliases.length; i++) add(aliases[i]);
    return keys;
  }

  function slugifyStore(name) {
    const slug = normalizeStoreKey(name).replace(/[^a-z0-9\u3400-\u9fff]+/g, "").slice(0, MAX_STORE_NAME);
    return slug || "store";
  }

  function uniqueStoreId(base, catalog) {
    const taken = {};
    for (let i = 0; i < catalog.length; i++) taken[catalog[i].id] = true;
    if (!taken[base]) return base;
    let n = 2;
    while (taken[base + "-" + n] && n < 100) n += 1;
    return base + "-" + n;
  }

  function findStore(catalog, storeId, storeName) {
    const list = Array.isArray(catalog) ? catalog : [];
    const idKey = normalizeStoreKey(storeId);
    if (idKey) {
      for (let i = 0; i < list.length; i++) {
        if (normalizeStoreKey(list[i].id) === idKey) return list[i];
      }
    }
    const nameKey = normalizeStoreKey(storeName || storeId);
    if (!nameKey) return null;
    for (let i = 0; i < list.length; i++) {
      if (storeKeys(list[i]).indexOf(nameKey) !== -1) return list[i];
    }
    return null;
  }

  /** catalog is the full list (seed + added). Empty or junk names are refused. */
  function resolveStoreChoice(catalog, storeId, storeName) {
    const list = Array.isArray(catalog) ? catalog : [];
    const found = findStore(list, storeId, storeName);
    if (found) return { id: found.id, name: found.name, created: false };
    const display = displayStoreName(storeName || storeId);
    const key = normalizeStoreKey(display);
    if (!key || !/[a-z0-9\u3400-\u9fff]/.test(key)) return { error: "store_required" };
    if (display.length > MAX_STORE_NAME) return { error: "store_too_long" };
    return {
      id: uniqueStoreId(slugifyStore(display), list),
      name: display,
      created: true,
    };
  }

  function storeMatches(store, query) {
    const q = normalizeStoreKey(query);
    if (!q) return true;
    const keys = storeKeys(store);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(q) !== -1) return true;
    }
    return false;
  }

  function uploadReady(store) {
    return !!(store && store.id && store.name);
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
    SEED_STORES: SEED_STORES,
    MAX_STORE_NAME: MAX_STORE_NAME,
    displayStoreName: displayStoreName,
    normalizeStoreKey: normalizeStoreKey,
    resolveStoreChoice: resolveStoreChoice,
    storeMatches: storeMatches,
    uploadReady: uploadReady,
  };
});
