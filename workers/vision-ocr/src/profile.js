/**
 * Supermarket → shelf-tag parse profile.
 *
 * `mannings` is the current parse.js behavior (萬寧 shelf tags).
 * `parknshop` is reserved. To add a 百佳 parser later, set
 * `PARSERS.parknshop = parseParknshop` in this file. Do not add that function yet.
 * Every profile without its own function uses the mannings parser.
 */
import { parseVisionResponse } from "./parse.js";

export const PARSERS = {
  mannings: parseVisionResponse,
};

const NAME_PROFILES = {
  "萬寧": "mannings",
  mannings: "mannings",
  "百佳": "parknshop",
  parknshop: "parknshop",
};

function nameKey(value) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[\s\u3000]+/g, "")
    .trim()
    .toLowerCase();
}

/** Profile id for a submission. Missing or unknown stores use `default`. */
export function ocrProfileForStore(storeId, storeName) {
  const id = nameKey(storeId);
  if (id === "mannings") return "mannings";
  if (id === "parknshop") return "parknshop";
  const name = nameKey(storeName);
  if (NAME_PROFILES[name]) return NAME_PROFILES[name];
  return "default";
}

/**
 * Run the parser registered for `profile`.
 * Pass `parsers` in tests to prove a future profile can plug in
 * without changing the caller. Production uses PARSERS.
 */
export function parseWithProfile(profile, payload, parsers) {
  const requested = String(profile || "default").trim().toLowerCase() || "default";
  const table = parsers || PARSERS;
  const registered = !!(table && typeof table[requested] === "function");
  const parser = registered ? table[requested] : ((table && table.mannings) || parseVisionResponse);
  const parsed = parser(payload) || {};
  return {
    ok: parsed.ok !== false,
    productName: parsed.productName || "",
    price: parsed.price || "",
    offer: parsed.offer || "",
    profile: requested,
    parser: registered ? requested : "mannings",
  };
}
