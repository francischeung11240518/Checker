/** Best-effort price-tag parse. Returns name, price, offer, and pack size — never the image. */

/** Same offer coverage as report-shared.js parseOcr, including 半價 and % off. */
const OFFER_RE = /買\s*第?\s*\d+\s*件\s*半\s*價|第\s*[二2]\s*件\s*半\s*價|買\s*\d+\s*件[^\n]{0,18}|買\s*\d+\s*送\s*\d+|第\s*[二2]\s*件[^\n]{0,12}|\d{1,2}\s*%\s*off|\d+\s*for\s*\$?\s*\d+(?:[.,]\d{1,2})?|減\s*\$?\s*\d+(?:[.,]\d{1,2})?/i;

export function collapseCjkSpaces(s) {
  return String(s || "")
    .replace(/([\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, "$1")
    .replace(/(\d)[ \t]+(?=[\u4e00-\u9fff])/g, "$1");
}

function cjkCount(s) {
  return (String(s || "").match(/[\u4e00-\u9fff]/g) || []).length;
}

export function normPrice(raw) {
  const n = parseFloat(String(raw).replace(",", "."));
  if (!Number.isFinite(n) || n <= 0 || n >= 10000) return null;
  return Math.round(n * 100) / 100;
}

export function formatPrice(n) {
  if (n == null) return "";
  return n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function cleanName(value) {
  return collapseCjkSpaces(String(value || ""))
    .replace(/\d{6,}/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

export function offerFromText(text) {
  const raw = collapseCjkSpaces(String(text || ""));
  const match = OFFER_RE.exec(raw);
  if (!match) return "";
  return match[0].replace(/\s+/g, " ").trim().slice(0, 40);
}

/** True when this price token is the amount printed inside the offer phrase. */
function priceSitsInOffer(offerText, desc) {
  if (!offerText) return false;
  const compactOffer = offerText.replace(/\s+/g, "");
  const compactDesc = String(desc || "").replace(/\s+/g, "");
  if (!compactDesc) return false;
  let from = 0;
  while (from < compactOffer.length) {
    const at = compactOffer.indexOf(compactDesc, from);
    if (at < 0) return false;
    const prev = at > 0 ? compactOffer.charAt(at - 1) : "";
    const next = compactOffer.charAt(at + compactDesc.length);
    const glued = (/\d/.test(compactDesc.charAt(0)) && /\d/.test(prev))
      || (/\d/.test(compactDesc.charAt(compactDesc.length - 1)) && /\d/.test(next));
    if (!glued) return true;
    from = at + 1;
  }
  return false;
}

function boxArea(poly) {
  const vertices = poly && poly.vertices;
  if (!vertices || vertices.length < 2) return 0;
  const xs = vertices.map(function (p) { return Number(p && p.x) || 0; });
  const ys = vertices.map(function (p) { return Number(p && p.y) || 0; });
  const w = Math.max.apply(null, xs) - Math.min.apply(null, xs);
  const h = Math.max.apply(null, ys) - Math.min.apply(null, ys);
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

/** A whole token that looks like an HK shelf price, not a barcode or year. */
export function priceToken(text) {
  const t = String(text || "").trim();
  const m = t.match(/^(?:HKD|HK\$|＄|\$)?\s*(\d{1,4}(?:[.,]\d{1,2})?)$/i);
  if (!m) return null;
  const digits = m[1].replace(/[.,].*/, "");
  const marked = /[$＄]|HK/i.test(t) || /[.,]\d/.test(t);
  if (!marked && digits.length >= 4) return null;
  return normPrice(m[1]);
}

function lineIndexAt(raw, index) {
  let line = 0;
  const end = Math.min(Math.max(index, 0), raw.length);
  for (let i = 0; i < end; i++) {
    if (raw.charAt(i) === "\n") line += 1;
  }
  return line;
}

function pricesInText(text) {
  const raw = collapseCjkSpaces(String(text || ""));
  const offer = OFFER_RE.exec(raw);
  const found = [];
  const re = /(?:HKD|HK\$|＄|\$)\s*(\d{1,4}(?:[.,]\d{1,2})?)/gi;
  let match;
  while ((match = re.exec(raw))) {
    const n = normPrice(match[1]);
    if (n == null) continue;
    const inside = !!(offer && match.index >= offer.index && match.index < offer.index + offer[0].length);
    found.push({
      n: n,
      inside: inside,
      decimal: /[.,]\d/.test(match[0]),
      currency: true,
      area: 0,
      lineIndex: lineIndexAt(raw, match.index),
    });
  }
  const lines = raw.split(/\n/);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const token = priceToken(lines[i].trim());
    if (token != null) {
      const inside = !!(offer && offset >= offer.index && offset < offer.index + offer[0].length);
      found.push({
        n: token,
        inside: inside,
        decimal: /[.,]\d/.test(lines[i]),
        currency: /[$＄]|HK/i.test(lines[i]),
        area: 0,
        lineIndex: i,
      });
    }
    offset += lines[i].length + 1;
  }
  return found;
}

function pickPrice(cands) {
  const outside = cands.filter(function (c) { return !c.inside; });
  const pool = outside.length ? outside.slice() : cands.slice();
  if (!pool.length) return null;
  pool.sort(function (a, b) {
    if ((a.area > 0 || b.area > 0) && b.area !== a.area) {
      if (b.area > a.area * 1.25) return 1;
      if (a.area > b.area * 1.25) return -1;
    }
    if (a.currency !== b.currency) return a.currency ? -1 : 1;
    if (a.decimal !== b.decimal) return a.decimal ? -1 : 1;
    return 0;
  });
  return pool[0];
}

const SIZE_UNIT = "ml|mL|ML|kg|KG|g|L|l|毫升|公升|公斤|公克|克|升|粒|片|包|支|罐|盒|件|裝";

/** CJK name, optional embedded Latin letters (芒果o者厘粉), plus a short pack/size. Not a barcode or $price. */
function productSpan(core) {
  const unit = "(?:" + SIZE_UNIT + ")";
  const re = new RegExp(
    "\\d{0,4}\\s*[\\u4e00-\\u9fff](?:" +
      "[\\u4e00-\\u9fff]" +
      "|[A-Za-z]" +
      "|\\s+(?=[\\u4e00-\\u9fffA-Za-z\\d])" +
      "|\\d{1,4}[.,]\\d{1,3}\\s*" + unit +
      "|\\d{1,4}(?![.,]\\d)\\s*" + unit + "?" +
      "|[xX×]\\s*\\d{1,4}" +
      "|\\s+\\d{1,4}[.,]\\d{1,3}\\s*" + unit +
      "|\\s+\\d{1,4}(?![.,]\\d)\\s*" + unit + "?" +
      "|\\s+[xX×]\\s*\\d{1,4}" +
    ")*"
  );
  const match = String(core || "").match(re);
  return match ? match[0] : "";
}

function cleanCore(line) {
  let core = String(line || "");
  core = core.replace(/(?:HKD|HK\$|＄|\$)\s*\d{1,4}(?:[.,]\d{1,2})?/gi, " ");
  core = core.replace(/\d{5,}/g, " ").replace(/[|｜]/g, " ");
  core = core.replace(/\s+/g, " ").trim();
  if (!core || priceToken(core) != null) return "";
  if (cjkCount(core) < 2) return "";
  const hit = productSpan(core);
  const picked = hit && cjkCount(hit) >= 2 ? hit : core;
  return collapseCjkSpaces(picked).replace(/[ \t]+/g, "");
}

/** Currency amounts and the chosen price word are not pack counts. Bare 60 / 500 stay. */
function isShelfPriceWord(desc, priceCand) {
  const t = String(desc || "").trim();
  if (!t || priceToken(t) == null) return false;
  if (/[$＄]|HK/i.test(t)) return true;
  const chosen = priceCand && String(priceCand.description || "").trim();
  return !!chosen && chosen === t;
}

/** Offer lines are not product names. A name printed before the offer on the same line is kept. */
function nameFromLine(line) {
  const match = OFFER_RE.exec(line);
  if (!match) return cleanCore(line);
  const before = line.slice(0, match.index).trim();
  if (cjkCount(before) >= 2) return cleanCore(before);
  return "";
}

const PRICE_LABELS = {
  "價": true,
  "售價": true,
  "特價": true,
  "正價": true,
  "原價": true,
  "現價": true,
  "價錢": true,
  "價格": true,
  "會員價": true,
  "優惠價": true,
  "零售價": true,
  "促銷價": true,
  "超值價": true,
};

function normalizeLabel(text) {
  return collapseCjkSpaces(String(text || ""))
    .replace(/\s+/g, "")
    .replace(/[：:．。]/g, "")
    .replace(/\.(?!\d)/g, "");
}

/** 售價 / 特價 / 價 are shelf labels, not the product. */
function isPriceLabel(text) {
  const t = normalizeLabel(text);
  return !!t && !!PRICE_LABELS[t];
}

/** Drop a leading or trailing price label when a real name remains. */
function withoutPriceLabel(name) {
  let t = normalizeLabel(name);
  if (!t || isPriceLabel(t)) return "";
  const keys = Object.keys(PRICE_LABELS).filter(function (key) { return key.length >= 2; });
  keys.sort(function (a, b) { return b.length - a.length; });
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      let next = "";
      if (t.indexOf(key) === 0) next = t.slice(key.length);
      else if (t.length > key.length && t.lastIndexOf(key) === t.length - key.length) next = t.slice(0, t.length - key.length);
      if (next && cjkCount(next) >= 2) {
        t = next;
        changed = true;
        break;
      }
    }
  }
  return t;
}

function usableName(line) {
  const name = withoutPriceLabel(nameFromLine(line));
  if (!name || isPriceLabel(name) || cjkCount(name) < 2) return "";
  return name;
}

function rectFromPoly(poly) {
  const vertices = poly && poly.vertices;
  if (!vertices || vertices.length < 2) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < vertices.length; i++) {
    const x = Number(vertices[i] && vertices[i].x) || 0;
    const y = Number(vertices[i] && vertices[i].y) || 0;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  if (!(x1 > x0) || !(y1 > y0)) return null;
  return { x0: x0, y0: y0, x1: x1, y1: y1, w: x1 - x0, h: y1 - y0 };
}

function gapBetween(a, b) {
  const gapX = a.x1 <= b.x0 ? b.x0 - a.x1 : b.x1 <= a.x0 ? a.x0 - b.x1 : 0;
  const gapY = a.y1 <= b.y0 ? b.y0 - a.y1 : b.y1 <= a.y0 ? a.y0 - b.y1 : 0;
  return { gapX: gapX, gapY: gapY };
}

/** Neighbourhood around a price or 價 label, in that box's own height and width. */
function isNearRect(anchor, rect) {
  const g = gapBetween(anchor, rect);
  const h = Math.max(anchor.h, 8);
  const span = Math.max(anchor.w, h);
  return g.gapX <= span * 3 && g.gapY <= h * 3;
}

function rectDistance(anchor, rect) {
  const g = gapBetween(anchor, rect);
  return Math.hypot(g.gapX, g.gapY);
}

function sameLine(a, b) {
  const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  const minH = Math.min(a.h, b.h);
  if (minH > 0 && overlap >= minH * 0.45) return true;
  const ay = (a.y0 + a.y1) / 2;
  const by = (b.y0 + b.y1) / 2;
  return Math.abs(ay - by) <= Math.max(a.h, b.h) * 0.45;
}

function joinWordText(parts) {
  let s = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!s) {
      s = part;
      continue;
    }
    const prev = s.charAt(s.length - 1);
    const next = part.charAt(0);
    const prevName = /[\u4e00-\u9fffA-Za-z]/.test(prev);
    const nextName = /[\u4e00-\u9fffA-Za-z]/.test(next);
    if (prevName && nextName) s += part;
    else s += " " + part;
  }
  return s;
}

/** Lines this close to the price or a 價 label count as the nearby region. */
const NEAR_LINE_DIST = 2;

/** Inside the nearby region, the most Chinese characters win. Distance only breaks a tie. */
function preferMostCjk(cjk, dist, bestCjk, bestDist) {
  if (cjk > bestCjk) return true;
  if (cjk < bestCjk) return false;
  return dist < bestDist;
}

function boxAnchors(words, priceCand) {
  const anchors = [];
  const priceRect = priceCand && rectFromPoly(priceCand.poly);
  if (priceRect) anchors.push(priceRect);
  const labels = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!isPriceLabel(word && word.description)) continue;
    const rect = rectFromPoly(word.boundingPoly);
    if (rect) labels.push(rect);
  }
  if (priceRect) {
    for (let i = 0; i < labels.length; i++) {
      if (isNearRect(priceRect, labels[i])) anchors.push(labels[i]);
    }
  } else if (!priceCand || priceCand.n == null) {
    for (let i = 0; i < labels.length; i++) anchors.push(labels[i]);
  }
  return anchors;
}

/** Among word boxes next to the chosen price or a nearby 價 label, the most Chinese characters win. */
function productNameNearBoxes(words, priceCand) {
  if (!words || !words.length) return "";
  const anchors = boxAnchors(words, priceCand);
  if (!anchors.length) return "";
  const items = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const desc = String(word && word.description || "").trim();
    if (!desc || isShelfPriceWord(desc, priceCand) || isPriceLabel(desc)) continue;
    const rect = rectFromPoly(word && word.boundingPoly);
    if (!rect) continue;
    let dist = Infinity;
    for (let a = 0; a < anchors.length; a++) {
      if (!isNearRect(anchors[a], rect)) continue;
      const d = rectDistance(anchors[a], rect);
      if (d < dist) dist = d;
    }
    if (dist === Infinity) continue;
    items.push({ desc: desc, rect: rect, dist: dist });
  }
  if (!items.length) return "";
  items.sort(function (a, b) {
    if (a.rect.y0 !== b.rect.y0) return a.rect.y0 - b.rect.y0;
    return a.rect.x0 - b.rect.x0;
  });
  const lines = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let line = null;
    for (let j = 0; j < lines.length; j++) {
      if (sameLine(lines[j].seed, item.rect)) {
        line = lines[j];
        break;
      }
    }
    if (!line) lines.push({ seed: item.rect, items: [item], dist: item.dist });
    else {
      line.items.push(item);
      if (item.dist < line.dist) line.dist = item.dist;
    }
  }
  let best = "";
  let bestDist = Infinity;
  let bestCjk = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    line.items.sort(function (a, b) { return a.rect.x0 - b.rect.x0; });
    const parts = [];
    for (let j = 0; j < line.items.length; j++) parts.push(line.items[j].desc);
    const name = usableName(joinWordText(parts));
    const cjk = cjkCount(name);
    if (!name || !preferMostCjk(cjk, line.dist, bestCjk, bestDist)) continue;
    bestDist = line.dist;
    bestCjk = cjk;
    best = name;
  }
  return cleanName(best);
}

function lineHasChosenPrice(line, price) {
  if (price == null) return false;
  const trimmed = String(line || "").trim();
  if (priceToken(trimmed) === price) return true;
  const re = /(?:HKD|HK\$|＄|\$)\s*(\d{1,4}(?:[.,]\d{1,2})?)/gi;
  let match;
  while ((match = re.exec(trimmed))) {
    if (normPrice(match[1]) === price) return true;
  }
  return false;
}

function textAnchorIndexes(lines, priceCand) {
  const indexes = [];
  if (priceCand && priceCand.n != null) {
    if (priceCand.lineIndex != null && priceCand.lineIndex >= 0 && priceCand.lineIndex < lines.length) {
      indexes.push(priceCand.lineIndex);
      return indexes;
    }
    for (let i = 0; i < lines.length; i++) {
      if (lineHasChosenPrice(lines[i], priceCand.n)) indexes.push(i);
    }
    if (indexes.length) return indexes;
  }
  for (let i = 0; i < lines.length; i++) {
    if (isPriceLabel(lines[i])) indexes.push(i);
  }
  return indexes;
}

/** No boxes: among lines next to the price or a 價 label, the most Chinese characters win. */
function productNameNearLines(text, priceCand) {
  const raw = collapseCjkSpaces(String(text || ""));
  const lines = raw.split(/\n/);
  const anchors = textAnchorIndexes(lines, priceCand);
  if (!anchors.length) return "";
  let best = "";
  let bestDist = Infinity;
  let bestCjk = -1;
  for (let i = 0; i < lines.length; i++) {
    const name = usableName(lines[i]);
    const cjk = cjkCount(name);
    if (!name) continue;
    let dist = Infinity;
    for (let a = 0; a < anchors.length; a++) {
      const d = Math.abs(i - anchors[a]);
      if (d < dist) dist = d;
    }
    if (dist > NEAR_LINE_DIST) continue;
    if (!preferMostCjk(cjk, dist, bestCjk, bestDist)) continue;
    bestDist = dist;
    bestCjk = cjk;
    best = name;
  }
  return cleanName(best);
}

/**
 * Whole-pack photos: branding is the longest Chinese line, the shelf name sits by the price.
 * Inside the region next to the price or a 價 label, the most Chinese characters win.
 * The old whole-image guess runs only when that region has no usable name.
 */
function chooseProductName(text, words, priceCand) {
  const nearBox = productNameNearBoxes(words, priceCand);
  if (nearBox) return nearBox;
  const nearLine = productNameNearLines(text, priceCand);
  if (nearLine) return nearLine;
  return productNameFromText(text);
}

function productNameFromText(text) {
  const raw = collapseCjkSpaces(String(text || ""));
  const lines = raw.split(/\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  let best = "";
  let score = 0;
  for (let i = 0; i < lines.length; i++) {
    const candidate = usableName(lines[i]);
    const cjk = cjkCount(candidate);
    if (cjk >= 2 && cjk > score) {
      score = cjk;
      best = candidate;
    }
  }
  if (score < 2) {
    const latin = raw.match(/[A-Z][A-Z0-9]{2,}(?:\s+[A-Z][A-Z0-9]{2,}){1,4}/);
    if (latin) best = latin[0];
  }
  return cleanName(best);
}

function symbolBreak(symbol) {
  const type = symbol && symbol.property && symbol.property.detectedBreak && symbol.property.detectedBreak.type;
  if (type === "LINE_BREAK" || type === "EOL_SURE_SPACE") return "\n";
  if (type === "SPACE" || type === "SURE_SPACE") return " ";
  if (type === "HYPHEN") return "-";
  return "";
}

/** DOCUMENT_TEXT_DETECTION pages keep real breaks, so Chinese is not split by a space per character. */
function textFromAnnotation(annotation) {
  if (!annotation) return "";
  const pages = annotation.pages;
  if (!Array.isArray(pages) || !pages.length) return annotation.text || "";
  let out = "";
  let symbols = 0;
  for (let p = 0; p < pages.length; p++) {
    const blocks = pages[p].blocks || [];
    for (let b = 0; b < blocks.length; b++) {
      const paragraphs = blocks[b].paragraphs || [];
      for (let i = 0; i < paragraphs.length; i++) {
        const words = paragraphs[i].words || [];
        for (let w = 0; w < words.length; w++) {
          const syms = words[w].symbols || [];
          for (let s = 0; s < syms.length; s++) {
            out += syms[s].text || "";
            out += symbolBreak(syms[s]);
            if (syms[s].text) symbols += 1;
          }
        }
      }
    }
  }
  if (!symbols || !out.trim()) return annotation.text || "";
  return out;
}

function wordsFromAnnotation(annotation) {
  const words = [];
  const pages = annotation && annotation.pages;
  if (!Array.isArray(pages)) return words;
  for (let p = 0; p < pages.length; p++) {
    const blocks = pages[p].blocks || [];
    for (let b = 0; b < blocks.length; b++) {
      const paragraphs = blocks[b].paragraphs || [];
      for (let i = 0; i < paragraphs.length; i++) {
        const list = paragraphs[i].words || [];
        for (let w = 0; w < list.length; w++) {
          const syms = list[w].symbols || [];
          let description = "";
          for (let s = 0; s < syms.length; s++) description += syms[s].text || "";
          if (!description) continue;
          words.push({
            description: description,
            boundingPoly: list[w].boundingBox || list[w].boundingPoly,
          });
        }
      }
    }
  }
  return words;
}

const PACK_UNIT_SRC = "包裝|毫升|公升|公斤|公克|ml|mL|ML|Ml|kg|KG|Kg|kG|g|G|克|升|粒|片|包|支|罐|盒|件|裝|L|l";

function canonPackUnit(unit) {
  const raw = String(unit || "");
  const fixed = {
    "毫升": "毫升",
    "公升": "公升",
    "公斤": "公斤",
    "公克": "公克",
    "包裝": "包裝",
    "克": "克",
    "升": "升",
    "粒": "粒",
    "片": "片",
    "包": "包",
    "支": "支",
    "罐": "罐",
    "盒": "盒",
    "件": "件",
    "裝": "裝",
  };
  if (fixed[raw]) return fixed[raw];
  const lower = raw.toLowerCase();
  if (lower === "ml") return "ml";
  if (lower === "kg") return "kg";
  if (lower === "g") return "g";
  if (lower === "l") return "L";
  return "";
}

function formatPackNumber(raw) {
  const n = parseFloat(String(raw || "").replace(",", "."));
  if (!Number.isFinite(n) || n <= 0 || n >= 10000) return "";
  const rounded = Math.round(n * 1000) / 1000;
  if (!(rounded > 0)) return "";
  return rounded.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function currencyBefore(text, index) {
  const prev = text.slice(Math.max(0, index - 6), index);
  return /(?:HKD|HK\$|＄|\$)\s*$/i.test(prev);
}

function offerOverlap(text) {
  const match = new RegExp(OFFER_RE.source, "i").exec(String(text || ""));
  if (!match) return null;
  return { start: match.index, end: match.index + match[0].length };
}

function overlapsSpan(span, start, end) {
  if (!span) return false;
  return start < span.end && end > span.start;
}

/** 500ml, 1.25L, 60粒, 8件, 8包裝, x8. A shelf $ price or a long barcode is not a pack size. */
function packSizesInText(text) {
  const raw = String(text || "");
  const span = offerOverlap(raw);
  const found = [];
  const unitRe = new RegExp(
    "(^|[^0-9])(\\d{1,4}(?:[.,]\\d{1,3})?)\\s*(" + PACK_UNIT_SRC + ")(?![A-Za-z])",
    "g"
  );
  let match;
  while ((match = unitRe.exec(raw))) {
    const numStart = match.index + match[1].length;
    const end = match.index + match[0].length;
    if (overlapsSpan(span, numStart, end) || currencyBefore(raw, numStart)) continue;
    const unit = canonPackUnit(match[3]);
    const num = formatPackNumber(match[2]);
    if (!num || !unit) continue;
    found.push({ display: num + unit, index: numStart });
  }
  const countRe = /(^|[^A-Za-z0-9])([xX×])\s*(\d{1,4})(?!\d)/g;
  while ((match = countRe.exec(raw))) {
    const numStart = match.index + match[1].length;
    const end = match.index + match[0].length;
    if (overlapsSpan(span, numStart, end)) continue;
    const num = formatPackNumber(match[3]);
    if (!num) continue;
    found.push({ display: "x" + num, index: numStart });
  }
  found.sort(function (a, b) { return a.index - b.index; });
  return found;
}

function nameHasPack(productName, display) {
  const name = String(productName || "").replace(/\s+/g, "").toLowerCase();
  const token = String(display || "").replace(/\s+/g, "").toLowerCase();
  if (!name || !token) return false;
  return name.indexOf(token) !== -1;
}

function betterPack(candidate, best) {
  if (!best) return true;
  if (candidate.dist !== best.dist) return candidate.dist < best.dist;
  if (candidate.inName !== best.inName) return candidate.inName;
  return candidate.index < best.index;
}

function considerPackSizes(sizes, dist, productName, best) {
  let next = best;
  for (let i = 0; i < sizes.length; i++) {
    const cand = {
      display: sizes[i].display,
      dist: dist,
      index: sizes[i].index,
      inName: nameHasPack(productName, sizes[i].display),
    };
    if (betterPack(cand, next)) next = cand;
  }
  return next;
}

function embeddedPackSize(productName) {
  const sizes = packSizesInText(productName);
  return sizes.length ? sizes[0].display : "";
}

function barePackNumber(line) {
  return /^\d{1,4}(?:[.,]\d{1,3})?$/.test(String(line || "").trim());
}

function barePackUnit(line) {
  return new RegExp("^(?:" + PACK_UNIT_SRC + ")$").test(String(line || "").trim());
}

function bareCountMark(line) {
  return /^[xX×]$/.test(String(line || "").trim());
}

function packSizeNearLines(text, priceCand, productName) {
  const raw = collapseCjkSpaces(String(text || ""));
  const lines = raw.split(/\n/);
  const anchors = textAnchorIndexes(lines, priceCand);
  if (!anchors.length) return "";
  const near = [];
  for (let i = 0; i < lines.length; i++) {
    let dist = Infinity;
    for (let a = 0; a < anchors.length; a++) {
      const d = Math.abs(i - anchors[a]);
      if (d < dist) dist = d;
    }
    if (dist <= NEAR_LINE_DIST) near.push({ i: i, dist: dist });
  }
  let best = null;
  for (let n = 0; n < near.length; n++) {
    const row = near[n];
    let chunk = lines[row.i];
    let dist = row.dist;
    const next = n + 1 < near.length ? near[n + 1] : null;
    if (next && next.i === row.i + 1) {
      const left = String(lines[row.i] || "").trim();
      const right = String(lines[next.i] || "").trim();
      if ((barePackNumber(left) && barePackUnit(right)) || (bareCountMark(left) && barePackNumber(right))) {
        chunk = left + right;
        dist = Math.min(dist, next.dist);
      }
    }
    best = considerPackSizes(packSizesInText(chunk), dist, productName, best);
  }
  return best ? best.display : "";
}

function packSizeNearBoxes(words, priceCand, anchors, productName) {
  if (!words || !words.length || !anchors.length) return "";
  const items = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const desc = String(word && word.description || "").trim();
    if (!desc || isShelfPriceWord(desc, priceCand) || isPriceLabel(desc)) continue;
    const rect = rectFromPoly(word && word.boundingPoly);
    if (!rect) continue;
    let dist = Infinity;
    for (let a = 0; a < anchors.length; a++) {
      if (!isNearRect(anchors[a], rect)) continue;
      const d = rectDistance(anchors[a], rect);
      if (d < dist) dist = d;
    }
    if (dist === Infinity) continue;
    items.push({ desc: desc, rect: rect, dist: dist });
  }
  if (!items.length) return "";
  items.sort(function (a, b) {
    if (a.rect.y0 !== b.rect.y0) return a.rect.y0 - b.rect.y0;
    return a.rect.x0 - b.rect.x0;
  });
  const lines = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let line = null;
    for (let j = 0; j < lines.length; j++) {
      if (sameLine(lines[j].seed, item.rect)) {
        line = lines[j];
        break;
      }
    }
    if (!line) lines.push({ seed: item.rect, items: [item], dist: item.dist });
    else {
      line.items.push(item);
      if (item.dist < line.dist) line.dist = item.dist;
    }
  }
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    line.items.sort(function (a, b) { return a.rect.x0 - b.rect.x0; });
    const parts = [];
    for (let j = 0; j < line.items.length; j++) parts.push(line.items[j].desc);
    best = considerPackSizes(packSizesInText(joinWordText(parts)), line.dist, productName, best);
  }
  return best ? best.display : "";
}

/**
 * Capacity or pack count in the same neighbourhood as the price and the chosen name.
 * A size already glued into productName is still copied here.
 * With word boxes, a size outside that neighbourhood loses to a nearer one.
 */
function choosePackSize(text, words, priceCand, productName) {
  const anchors = boxAnchors(words || [], priceCand);
  if (anchors.length) {
    const near = packSizeNearBoxes(words, priceCand, anchors, productName);
    if (near) return near;
    return embeddedPackSize(productName);
  }
  const nearLine = packSizeNearLines(text, priceCand, productName);
  if (nearLine) return nearLine;
  return embeddedPackSize(productName);
}

export function parseVisionResponse(payload) {
  const response = payload && Array.isArray(payload.responses) ? payload.responses[0] : null;
  if (!response || response.error) {
    return { ok: false, productName: "", price: "", offer: "", packSize: "" };
  }
  const annotation = response.fullTextAnnotation;
  const text = textFromAnnotation(annotation)
    || (response.textAnnotations && response.textAnnotations[0] && response.textAnnotations[0].description)
    || "";
  const offer = offerFromText(text);
  let words = Array.isArray(response.textAnnotations) ? response.textAnnotations.slice(1) : [];
  if (!words.length) words = wordsFromAnnotation(annotation);
  let cands = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const n = priceToken(word && word.description);
    if (n == null) continue;
    const desc = String(word.description || "");
    cands.push({
      n: n,
      inside: priceSitsInOffer(offer, desc),
      decimal: /[.,]\d/.test(desc),
      currency: /[$＄]|HK/i.test(desc),
      area: boxArea(word.boundingPoly),
      poly: word.boundingPoly || null,
      description: desc,
    });
  }
  if (!cands.length) cands = pricesInText(text);
  const picked = pickPrice(cands);
  const price = picked ? picked.n : null;
  const productName = chooseProductName(text, words, picked);
  return {
    ok: true,
    productName: productName,
    price: formatPrice(price),
    offer: offer,
    packSize: choosePackSize(text, words, picked, productName),
  };
}

export function sniffMime(bytes) {
  if (!bytes || bytes.length < 12) return "";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  return "";
}

export function bytesToBase64(bytes) {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(bytes.length, i + chunk));
    const arr = new Array(slice.length);
    for (let j = 0; j < slice.length; j++) arr[j] = slice[j];
    binary += String.fromCharCode.apply(null, arr);
  }
  return btoa(binary);
}

export function decodeImageBase64(input, declaredMime) {
  let raw = String(input || "").trim();
  let mime = String(declaredMime || "").toLowerCase();
  const dataUrl = raw.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
  if (dataUrl) {
    mime = dataUrl[1].toLowerCase();
    raw = dataUrl[2];
  }
  raw = raw.replace(/\s+/g, "");
  if (!raw) return { error: "bad_request" };
  let bytes;
  try {
    const binary = atob(raw);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch (e) {
    return { error: "bad_request" };
  }
  const sniffed = sniffMime(bytes);
  if (!sniffed) return { error: "unsupported_type" };
  if (mime && mime !== sniffed) return { error: "unsupported_type" };
  return { bytes: bytes, mime: sniffed, base64: bytesToBase64(bytes) };
}
