import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { audit, handleRequest } from "../src/index.js";

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

function memoryKv(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, String(value)); },
    map: map,
  };
}

function baseEnv(over) {
  return Object.assign({
    VISION_OCR_ENABLED: "true",
    DAILY_REQUEST_CAP: "50",
    MONTHLY_BUDGET_USD: "15",
    MONTHLY_STOP_FRACTION: "0.8",
    FREE_UNITS_PER_MONTH: "1000",
    PRICE_PER_THOUSAND_USD: "1.50",
    MAX_IMAGE_BYTES: "900000",
    GOOGLE_VISION_API_KEY: "test-key-not-real",
    QUOTA: memoryKv(),
  }, over);
}

function postJson(body, origin) {
  return new Request("https://worker.test/ocr", {
    method: "POST",
    headers: {
      origin: origin || "https://francischeung11240518.github.io",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function visionFetch(calls) {
  return async function (url, init) {
    calls.push({ url: String(url), init: init });
    return new Response(JSON.stringify({
      responses: [{
        fullTextAnnotation: { text: "紫花油\nHK$49.9\n" },
        textAnnotations: [{ description: "紫花油\nHK$49.9\n" }],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

function captureLogs() {
  const lines = [];
  const orig = console.log;
  console.log = function () {
    lines.push(Array.from(arguments).join(" "));
  };
  return {
    lines: lines,
    restore: function () { console.log = orig; },
  };
}

test("kill switch refuses before any Vision call", async () => {
  const calls = [];
  const logs = captureLogs();
  try {
    const res = await handleRequest(
      postJson({ consent: true, imageBase64: Buffer.from(JPEG).toString("base64"), mimeType: "image/jpeg" }),
      baseEnv({ VISION_OCR_ENABLED: "false" }),
      { fetch: visionFetch(calls), now: new Date("2026-10-13T02:00:00Z") }
    );
    const body = await res.json();
    assert.equal(res.status, 403);
    assert.equal(body.error, "kill_switch");
    assert.match(body.message, /已關閉/);
    assert.equal(calls.length, 0);
    assert.match(logs.lines.join("\n"), /kill_switch/);
  } finally {
    logs.restore();
  }
});

test("missing consent and foreign origin are rejected", async () => {
  const now = new Date("2026-10-13T02:00:00Z");
  const imageBase64 = Buffer.from(JPEG).toString("base64");
  const noConsent = await handleRequest(
    postJson({ consent: "true", imageBase64: imageBase64, mimeType: "image/jpeg" }),
    baseEnv(),
    { fetch: async function () { throw new Error("no"); }, now: now }
  );
  assert.equal((await noConsent.json()).error, "consent_required");

  const foreign = await handleRequest(
    postJson({ consent: true, imageBase64: imageBase64, mimeType: "image/jpeg" }, "https://evil.example"),
    baseEnv(),
    { fetch: async function () { throw new Error("no"); }, now: now }
  );
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get("access-control-allow-origin"), null);
});

test("daily and monthly caps refuse without calling Vision", async () => {
  const imageBase64 = Buffer.from(JPEG).toString("base64");
  const now = new Date("2026-10-13T02:00:00Z");
  const daily = await handleRequest(
    postJson({ consent: true, imageBase64: imageBase64, mimeType: "image/jpeg" }),
    baseEnv({ QUOTA: memoryKv({ "day:2026-10-13": "50", "month:2026-10": "10" }) }),
    { fetch: async function () { throw new Error("no"); }, now: now }
  );
  assert.equal((await daily.json()).error, "daily_quota");

  const monthly = await handleRequest(
    postJson({ consent: true, imageBase64: imageBase64, mimeType: "image/jpeg" }),
    baseEnv({ QUOTA: memoryKv({ "month:2026-10": "9000" }) }),
    { fetch: async function () { throw new Error("no"); }, now: now }
  );
  assert.equal((await monthly.json()).error, "monthly_quota");
});

test("missing quota binding fails closed", async () => {
  const env = baseEnv();
  delete env.QUOTA;
  const res = await handleRequest(
    postJson({
      consent: true,
      imageBase64: Buffer.from(JPEG).toString("base64"),
      mimeType: "image/jpeg",
    }),
    env,
    { fetch: async function () { throw new Error("no"); }, now: new Date("2026-10-13T02:00:00Z") }
  );
  assert.equal((await res.json()).error, "quota_unconfigured");
});

test("successful call returns name and price and does not log the image", async () => {
  const calls = [];
  const logs = captureLogs();
  const imageBase64 = Buffer.from(JPEG).toString("base64");
  try {
    const res = await handleRequest(
      postJson({ consent: true, imageBase64: imageBase64, mimeType: "image/jpeg" }),
      baseEnv(),
      { fetch: visionFetch(calls), now: new Date("2026-10-13T02:00:00Z") }
    );
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.productName, "紫花油");
    assert.equal(body.price, "49.9");
    assert.equal(body.offer, "");
    assert.equal(body.packSize, "");
    assert.equal(body.imageBase64, undefined);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /vision\.googleapis\.com\/v1\/images:annotate$/);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.requests.length, 1);
    assert.equal(sent.requests[0].features.length, 1);
    assert.equal(sent.requests[0].features[0].type, "DOCUMENT_TEXT_DETECTION");
    assert.deepEqual(sent.requests[0].imageContext.languageHints, ["zh-Hant", "en"]);
    assert.equal(calls[0].init.headers["x-goog-api-key"], "test-key-not-real");
    assert.equal(calls[0].init.redirect, "error");
    const logText = logs.lines.join("\n");
    assert.doesNotMatch(logText, /imageBase64|紫花油|test-key-not-real/);
    assert.match(logText, /"ok":true/);
    assert.match(logText, /"bytes":14/);
    const kv = baseEnv().QUOTA;
    void kv;
  } finally {
    logs.restore();
  }
});

test("successful call returns the offer phrase and still makes one Vision call", async () => {
  const calls = [];
  const logs = captureLogs();
  try {
    const res = await handleRequest(
      postJson({
        consent: true,
        imageBase64: Buffer.from(JPEG).toString("base64"),
        mimeType: "image/jpeg",
      }),
      baseEnv(),
      {
        fetch: async function (url, init) {
          calls.push({ url: String(url), init: init });
          return new Response(JSON.stringify({
            responses: [{
              fullTextAnnotation: { text: "潘 婷\n$49.9\n買2件$88\n" },
            }],
          }), { status: 200, headers: { "content-type": "application/json" } });
        },
        now: new Date("2026-10-13T02:00:00Z"),
      }
    );
    const body = await res.json();
    assert.equal(body.productName, "潘婷");
    assert.equal(body.price, "49.9");
    assert.equal(body.offer, "買2件$88");
    assert.equal(body.packSize, "");
    assert.equal(body.text, undefined);
    assert.equal(calls.length, 1);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.requests[0].features.length, 1);
    assert.doesNotMatch(logs.lines.join("\n"), /潘婷|買2件|test-key-not-real/);
  } finally {
    logs.restore();
  }
});

test("quota counters increment and the image is not stored in KV", async () => {
  const quota = memoryKv();
  await handleRequest(
    postJson({
      consent: true,
      imageBase64: Buffer.from(JPEG).toString("base64"),
      mimeType: "image/jpeg",
    }),
    baseEnv({ QUOTA: quota }),
    { fetch: visionFetch([]), now: new Date("2026-10-13T02:00:00Z") }
  );
  assert.equal(quota.map.get("day:2026-10-13"), "1");
  assert.equal(quota.map.get("month:2026-10"), "1");
  for (const value of quota.map.values()) {
    assert.doesNotMatch(value, /\/9j\//);
    assert.equal(value.length < 12, true);
  }
});

test("oversized image and bad base64 are refused", async () => {
  const now = new Date("2026-10-13T02:00:00Z");
  const bad = await handleRequest(
    postJson({ consent: true, imageBase64: "!!!!", mimeType: "image/jpeg" }),
    baseEnv(),
    { fetch: async function () { throw new Error("no"); }, now: now }
  );
  assert.equal((await bad.json()).error, "bad_request");

  const bulky = new Uint8Array(2000);
  bulky.set(JPEG);
  const tooBig = await handleRequest(
    postJson({
      consent: true,
      imageBase64: Buffer.from(bulky).toString("base64"),
      mimeType: "image/jpeg",
    }),
    baseEnv({ MAX_IMAGE_BYTES: "1500" }),
    { fetch: async function () { throw new Error("no"); }, now: now }
  );
  assert.equal((await tooBig.json()).error, "payload_too_large");
});

test("multipart consent true is accepted", async () => {
  const form = new FormData();
  form.set("consent", "true");
  form.set("image", new File([JPEG], "tag.jpg", { type: "image/jpeg" }));
  const req = new Request("https://worker.test/", {
    method: "POST",
    headers: { origin: "http://127.0.0.1:8080" },
    body: form,
  });
  const calls = [];
  const res = await handleRequest(req, baseEnv(), {
    fetch: visionFetch(calls),
    now: new Date("2026-10-13T02:00:00Z"),
  });
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.price, "49.9");
  assert.equal(calls.length, 1);
});

test("audit helper drops image fields", () => {
  const logs = captureLogs();
  try {
    audit({ ok: false, error: "upstream", bytes: 3, imageBase64: "SECRET-IMAGE", dayCount: 1, monthCount: 2 });
    assert.doesNotMatch(logs.lines.join("\n"), /SECRET-IMAGE/);
    assert.match(logs.lines.join("\n"), /"bytes":3/);
  } finally {
    logs.restore();
  }
});

test("source and config contain no real secrets or image bucket", () => {
  const files = ["src/index.js", "wrangler.toml", ".dev.vars.example", "README.md"];
  for (const file of files) {
    const text = fs.readFileSync(new URL("../" + file, import.meta.url), "utf8");
    assert.doesNotMatch(text, /AIza[0-9A-Za-z_-]{20,}/);
    assert.doesNotMatch(text, /BEGIN PRIVATE KEY/);
  }
  const src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /R2_BUCKET|env\.R2|IMAGES\.put/);
});
