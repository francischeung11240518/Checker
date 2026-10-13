/** Budget brakes for the internal Vision OCR pilot. No image data. */

export const PAGES_ORIGIN = "https://francischeung11240518.github.io";

export function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Google Cloud Vision Text Detection public list price used by this pilot
 * (confirm on https://cloud.google.com/vision/pricing before go-live):
 *   - first 1,000 units / month: US$0
 *   - units 1,001–5,000,000: US$1.50 / 1,000
 * One TEXT_DETECTION on one image counts as one unit. This worker sends
 * only that one feature, so one accepted request ≈ one unit.
 *
 * Hard paid cap default US$15:
 *   paid units at cap = 15 / 1.50 * 1,000 = 10,000
 *   stop fraction default 0.80 → 8,000 paid units
 *   monthly counter stops at free 1,000 + 8,000 = 9,000 requests
 *   estimated spend at the brake ≈ 8,000 / 1,000 * 1.50 = US$12
 */
export function monthlyPlan(env) {
  const budgetUsd = Math.max(0, num(env && env.MONTHLY_BUDGET_USD, 15));
  let fraction = num(env && env.MONTHLY_STOP_FRACTION, 0.8);
  if (!Number.isFinite(fraction)) fraction = 0.8;
  fraction = Math.min(1, Math.max(0, fraction));
  const freeUnits = Math.max(0, Math.floor(num(env && env.FREE_UNITS_PER_MONTH, 1000)));
  const pricePerThousandUsd = Math.max(0, num(env && env.PRICE_PER_THOUSAND_USD, 1.5));
  const paidUnitsAtCap = pricePerThousandUsd > 0
    ? Math.floor((budgetUsd / pricePerThousandUsd) * 1000)
    : 0;
  const paidUnitsStop = Math.floor(paidUnitsAtCap * fraction);
  return {
    budgetUsd,
    fraction,
    freeUnits,
    pricePerThousandUsd,
    paidUnitsAtCap,
    paidUnitsStop,
    monthlyUnitLimit: freeUnits + paidUnitsStop,
    estimatedUsdAtStop: (paidUnitsStop / 1000) * pricePerThousandUsd,
  };
}

export function dailyCap(env) {
  return Math.max(0, Math.floor(num(env && env.DAILY_REQUEST_CAP, 50)));
}

export function maxImageBytes(env) {
  return Math.max(1000, Math.floor(num(env && env.MAX_IMAGE_BYTES, 900000)));
}

export function maxBodyBytes(env) {
  const image = maxImageBytes(env);
  return Math.max(image + 1024, Math.floor(image * 1.4 + 4096));
}

/** Missing or any value other than the on-tokens means the kill switch is off. */
export function killSwitchEnabled(value) {
  const v = String(value == null ? "" : value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

export function hkQuotaKeys(now) {
  const date = now instanceof Date ? now : new Date(now);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = function (type) {
    const part = parts.find(function (p) { return p.type === type; });
    return part ? part.value : "";
  };
  const y = get("year");
  const m = get("month");
  const d = get("day");
  return { dayKey: "day:" + y + "-" + m + "-" + d, monthKey: "month:" + y + "-" + m };
}

export function originAllowed(origin) {
  if (!origin) return { ok: true, browser: false };
  let url;
  try {
    url = new URL(origin);
  } catch (e) {
    return { ok: false, browser: true };
  }
  if (url.origin === PAGES_ORIGIN) return { ok: true, browser: true };
  const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (localHost && (url.protocol === "http:" || url.protocol === "https:")) {
    return { ok: true, browser: true };
  }
  return { ok: false, browser: true };
}

export function consentAccepted(value, source) {
  if (source === "json") return value === true;
  if (source === "multipart") return value === "true";
  return false;
}
