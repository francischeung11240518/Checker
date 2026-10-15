import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { handleRequest } from "../src/index.js";
import { adminKeyMatches } from "../src/auth.js";
import { isWorkerUrlAllowed, ocrEndpoint } from "../src/url.js";

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const PAGES = "https://francischeung11240518.github.io";
const NOW = new Date("2026-10-14T02:00:00.000Z");

function memoryKv() {
  const map = new Map();
  return {
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, String(value)); },
    async delete(key) { map.delete(key); },
    async list(opts) {
      const prefix = (opts && opts.prefix) || "";
      const keys = [];
      for (const name of map.keys()) {
        if (String(name).startsWith(prefix)) keys.push({ name: name });
      }
      return { keys: keys, list_complete: true, cursor: "" };
    },
    map: map,
  };
}

function memoryR2() {
  const map = new Map();
  return {
    async put(key, value, opts) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      map.set(key, {
        bytes: bytes,
        httpMetadata: (opts && opts.httpMetadata) || {},
      });
    },
    async get(key) {
      const item = map.get(key);
      if (!item) return null;
      return {
        httpMetadata: item.httpMetadata,
        body: item.bytes,
        async arrayBuffer() {
          const bytes = item.bytes;
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
      };
    },
    async delete(key) { map.delete(key); },
    map: map,
  };
}

function baseEnv(over) {
  return Object.assign({
    UPLOAD_ENABLED: "true",
    MAX_IMAGE_BYTES: "4000000",
    UPLOADS_PER_MINUTE: "8",
    VISION_OCR_URL: "",
    VISION_OCR_MAX_BYTES: "900000",
    ADMIN_KEY: "test-admin-key",
    SUBMISSIONS: memoryKv(),
    PHOTOS: memoryR2(),
  }, over);
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

async function uploadJpeg(env, fields, headers) {
  const file = new File([JPEG], "tag.jpg", { type: "image/jpeg" });
  const form = new FormData();
  form.set("image", file);
  if (fields && fields.nickname != null) form.set("nickname", fields.nickname);
  if (fields && fields.email != null) form.set("email", fields.email);
  const h = Object.assign({ origin: PAGES }, headers || {});
  return handleRequest(new Request("https://worker.test/upload", {
    method: "POST",
    headers: h,
    body: form,
  }), env, { now: NOW });
}

function adminHeaders(extra) {
  return Object.assign({
    origin: PAGES,
    "content-type": "application/json",
    "x-admin-key": "test-admin-key",
  }, extra || {});
}

test("admin key compare hashes both sides and rejects empty", async () => {
  assert.equal(await adminKeyMatches("test-admin-key", "test-admin-key"), true);
  assert.equal(await adminKeyMatches("nope", "test-admin-key"), false);
  assert.equal(await adminKeyMatches("", ""), false);
  assert.equal(await adminKeyMatches("test-admin-key", ""), false);
});

test("vision URL allowlist stays on workers.dev or loopback", () => {
  assert.equal(isWorkerUrlAllowed("https://checker-vision-ocr.example.workers.dev/"), true);
  assert.equal(isWorkerUrlAllowed("http://127.0.0.1:8788/"), true);
  assert.equal(ocrEndpoint("http://127.0.0.1:8788/"), "http://127.0.0.1:8788/ocr");
  assert.equal(isWorkerUrlAllowed("https://evil.example/ocr"), false);
  assert.equal(ocrEndpoint("https://evil.example/ocr"), "");
  assert.equal(isWorkerUrlAllowed(""), false);
});

test("upload stays off unless the kill switch is on", async () => {
  const env = baseEnv({ UPLOAD_ENABLED: "false" });
  const res = await uploadJpeg(env, { nickname: "阿明" });
  const body = await res.json();
  assert.equal(res.status, 403);
  assert.equal(body.error, "upload_disabled");
  assert.equal(env.PHOTOS.map.size, 0);
  assert.equal(env.SUBMISSIONS.map.size, 0);
});

test("foreign origin and bad image are refused", async () => {
  const env = baseEnv();
  const foreign = await uploadJpeg(env, {}, { origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error, "origin");
  assert.equal(foreign.headers.get("access-control-allow-origin"), null);

  const file = new File([Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])], "x.txt", { type: "text/plain" });
  const form = new FormData();
  form.set("image", file);
  const bad = await handleRequest(new Request("https://worker.test/upload", {
    method: "POST",
    headers: { origin: PAGES },
    body: form,
  }), env, { now: NOW });
  assert.equal((await bad.json()).error, "unsupported_type");
  assert.equal(env.PHOTOS.map.size, 0);
});

test("multipart upload stores the photo and optional contact", async () => {
  const logs = captureLogs();
  const env = baseEnv();
  try {
    const res = await uploadJpeg(env, { nickname: "阿明", email: "wing-secret@example.com" });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.status, "pending");
    assert.match(body.message, /已上傳/);
    assert.equal(body.email, undefined);
    assert.equal(env.PHOTOS.map.size, 1);
    const saved = JSON.parse(env.SUBMISSIONS.map.get("sub:" + body.id));
    assert.equal(saved.nickname, "阿明");
    assert.equal(saved.email, "wing-secret@example.com");
    assert.equal(saved.status, "pending");
    assert.equal(saved.imageKey, "photos/" + body.id + ".jpg");
    assert.equal(env.SUBMISSIONS.map.get("pending:" + body.id), body.createdAt);
    const joined = logs.lines.join("\n");
    assert.equal(joined.includes("wing-secret@example.com"), false);
    assert.equal(joined.includes("test-admin-key"), false);
    assert.match(joined, /"op":"upload"/);
  } finally {
    logs.restore();
  }
});

test("json base64 upload and size cap", async () => {
  const big = new Uint8Array(1200);
  big[0] = 0xff;
  big[1] = 0xd8;
  big[2] = 0xff;
  const env = baseEnv({ MAX_IMAGE_BYTES: "1000" });
  const tooBig = await handleRequest(new Request("https://worker.test/upload", {
    method: "POST",
    headers: { origin: PAGES, "content-type": "application/json" },
    body: JSON.stringify({
      imageBase64: Buffer.from(big).toString("base64"),
      mimeType: "image/jpeg",
    }),
  }), env, { now: NOW });
  assert.equal(tooBig.status, 413);
  assert.equal(env.PHOTOS.map.size, 0);

  const okEnv = baseEnv();
  const res = await handleRequest(new Request("https://worker.test/upload", {
    method: "POST",
    headers: { origin: PAGES, "content-type": "application/json" },
    body: JSON.stringify({
      imageBase64: Buffer.from(JPEG).toString("base64"),
      mimeType: "image/jpeg",
      nickname: "",
      email: "",
    }),
  }), okEnv, { now: NOW });
  assert.equal(res.status, 201);
  const body = await res.json();
  const saved = JSON.parse(okEnv.SUBMISSIONS.map.get("sub:" + body.id));
  assert.equal(saved.nickname, "");
  assert.equal(saved.email, "");
});

test("bad contact is rejected and rate limit counts", async () => {
  const env = baseEnv({ UPLOADS_PER_MINUTE: "1" });
  const bad = await uploadJpeg(env, { email: "not-an-email" });
  assert.equal((await bad.json()).error, "bad_contact");
  const second = await uploadJpeg(env, {});
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error, "rate_limited");
});

test("admin list, detail, and image need the shared secret", async () => {
  const env = baseEnv();
  const created = await (await uploadJpeg(env, { nickname: "阿明", email: "a@example.com" })).json();
  const missing = await handleRequest(new Request("https://worker.test/submissions", {
    headers: { origin: PAGES },
  }), env, { now: NOW });
  assert.equal(missing.status, 401);

  const unset = await handleRequest(new Request("https://worker.test/submissions", {
    headers: { origin: PAGES, "x-admin-key": "test-admin-key" },
  }), baseEnv({ ADMIN_KEY: "" }), { now: NOW });
  assert.equal(unset.status, 503);

  const list = await handleRequest(new Request("https://worker.test/submissions?status=pending", {
    headers: adminHeaders(),
  }), env, { now: NOW });
  const listed = await list.json();
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].nickname, "阿明");
  assert.equal(listed.items[0].email, "a@example.com");
  assert.equal(listed.items[0].createdAt, created.createdAt);
  assert.equal(listed.items[0].imageKey, undefined);

  const one = await handleRequest(new Request("https://worker.test/submissions/" + created.id, {
    headers: adminHeaders(),
  }), env, { now: NOW });
  assert.equal((await one.json()).item.status, "pending");

  const image = await handleRequest(new Request("https://worker.test/submissions/" + created.id + "/image", {
    headers: adminHeaders(),
  }), env, { now: NOW });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  const bytes = new Uint8Array(await image.arrayBuffer());
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);

  const hidden = await handleRequest(new Request("https://worker.test/submissions/" + created.id + "/image", {
    headers: { origin: PAGES },
  }), env, { now: NOW });
  assert.equal(hidden.status, 401);
});

test("preflight allows the admin header for the Pages origin", async () => {
  const res = await handleRequest(new Request("https://worker.test/submissions", {
    method: "OPTIONS",
    headers: { origin: PAGES, "access-control-request-headers": "x-admin-key, content-type" },
  }), baseEnv(), { now: NOW });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), PAGES);
  assert.match(res.headers.get("access-control-allow-headers"), /x-admin-key/);
});

test("reject marks a note and does not notify", async () => {
  const env = baseEnv();
  const created = await (await uploadJpeg(env, { email: "a@example.com" })).json();
  const empty = await handleRequest(new Request("https://worker.test/submissions/" + created.id, {
    method: "PATCH",
    headers: adminHeaders(),
    body: JSON.stringify({ action: "reject", adminNote: "  " }),
  }), env, { now: NOW });
  assert.equal((await empty.json()).error, "note_required");

  const res = await handleRequest(new Request("https://worker.test/submissions/" + created.id, {
    method: "PATCH",
    headers: adminHeaders(),
    body: JSON.stringify({ action: "reject", adminNote: "唔係價牌" }),
  }), env, { now: NOW });
  const body = await res.json();
  assert.equal(body.item.status, "rejected");
  assert.equal(body.item.adminNote, "唔係價牌");
  assert.equal(body.notified, false);
  assert.equal(env.SUBMISSIONS.map.has("pending:" + created.id), false);

  const pending = await (await handleRequest(new Request("https://worker.test/submissions?status=pending", {
    headers: adminHeaders(),
  }), env, { now: NOW })).json();
  assert.equal(pending.items.length, 0);
});

test("approve writes a publish stub and does not touch a second time", async () => {
  const env = baseEnv();
  const created = await (await uploadJpeg(env, { nickname: "阿明" })).json();
  const res = await handleRequest(new Request("https://worker.test/submissions/" + created.id, {
    method: "PATCH",
    headers: adminHeaders(),
    body: JSON.stringify({
      action: "approve",
      productName: "維他奶",
      price: "8.5",
      offer: "買2件$15",
    }),
  }), env, { now: NOW });
  const body = await res.json();
  assert.equal(body.item.status, "approved");
  assert.equal(body.notified, false);
  assert.equal(body.queued, true);
  assert.match(body.publishStub.nextStep, /未寫入產品庫/);
  assert.equal(body.publishStub.productName, "維他奶");
  assert.equal(body.publishStub.price, "8.5");
  const queue = JSON.parse(env.SUBMISSIONS.map.get("publish-queue"));
  assert.equal(queue.length, 1);
  assert.equal(queue[0].id, created.id);
  assert.equal(env.SUBMISSIONS.map.has("publish:" + created.id), true);

  const again = await handleRequest(new Request("https://worker.test/submissions/" + created.id, {
    method: "PATCH",
    headers: adminHeaders(),
    body: JSON.stringify({ action: "approve", productName: "維他奶", price: "8.5" }),
  }), env, { now: NOW });
  assert.equal(again.status, 409);
  assert.equal(JSON.parse(env.SUBMISSIONS.map.get("publish-queue")).length, 1);
});

test("ocr prefill calls checker-vision-ocr and does not call Google directly", async () => {
  const env = baseEnv({ VISION_OCR_URL: "https://checker-vision-ocr.example.workers.dev/" });
  const created = await (await uploadJpeg(env, {})).json();
  const calls = [];
  const res = await handleRequest(new Request("https://worker.test/submissions/" + created.id + "/ocr", {
    method: "POST",
    headers: adminHeaders(),
  }), env, {
    now: NOW,
    fetch: async function (url, init) {
      calls.push({ url: String(url), init: init });
      return new Response(JSON.stringify({
        ok: true,
        productName: "紫花油",
        price: "49.9",
        offer: "第二件半價",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://checker-vision-ocr.example.workers.dev/ocr");
  assert.equal(String(calls[0].url).includes("vision.googleapis.com"), false);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.consent, true);
  assert.equal(sent.mimeType, "image/jpeg");
  assert.equal(typeof sent.imageBase64, "string");
  assert.equal(body.item.productName, "紫花油");
  assert.equal(body.item.price, "49.9");
  assert.equal(body.item.offer, "第二件半價");
  assert.equal(body.rawText, "");
  assert.equal(body.ocrVia, "checker-vision-ocr");
  assert.equal(body.ocrViaBinding, false);
});

test("production ocr uses the service binding and skips the public workers.dev fetch", async () => {
  const env = baseEnv({
    VISION_OCR_URL: "https://checker-vision-ocr.example.workers.dev/",
    VISION_OCR: {
      async fetch(request) {
        const sent = await request.json();
        return new Response(JSON.stringify({
          ok: true,
          productName: sent.consent === true ? "維他奶" : "",
          price: "8.5",
          offer: "第二件半價",
          sawUrl: request.url,
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    },
  });
  const created = await (await uploadJpeg(env, {})).json();
  let publicFetches = 0;
  const res = await handleRequest(new Request("https://worker.test/submissions/" + created.id + "/ocr", {
    method: "POST",
    headers: adminHeaders(),
  }), env, {
    now: NOW,
    fetch: async function () {
      publicFetches += 1;
      throw new Error("public fetch must not run");
    },
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(publicFetches, 0);
  assert.equal(body.ocrViaBinding, true);
  assert.equal(body.item.productName, "維他奶");
  assert.equal(body.item.price, "8.5");
  const health = await (await handleRequest(new Request("https://worker.test/"), env, { now: NOW })).json();
  assert.equal(health.ocrViaBinding, true);
  assert.equal(health.ocrConfigured, true);
});

test("ocr without a vision URL does not fetch", async () => {
  const env = baseEnv({ VISION_OCR_URL: "" });
  const created = await (await uploadJpeg(env, {})).json();
  let called = 0;
  const res = await handleRequest(new Request("https://worker.test/submissions/" + created.id + "/ocr", {
    method: "POST",
    headers: adminHeaders(),
  }), env, {
    now: NOW,
    fetch: async function () { called += 1; throw new Error("no"); },
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "ocr_unconfigured");
  assert.equal(called, 0);
});

test("oversized photo is not sent to vision", async () => {
  const env = baseEnv({
    VISION_OCR_URL: "http://127.0.0.1:8788/",
    VISION_OCR_MAX_BYTES: "4",
  });
  const created = await (await uploadJpeg(env, {})).json();
  let called = 0;
  const res = await handleRequest(new Request("https://worker.test/submissions/" + created.id + "/ocr", {
    method: "POST",
    headers: adminHeaders(),
  }), env, {
    now: NOW,
    fetch: async function () { called += 1; throw new Error("no"); },
  });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, "ocr_image_too_large");
  assert.equal(called, 0);
});

test("save keeps the submission pending", async () => {
  const env = baseEnv();
  const created = await (await uploadJpeg(env, {})).json();
  const res = await handleRequest(new Request("https://worker.test/submissions/" + created.id, {
    method: "PATCH",
    headers: adminHeaders(),
    body: JSON.stringify({ action: "save", productName: "檸檬茶", price: "12" }),
  }), env, { now: NOW });
  const body = await res.json();
  assert.equal(body.item.status, "pending");
  assert.equal(body.item.productName, "檸檬茶");
  assert.equal(body.publishStub, null);
  assert.equal(env.SUBMISSIONS.map.has("pending:" + created.id), true);
});

test("health hides the admin key and reports the kill switch", async () => {
  const res = await handleRequest(new Request("https://worker.test/"), baseEnv({
    UPLOAD_ENABLED: "false",
    VISION_OCR_URL: "",
  }), { now: NOW });
  const body = await res.json();
  assert.equal(body.service, "checker-photo-upload");
  assert.equal(body.uploadEnabled, false);
  assert.equal(body.ocrConfigured, false);
  assert.equal(body.ocrViaBinding, false);
  assert.equal(JSON.stringify(body).includes("test-admin-key"), false);
});

test("config keeps the upload switch off and does not embed secrets", () => {
  const cfg = fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(cfg, /"UPLOAD_ENABLED": "false"/);
  assert.match(cfg, /"binding": "PHOTOS"/);
  assert.match(cfg, /"bucket_name": "checker-price-tags"/);
  assert.match(cfg, /"binding": "SUBMISSIONS"/);
  assert.match(cfg, /"binding": "VISION_OCR"/);
  assert.match(cfg, /"service": "checker-vision-ocr"/);
  assert.match(cfg, /replace_before_deploy/);
  assert.doesNotMatch(cfg, /GOOGLE_VISION|PRIVATE KEY|AIza/);
  const example = fs.readFileSync(new URL("../.dev.vars.example", import.meta.url), "utf8");
  assert.match(example, /local-dev-only-not-a-real-secret/);
  assert.doesNotMatch(example, /AIza|PRIVATE KEY/);
});

test("ocr prefill stores pack size and save keeps an edit", async () => {
  const env = baseEnv({ VISION_OCR_URL: "https://checker-vision-ocr.example.workers.dev/" });
  const created = await (await uploadJpeg(env, {})).json();
  const res = await handleRequest(new Request("https://worker.test/submissions/" + created.id + "/ocr", {
    method: "POST",
    headers: adminHeaders(),
  }), env, {
    now: NOW,
    fetch: async function () {
      return new Response(JSON.stringify({
        ok: true,
        productName: "維他命",
        price: "128",
        offer: "",
        packSize: "60粒",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.item.packSize, "60粒");
  assert.deepEqual(body.filled, ["productName", "price", "packSize"]);

  const saved = await handleRequest(new Request("https://worker.test/submissions/" + created.id, {
    method: "PATCH",
    headers: adminHeaders(),
    body: JSON.stringify({
      action: "save",
      productName: "維他命",
      price: "128",
      offer: "",
      packSize: "500ml",
    }),
  }), env, { now: NOW });
  const after = await saved.json();
  assert.equal(after.item.packSize, "500ml");
  assert.equal(after.item.status, "pending");
});
