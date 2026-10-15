import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  MAX_CUSTOM_STORES,
  SEED_STORES,
  mergeCustomStore,
  normalizeStoreKey,
  publicStores,
  resolveStoreInput,
} from "../src/stores.js";

const require = createRequire(import.meta.url);
const Upload = require("../../../upload.js");

test("browser and worker share the same seed names", () => {
  assert.deepEqual(Upload.SEED_STORES, SEED_STORES);
  assert.equal(Upload.INTERNAL_PHOTO_UPLOAD, false);
});

test("store keys ignore case and spaces and keep the first display name", () => {
  assert.equal(normalizeStoreKey("  Park N Shop "), "parknshop");
  assert.equal(Upload.normalizeStoreKey("  Park N Shop "), "parknshop");
  assert.equal(normalizeStoreKey("優品　360"), "優品360");

  const cases = [
    ["", "萬寧", { id: "mannings", name: "萬寧", created: false }],
    ["MANNINGS", "其他", { id: "mannings", name: "萬寧", created: false }],
    ["", "759", { id: "store759", name: "759阿信屋", created: false }],
    ["", "759阿信屋", { id: "store759", name: "759阿信屋", created: false }],
    ["", "  一田百貨 ", { id: "yata", name: "一田", created: false }],
    ["", "", { error: "store_required" }],
    ["", "   ", { error: "store_required" }],
    ["", "!!!", { error: "store_required" }],
  ];
  for (const row of cases) {
    const worker = resolveStoreInput(row[0], row[1], []);
    const browser = Upload.resolveStoreChoice(Upload.SEED_STORES, row[0], row[1]);
    assert.deepEqual(worker, row[2], JSON.stringify(row[1]));
    assert.deepEqual(browser, row[2], "browser " + JSON.stringify(row[1]));
  }

  const created = resolveStoreInput("", "優品360", []);
  assert.equal(created.created, true);
  assert.equal(created.name, "優品360");
  const again = resolveStoreInput("", "優品 360", [{ id: created.id, name: created.name }]);
  assert.deepEqual(again, { id: created.id, name: "優品360", created: false });
  const browserAgain = Upload.resolveStoreChoice(
    Upload.SEED_STORES.concat([{ id: created.id, name: created.name }]),
    "",
    "優品 360"
  );
  assert.deepEqual(browserAgain, again);

  const tooLong = "超".repeat(41);
  assert.equal(resolveStoreInput("", tooLong, []).error, "store_too_long");
  assert.equal(Upload.resolveStoreChoice(Upload.SEED_STORES, "", tooLong).error, "store_too_long");
  assert.equal(Upload.uploadReady(null), false);
  assert.equal(Upload.uploadReady({ id: "mannings", name: "萬寧" }), true);
  assert.equal(Upload.storeMatches(SEED_STORES[0], "man"), true);
  assert.equal(Upload.storeMatches(SEED_STORES[0], "屈臣"), false);
});

test("custom list dedupes and stops growing at the cap", () => {
  const first = mergeCustomStore([], { id: "優品360", name: "優品360" }, "2026-10-15T00:00:00.000Z");
  assert.equal(first.added, true);
  const second = mergeCustomStore(first.list, { id: "優品360", name: "優品 360" }, "2026-10-15T01:00:00.000Z");
  assert.equal(second.added, false);
  assert.equal(second.store.name, "優品360");
  assert.equal(second.list.length, 1);
  assert.equal(second.list[0].addedAt, "2026-10-15T00:00:00.000Z");

  const seedHit = mergeCustomStore(first.list, { id: "mannings", name: "萬寧" }, "2026-10-15T01:00:00.000Z");
  assert.equal(seedHit.added, false);
  assert.equal(seedHit.list.length, 1);

  const full = [];
  for (let i = 0; i < MAX_CUSTOM_STORES; i++) full.push({ id: "s" + i, name: "店" + i });
  const blocked = mergeCustomStore(full, { id: "extra", name: "新店" }, "2026-10-15T02:00:00.000Z");
  assert.equal(blocked.added, false);
  assert.equal(blocked.full, true);
  assert.equal(blocked.list.length, MAX_CUSTOM_STORES);

  const pub = publicStores(first.list);
  assert.equal(pub[0].name, "萬寧");
  assert.equal(pub.some(function (row) { return row.id === "優品360" && row.name === "優品360"; }), true);
  assert.equal(pub.filter(function (row) { return row.id === "mannings"; }).length, 1);
});
