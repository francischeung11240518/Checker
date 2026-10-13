/** Best-effort price-tag parse. Returns name, price, and a short offer — never the image. */

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
  return pool[0].n;
}

function cleanCore(line) {
  let core = String(line || "");
  core = core.replace(/(?:HKD|HK\$|＄|\$)\s*\d{1,4}(?:[.,]\d{1,2})?/gi, " ");
  core = core.replace(/\d{5,}/g, " ").replace(/[|｜]/g, " ");
  core = core.replace(/\s+/g, " ").trim();
  if (!core || priceToken(core) != null) return "";
  if (cjkCount(core) < 2) return "";
  const hit = core.match(/(\d{0,3})?\s*([\u4e00-\u9fff][\u4e00-\u9fff0-9]{1,})/);
  const picked = hit && cjkCount((hit[1] || "") + hit[2]) >= 2 ? (hit[1] || "") + hit[2] : core;
  return collapseCjkSpaces(picked).replace(/[ \t]+/g, "");
}

/** Offer lines are not product names. A name printed before the offer on the same line is kept. */
function nameFromLine(line) {
  const match = OFFER_RE.exec(line);
  if (!match) return cleanCore(line);
  const before = line.slice(0, match.index).trim();
  if (cjkCount(before) >= 2) return cleanCore(before);
  return "";
}

function productNameFromText(text) {
  const raw = collapseCjkSpaces(String(text || ""));
  const lines = raw.split(/\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  let best = "";
  let score = 0;
  for (let i = 0; i < lines.length; i++) {
    const candidate = nameFromLine(lines[i]);
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

export function parseVisionResponse(payload) {
  const response = payload && Array.isArray(payload.responses) ? payload.responses[0] : null;
  if (!response || response.error) {
    return { ok: false, productName: "", price: "", offer: "" };
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
    });
  }
  if (!cands.length) cands = pricesInText(text);
  const price = pickPrice(cands);
  return {
    ok: true,
    productName: productNameFromText(text),
    price: formatPrice(price),
    offer: offer,
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
