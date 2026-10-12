/* Shared labels and draft parsing for the photo price report.
   No network, no retailer pages. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PricewatchShared = api;
})(typeof window !== "undefined" ? window : null, function () {
  const CONSENT_VERSION = "2026-10-12";

  const SHOPS = [
    { code: "PARKNSHOP", name: "百佳" },
    { code: "WELLCOME", name: "惠康" },
    { code: "JASONS", name: "Market Place" },
    { code: "AEON", name: "AEON" },
    { code: "WATSONS", name: "屈臣氏" },
    { code: "MANNINGS", name: "萬寧" },
    { code: "LUNGFUNG", name: "龍豐" },
    { code: "DCHFOOD", name: "大昌" },
    { code: "SASA", name: "莎莎" },
  ];

  const SHOP_WORDS = [
    ["PARKNSHOP", ["百佳", "parknshop", "park n shop", "parkn shop"]],
    ["WELLCOME", ["惠康", "wellcome"]],
    ["JASONS", ["market place", "marketplace", "jasons"]],
    ["AEON", ["aeon", "永旺"]],
    ["WATSONS", ["屈臣氏", "watsons"]],
    ["MANNINGS", ["萬寧", "mannings"]],
    ["LUNGFUNG", ["龍豐"]],
    ["DCHFOOD", ["大昌食品", "dch food"]],
    ["SASA", ["莎莎"]],
  ];

  const PRICE_KINDS = [
    { id: "regular", label: "正價" },
    { id: "promo", label: "優惠價" },
    { id: "member", label: "會員價" },
    { id: "unknown", label: "唔確定" },
  ];

  const UNITS = [
    { id: "each", label: "每件" },
    { id: "case", label: "每箱" },
    { id: "other", label: "其他" },
  ];

  const CONFIDENCE_LABEL = { high: "高", mid: "中", low: "低" };

  function shopName(code) {
    for (let i = 0; i < SHOPS.length; i++) {
      if (SHOPS[i].code === code) return SHOPS[i].name;
    }
    return code || "";
  }

  function kindLabel(id) {
    for (let i = 0; i < PRICE_KINDS.length; i++) {
      if (PRICE_KINDS[i].id === id) return PRICE_KINDS[i].label;
    }
    return "";
  }

  function unitLabel(id) {
    for (let i = 0; i < UNITS.length; i++) {
      if (UNITS[i].id === id) return UNITS[i].label;
    }
    return "";
  }

  function confidenceLabel(id) {
    return CONFIDENCE_LABEL[id] || "低";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function formatMoney(n) {
    const v = Math.round(Number(n) * 100 + 1e-8) / 100;
    if (!isFinite(v)) return "";
    const s = v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
    return "$" + s;
  }

  function formatHKDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Hong_Kong",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  }

  function formatHKWhen(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Hong_Kong",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
    return formatHKDate(iso) + " " + time;
  }

  function normNum(s) {
    const n = parseFloat(String(s).replace(",", "."));
    if (!isFinite(n) || n <= 0 || n >= 10000) return null;
    return Math.round(n * 100) / 100;
  }

  function parsePrice(s) {
    const t = String(s || "").trim().replace(/^\$/, "").replace(/,/g, ".");
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
    return normNum(t);
  }

  function parseOcr(text) {
    const raw = String(text || "").replace(/\u0000/g, "");
    const dollars = [];
    const re = /(?:HKD|HK\$|＄|\$)\s*(\d{1,4}(?:[.,]\d{1,2})?)/gi;
    let m;
    while ((m = re.exec(raw))) {
      const n = normNum(m[1]);
      if (n == null) continue;
      dollars.push({ n: n, start: m.index, end: m.index + m[0].length, raw: m[0] });
    }
    const offerRe = /買\s*\d+\s*件[^\n]{0,18}|買\s*\d+\s*送\s*\d+|第\s*[二2]\s*件[^\n]{0,12}|\d+\s*for\s*\$?\s*\d+(?:[.,]\d{1,2})?|減\s*\$?\s*\d+(?:[.,]\d{1,2})?/i;
    const om = offerRe.exec(raw);
    const offer = om ? om[0].replace(/\s+/g, " ").trim().slice(0, 40) : "";
    let price = null;
    if (dollars.length) {
      const outside = om
        ? dollars.filter(function (d) { return d.end <= om.index || d.start >= om.index + om[0].length; })
        : dollars;
      const pool = outside.length ? outside : dollars;
      const withCents = pool.filter(function (d) { return /[.,]\d/.test(d.raw); });
      price = (withCents.length ? withCents : pool)[0].n;
    }
    const lines = raw.split(/\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    let productGuess = "";
    let best = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (om && line.indexOf(om[0].trim()) !== -1 && line.length < 24) continue;
      const cjk = (line.match(/[\u4e00-\u9fff]/g) || []).length;
      if (cjk >= 2 && cjk > best) {
        best = cjk;
        productGuess = line.slice(0, 30);
      }
    }
    const failed = !raw.trim();
    let confidence = "low";
    if (!failed && price != null && best >= 2) confidence = "high";
    else if (!failed && (price != null || best >= 2 || raw.trim().length > 8)) confidence = "mid";
    return {
      price: price,
      offer: offer,
      productGuess: productGuess,
      confidence: confidence,
      failed: failed,
    };
  }

  function applyEngineConfidence(parsed, engineConfidence) {
    const next = {
      price: parsed.price,
      offer: parsed.offer,
      productGuess: parsed.productGuess,
      confidence: parsed.confidence,
      failed: parsed.failed,
    };
    if (typeof engineConfidence !== "number" || !isFinite(engineConfidence)) return next;
    if (engineConfidence < 40) next.confidence = "low";
    else if (engineConfidence < 65 && next.confidence === "high") next.confidence = "mid";
    return next;
  }

  function redactExcerpt(text) {
    return String(text || "")
      .replace(/\d{8,}/g, "［數字已遮］")
      .replace(/[ \t]+\n/g, "\n")
      .trim()
      .slice(0, 180);
  }

  function sensitiveHint(text) {
    const t = String(text || "");
    if (/會員|積分|易賞錢|yuu|身份證|信用卡|visa|mastercard/i.test(t)) {
      return "系統讀到可能係會員卡或個人資料。請遮住或重拍。如果你已遮好，可以繼續。";
    }
    if (/電話|手機|地址/.test(t)) {
      return "系統讀到可能係電話或地址。請遮住或重拍。如果你已遮好，可以繼續。";
    }
    return "";
  }

  function shopMentioned(text) {
    const t = String(text || "").toLowerCase();
    const found = [];
    for (let i = 0; i < SHOP_WORDS.length; i++) {
      const code = SHOP_WORDS[i][0];
      const words = SHOP_WORDS[i][1];
      for (let j = 0; j < words.length; j++) {
        if (t.indexOf(words[j]) !== -1) {
          found.push(code);
          break;
        }
      }
    }
    return found.length === 1 ? found[0] : "";
  }

  function isFarFromCc(userPrice, ccShelf) {
    const price = Number(userPrice);
    const cc = Number(ccShelf);
    if (!(price > 0) || !(cc > 0)) return false;
    const ratio = price / cc;
    const diff = Math.abs(price - cc);
    return diff >= 5 && (ratio >= 1.5 || ratio <= 0.5);
  }

  function ccOffer(product, shopCode) {
    if (!product || !product.pr || !shopCode) return null;
    for (let i = 0; i < product.pr.length; i++) {
      const row = product.pr[i];
      if (row[0] === shopCode && row[1] != null) {
        return { shelf: row[1], en: row[2] || "", zh: row[3] || "" };
      }
    }
    return null;
  }

  function productTitle(p) {
    if (!p) return "";
    const brand = p.bz || p.be || "";
    const name = p.nz || "";
    if (brand && name && name.indexOf(brand) !== 0) return brand + " " + name;
    return name || brand;
  }

  function queryTokens(query) {
    return String(query || "").normalize("NFKC").toLowerCase().match(/[a-z0-9.]+|[\u4e00-\u9fff]+/g) || [];
  }

  function searchCatalog(catalog, query) {
    const list = catalog && catalog.list ? catalog.list : (catalog || []);
    const tokens = queryTokens(query);
    if (!tokens.length) return [];
    const scored = [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const name = String(p.nz || "").toLowerCase();
      const brand = (String(p.bz || "") + " " + String(p.be || "")).toLowerCase();
      let ok = true;
      let score = 0;
      for (let t = 0; t < tokens.length; t++) {
        const token = tokens[t];
        const inName = name.indexOf(token) !== -1;
        const inBrand = brand.indexOf(token) !== -1;
        if (!inName && !inBrand) {
          ok = false;
          break;
        }
        if (inName) score += 2;
        if (inBrand) score += 2;
        if (t === 0 && (name.indexOf(token) === 0 || brand.indexOf(token) === 0)) score += 3;
      }
      if (!ok) continue;
      scored.push({ p: p, score: score });
    }
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.p.nz || "").localeCompare(String(b.p.nz || ""), "zh-Hant");
    });
    return scored.slice(0, 8).map(function (row) { return row.p; });
  }

  function indexCatalog(data) {
    const list = data || [];
    const byCode = new Map();
    for (let i = 0; i < list.length; i++) byCode.set(list[i].c, list[i]);
    return { list: list, byCode: byCode };
  }

  async function loadCatalog() {
    const res = await fetch("index.html");
    if (!res.ok) throw new Error("catalog");
    const text = await res.text();
    const marker = "const DATA = ";
    const start = text.indexOf(marker);
    if (start < 0) throw new Error("catalog-marker");
    const end = text.indexOf(";\n", start);
    if (end < 0) throw new Error("catalog-end");
    const data = JSON.parse(text.slice(start + marker.length, end));
    return indexCatalog(data);
  }

  return {
    CONSENT_VERSION: CONSENT_VERSION,
    SHOPS: SHOPS,
    PRICE_KINDS: PRICE_KINDS,
    UNITS: UNITS,
    shopName: shopName,
    kindLabel: kindLabel,
    unitLabel: unitLabel,
    confidenceLabel: confidenceLabel,
    escapeHtml: escapeHtml,
    formatMoney: formatMoney,
    formatHKDate: formatHKDate,
    formatHKWhen: formatHKWhen,
    parsePrice: parsePrice,
    parseOcr: parseOcr,
    applyEngineConfidence: applyEngineConfidence,
    redactExcerpt: redactExcerpt,
    sensitiveHint: sensitiveHint,
    shopMentioned: shopMentioned,
    isFarFromCc: isFarFromCc,
    ccOffer: ccOffer,
    productTitle: productTitle,
    searchCatalog: searchCatalog,
    loadCatalog: loadCatalog,
  };
});
