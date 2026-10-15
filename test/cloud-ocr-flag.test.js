const assert = require("node:assert/strict");
const test = require("node:test");
const Cloud = require("../report-cloud-ocr.js");

test("production flag stays off", () => {
  assert.equal(Cloud.INTERNAL_CLOUD_OCR, false);
  assert.deepEqual(Cloud.readFlag("", function () { return null; }), { enabled: false, persist: "" });
});

test("query and localStorage opt in, and off clears it", () => {
  assert.deepEqual(Cloud.readFlag("?cloudOcr=1", function () { return null; }), { enabled: true, persist: "on" });
  assert.deepEqual(Cloud.readFlag("", function (key) {
    return key === Cloud.FLAG_KEY ? "1" : null;
  }), { enabled: true, persist: "" });
  assert.deepEqual(Cloud.readFlag("?cloudOcr=0", function () { return "1"; }), { enabled: false, persist: "off" });
});

test("worker URL allowlist", () => {
  assert.equal(Cloud.isWorkerUrlAllowed("https://checker-vision-ocr.example.workers.dev/ocr"), true);
  assert.equal(Cloud.isWorkerUrlAllowed("http://127.0.0.1:8787/"), true);
  assert.equal(Cloud.isWorkerUrlAllowed("http://localhost:8080"), true);
  assert.equal(Cloud.isWorkerUrlAllowed("https://evil.example/ocr"), false);
  assert.equal(Cloud.isWorkerUrlAllowed("https://francischeung11240518.github.io/Checker/"), false);
  assert.equal(Cloud.isWorkerUrlAllowed("https://user:pass@foo.workers.dev/"), false);
  assert.equal(Cloud.isWorkerUrlAllowed("http://foo.workers.dev/"), false);
});

test("query worker URL is used but not preferred over an invalid host", () => {
  const good = Cloud.workerUrlFrom(
    "?cloudOcr=1&cloudOcrUrl=https://pilot.example.workers.dev/",
    function () { return "https://stored.example.workers.dev/"; }
  );
  assert.equal(good, "https://pilot.example.workers.dev/");
  const stored = Cloud.workerUrlFrom("?cloudOcrUrl=https://evil.example/", function (key) {
    return key === Cloud.URL_KEY ? "http://127.0.0.1:8787" : "";
  });
  assert.equal(stored, "http://127.0.0.1:8787");
});

test("cloud offer rules", () => {
  const weak = { failed: true, price: null, confidence: "low" };
  assert.equal(Cloud.shouldOfferCloud({
    flagOn: true, photoKind: "shelf", sensitive: false, hasCrop: true, ocr: weak,
  }), true);
  assert.equal(Cloud.shouldOfferCloud({
    flagOn: false, photoKind: "shelf", sensitive: false, hasCrop: true, ocr: weak,
  }), false);
  assert.equal(Cloud.shouldOfferCloud({
    flagOn: true, photoKind: "receipt", sensitive: false, hasCrop: true, ocr: weak,
  }), false);
  assert.equal(Cloud.shouldOfferCloud({
    flagOn: true, photoKind: "shelf", sensitive: true, hasCrop: true, ocr: weak,
  }), false);
  assert.equal(Cloud.shouldOfferCloud({
    flagOn: true, photoKind: "shelf", sensitive: false, hasCrop: false, ocr: weak,
  }), false);
  assert.equal(Cloud.shouldOfferCloud({
    flagOn: true,
    photoKind: "shelf",
    sensitive: false,
    hasCrop: true,
    ocr: { failed: false, price: 49.9, confidence: "high" },
  }), false);
  assert.equal(Cloud.localOcrWeak({ failed: false, price: 12, confidence: "low" }), true);
  assert.equal(Cloud.localOcrWeak({ failed: false, price: 12, confidence: "mid" }), false);
});

test("default crop is a tag region, never the full frame", () => {
  const crop = Cloud.defaultCrop();
  assert.deepEqual(crop, { x: 0.14, y: 0.32, w: 0.72, h: 0.56 });
  assert.ok(crop.y + crop.h > 0.84);
  assert.ok(crop.w <= 0.85 && crop.h <= 0.85);
  assert.ok(crop.w * crop.h < 0.5);
  assert.notEqual(crop.w, 1);
  let grown = crop;
  for (let i = 0; i < 20; i++) grown = Cloud.nudgeCrop(grown, 0, 0, 0.1, 0.1);
  assert.equal(grown.w, 0.85);
  assert.equal(grown.h, 0.85);
  assert.ok(grown.x >= 0 && grown.y >= 0);
  assert.ok(grown.x + grown.w <= 1 + 1e-9);
});

test("name cleanup collapses Chinese spaces and drops a bare offer", () => {
  assert.equal(Cloud.cleanName("潘 婷"), "潘婷");
  assert.equal(Cloud.cleanName("潘  婷 乳液"), "潘婷乳液");
  assert.equal(Cloud.cleanName("PANTENE 潘 婷"), "PANTENE 潘婷");
  assert.equal(Cloud.cleanName("潘婷乳液 買2件$88"), "潘婷乳液");
  assert.equal(Cloud.cleanName("第二件半價"), "");
  assert.equal(Cloud.cleanName("50% off"), "");
  assert.equal(Cloud.cleanOffer("  買 2 件 半 價  "), "買 2件半價");
  assert.equal(Cloud.cleanOffer("第 二 件 半 價"), "第二件半價");
  assert.equal(Cloud.cleanPackSize(" 500 ml "), "500ml");
  assert.equal(Cloud.cleanPackSize("1.25 L"), "1.25L");
  assert.equal(Cloud.cleanPackSize("60 粒"), "60粒");
  assert.equal(Cloud.cleanPackSize("× 8"), "x8");
  assert.equal(Cloud.cleanPackSize("2KG"), "2kg");
});

test("postCrop sends consent and refuses other hosts", async () => {
  let called = 0;
  const blob = new Blob([Uint8Array.from([1, 2, 3, 4])], { type: "image/jpeg" });
  const blocked = await Cloud.postCrop("https://evil.example/ocr", blob, function () {
    called += 1;
  });
  assert.equal(blocked.error, "bad_url");
  assert.equal(called, 0);

  const ok = await Cloud.postCrop("http://127.0.0.1:8787/ocr", blob, async function (url, init) {
    called += 1;
    const body = JSON.parse(init.body);
    assert.equal(url, "http://127.0.0.1:8787/ocr");
    assert.equal(body.consent, true);
    assert.equal(body.mimeType, "image/jpeg");
    assert.equal(typeof body.imageBase64, "string");
    assert.ok(body.imageBase64.length > 0);
    return new Response(JSON.stringify({ ok: true, productName: "紫花油", price: "49.9" }), { status: 200 });
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.price, "49.9");
  assert.equal(called, 1);
});

test("postCrop treats kill switch as a failed call", async () => {
  const blob = new Blob([Uint8Array.from([9, 9, 9, 9])], { type: "image/jpeg" });
  const result = await Cloud.postCrop("http://localhost:8787/", blob, async function () {
    return new Response(JSON.stringify({
      ok: false,
      error: "kill_switch",
      message: "雲端認字已關閉，請用本機或人手填。",
    }), { status: 403 });
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "kill_switch");
});
