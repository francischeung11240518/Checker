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
    assert.equal(parsed.offer, "買2件$88");
});

test("keeps a product name that shares a line with the offer", () => {
  const parsed = parseVisionResponse({
    responses: [{ fullTextAnnotation: { text: "潘婷乳液 買2件$88\n$49.9" } }],
  });
  assert.equal(parsed.productName, "潘婷乳液");
  assert.equal(parsed.price, "49.9");
  assert.equal(parsed.offer, "買2件$88");
});

test("collapses spaces between Chinese characters", () => {
  const parsed = parseVisionResponse({
    responses: [{ fullTextAnnotation: { text: "潘 婷\n$49.9\n" } }],
  });
  assert.equal(parsed.productName, "潘婷");
  assert.equal(parsed.price, "49.9");
  assert.equal(parsed.offer, "");
});

test("offer lines are not product names, including 半價 and percent off", () => {
  const rows = [
    ["潘 婷 乳液\n$49.9\n第二件半價", "潘婷乳液", "49.9", "第二件半價"],
    ["紫花油\n$49.9\n買2件半價", "紫花油", "49.9", "買2件半價"],
    ["可樂\n$10.5\n50% off", "可樂", "10.5", "50% off"],
    ["可樂\n$12\n減 $2", "可樂", "12", "減 $2"],
    ["可樂\n$10\n2 for $18", "可樂", "10", "2 for $18"],
    ["保心安\n$53.5\n買2送1", "保心安", "53.5", "買2送1"],
  ];
  for (const row of rows) {
    const parsed = parseVisionResponse({
      responses: [{ fullTextAnnotation: { text: row[0] } }],
    });
    assert.equal(parsed.productName, row[1], row[0]);
    assert.equal(parsed.price, row[2], row[0]);
    assert.equal(parsed.offer, row[3], row[0]);
  }
});

test("a long offer line does not replace a shorter product name", () => {
  const parsed = parseVisionResponse({
    responses: [{ fullTextAnnotation: { text: "潘婷\n$49.9\n買2件$88即日新鮮優惠大特價" } }],
  });
  assert.equal(parsed.productName, "潘婷");
  assert.equal(parsed.price, "49.9");
  assert.match(parsed.offer, /^買2件\$88/);
});

test("a larger offer price box does not replace the shelf price", () => {
  const parsed = parseVisionResponse({
    responses: [{
      fullTextAnnotation: { text: "潘婷\n$49.9\n買2件$88" },
      textAnnotations: [
        { description: "潘婷\n$49.9\n買2件$88" },
        { description: "$49.9", boundingPoly: { vertices: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }] } },
        { description: "$88", boundingPoly: { vertices: [{ x: 0, y: 40 }, { x: 200, y: 40 }, { x: 200, y: 160 }, { x: 0, y: 160 }] } },
      ],
    }],
  });
  assert.equal(parsed.price, "49.9");
  assert.equal(parsed.offer, "買2件$88");
  assert.equal(parsed.productName, "潘婷");
});

test("document text symbols keep a Chinese name and the offer", () => {
  const parsed = parseVisionResponse({
    responses: [{
      fullTextAnnotation: {
        text: "潘 婷\n$49.9\n買2件$88",
        pages: [{
          blocks: [{
            paragraphs: [{
              words: [
                {
                  symbols: [
                    { text: "潘" },
                    { text: "婷", property: { detectedBreak: { type: "LINE_BREAK" } } },
                  ],
                  boundingBox: { vertices: [{ x: 0, y: 80 }, { x: 80, y: 80 }, { x: 80, y: 110 }, { x: 0, y: 110 }] },
                },
                {
                  symbols: [
                    { text: "$" },
                    { text: "4" },
                    { text: "9" },
                    { text: "." },
                    { text: "9", property: { detectedBreak: { type: "LINE_BREAK" } } },
                  ],
                  boundingBox: { vertices: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 70 }, { x: 0, y: 70 }] },
                },
                {
                  symbols: [
                    { text: "買" },
                    { text: "2" },
                    { text: "件" },
                    { text: "$" },
                    { text: "8" },
                    { text: "8", property: { detectedBreak: { type: "LINE_BREAK" } } },
                  ],
                  boundingBox: { vertices: [{ x: 0, y: 120 }, { x: 40, y: 120 }, { x: 40, y: 140 }, { x: 0, y: 140 }] },
                },
              ],
            }],
          }],
        }],
      },
    }],
  });
  assert.equal(parsed.productName, "潘婷");
  assert.equal(parsed.price, "49.9");
  assert.equal(parsed.offer, "買2件$88");
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
