const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Upload = require("../upload.js");
const Admin = require("../admin-uploads.js");

const root = path.join(__dirname, "..");

function read(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

test("upload page stays off unless the internal flag is set", () => {
  assert.equal(Upload.INTERNAL_PHOTO_UPLOAD, false);
  assert.deepEqual(Upload.readFlag("", function () { return null; }), { enabled: false, persist: "" });
  assert.deepEqual(Upload.readFlag("?pilot=1", function () { return null; }), { enabled: true, persist: "on" });
  assert.deepEqual(Upload.readFlag("", function (key) {
    return key === Upload.FLAG_KEY ? "1" : null;
  }), { enabled: true, persist: "" });
  assert.deepEqual(Upload.readFlag("?pilot=0", function () { return "1"; }), { enabled: false, persist: "off" });
});

test("upload worker URL is allowlisted and not taken from an unsafe query", () => {
  assert.equal(Upload.isWorkerUrlAllowed("https://checker-photo-upload.example.workers.dev/"), true);
  assert.equal(Upload.isWorkerUrlAllowed("http://127.0.0.1:8787/"), true);
  assert.equal(Upload.isWorkerUrlAllowed("https://evil.example/upload"), false);
  const good = Upload.workerUrlFrom(
    "?pilot=1&uploadUrl=https://pilot.example.workers.dev/",
    function () { return "https://stored.example.workers.dev/"; }
  );
  assert.equal(good, "https://pilot.example.workers.dev/");
  const stored = Upload.workerUrlFrom("?uploadUrl=https://evil.example/", function (key) {
    return key === Upload.URL_KEY ? "http://127.0.0.1:8787" : "";
  });
  assert.equal(stored, "http://127.0.0.1:8787");
});

test("contact fields are optional and oversized photos are reencoded", () => {
  assert.deepEqual(Upload.normalizeContact("  阿明  ", ""), { nickname: "阿明", email: "" });
  assert.deepEqual(Upload.normalizeContact("", "a@example.com"), { nickname: "", email: "a@example.com" });
  assert.equal(Upload.normalizeContact("阿明", "nope").error, "bad_contact");
  assert.equal(Upload.normalizeContact("名".repeat(41), "").error, "bad_contact");
  assert.equal(Upload.shouldReencode("image/jpeg", 1000), false);
  assert.equal(Upload.shouldReencode("image/jpeg", Upload.MAX_DIRECT_BYTES + 1), true);
  assert.equal(Upload.shouldReencode("image/heic", 1000), true);
  assert.deepEqual(Upload.fitEdge(4000, 2000, 1600), { w: 1600, h: 800 });
});

test("admin helpers build the review patch and format Hong Kong time", () => {
  assert.deepEqual(Admin.buildPatch("reject", {
    productName: "維他奶",
    price: "8.5",
    offer: "",
    packSize: "250ml",
    adminNote: "唔係價牌",
  }), {
    action: "reject",
    productName: "維他奶",
    price: "8.5",
    offer: "",
    packSize: "250ml",
    adminNote: "唔係價牌",
  });
  assert.equal(Admin.statusLabel("pending"), "待審核");
  const stamp = Admin.formatStamp("2026-10-14T02:00:00.000Z");
  assert.match(stamp, /2026/);
  assert.match(stamp, /10/);
  assert.match(stamp, /14/);
  assert.match(stamp, /10:00/);
  assert.equal(Admin.isWorkerUrlAllowed("https://checker-photo-upload.example.workers.dev"), true);
  assert.equal(Admin.workerUrlFrom("?adminKey=should-not-be-read&uploadUrl=https://pilot.example.workers.dev/", function () {
    return "";
  }), "https://pilot.example.workers.dev/");
});

test("a supermarket is required and new names dedupe against the seed", () => {
  assert.equal(Upload.normalizeStoreKey("  萬寧 "), "萬寧");
  assert.equal(Upload.normalizeStoreKey("Mannings"), "mannings");
  assert.deepEqual(Upload.resolveStoreChoice(Upload.SEED_STORES, "", "Mannings"), {
    id: "mannings",
    name: "萬寧",
    created: false,
  });
  assert.deepEqual(Upload.resolveStoreChoice(Upload.SEED_STORES, "", "759"), {
    id: "store759",
    name: "759阿信屋",
    created: false,
  });
  assert.equal(Upload.resolveStoreChoice(Upload.SEED_STORES, "", "  ").error, "store_required");
  const added = Upload.resolveStoreChoice(Upload.SEED_STORES, "", "優品360");
  assert.equal(added.created, true);
  assert.equal(added.name, "優品360");
  assert.equal(Upload.uploadReady(added), true);
  assert.equal(Upload.uploadReady(null), false);
  const names = Upload.SEED_STORES.map(function (row) { return row.name; });
  for (const name of ["萬寧", "屈臣氏", "百佳", "惠康", "AEON", "一田", "759阿信屋"]) {
    assert.equal(names.includes(name), true, name);
  }
});

test("public search does not link the upload page, and pages do not embed secrets", () => {
  const index = read("index.html");
  const upload = read("upload.html");
  const uploadJs = read("upload.js");
  const admin = read("admin-uploads.html");
  const adminJs = read("admin-uploads.js");
  assert.equal(index.includes("upload.html"), false);
  assert.equal(index.includes("admin-uploads.html"), false);
  assert.equal(upload.includes("tesseract"), false);
  assert.equal(upload.includes("vision.googleapis"), false);
  assert.equal(upload.includes("capture="), false);
  assert.match(upload, /type="file"/);
  assert.match(upload, /accept="image\/\*"/);
  assert.equal(uploadJs.includes("INTERNAL_PHOTO_UPLOAD = false"), true);
  assert.match(upload, /清單冇？新增超市/);
  assert.match(upload, /請先揀超市/);
  assert.match(upload, /storeName/);
  assert.match(upload, /id="photo"[^>]*disabled/);
  assert.match(upload, /id="send"[^>]*disabled/);
  assert.match(admin, /id="storeFilter"/);
  assert.match(adminJs, /storeName/);
  assert.match(adminJs, /未填超市/);
  assert.equal(Admin.storeLabel({ storeName: "萬寧", storeId: "mannings" }), "萬寧");
  assert.equal(Admin.storeLabel({}), "未填超市");
  const blob = [upload, uploadJs, admin, adminJs, read("admin.html")].join("\n");
  assert.equal(blob.includes("GOOGLE_VISION"), false);
  assert.equal(blob.includes("ADMIN_KEY="), false);
  assert.match(read("admin.html"), /admin-uploads\.html/);
});
