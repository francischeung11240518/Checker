/* Login + personal watchlist client.
   The Worker URL stays empty until Francis pastes the deployed workers.dev host.
   Session is a Bearer token in localStorage, not a cross-site cookie.
   This file does not embed OAuth client secrets. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CheckerAuth = api;
})(typeof window !== "undefined" ? window : null, function () {
  const URL_KEY = "checker-auth-worker-url";
  const TOKEN_KEY = "checker-auth-token";
  /** Paste the deployed host after `wrangler deploy`. Leave empty until then. */
  const AUTH_WORKER_URL = "";
  const ORPHAN_LABEL = "暫時未有／已唔再提供";
  const P_CODE = /^[Pp](\d{1,12})$/;
  const DIGIT_CODE = /^(\d{4,12})$/;

  function normalizeProductCode(input) {
    if (typeof input !== "string") return "";
    const raw = input.trim();
    if (!raw || raw.length > 16) return "";
    const prefixed = P_CODE.exec(raw);
    if (prefixed) return "P" + prefixed[1];
    const digits = DIGIT_CODE.exec(raw);
    if (digits) return digits[1];
    return "";
  }

  function dayDirection(oldPrice, newPrice) {
    const oldN = Number(oldPrice);
    const newN = Number(newPrice);
    if (!(oldN > 0) || !(newN > 0)) return "";
    if (newN > oldN + 0.004) return "升";
    if (newN < oldN - 0.004) return "跌";
    return "差不多";
  }

  function dayChangeLine(oldText, newText, direction) {
    if (direction !== "升" && direction !== "跌" && direction !== "差不多") return "";
    const oldS = String(oldText || "");
    const newS = String(newText || "");
    if (!oldS || !newS) return "";
    return "較前一日" + direction + "，由 " + oldS + " 到 " + newS;
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

  function readStoredUrl(storageGet) {
    let raw = "";
    try {
      raw = storageGet ? storageGet(URL_KEY) || "" : "";
    } catch (e) {
      raw = "";
    }
    raw = String(raw || "").trim();
    return isWorkerUrlAllowed(raw) ? raw : "";
  }

  /** Query authUrl is this visit only. It is not written to localStorage. */
  function workerUrlFrom(search, storageGet, configured) {
    const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
    const fromQuery = String(params.get("authUrl") || "").trim();
    if (fromQuery && isWorkerUrlAllowed(fromQuery)) return fromQuery.replace(/\/+$/, "");
    const stored = readStoredUrl(storageGet);
    if (stored) return stored.replace(/\/+$/, "");
    const baked = String(configured == null ? AUTH_WORKER_URL : configured).trim();
    if (baked && isWorkerUrlAllowed(baked)) return baked.replace(/\/+$/, "");
    return "";
  }

  function apiUrl(base, path) {
    return new URL(path, String(base || "").replace(/\/+$/, "") + "/").toString();
  }

  function accountLabel(user) {
    const name = user && user.name ? String(user.name).trim() : "";
    if (name) {
      const chars = Array.from(name);
      return chars.length > 12 ? chars.slice(0, 12).join("") + "…" : name;
    }
    const email = user && user.email ? String(user.email).trim() : "";
    if (email) {
      const at = email.indexOf("@");
      const local = at > 0 ? email.slice(0, at) : email;
      const chars = Array.from(local);
      return chars.length > 4 ? chars.slice(0, 4).join("") + "…" : local;
    }
    // Reserved for a later Apple login. v1 never creates this provider.
    if (user && user.provider === "apple") return "Apple 用家";
    return "Google 用家";
  }

  return {
    URL_KEY: URL_KEY,
    TOKEN_KEY: TOKEN_KEY,
    AUTH_WORKER_URL: AUTH_WORKER_URL,
    ORPHAN_LABEL: ORPHAN_LABEL,
    normalizeProductCode: normalizeProductCode,
    dayDirection: dayDirection,
    dayChangeLine: dayChangeLine,
    isWorkerUrlAllowed: isWorkerUrlAllowed,
    workerUrlFrom: workerUrlFrom,
    apiUrl: apiUrl,
    accountLabel: accountLabel,
  };
});
