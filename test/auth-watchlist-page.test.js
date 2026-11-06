const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Auth = require("../auth-watchlist.js");

const root = path.join(__dirname, "..");

function read(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

test("page product codes match the worker normalize rules", () => {
  assert.equal(Auth.normalizeProductCode("P000005418"), "P000005418");
  assert.equal(Auth.normalizeProductCode("  p000000670 "), "P000000670");
  assert.equal(Auth.normalizeProductCode("P00001864"), "P00001864");
  assert.equal(Auth.normalizeProductCode("P0000039670"), "P0000039670");
  assert.equal(Auth.normalizeProductCode("173520"), "173520");
  assert.equal(Auth.normalizeProductCode("P000005418;drop"), "");
  assert.equal(Auth.normalizeProductCode(5418), "");
  assert.equal(Auth.ORPHAN_LABEL, "暫時未有／已唔再提供");
});

test("day-over-day wording stays soft", () => {
  assert.equal(Auth.dayDirection(10, 10), "差不多");
  assert.equal(Auth.dayDirection(10, 10.5), "升");
  assert.equal(Auth.dayDirection(10, 9.5), "跌");
  assert.equal(Auth.dayChangeLine("$10", "$10.5", "升"), "較前一日升，由 $10 到 $10.5");
  assert.equal(Auth.dayChangeLine("$10", "$9.5", "跌"), "較前一日跌，由 $10 到 $9.5");
  assert.equal(Auth.dayChangeLine("$8", "$8", "差不多"), "較前一日差不多，由 $8 到 $8");
  assert.equal(Auth.dayChangeLine("$8", "$9", "原價"), "");
  const line = Auth.dayChangeLine("$8", "$9", "跌");
  assert.equal(line.includes("原價"), false);
});

test("worker URL allowlist and empty default", () => {
  assert.equal(Auth.AUTH_WORKER_URL, "");
  assert.equal(Auth.isWorkerUrlAllowed("https://checker-auth-watchlist.example.workers.dev/"), true);
  assert.equal(Auth.isWorkerUrlAllowed("http://127.0.0.1:8787/"), true);
  assert.equal(Auth.isWorkerUrlAllowed("http://localhost:8080"), true);
  assert.equal(Auth.isWorkerUrlAllowed("https://evil.example/session"), false);
  assert.equal(Auth.isWorkerUrlAllowed("https://francischeung11240518.github.io/Checker/"), false);
  const good = Auth.workerUrlFrom(
    "?authUrl=https://pilot.example.workers.dev/",
    function () { return "https://stored.example.workers.dev/"; }
  );
  assert.equal(good, "https://pilot.example.workers.dev");
  const stored = Auth.workerUrlFrom("?authUrl=https://evil.example/", function (key) {
    return key === Auth.URL_KEY ? "http://127.0.0.1:8787" : "";
  });
  assert.equal(stored, "http://127.0.0.1:8787");
  assert.equal(Auth.workerUrlFrom("", function () { return ""; }), "");
});

test("search page wires login and watchlist without secrets", () => {
  const index = read("index.html");
  const client = read("auth-watchlist.js");
  assert.match(index, /src="auth-watchlist\.js"/);
  assert.match(index, /id="loginOpen"/);
  assert.match(index, /id="watchlist"/);
  assert.match(index, /加入追蹤/);
  assert.match(index, /我的追蹤/);
  assert.match(index, /用 Google 繼續/);
  assert.match(index, /id="privacyNote"/);
  assert.match(index, /第一版只用 Google/);
  assert.match(index, /資料保留期未定/);
  assert.equal(index.includes("id=\"appleBtn\""), false);
  assert.equal(index.includes("用 Apple 繼續"), false);
  assert.equal(index.includes("appleid.cdn-apple.com"), false);
  assert.equal(index.includes("原價"), false);
  assert.equal(client.includes("原價"), false);
  assert.equal(index.includes("SESSION_SECRET"), false);
  assert.equal(client.includes("SESSION_SECRET"), false);
  assert.equal(client.includes("BEGIN PRIVATE KEY"), false);
  assert.equal(index.includes("upload.html"), false);
});
