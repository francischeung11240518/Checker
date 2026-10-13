import assert from "node:assert/strict";
import test from "node:test";
import { decodeImageBase64, parseVisionResponse, priceToken } from "../src/parse.js";

test("single-tag samples from the pilot plan", () => {
  const samples = [
    ["紫花油\nHK$49.9\n", "紫花油", "49.9"],
    ["保心安\n53.5\n", "保心安", "53.5"],
    ["余仁生\n$238\n", "余仁生", "238"],
    ["潘婷乳液\n$49.90\n買2件$88\n", "潘婷乳液", "49.9"],
  ];
  for (const row of samples) {
    const parsed = parseVisionResponse({
      responses: [{ fullTextAnnotation: { text: row[0] }, textAnnotations: [{ description: row[0] }] }],
    });
    assert.equal(parsed.productName, row[1], row[0]);
    assert.equal(parsed.price, row[2], row[0]);
  }
});

test("larger price box wins over a smaller offer amount", () => {
  const parsed = parseVisionResponse({
    responses: [{
      fullTextAnnotation: { text: "潘婷\n$49.9\n買2件$88" },
      textAnnotations: [
        { description: "潘婷\n$49.9\n買2件$88" },
        { description: "潘婷", boundingPoly: { vertices: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 0, y: 20 }] } },
        { description: "$49.9", boundingPoly: { vertices: [{ x: 0, y: 30 }, { x: 200, y: 30 }, { x: 200, y: 120 }, { x: 0, y: 120 }] } },
        { description: "$88", boundingPoly: { vertices: [{ x: 0, y: 130 }, { x: 30, y: 130 }, { x: 30, y: 150 }, { x: 0, y: 150 }] } },
      ],
    }],
  });
  assert.equal(parsed.price, "49.9");
  assert.equal(parsed.productName, "潘婷");
});

test("rejects year-like bare numbers and keeps a decimal price", () => {
  assert.equal(priceToken("2026"), null);
  assert.equal(priceToken("49.9"), 49.9);
  assert.equal(priceToken("$238"), 238);
});

test("does not return raw text", () => {
  const parsed = parseVisionResponse({
    responses: [{ fullTextAnnotation: { text: "會員 12345678\n紫花油\n$49.9" } }],
  });
  assert.equal(parsed.price, "49.9");
  assert.equal(Object.hasOwn(parsed, "text"), false);
  assert.ok(!parsed.productName.includes("12345678"));
});

test("decode checks magic bytes and size input", () => {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const b64 = Buffer.from(bytes).toString("base64");
  const ok = decodeImageBase64(b64, "image/jpeg");
  assert.equal(ok.mime, "image/jpeg");
  assert.equal(decodeImageBase64(b64, "image/png").error, "unsupported_type");
  assert.equal(decodeImageBase64("not base64!!!").error, "bad_request");
});
