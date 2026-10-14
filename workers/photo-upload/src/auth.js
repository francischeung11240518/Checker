/** Shared-secret check for admin routes. The key lives in a Wrangler secret, never in git. */

import { timingSafeEqual } from "node:crypto";

/**
 * Compare a header to ADMIN_KEY.
 * Both sides are hashed first so a length mismatch cannot short-circuit the compare.
 * An empty expected key never matches.
 */
export async function adminKeyMatches(provided, expected) {
  const expectedText = String(expected == null ? "" : expected).trim();
  if (!expectedText) return false;
  const providedText = String(provided == null ? "" : provided).trim();
  const enc = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(providedText)),
    crypto.subtle.digest("SHA-256", enc.encode(expectedText)),
  ]);
  return timingSafeEqual(new Uint8Array(left), new Uint8Array(right));
}
