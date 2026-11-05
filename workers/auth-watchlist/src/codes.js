/** Stable product id stored in D1. Prices stay in the Pages bundle. */

const P_CODE = /^[Pp](\d{1,12})$/;
const DIGIT_CODE = /^(\d{4,12})$/;

/**
 * Normalize a Consumer Council style code.
 * `P` / `p` plus digits keeps the digit width (padding would collide
 * P00001864 with a different 9-digit code). Pure digit odd-ids stay digits.
 * Returns "" when the value is not a product code.
 */
export function normalizeProductCode(input) {
  if (typeof input !== "string") return "";
  const raw = input.trim();
  if (!raw || raw.length > 16) return "";
  const prefixed = P_CODE.exec(raw);
  if (prefixed) return "P" + prefixed[1];
  const digits = DIGIT_CODE.exec(raw);
  if (digits) return digits[1];
  return "";
}

export const WATCHLIST_CAP = 50;

/** Locked product max is 50. Env may only lower it. */
export function watchlistMax(env) {
  const n = Number(env && env.WATCHLIST_MAX);
  if (!Number.isFinite(n) || n <= 0) return WATCHLIST_CAP;
  return Math.min(WATCHLIST_CAP, Math.floor(n));
}
