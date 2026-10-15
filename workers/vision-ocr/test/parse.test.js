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

function box(x, y, w, h) {
  return {
    vertices: [
      { x: x, y: y },
      { x: x + w, y: y },
      { x: x + w, y: y + h },
      { x: x, y: y + h },
    ],
  };
}

test("keeps a pack count in the name next to the price", () => {
  const boxed = parseVisionResponse({
    responses: [{
      fullTextAnnotation: { text: "余仁生烏髮生膠囊\n60\n粒\n$128" },
      textAnnotations: [
        { description: "余仁生烏髮生膠囊\n60\n粒\n$128" },
        { description: "余仁生烏髮生膠囊", boundingPoly: box(10, 700, 240, 36) },
        { description: "60", boundingPoly: box(254, 700, 36, 36) },
        { description: "粒", boundingPoly: box(294, 700, 32, 36) },
        { description: "$128", boundingPoly: box(10, 748, 180, 72) },
      ],
    }],
  });
  assert.equal(boxed.productName, "余仁生烏髮生膠囊60粒");
  assert.equal(boxed.packSize, "60粒");
  assert.equal(boxed.price, "128");
  assert.equal(boxed.offer, "");

  const spaced = parseVisionResponse({
    responses: [{ fullTextAnnotation: { text: "余仁生烏髮生膠囊 60 粒\n$128" } }],
  });
  assert.equal(spaced.productName, "余仁生烏髮生膠囊60粒");
  assert.equal(spaced.packSize, "60粒");
  assert.equal(spaced.price, "128");

  const sizes = [
    ["可樂500ml\n$8.5", "可樂500ml", "8.5", "500ml"],
    ["果汁 1.25L\n$12", "果汁1.25L", "12", "1.25L"],
    ["威化餅x8\n$15.5", "威化餅x8", "15.5", "x8"],
    ["8包裝曲奇\n$20", "8包裝曲奇", "20", "8包裝"],
  ];
  for (const row of sizes) {
    const parsed = parseVisionResponse({
      responses: [{ fullTextAnnotation: { text: row[0] } }],
    });
    assert.equal(parsed.productName, row[1], row[0]);
    assert.equal(parsed.price, row[2], row[0]);
    assert.equal(parsed.packSize, row[3], row[0]);
  }
});

test("short name next to the price beats packaging on the same photo", () => {
  const packaging = "全新升級營養配方香濃麥芽飲品全家共享限時優惠";
  const text = "好立克\n$45.9\n" + packaging;
  const parsed = parseVisionResponse({
    responses: [{
      fullTextAnnotation: { text: text },
      textAnnotations: [
        { description: text },
        { description: "好", boundingPoly: box(12, 700, 36, 40) },
        { description: "立", boundingPoly: box(50, 700, 36, 40) },
        { description: "克", boundingPoly: box(88, 700, 36, 40) },
        { description: "$45.9", boundingPoly: box(12, 748, 140, 64) },
        { description: packaging, boundingPoly: box(0, 20, 420, 48) },
      ],
    }],
  });
  assert.equal(parsed.price, "45.9");
  assert.equal(parsed.productName, "好立克");
  assert.equal(parsed.offer, "");
});

test("short name on the line beside the price beats a longer packaging line", () => {
  const parsed = parseVisionResponse({
    responses: [{
      fullTextAnnotation: {
        text: "全新升級營養配方香濃麥芽飲品全家共享限時優惠\n\n\n好立克\n$45.9",
      },
    }],
  });
  assert.equal(parsed.price, "45.9");
  assert.equal(parsed.productName, "好立克");
});

test("a longer name next to the price beats closer short text and farther packaging", () => {
  const packaging = "全新升級營養配方香濃麥芽飲品全家共享限時優惠";
  const longer = "維他檸檬茶低糖裝";
  const text = packaging + "\n\n\n" + longer + "\n好立克\n$45.9";
  const parsed = parseVisionResponse({
    responses: [{
      fullTextAnnotation: { text: text },
      textAnnotations: [
        { description: text },
        { description: packaging, boundingPoly: box(0, 10, 460, 40) },
        { description: longer, boundingPoly: box(12, 620, 280, 40) },
        { description: "好立克", boundingPoly: box(12, 700, 110, 40) },
        { description: "$45.9", boundingPoly: box(12, 748, 140, 64) },
      ],
    }],
  });
  assert.equal(parsed.price, "45.9");
  assert.equal(parsed.productName, longer);
  assert.equal(parsed.offer, "");
});

test("two nearby lines use the one with more Chinese characters", () => {
  const parsed = parseVisionResponse({
    responses: [{
      fullTextAnnotation: {
        text: "全新升級營養配方香濃麥芽飲品全家共享限時優惠\n\n\n維他檸檬茶低糖裝\n好立克\n$45.9",
      },
    }],
  });
  assert.equal(parsed.price, "45.9");
  assert.equal(parsed.productName, "維他檸檬茶低糖裝");
});

test("whole-image longest name is used only when nothing usable is near the price", () => {
  const parsed = parseVisionResponse({
    responses: [{
      fullTextAnnotation: { text: "維他檸檬茶低糖裝\n\n\n\n$12.5" },
    }],
  });
  assert.equal(parsed.price, "12.5");
  assert.equal(parsed.productName, "維他檸檬茶低糖裝");
});

test("a 價 label anchors the name when the tag has no dollar amount", () => {
  const packaging = "全新升級營養配方香濃麥芽飲品全家共享限時優惠";
  const text = "好立克\n特價\n" + packaging;
  const parsed = parseVisionResponse({
    responses: [{
      fullTextAnnotation: { text: text },
      textAnnotations: [
        { description: text },
        { description: "好立克", boundingPoly: box(10, 500, 120, 36) },
        { description: "特價", boundingPoly: box(10, 546, 80, 32) },
        { description: packaging, boundingPoly: box(0, 8, 460, 50) },
      ],
    }],
  });
  assert.equal(parsed.price, "");
  assert.equal(parsed.productName, "好立克");
});

test("price only still returns the price", () => {
  const rows = [
    {
      responses: [{
        fullTextAnnotation: { text: "$12.5" },
        textAnnotations: [
          { description: "$12.5" },
          { description: "$12.5", boundingPoly: box(8, 40, 120, 48) },
        ],
      }],
    },
    { responses: [{ fullTextAnnotation: { text: "特價\n$12.5" } }] },
  ];
  for (const payload of rows) {
    const parsed = parseVisionResponse(payload);
    assert.equal(parsed.price, "12.5");
    assert.equal(parsed.productName, "");
    assert.equal(parsed.offer, "");
  }
});

test("no price falls back to the longest Chinese line", () => {
  const parsed = parseVisionResponse({
    responses: [{ fullTextAnnotation: { text: "維他\n維他檸檬茶低糖裝" } }],
  });
  assert.equal(parsed.price, "");
  assert.equal(parsed.productName, "維他檸檬茶低糖裝");
  assert.equal(parsed.offer, "");
});

test("pack size is its own field and keeps the digits in the name", () => {
  const rows = [
    ["可樂 500 ml\n$8.5", "可樂500ml", "8.5", "500ml"],
    ["果汁 1.25 L\n$12", "果汁1.25L", "12", "1.25L"],
    ["維他命 60 粒\n$128", "維他命60粒", "128", "60粒"],
    ["曲奇8件\n$20", "曲奇8件", "20", "8件"],
    ["威化餅 x 8\n$15.5", "威化餅x8", "15.5", "x8"],
    ["餅乾×8\n$15", "餅乾×8", "15", "x8"],
    ["牛奶 1,25L\n$18", "牛奶1,25L", "18", "1.25L"],
    ["果汁1.25公升\n$12", "果汁1.25公升", "12", "1.25公升"],
    ["泰國香米2公斤\n$40", "泰國香米2公斤", "40", "2公斤"],
    ["砂糖100公克\n$5", "砂糖100公克", "5", "100公克"],
  ];
  for (const row of rows) {
    const parsed = parseVisionResponse({
      responses: [{ fullTextAnnotation: { text: row[0] } }],
    });
    assert.equal(parsed.productName, row[1], row[0]);
    assert.equal(parsed.price, row[2], row[0]);
    assert.equal(parsed.packSize, row[3], row[0]);
  }
});

test("a shelf price, a barcode, and an offer quantity are not pack size", () => {
  const rows = [
    ["$12.5", "", "12.5", ""],
    ["特價\n$12.5", "", "12.5", ""],
    ["可樂\n4891234567890\n$8.5", "可樂", "8.5", ""],
    ["潘婷乳液\n$49.9\n買2件$88", "潘婷乳液", "49.9", ""],
    ["紫花油\n$49.9\n第二件半價", "紫花油", "49.9", ""],
  ];
  for (const row of rows) {
    const parsed = parseVisionResponse({
      responses: [{ fullTextAnnotation: { text: row[0] } }],
    });
    assert.equal(parsed.productName, row[1], row[0]);
    assert.equal(parsed.price, row[2], row[0]);
    assert.equal(parsed.packSize, row[3], row[0]);
    if (row[0].indexOf("買2件") >= 0) assert.equal(parsed.offer, "買2件$88");
    if (row[0].indexOf("半價") >= 0) assert.equal(parsed.offer, "第二件半價");
  }
});

test("a pack size far from the price loses to a nearer one", () => {
  const text = "2L\n$12\n備註\n果汁 500ml";
  const parsed = parseVisionResponse({
    responses: [{
      fullTextAnnotation: { text: text },
      textAnnotations: [
        { description: text },
        { description: "2L", boundingPoly: box(0, 10, 70, 36) },
        { description: "$12", boundingPoly: box(12, 700, 140, 64) },
        { description: "果汁", boundingPoly: box(12, 640, 80, 36) },
        { description: "500ml", boundingPoly: box(100, 640, 110, 36) },
      ],
    }],
  });
  assert.equal(parsed.price, "12");
  assert.equal(parsed.productName, "果汁500ml");
  assert.equal(parsed.packSize, "500ml");
});

test("split count tokens next to the price become one pack size", () => {
  const parsed = parseVisionResponse({
    responses: [{ fullTextAnnotation: { text: "維他命\n60\n粒\n$88" } }],
  });
  assert.equal(parsed.productName, "維他命");
  assert.equal(parsed.packSize, "60粒");
  assert.equal(parsed.price, "88");
});

test("keeps embedded Latin letters in a shelf-tag product name", () => {
  const full = "羅拔臣芒果o者厘粉";
  const textOnly = parseVisionResponse({
    responses: [{ fullTextAnnotation: { text: full + "\n$9.9\n90g" } }],
  });
  assert.equal(textOnly.productName, full);
  assert.equal(textOnly.price, "9.9");
  assert.equal(textOnly.packSize, "90g");

  const spaced = parseVisionResponse({
    responses: [{ fullTextAnnotation: { text: "羅拔臣芒果 o 者厘粉\n$9.9\n90g" } }],
  });
  assert.equal(spaced.productName, full);
  assert.equal(spaced.price, "9.9");
  assert.equal(spaced.packSize, "90g");

  const text = full + "\n$9.9\n90g";
  const boxed = parseVisionResponse({
    responses: [{
      fullTextAnnotation: { text: text },
      textAnnotations: [
        { description: text },
        { description: "羅拔臣", boundingPoly: box(10, 700, 90, 36) },
        { description: "芒果", boundingPoly: box(100, 700, 60, 36) },
        { description: "o", boundingPoly: box(160, 708, 14, 24) },
        { description: "者厘粉", boundingPoly: box(174, 700, 90, 36) },
        { description: "$9.9", boundingPoly: box(280, 700, 80, 48) },
        { description: "90g", boundingPoly: box(10, 760, 50, 28) },
      ],
    }],
  });
  assert.equal(boxed.productName, full);
  assert.equal(boxed.price, "9.9");
  assert.equal(boxed.packSize, "90g");
  // 者厘粉 is closer to the price than 芒果; joining same-line fragments still keeps the full name.
  assert.ok(boxed.productName.includes("者厘粉"));
  assert.ok(boxed.productName.includes("羅拔臣"));
});

test("same-line brand left of the near-price hit still joins into the product name", () => {
  // Price far enough that 羅拔臣 sits outside isNearRect, while 芒果o者厘粉 stay inside.
  const full = "羅拔臣芒果o者厘粉";
  const text = full + "\n$9.9\n90g";
  const parsed = parseVisionResponse({
    responses: [{
      fullTextAnnotation: { text: text },
      textAnnotations: [
        { description: text },
        { description: "羅拔臣", boundingPoly: box(10, 700, 90, 36) },
        { description: "芒果", boundingPoly: box(100, 700, 60, 36) },
        { description: "o", boundingPoly: box(160, 708, 14, 24) },
        { description: "者厘粉", boundingPoly: box(174, 700, 90, 36) },
        { description: "$9.9", boundingPoly: box(400, 690, 90, 56) },
        { description: "90g", boundingPoly: box(400, 760, 50, 28) },
      ],
    }],
  });
  assert.equal(parsed.productName, full);
  assert.equal(parsed.price, "9.9");
  assert.equal(parsed.packSize, "90g");
});

test("decode checks magic bytes and size input", () => {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const b64 = Buffer.from(bytes).toString("base64");
  const ok = decodeImageBase64(b64, "image/jpeg");
  assert.equal(ok.mime, "image/jpeg");
  assert.equal(decodeImageBase64(b64, "image/png").error, "unsupported_type");
  assert.equal(decodeImageBase64("not base64!!!").error, "bad_request");
});
