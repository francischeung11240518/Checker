/** Best-effort price-tag parse. Returns name and price only — never the image. */

const OFFER_RE = /買\s*\d+\s*件[^\n]{0,18}|買\s*\d+\s*送\s*\d+|第\s*[二2]\s*件[^\n]{0,12}|\d+\s*for\s*\$?\s*\d+(?:[.,]\d{1,2})?|減\s*\$?\s*\d+(?:[.,]\d{1,2})?/i;

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
  return String(value || "")
    .replace(/\d{6,}/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
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
  const raw = String(text || "");
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

function productNameFromText(text) {
  const lines = String(text || "").split(/\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  let best = "";
  let score = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (OFFER_RE.test(line) && line.length < 24) continue;
    if (priceToken(line) != null && line.length < 16) continue;
    const cjk = (line.match(/[\u4e00-\u9fff]/g) || []).length;
    if (cjk >= 2 && cjk > score) {
      score = cjk;
      best = line;
    }
  }
  return cleanName(best);
}

export function parseVisionResponse(payload) {
  const response = payload && Array.isArray(payload.responses) ? payload.responses[0] : null;
  if (!response || response.error) {
    return { ok: false, productName: "", price: "" };
  }
  const text = (response.fullTextAnnotation && response.fullTextAnnotation.text)
    || (response.textAnnotations && response.textAnnotations[0] && response.textAnnotations[0].description)
    || "";
  const words = Array.isArray(response.textAnnotations) ? response.textAnnotations.slice(1) : [];
  let cands = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const n = priceToken(word && word.description);
    if (n == null) continue;
    const desc = String(word.description || "");
    cands.push({
      n: n,
      inside: false,
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
