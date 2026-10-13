/* Same-browser queue for photo price reports.
   Metadata and photos stay in IndexedDB on this device. This store does not upload.
   Optional internal cloud OCR is a separate request and stays off unless the flag is on. */
(function (root) {
  const DB_NAME = "pricewatch-reports";
  const DB_VERSION = 1;
  const META = "reports";
  const PHOTOS = "photos";
  const CONSENT_KEY = "pricewatch-report-consent";
  const TOUCH_KEY = "pricewatch-reports-touch";
  let dbPromise = null;

  function consentVersion() {
    const shared = root.PricewatchShared;
    return shared ? shared.CONSENT_VERSION : "2026-10-12";
  }

  function hasConsent() {
    try {
      return localStorage.getItem(CONSENT_KEY) === consentVersion();
    } catch (e) {
      return false;
    }
  }

  function setConsent() {
    try {
      localStorage.setItem(CONSENT_KEY, consentVersion());
      return true;
    } catch (e) {
      return false;
    }
  }

  function touch() {
    try {
      localStorage.setItem(TOUCH_KEY, String(Date.now()));
    } catch (e) {}
    try {
      if (typeof BroadcastChannel === "function") {
        const bc = new BroadcastChannel("pricewatch-reports");
        bc.postMessage({ t: Date.now() });
        bc.close();
      }
    } catch (e) {}
  }

  function openDb() {
    if (!root.indexedDB) return Promise.reject(new Error("no-idb"));
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        const req = root.indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function () {
          const db = req.result;
          if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" });
          if (!db.objectStoreNames.contains(PHOTOS)) db.createObjectStore(PHOTOS, { keyPath: "id" });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () {
          dbPromise = null;
          reject(req.error || new Error("idb"));
        };
      });
    }
    return dbPromise;
  }

  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error("tx")); };
      tx.onabort = function () { reject(tx.error || new Error("abort")); };
    });
  }

  function cleanMeta(meta) {
    const copy = Object.assign({}, meta || {});
    delete copy.photo;
    delete copy.photoUrl;
    return copy;
  }

  async function save(meta, photoBlob) {
    const db = await openDb();
    const clean = cleanMeta(meta);
    if (photoBlob instanceof Blob) clean.hasPhoto = true;
    else if (photoBlob === null) clean.hasPhoto = false;
    const tx = db.transaction([META, PHOTOS], "readwrite");
    tx.objectStore(META).put(clean);
    if (photoBlob instanceof Blob) tx.objectStore(PHOTOS).put({ id: clean.id, blob: photoBlob });
    else if (photoBlob === null) tx.objectStore(PHOTOS).delete(clean.id);
    await txDone(tx);
    touch();
    return clean;
  }

  async function list() {
    const db = await openDb();
    const tx = db.transaction(META, "readonly");
    const req = tx.objectStore(META).getAll();
    const rows = await new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error); };
    });
    await txDone(tx);
    return rows.map(cleanMeta);
  }

  async function get(id) {
    const db = await openDb();
    const tx = db.transaction(META, "readonly");
    const req = tx.objectStore(META).get(id);
    const row = await new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error); };
    });
    await txDone(tx);
    return row ? cleanMeta(row) : null;
  }

  async function getPhoto(id) {
    const db = await openDb();
    const tx = db.transaction(PHOTOS, "readonly");
    const req = tx.objectStore(PHOTOS).get(id);
    const row = await new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error); };
    });
    await txDone(tx);
    return row && row.blob ? row.blob : null;
  }

  async function remove(id) {
    const db = await openDb();
    const tx = db.transaction([META, PHOTOS], "readwrite");
    tx.objectStore(META).delete(id);
    tx.objectStore(PHOTOS).delete(id);
    await txDone(tx);
    touch();
  }

  root.PricewatchReports = {
    CONSENT_KEY: CONSENT_KEY,
    TOUCH_KEY: TOUCH_KEY,
    hasConsent: hasConsent,
    setConsent: setConsent,
    save: save,
    list: list,
    get: get,
    getPhoto: getPhoto,
    remove: remove,
  };
})(typeof window !== "undefined" ? window : globalThis);
