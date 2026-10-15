import assert from "node:assert/strict";
import test from "node:test";
import { parseVisionResponse } from "../src/parse.js";
import { PARSERS, ocrProfileForStore, parseWithProfile } from "../src/profile.js";
import { handleRequest } from "../src/index.js";

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

const SAMPLE = {
  responses: [{
    fullTextAnnotation: { text: "紫花油\nHK$49.9\n" },
    textAnnotations: [{ description: "紫花油\nHK$49.9\n" }],
  }],
};

function memoryKv() {
  const map = new Map();
  return {
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, String(value)); },
  };
}

test("mannings uses the current parser and parknshop is only a hook", () => {
  assert.equal(typeof PARSERS.mannings, "function");
  assert.equal(PARSERS.parknshop, undefined);
  assert.equal(ocrProfileForStore("MANNINGS", ""), "mannings");
  assert.equal(ocrProfileForStore("", "萬寧"), "mannings");
  assert.equal(ocrProfileForStore("parknshop", "百佳"), "parknshop");
  assert.equal(ocrProfileForStore("", "Park N Shop"), "parknshop");
  assert.equal(ocrProfileForStore("watsons", "屈臣氏"), "default");
  assert.equal(ocrProfileForStore("store759", "759阿信屋"), "default");
  assert.equal(ocrProfileForStore("", ""), "default");

  const direct = parseVisionResponse(SAMPLE);
  const mannings = parseWithProfile("mannings", SAMPLE);
  const fallback = parseWithProfile("parknshop", SAMPLE);
  const unknown = parseWithProfile("default", SAMPLE);
  assert.equal(mannings.parser, "mannings");
  assert.equal(mannings.profile, "mannings");
  assert.equal(mannings.productName, direct.productName);
  assert.equal(mannings.price, direct.price);
  assert.equal(fallback.profile, "parknshop");
  assert.equal(fallback.parser, "mannings");
  assert.equal(fallback.productName, direct.productName);
  assert.equal(fallback.price, direct.price);
  assert.equal(unknown.parser, "mannings");
  assert.equal(unknown.productName, direct.productName);

  const plugged = parseWithProfile("parknshop", SAMPLE, {
    mannings: parseVisionResponse,
    parknshop: function () {
      return { ok: true, productName: "百佳專用", price: "1", offer: "" };
    },
  });
  assert.equal(plugged.profile, "parknshop");
  assert.equal(plugged.parser, "parknshop");
  assert.equal(plugged.productName, "百佳專用");
  assert.equal(plugged.price, "1");
});

test("vision worker selects the profile from the submitted supermarket", async () => {
  const env = {
    VISION_OCR_ENABLED: "true",
    DAILY_REQUEST_CAP: "50",
    MONTHLY_BUDGET_USD: "15",
    MONTHLY_STOP_FRACTION: "0.8",
    FREE_UNITS_PER_MONTH: "1000",
    PRICE_PER_THOUSAND_USD: "1.50",
    MAX_IMAGE_BYTES: "900000",
    GOOGLE_VISION_API_KEY: "test-key-not-real",
    QUOTA: memoryKv(),
  };
  const imageBase64 = Buffer.from(JPEG).toString("base64");
  async function call(extra) {
    return handleRequest(new Request("https://worker.test/ocr", {
      method: "POST",
      headers: {
        origin: "https://francischeung11240518.github.io",
        "content-type": "application/json",
      },
      body: JSON.stringify(Object.assign({
        consent: true,
        imageBase64: imageBase64,
        mimeType: "image/jpeg",
      }, extra)),
    }), env, {
      now: new Date("2026-10-15T02:00:00.000Z"),
      fetch: async function () {
        return new Response(JSON.stringify(SAMPLE), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
  }
  const mannings = await (await call({ storeId: "mannings", storeName: "萬寧" })).json();
  const parknshop = await (await call({ storeId: "parknshop", storeName: "百佳" })).json();
  const other = await (await call({ storeId: "watsons", storeName: "屈臣氏" })).json();
  assert.equal(mannings.ok, true);
  assert.equal(mannings.profile, "mannings");
  assert.equal(mannings.parser, "mannings");
  assert.equal(parknshop.profile, "parknshop");
  assert.equal(parknshop.parser, "mannings");
  assert.equal(parknshop.productName, mannings.productName);
  assert.equal(parknshop.price, mannings.price);
  assert.equal(other.profile, "default");
  assert.equal(other.parser, "mannings");
  assert.equal(other.productName, mannings.productName);
});
