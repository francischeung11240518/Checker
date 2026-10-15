/** Shared supermarket list for price-tag uploads.
 * Seed names follow the labels already used in the app (report-shared.js / search).
 * 一田 and 759阿信屋 are included because the upload pilot needs them even though
 * the Consumer Council price file does not list those chains.
 * User-added names are stored separately in KV under CUSTOM_STORES_KEY.
 */

export const MAX_STORE_NAME = 40;
export const MAX_CUSTOM_STORES = 200;
export const CUSTOM_STORES_KEY = "stores:custom";

export const SEED_STORES = [
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

function fieldText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** Display spelling: trim, drop control chars, collapse whitespace. Keep the caller's case. */
export function displayStoreName(value) {
  return fieldText(value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[\s\u3000]+/g, " ")
    .trim();
}

/** Compare key: case-insensitive, spaces ignored. */
export function normalizeStoreKey(value) {
  return displayStoreName(value).replace(/ /g, "").toLowerCase();
}

export function storeKeys(store) {
  const keys = [];
  function add(value) {
    const key = normalizeStoreKey(value);
    if (key && keys.indexOf(key) === -1) keys.push(key);
  }
  if (!store) return keys;
  add(store.id);
  add(store.name);
  const aliases = store.aliases || [];
  for (let i = 0; i < aliases.length; i++) add(aliases[i]);
  return keys;
}

export function slugifyStore(name) {
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

export function findStore(catalog, storeId, storeName) {
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

export function resolveStoreInput(storeId, storeName, custom) {
  const extras = Array.isArray(custom) ? custom : [];
  const catalog = SEED_STORES.concat(extras);
  const found = findStore(catalog, storeId, storeName);
  if (found) return { id: found.id, name: found.name, created: false };
  const display = displayStoreName(storeName || storeId);
  const key = normalizeStoreKey(display);
  if (!key || !/[a-z0-9\u3400-\u9fff]/.test(key)) return { error: "store_required" };
  if (display.length > MAX_STORE_NAME) return { error: "store_too_long" };
  return {
    id: uniqueStoreId(slugifyStore(display), catalog),
    name: display,
    created: true,
  };
}

export function readCustomStoreList(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i];
    if (!row || typeof row.id !== "string" || typeof row.name !== "string") continue;
    if (!row.id || !row.name) continue;
    out.push({ id: row.id, name: row.name, addedAt: row.addedAt || "" });
  }
  return out;
}

/** First-seen display name wins. Seed rows are never overwritten. */
export function mergeCustomStore(custom, store, nowIso) {
  const list = Array.isArray(custom) ? custom.map(function (row) {
    return { id: row.id, name: row.name, addedAt: row.addedAt || "" };
  }) : [];
  if (!store || !store.id || !store.name) return { list: list, added: false, store: store || null };
  const found = findStore(SEED_STORES.concat(list), store.id, store.name);
  if (found) return { list: list, added: false, store: { id: found.id, name: found.name } };
  if (list.length >= MAX_CUSTOM_STORES) {
    return { list: list, added: false, full: true, store: { id: store.id, name: store.name } };
  }
  const row = { id: store.id, name: store.name, addedAt: nowIso || "" };
  list.push(row);
  return { list: list, added: true, store: { id: row.id, name: row.name } };
}

export function publicStores(custom) {
  const out = [];
  const seen = {};
  function push(row, withAliases) {
    if (!row || !row.id || !row.name) return;
    const key = normalizeStoreKey(row.name);
    if (!key || seen[row.id] || seen["k:" + key]) return;
    seen[row.id] = true;
    seen["k:" + key] = true;
    const item = { id: row.id, name: row.name };
    if (withAliases && row.aliases && row.aliases.length) item.aliases = row.aliases.slice();
    out.push(item);
  }
  for (let i = 0; i < SEED_STORES.length; i++) push(SEED_STORES[i], true);
  const extras = Array.isArray(custom) ? custom : [];
  for (let i = 0; i < extras.length; i++) push(extras[i], false);
  return out;
}
