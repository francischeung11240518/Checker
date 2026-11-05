import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProductCode, watchlistMax, WATCHLIST_CAP } from "../src/codes.js";

test("normalizeProductCode keeps width and uppercases P", () => {
  assert.equal(normalizeProductCode("P000005418"), "P000005418");
  assert.equal(normalizeProductCode("  p000000670 "), "P000000670");
  assert.equal(normalizeProductCode("p000000669"), "P000000669");
  assert.equal(normalizeProductCode("P00001864"), "P00001864");
  assert.equal(normalizeProductCode("P00001863"), "P00001863");
  assert.equal(normalizeProductCode("P0000039670"), "P0000039670");
  assert.equal(normalizeProductCode("P0000015396"), "P0000015396");
  assert.equal(normalizeProductCode("173520"), "173520");
});

test("normalizeProductCode rejects anything that is not a product code", () => {
  assert.equal(normalizeProductCode(""), "");
  assert.equal(normalizeProductCode("   "), "");
  assert.equal(normalizeProductCode("P"), "");
  assert.equal(normalizeProductCode("Pabc"), "");
  assert.equal(normalizeProductCode("12"), "");
  assert.equal(normalizeProductCode("P000005418 "), "P000005418");
  assert.equal(normalizeProductCode("P000005418;drop"), "");
  assert.equal(normalizeProductCode("../P000005418"), "");
  assert.equal(normalizeProductCode("P" + "1".repeat(13)), "");
  assert.equal(normalizeProductCode(null), "");
  assert.equal(normalizeProductCode(5418), "");
});

test("watchlist max stays at the locked cap of 50", () => {
  assert.equal(WATCHLIST_CAP, 50);
  assert.equal(watchlistMax({}), 50);
  assert.equal(watchlistMax({ WATCHLIST_MAX: "50" }), 50);
  assert.equal(watchlistMax({ WATCHLIST_MAX: "2" }), 2);
  assert.equal(watchlistMax({ WATCHLIST_MAX: "100" }), 50);
  assert.equal(watchlistMax({ WATCHLIST_MAX: "0" }), 50);
  assert.equal(watchlistMax({ WATCHLIST_MAX: "nope" }), 50);
});
