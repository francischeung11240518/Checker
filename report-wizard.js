/* Click-through: consent → shop → photo → OCR draft → confirm → pending.
   OCR stays in the browser. A failed read still allows hand entry.
   Shelf tags often print a bare price (105 with a superscript 9) and no $. */
(function () {
  const S = window.PricewatchShared;
  const Store = window.PricewatchReports;
  const params = new URLSearchParams(location.search);

  const state = {
    step: "consent",
    editingId: null,
    createdAt: "",
    returnReason: "",
    shopCode: params.get("shop") || "",
    branch: "",
    photoKind: "shelf",
    photoBlob: null,
    sourceFile: null,
    photoUrl: "",
    photoHash: "",
    keepExistingPhoto: false,
    ocr: null,
    ocrExcerpt: "",
    sensitiveAck: false,
    productCode: "",
    productName: "",
    newProduct: false,
    spec: "",
    price: "",
    offerText: "",
    unit: "each",
    priceKind: "unknown",
    note: "",
    prefillCode: params.get("code") || "",
  };

  let catalog = null;
  let catalogError = "";
  let ocrToken = 0;
  const workerPromises = {};
  let clockTimer = 0;

  const $ = function (id) { return document.getElementById(id); };

  function showError(msg) {
    const el = $("saveError");
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = msg;
  }

  function setPhotoUrl(blob) {
    if (state.photoUrl) URL.revokeObjectURL(state.photoUrl);
    state.photoBlob = blob;
    state.photoUrl = blob ? URL.createObjectURL(blob) : "";
  }

  function show(step) {
    state.step = step;
    document.querySelectorAll("[data-step]").forEach(function (el) {
      el.hidden = el.getAttribute("data-step") !== step;
    });
    const labels = {
      consent: "1. 同意",
      shop: "2. 揀超市",
      photo: "3. 影相",
      preview: "3. 預覽",
      reading: "4. 讀相",
      warn: "4. 檢查",
      confirm: "5. 核對",
      summary: "6. 摘要",
      success: "完成",
      mine: "我的上報",
    };
    $("progress").textContent = labels[step] || "";
    $("returnBanner").hidden = !(state.returnReason && (step === "confirm" || step === "summary" || step === "photo"));
    if (!$("returnBanner").hidden) {
      $("returnBanner").textContent = "管理員退回：" + state.returnReason + "。改完可以再交。";
    }
    if (step === "shop") renderShop();
    if (step === "photo") renderPhotoKind();
    if (step === "preview") $("previewImg").src = state.photoUrl;
    if (step === "confirm") fillConfirm();
    if (step === "summary") fillSummary();
    if (step === "mine") renderMine();
    const head = document.querySelector('[data-step="' + step + '"] h2');
    if (head) {
      head.tabIndex = -1;
      head.focus();
    }
  }

  function selectedShopOk() {
    return S.SHOPS.some(function (s) { return s.code === state.shopCode; });
  }

  function renderShop() {
    const box = $("shopList");
    box.innerHTML = S.SHOPS.map(function (s) {
      const on = s.code === state.shopCode;
      return '<button type="button" data-shop="' + s.code + '" aria-pressed="' + (on ? "true" : "false") + '">'
        + S.escapeHtml(s.name) + "</button>";
    }).join("");
    $("branchInput").value = state.branch;
    $("shopNext").disabled = !selectedShopOk();
    refreshReturnedBanner();
  }

  async function refreshReturnedBanner() {
    const el = $("returnedBanner");
    try {
      const rows = await Store.list();
      const n = rows.filter(function (r) { return r.status === "returned"; }).length;
      if (!n || state.step !== "shop") {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      el.innerHTML = "你有 " + n + " 條退回要改。"
        + ' <button type="button" id="goReturned">去改</button>';
      $("goReturned").addEventListener("click", function () { show("mine"); });
    } catch (e) {
      el.hidden = true;
    }
  }

  function renderPhotoKind() {
    const receipt = state.photoKind === "receipt";
    $("kindShelf").setAttribute("aria-pressed", receipt ? "false" : "true");
    $("kindReceipt").setAttribute("aria-pressed", receipt ? "true" : "false");
    $("receiptTip").hidden = !receipt;
    $("takePhoto").textContent = receipt ? "影收據" : "影價牌";
  }

  function compressImage(file) {
    return new Promise(function (resolve) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        const max = 1280;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(function (blob) {
          URL.revokeObjectURL(url);
          resolve(blob || file);
        }, "image/jpeg", 0.72);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(file);
      };
      img.src = url;
    });
  }

  async function sha256(blob) {
    const buf = await blob.arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hash)).map(function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
  }

  async function useFile(file) {
    if (!file) return;
    showError("");
    state.sourceFile = file;
    const blob = await compressImage(file);
    setPhotoUrl(blob);
    state.keepExistingPhoto = false;
    try {
      state.photoHash = await sha256(blob);
    } catch (e) {
      state.photoHash = "";
    }
    state.sensitiveAck = false;
    show("preview");
  }

  function ocrStatusText(m) {
    if (!m || !m.status) return "讀相中…";
    const s = String(m.status);
    if (s === "recognizing text") {
      return "讀緊價牌… " + Math.round((m.progress || 0) * 100) + "%";
    }
    if (/language|traineddata/i.test(s)) return "載入中文同英文辨識…";
    if (/core|wasm|initial|loading/i.test(s)) return "準備讀相工具…";
    return "讀相中…";
  }

  function getWorker(lang) {
    if (!workerPromises[lang]) {
      if (!window.Tesseract) return Promise.reject(new Error("no-ocr"));
      // legacyLang false selects the compact 4.0.0_best_int packs on jsDelivr
      // (chi_tra ~1.6MB, eng ~3MB) instead of the 10–27MB legacy files.
      workerPromises[lang] = window.Tesseract.createWorker(lang, 1, {
        legacyLang: false,
        logger: function (m) {
          const el = $("ocrStatus");
          if (el && state.step === "reading") el.textContent = ocrStatusText(m);
        },
      }).catch(function (err) {
        delete workerPromises[lang];
        throw err;
      });
    }
    return workerPromises[lang];
  }

  function decodeImage(file) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("image"));
      };
      img.src = url;
    });
  }

  function cropCanvas(image, box, targetW) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(targetW));
    canvas.height = Math.max(1, Math.round(targetW * box.h / Math.max(box.w, 1)));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, box.x, box.y, box.w, box.h, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function findShelfBands(image) {
    const maxW = 480;
    const scale = Math.min(1, maxW / image.width);
    const w = Math.max(1, Math.round(image.width * scale));
    const h = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const x0 = Math.floor(w * 0.12);
    const x1 = Math.floor(w * 0.88);
    function lumAt(x, y) {
      const i = (y * w + x) * 4;
      return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    const rows = [];
    for (let y = 0; y < h; y++) {
      const lums = [];
      for (let x = x0; x < x1; x += 2) lums.push(lumAt(x, y));
      lums.sort(function (a, b) { return a - b; });
      const med = lums[lums.length >> 1] || 0;
      let ink = 0;
      for (let x = x0; x < x1; x += 2) if (med - lumAt(x, y) > 26) ink++;
      rows.push({ med: med, ink: ink, samples: lums.length });
    }
    const bands = [];
    let cur = null;
    for (let y = 0; y < h; y++) {
      const r = rows[y];
      const hot = r.med > 100 && r.ink > r.samples * 0.04 && r.ink < r.samples * 0.55;
      if (hot) {
        if (!cur) cur = { y0: y, y1: y };
        else cur.y1 = y;
      } else if (cur && y > cur.y1 + 3) {
        bands.push(cur);
        cur = null;
      }
    }
    if (cur) bands.push(cur);
    const tall = bands.map(function (b) {
      return { y0: b.y0, y1: b.y1, height: b.y1 - b.y0 + 1 };
    }).filter(function (b) {
      return b.height > h * 0.025 && b.height < h * 0.4;
    });
    tall.sort(function (a, b) { return b.height - a.height; });
    function px(v) { return Math.max(0, Math.min(image.width, v / w * image.width)); }
    function py(v) { return Math.max(0, Math.min(image.height, v / h * image.height)); }
    const found = [];
    for (let n = 0; n < tall.length && found.length < 3; n++) {
      const band = tall[n];
      const cols = [];
      for (let x = 0; x < w; x++) cols.push(0);
      for (let y = band.y0; y <= band.y1; y++) {
        const lums = [];
        for (let x = x0; x < x1; x += 2) lums.push(lumAt(x, y));
        lums.sort(function (a, b) { return a - b; });
        const med = lums[lums.length >> 1] || 0;
        for (let x = x0; x < x1; x++) if (med - lumAt(x, y) > 26) cols[x]++;
      }
      const smooth = cols.map(function (v, i) {
        let s = 0;
        for (let k = -2; k <= 2; k++) s += cols[Math.min(w - 1, Math.max(0, i + k))] || 0;
        return s / 5;
      });
      let total = 0;
      for (let x = 0; x < w; x++) total += smooth[x];
      if (!(total > 0)) continue;
      let best = null;
      for (let i = 0; i < w; i++) {
        let acc = 0;
        for (let j = i; j < w; j++) {
          acc += smooth[j];
          if (acc >= total * 0.84) {
            if (!best || j - i < best.x1 - best.x0) best = { x0: i, x1: j };
            break;
          }
        }
      }
      if (!best) continue;
      const coreW = Math.max(1, best.x1 - best.x0);
      const padL = Math.round(coreW * 0.08 + w * 0.01);
      const padR = Math.round(coreW * 0.45 + w * 0.01);
      const padY = Math.round(band.height * 0.2);
      const price = {
        x: px(best.x0 - padL),
        y: py(band.y0 - padY),
        w: px(best.x1 + padR) - px(best.x0 - padL),
        h: py(band.y1 + padY) - py(band.y0 - padY),
      };
      if (!(price.w > 8) || !(price.h > 8)) continue;
      const name = {
        x: image.width * 0.08,
        y: Math.min(image.height - 4, price.y + price.h * 0.88),
        w: image.width * 0.84,
        h: Math.max(price.h * 1.15, image.height * 0.08),
      };
      name.w = Math.min(name.w, image.width - name.x);
      name.h = Math.min(name.h, image.height - name.y);
      found.push({ price: price, name: name });
    }
    return found;
  }

  function reconcilePrintedPrice(price, raw, parsedPrice) {
    const dollars = [];
    const re = /(?:HKD|HK\$|＄|\$)\s*(\d{1,4}(?:[.,]\d{1,2})?)/gi;
    let m;
    while ((m = re.exec(String(raw || "")))) {
      const n = parseFloat(String(m[1]).replace(",", "."));
      if (n >= 0.5 && n < 10000) dollars.push(Math.round(n * 100) / 100);
    }
    if (!dollars.length) return price != null ? price : parsedPrice;
    if (price == null) return parsedPrice != null ? parsedPrice : dollars[0];
    if (dollars.some(function (d) { return Math.abs(d - price) < 0.011; })) return price;
    const cents = Math.round((price % 1) * 100);
    const bigger = dollars.filter(function (d) {
      return d > price && d < price * 40 && Math.round((d % 1) * 100) === cents;
    });
    if (bigger.length === 1) return bigger[0];
    return price;
  }

  function percentPrice(text, value) {
    const re = /(\d{1,3}(?:[.,]\d{1,2})?)\s*%/g;
    let m;
    while ((m = re.exec(String(text || "")))) {
      const n = parseFloat(m[1].replace(",", "."));
      if (Math.abs(n - value) < 0.011) return true;
    }
    return false;
  }

  async function recognize(worker, canvas, psm, whitelist) {
    await worker.setParameters({
      tessedit_pageseg_mode: String(psm),
      tessedit_char_whitelist: whitelist || "",
    });
    return worker.recognize(canvas);
  }

  function glyphDigit(text) {
    const t = String(text || "");
    if (t === "|" || t === "I" || t === "l" || t === "1") return "1";
    if (t === "O" || t === "o" || t === "0") return "0";
    if (/^[2-9]$/.test(t)) return t;
    return "";
  }

  function collectSymbols(result) {
    const symbols = [];
    const words = (result && result.data && result.data.words) || [];
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const list = word.symbols && word.symbols.length ? word.symbols : [word];
      for (let j = 0; j < list.length; j++) {
        const s = list[j];
        if (!s || !s.bbox) continue;
        symbols.push({
          t: String(s.text || ""),
          c: s.confidence || 0,
          x0: s.bbox.x0,
          y0: s.bbox.y0,
          x1: s.bbox.x1,
          y1: s.bbox.y1,
          h: s.bbox.y1 - s.bbox.y0,
        });
      }
    }
    return symbols;
  }

  async function readSuperscript(worker, canvas, sym) {
    const pad = Math.max(6, Math.round(sym.h * 0.12));
    const patch = {
      x: Math.max(0, sym.x0 - pad),
      y: Math.max(0, sym.y0 - pad),
      w: Math.min(canvas.width, sym.x1 + pad) - Math.max(0, sym.x0 - pad),
      h: Math.min(canvas.height, sym.y1 + pad) - Math.max(0, sym.y0 - pad),
    };
    if (!(patch.w > 4) || !(patch.h > 4)) return "";
    const scale = 300 / patch.h;
    const pc = document.createElement("canvas");
    pc.width = Math.max(1, Math.round(patch.w * scale));
    pc.height = Math.max(1, Math.round(patch.h * scale));
    const ctx = pc.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, pc.width, pc.height);
    ctx.drawImage(canvas, patch.x, patch.y, patch.w, patch.h, 0, 0, pc.width, pc.height);
    const raw = await recognize(worker, pc, 10, "0123456789");
    const id = ctx.getImageData(0, 0, pc.width, pc.height);
    const px = id.data;
    for (let i = 0; i < px.length; i += 4) {
      const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      const v = y < 118 ? 0 : 255;
      px[i] = px[i + 1] = px[i + 2] = v;
    }
    ctx.putImageData(id, 0, 0);
    const bin = await recognize(worker, pc, 10, "0123456789");
    const choices = [raw, bin].map(function (r) {
      const text = ((r && r.data && r.data.text) || "").replace(/\D/g, "");
      return {
        digit: text.length === 1 ? text : "",
        conf: r && r.data ? r.data.confidence || 0 : 0,
      };
    }).filter(function (c) { return c.digit && c.conf >= 60; });
    choices.sort(function (a, b) { return b.conf - a.conf; });
    return choices.length ? choices[0].digit : "";
  }

  async function assembleShelfPrice(worker, result, canvas) {
    const symbols = collectSymbols(result);
    const digitish = symbols.filter(function (s) { return glyphDigit(s.t); });
    const maxH = digitish.reduce(function (m, s) { return Math.max(m, s.h); }, 0);
    if (!(maxH > 0)) return null;
    const large = digitish.filter(function (s) { return s.h >= maxH * 0.62; })
      .sort(function (a, b) { return a.x0 - b.x0; });
    const kept = [];
    for (let i = 0; i < large.length; i++) {
      const s = large[i];
      if (kept.length) {
        const prev = kept[kept.length - 1];
        if (s.x0 - prev.x1 > maxH * 0.9) break;
      }
      kept.push(s);
    }
    if (kept.length < 2 || kept.length > 4) return null;
    const digits = kept.map(function (s) { return glyphDigit(s.t); }).join("");
    if (!/^\d{2,4}$/.test(digits)) return null;
    const first = kept[0];
    const last = kept[kept.length - 1];
    const top = Math.min.apply(null, kept.map(function (s) { return s.y0; }));
    const bot = Math.max.apply(null, kept.map(function (s) { return s.y1; }));
    const dot = symbols.filter(function (s) {
      return /^[.,．]$/.test(s.t) && s.c >= 40 && s.x0 > first.x0 && s.x1 < last.x1 && s.y0 > (top + bot) / 2;
    }).sort(function (a, b) { return b.c - a.c; })[0] || null;
    let cents = "";
    if (!dot) {
      const midY = (top + bot) / 2;
      const sup = symbols.filter(function (s) {
        return s.x0 >= last.x1 - 8 && s.y0 < midY && s.h < maxH * 0.75 && s.h > maxH * 0.18;
      }).sort(function (a, b) { return a.x0 - b.x0; })[0];
      if (sup) {
        if (/^[0-9]$/.test(sup.t) && sup.c >= 70) cents = sup.t;
        else cents = await readSuperscript(worker, canvas, sup);
      }
    }
    let value = cents ? Number(digits + "." + cents) : Number(digits);
    if (dot) {
      const left = kept.filter(function (s) { return s.x1 <= dot.x0 + 2; })
        .map(function (s) { return glyphDigit(s.t); }).join("");
      const right = kept.filter(function (s) { return s.x0 >= dot.x1 - 2; })
        .map(function (s) { return glyphDigit(s.t); }).join("");
      if (left && right) value = Number(left + "." + right);
    }
    if (!isFinite(value) || value < 0.5 || value > 9999) return null;
    return Math.round(value * 100) / 100;
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () { reject(new Error("timeout")); }, ms);
      promise.then(function (v) {
        clearTimeout(timer);
        resolve(v);
      }, function (e) {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  function rememberOcr(rawText, engineConfidence) {
    const parsed = S.applyEngineConfidence(S.parseOcr(rawText), engineConfidence);
    state.ocr = parsed;
    state.ocrExcerpt = S.redactExcerpt(rawText);
    state.shopMention = S.shopMentioned(rawText);
    state.sensitiveMessage = S.sensitiveHint(rawText);
    if (parsed.price != null) state.price = String(parsed.price);
    if (parsed.offer) state.offerText = parsed.offer;
  }

  function afterOcr() {
    if (state.sensitiveMessage && !state.sensitiveAck) {
      $("warnText").textContent = state.sensitiveMessage;
      show("warn");
      return;
    }
    show("confirm");
  }

  async function runOcr() {
    const token = ++ocrToken;
    show("reading");
    $("ocrStatus").textContent = "準備讀相…";
    let raw = "";
    let price = null;
    let engineConfidence = null;
    try {
      const started = Date.now();
      while (!window.Tesseract) {
        if (Date.now() - started > 20000) throw new Error("no-ocr");
        await new Promise(function (resolve) { setTimeout(resolve, 200); });
      }
      const img = await decodeImage(state.sourceFile || state.photoBlob);
      if (token !== ocrToken) return;
      const bands = findShelfBands(img);
      const eng = await withTimeout(getWorker("eng"), 45000);
      if (token !== ocrToken) return;
      let chosen = null;
      if (bands && bands.length) {
        $("ocrStatus").textContent = "讀緊價錢…";
        for (let i = 0; i < bands.length; i++) {
          const priceCanvas = cropCanvas(img, bands[i].price, 1200);
          const priceResult = await withTimeout(recognize(eng, priceCanvas, 6, ""), 22000);
          if (token !== ocrToken) return;
          const text = (priceResult && priceResult.data && priceResult.data.text) || "";
          const assembled = await assembleShelfPrice(eng, priceResult, priceCanvas);
          const cropParsed = S.parseOcr(text);
          const hasDollar = /(?:HKD|HK\$|＄|\$)\s*\d/.test(text);
          let candidate = assembled;
          if (hasDollar && cropParsed.price != null) candidate = cropParsed.price;
          if (candidate == null || percentPrice(text, candidate)) continue;
          const hasCents = Math.round(candidate * 100) % 100 !== 0;
          const score = hasDollar ? 3 : (hasCents ? 2 : 1);
          if (!chosen || score > chosen.score) {
            chosen = { score: score, band: bands[i], text: text, price: candidate };
            engineConfidence = priceResult && priceResult.data ? priceResult.data.confidence : engineConfidence;
          }
          if (score >= 2) break;
        }
        if (chosen) {
          price = chosen.price;
          raw += chosen.text;
        }
        const nameBand = (chosen && chosen.band) || bands[0];
        $("ocrStatus").textContent = "讀緊產品名…";
        const nameCanvas = cropCanvas(img, nameBand.name, 1500);
        let nameResult = null;
        try {
          const chi = await withTimeout(getWorker("chi_tra+eng"), 50000);
          if (token !== ocrToken) return;
          nameResult = await withTimeout(recognize(chi, nameCanvas, 6, ""), 22000);
        } catch (e) {
          delete workerPromises["chi_tra+eng"];
          nameResult = await withTimeout(recognize(eng, nameCanvas, 6, ""), 22000);
        }
        if (token !== ocrToken) return;
        raw += "\n" + ((nameResult && nameResult.data && nameResult.data.text) || "");
      }
      const early = S.parseOcr(raw);
      if (price == null || !early.productGuess) {
        $("ocrStatus").textContent = "再讀一次成張相…";
        const full = cropCanvas(img, { x: 0, y: 0, w: img.width, h: img.height }, 1400);
        const fullResult = await withTimeout(recognize(eng, full, 6, ""), 22000);
        if (token !== ocrToken) return;
        raw += "\n" + ((fullResult && fullResult.data && fullResult.data.text) || "");
        if (engineConfidence == null && fullResult && fullResult.data) {
          engineConfidence = fullResult.data.confidence;
        }
      }
    } catch (e) {
      delete workerPromises.eng;
    }
    if (token !== ocrToken) return;
    const parsed = S.applyEngineConfidence(S.parseOcr(raw), engineConfidence);
    price = reconcilePrintedPrice(price, raw, parsed.price);
    rememberOcr(raw, engineConfidence);
    if (price != null) {
      state.price = String(price);
      state.ocr.price = price;
    }
    if (price != null || (state.ocr && state.ocr.productGuess)) {
      state.ocr.failed = false;
    }
    afterOcr();
  }

  function skipOcr() {
    ocrToken += 1;
    if (!state.ocr) {
      rememberOcr("", null);
      state.ocr.failed = true;
      state.ocr.confidence = "low";
    }
    state.sensitiveAck = true;
    show("confirm");
  }

  function productByCode(code) {
    if (!catalog || !code) return null;
    return catalog.byCode.get(code) || null;
  }

  function applyPicked(p) {
    state.productCode = p.c;
    state.productName = S.productTitle(p);
    state.newProduct = false;
    state.spec = p.nz || "";
    $("newProduct").checked = false;
    $("newNameWrap").hidden = true;
    renderPicked();
    renderCc();
  }

  function renderPicked() {
    const line = $("pickedLine");
    if (state.productCode && state.productName) {
      line.hidden = false;
      line.innerHTML = "已揀：<b>" + S.escapeHtml(state.productName) + "</b> "
        + '<button type="button" id="clearPicked">揀另一隻</button>';
      $("clearPicked").addEventListener("click", function () {
        state.productCode = "";
        state.productName = "";
        renderPicked();
        renderResults($("productSearch").value);
        renderCc();
      });
    } else {
      line.hidden = true;
      line.innerHTML = "";
    }
  }

  function renderResults(query) {
    const box = $("productResults");
    if (!catalog) {
      box.innerHTML = catalogError
        ? '<p class="hint">產品庫載入失敗，可以剔「庫入面搵唔到」自己填名。</p>'
        : '<p class="hint">產品庫載入中…</p>';
      return;
    }
    const q = String(query || "").trim();
    const guess = state.ocr && state.ocr.productGuess;
    const hits = q ? S.searchCatalog(catalog, q) : (guess ? S.searchCatalog(catalog, guess) : []);
    if (!hits.length) {
      box.innerHTML = q ? '<p class="hint">未見相近產品。可以剔「庫入面搵唔到」。</p>' : "";
      return;
    }
    const label = !q && guess ? '<p class="hint">系統估到「' + S.escapeHtml(guess) + "」，請撳一隻核對。</p>" : "";
    box.innerHTML = label + hits.map(function (p) {
      return '<button type="button" data-pick="' + S.escapeHtml(p.c) + '">' + S.escapeHtml(S.productTitle(p)) + "</button>";
    }).join("");
  }

  function renderChoiceRow(container, items, current, attr) {
    container.innerHTML = items.map(function (item) {
      const on = item.id === current;
      return '<button type="button" ' + attr + '="' + item.id + '" aria-pressed="' + (on ? "true" : "false") + '">'
        + S.escapeHtml(item.label) + "</button>";
    }).join("");
  }

  function renderCc() {
    const el = $("ccHint");
    const product = productByCode(state.productCode);
    if (!product) {
      el.textContent = state.newProduct
        ? "你標記咗庫入面搵唔到。管理員會再處理。通過之後搜尋可以見到，但暫時未有消委會價可對。"
        : "揀咗產品之後，如果消委會有價，會喺度對住顯示。上報唔會覆蓋消委會現價。";
      return;
    }
    const cc = S.ccOffer(product, state.shopCode);
    if (!cc) {
      el.textContent = "消委會未有 " + S.shopName(state.shopCode) + " 呢隻嘅現價。你嘅上報通過後會另外標「用戶上報」，唔會寫入消委會價。";
      return;
    }
    const offer = cc.zh || cc.en;
    el.textContent = "消委會現價 " + S.formatMoney(cc.shelf)
      + (offer ? "（" + offer + "）" : "")
      + "。上報通過後會排喺旁邊，標「用戶上報」，唔會覆蓋呢個價。";
  }

  function fillConfirm() {
    $("confirmShop").textContent = S.shopName(state.shopCode) + (state.branch ? " · " + state.branch : "");
    $("priceInput").value = state.price;
    $("offerInput").value = state.offerText;
    $("specInput").value = state.spec;
    $("noteInput").value = state.note;
    $("newProduct").checked = state.newProduct;
    $("newNameWrap").hidden = !state.newProduct;
    $("newName").value = state.newProduct ? state.productName : "";
    const failed = state.ocr && state.ocr.failed;
    $("draftNote").textContent = failed
      ? "讀唔到相入面嘅字，請自己填。填好先提交。"
      : "以下係系統讀相結果，請改到啱先提交。";
    const hint = $("priceHint");
    hint.textContent = state.ocr && state.ocr.price != null && !failed
      ? "系統讀到價錢，請核對。"
      : "請自己填價錢。";
    const shopHint = $("shopHint");
    if (state.shopMention && state.shopMention !== state.shopCode) {
      shopHint.hidden = false;
      shopHint.textContent = "相入面好似提到" + S.shopName(state.shopMention) + "，你揀咗" + S.shopName(state.shopCode) + "。請核對。";
    } else {
      shopHint.hidden = true;
    }
    renderChoiceRow($("unitRow"), S.UNITS, state.unit, "data-unit");
    renderChoiceRow($("kindRow"), S.PRICE_KINDS, state.priceKind, "data-kind");
    if (catalog && state.prefillCode && !state.productCode && !state.newProduct) {
      const preset = productByCode(state.prefillCode);
      state.prefillCode = "";
      if (preset) applyPicked(preset);
    }
    const searchValue = $("productSearch").value;
    if (!searchValue && state.ocr && state.ocr.productGuess && !state.productCode && !state.newProduct) {
      $("productSearch").value = state.ocr.productGuess;
    }
    renderPicked();
    renderResults($("productSearch").value);
    renderCc();
    $("formError").hidden = true;
  }

  function readConfirm() {
    state.price = $("priceInput").value.trim();
    state.offerText = $("offerInput").value.trim().slice(0, 40);
    state.spec = $("specInput").value.trim().slice(0, 40);
    state.note = $("noteInput").value.trim().slice(0, 40);
    state.unit = state.unit || "each";
    state.priceKind = state.priceKind || "unknown";
    if ($("newProduct").checked) {
      state.newProduct = true;
      state.productCode = "";
      state.productName = $("newName").value.trim().slice(0, 80);
    } else {
      state.newProduct = false;
    }
  }

  function formProblem() {
    if (!selectedShopOk()) return "請先揀超市。";
    if (!S.parsePrice(state.price)) return "請填一個價錢，例如 12.9。";
    if (state.newProduct) {
      if (!state.productName) return "請填新貨名稱，或者取消「庫入面搵唔到」再揀產品。";
    } else if (!state.productCode || !state.productName) {
      return "請揀一隻站內產品，或者剔「庫入面搵唔到」。";
    }
    if (!Store.hasConsent()) return "請先同意私隱提示。";
    return "";
  }

  function fillSummary() {
    readConfirm();
    if (state.photoUrl) {
      $("summaryImg").src = state.photoUrl;
      $("summaryImg").hidden = false;
    } else {
      $("summaryImg").hidden = true;
    }
    const kind = S.kindLabel(state.priceKind);
    const unit = S.unitLabel(state.unit);
    const price = S.parsePrice(state.price);
    const rows = [
      ["超市", S.shopName(state.shopCode)],
      ["分店", state.branch || "（冇填）"],
      ["產品", state.productName],
      ["規格", state.spec || "（冇填）"],
      ["價錢", price != null ? S.formatMoney(price) : state.price],
      ["單位", unit],
      ["價類", kind],
      ["優惠", state.offerText || "（冇）"],
      ["備註", state.note || "（冇）"],
    ];
    $("summaryBox").innerHTML = rows.map(function (row) {
      return "<p><span class=\"k\">" + S.escapeHtml(row[0]) + "</span>" + S.escapeHtml(row[1]) + "</p>";
    }).join("") + "<p><span class=\"k\">狀態</span>提交後係待審核，未公開。</p>";
    $("confirmCheck").checked = false;
    $("submitReport").disabled = true;
    tickClock();
  }

  function tickClock() {
    const el = $("nowClock");
    if (el) el.textContent = "而家 " + S.formatHKWhen(new Date().toISOString());
  }

  async function submitReport() {
    readConfirm();
    const problem = formProblem();
    if (problem || !$("confirmCheck").checked) {
      showError(problem || "請先剔已核對。");
      return;
    }
    if (!state.photoBlob && !state.keepExistingPhoto) {
      showError("請先影張相或者上傳。");
      return;
    }
    $("submitReport").disabled = true;
    showError("");
    const now = new Date().toISOString();
    const price = S.parsePrice(state.price);
    const id = state.editingId || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    const meta = {
      id: id,
      status: "pending",
      createdAt: state.createdAt || now,
      updatedAt: now,
      reportedAt: now,
      publishedAt: "",
      consentVersion: S.CONSENT_VERSION,
      shopCode: state.shopCode,
      branch: state.branch,
      photoKind: state.photoKind,
      photoHash: state.photoHash,
      hasPhoto: true,
      ocr: {
        confidence: state.ocr ? state.ocr.confidence : "low",
        failed: !!(state.ocr && state.ocr.failed),
        price: state.ocr ? state.ocr.price : null,
        offer: state.ocr ? state.ocr.offer : "",
        productGuess: state.ocr ? state.ocr.productGuess : "",
        excerpt: state.ocrExcerpt || "",
      },
      productCode: state.productCode,
      productName: state.productName,
      newProduct: state.newProduct,
      spec: state.spec,
      price: price,
      offerText: state.offerText,
      unit: state.unit,
      priceKind: state.priceKind,
      note: state.note,
      returnReason: "",
      rejectReason: "",
    };
    try {
      const blobArg = state.photoBlob ? state.photoBlob : undefined;
      await Store.save(meta, blobArg);
      state.editingId = null;
      state.returnReason = "";
      show("success");
    } catch (e) {
      $("submitReport").disabled = false;
      showError("儲存失敗。請檢查瀏覽器係咪封鎖咗網站資料。");
    }
  }

  function resetForAnother() {
    state.editingId = null;
    state.createdAt = "";
    state.returnReason = "";
    state.branch = "";
    state.photoKind = "shelf";
    setPhotoUrl(null);
    state.sourceFile = null;
    state.photoHash = "";
    state.keepExistingPhoto = false;
    state.ocr = null;
    state.ocrExcerpt = "";
    state.sensitiveAck = false;
    state.productCode = state.prefillCode || "";
    state.productName = "";
    state.newProduct = false;
    state.spec = "";
    state.price = "";
    state.offerText = "";
    state.unit = "each";
    state.priceKind = "unknown";
    state.note = "";
    state.shopMention = "";
    $("productSearch").value = "";
    $("camInput").value = "";
    $("libInput").value = "";
    show(Store.hasConsent() ? "shop" : "consent");
  }

  async function renderMine() {
    const box = $("mineList");
    let rows = [];
    try {
      rows = await Store.list();
    } catch (e) {
      box.innerHTML = '<p class="warn">呢個瀏覽器未能讀取上報。</p>';
      return;
    }
    rows.sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
    if (!rows.length) {
      box.innerHTML = '<p class="card">未有上報。</p>';
      return;
    }
    const statusText = {
      pending: "待審核",
      approved: "已通過",
      returned: "退回改",
      rejected: "已拒絕",
    };
    box.innerHTML = rows.map(function (r) {
      const st = statusText[r.status] || r.status;
      const cls = r.status === "approved" ? "status" : "status wait";
      let extra = "";
      if (r.status === "returned" && r.returnReason) extra = "<p>原因：" + S.escapeHtml(r.returnReason) + "</p>";
      if (r.status === "rejected") {
        extra = "<p>原圖已刪。" + (r.rejectReason ? "原因：" + S.escapeHtml(r.rejectReason) : "") + "</p>";
      }
      const edit = r.status === "returned"
        ? '<button type="button" data-edit="' + S.escapeHtml(r.id) + '">改再交</button>'
        : "";
      return '<article class="card mine-card"><p class="' + cls + '">' + st + "</p><p><b>"
        + S.escapeHtml(r.productName || "未填產品") + "</b></p><p>"
        + S.escapeHtml(S.shopName(r.shopCode)) + " " + S.escapeHtml(S.formatMoney(r.price))
        + "</p><p class=\"sub\">" + S.escapeHtml(S.formatHKWhen(r.reportedAt || r.createdAt)) + "</p>"
        + extra
        + '<div class="stack row">' + edit
        + '<button type="button" data-del="' + S.escapeHtml(r.id) + '">刪除呢條（連相）</button></div></article>';
    }).join("");
  }

  async function openReturned(id) {
    const rec = await Store.get(id);
    if (!rec || rec.status !== "returned") {
      show("mine");
      return;
    }
    state.editingId = rec.id;
    state.createdAt = rec.createdAt || "";
    state.returnReason = rec.returnReason || "";
    state.shopCode = rec.shopCode || "";
    state.branch = rec.branch || "";
    state.photoKind = rec.photoKind || "shelf";
    state.photoHash = rec.photoHash || "";
    state.productCode = rec.productCode || "";
    state.productName = rec.productName || "";
    state.newProduct = !!rec.newProduct;
    state.spec = rec.spec || "";
    state.price = rec.price != null ? String(rec.price) : "";
    state.offerText = rec.offerText || "";
    state.unit = rec.unit || "each";
    state.priceKind = rec.priceKind || "unknown";
    state.note = rec.note || "";
    state.ocr = rec.ocr || null;
    state.ocrExcerpt = rec.ocr && rec.ocr.excerpt ? rec.ocr.excerpt : "";
    state.sensitiveAck = true;
    const blob = await Store.getPhoto(id);
    if (blob) {
      setPhotoUrl(blob);
      state.keepExistingPhoto = true;
    } else {
      setPhotoUrl(null);
      state.keepExistingPhoto = false;
    }
    show("confirm");
  }

  async function deleteReport(id, button) {
    if (button.getAttribute("data-armed") !== "1") {
      button.setAttribute("data-armed", "1");
      button.textContent = "確定刪除";
      return;
    }
    await Store.remove(id);
    if (state.editingId === id) resetForAnother();
    else renderMine();
  }

  function bind() {
    $("agree").addEventListener("change", function () {
      $("consentNext").disabled = !$("agree").checked;
    });
    $("consentNext").addEventListener("click", function () {
      if (!$("agree").checked) return;
      if (!Store.setConsent()) {
        showError("呢個瀏覽器未能儲存同意紀錄，仍然可以繼續，但下次要再同意。");
      }
      if (state.pendingReturnId) {
        const rid = state.pendingReturnId;
        state.pendingReturnId = "";
        openReturned(rid);
        return;
      }
      show("shop");
    });
    $("shopList").addEventListener("click", function (ev) {
      const btn = ev.target.closest("[data-shop]");
      if (!btn) return;
      state.shopCode = btn.getAttribute("data-shop");
      renderShop();
    });
    $("branchInput").addEventListener("input", function () {
      state.branch = $("branchInput").value.trim().slice(0, 40);
    });
    $("shopNext").addEventListener("click", function () {
      if (!selectedShopOk()) return;
      state.branch = $("branchInput").value.trim().slice(0, 40);
      show("photo");
    });
    $("openMine").addEventListener("click", function () { show("mine"); });
    $("kindShelf").addEventListener("click", function () {
      state.photoKind = "shelf";
      renderPhotoKind();
    });
    $("kindReceipt").addEventListener("click", function () {
      state.photoKind = "receipt";
      renderPhotoKind();
    });
    $("takePhoto").addEventListener("click", function () { $("camInput").click(); });
    $("pickPhoto").addEventListener("click", function () { $("libInput").click(); });
    $("camInput").addEventListener("change", function () { useFile($("camInput").files && $("camInput").files[0]); });
    $("libInput").addEventListener("change", function () { useFile($("libInput").files && $("libInput").files[0]); });
    $("photoBack").addEventListener("click", function () { show("shop"); });
    $("retake").addEventListener("click", function () {
      $("camInput").value = "";
      $("libInput").value = "";
      show("photo");
    });
    $("usePhoto").addEventListener("click", function () {
      if (!state.photoBlob) return;
      runOcr();
    });
    $("skipOcr").addEventListener("click", skipOcr);
    $("warnRetake").addEventListener("click", function () { show("photo"); });
    $("warnContinue").addEventListener("click", function () {
      state.sensitiveAck = true;
      show("confirm");
    });
    $("changeShop").addEventListener("click", function () {
      readConfirm();
      show("shop");
    });
    $("productSearch").addEventListener("input", function () {
      renderResults($("productSearch").value);
    });
    $("productResults").addEventListener("click", function (ev) {
      const btn = ev.target.closest("[data-pick]");
      if (!btn || !catalog) return;
      const p = productByCode(btn.getAttribute("data-pick"));
      if (p) applyPicked(p);
    });
    $("newProduct").addEventListener("change", function () {
      state.newProduct = $("newProduct").checked;
      $("newNameWrap").hidden = !state.newProduct;
      if (state.newProduct) {
        state.productCode = "";
        if (!$("newName").value && state.ocr && state.ocr.productGuess) {
          $("newName").value = state.ocr.productGuess;
          state.productName = state.ocr.productGuess;
        }
        renderPicked();
      }
      renderCc();
    });
    $("newName").addEventListener("input", function () {
      if ($("newProduct").checked) state.productName = $("newName").value.trim().slice(0, 80);
    });
    $("unitRow").addEventListener("click", function (ev) {
      const btn = ev.target.closest("[data-unit]");
      if (!btn) return;
      state.unit = btn.getAttribute("data-unit");
      renderChoiceRow($("unitRow"), S.UNITS, state.unit, "data-unit");
    });
    $("kindRow").addEventListener("click", function (ev) {
      const btn = ev.target.closest("[data-kind]");
      if (!btn) return;
      state.priceKind = btn.getAttribute("data-kind");
      renderChoiceRow($("kindRow"), S.PRICE_KINDS, state.priceKind, "data-kind");
    });
    $("priceInput").addEventListener("input", renderCc);
    $("toSummary").addEventListener("click", function () {
      readConfirm();
      const problem = formProblem();
      const err = $("formError");
      if (problem) {
        err.hidden = false;
        err.textContent = problem;
        return;
      }
      err.hidden = true;
      show("summary");
    });
    $("backPhoto").addEventListener("click", function () {
      readConfirm();
      show(state.photoUrl ? "preview" : "photo");
    });
    $("confirmCheck").addEventListener("change", function () {
      $("submitReport").disabled = !$("confirmCheck").checked;
    });
    $("submitReport").addEventListener("click", submitReport);
    $("backEdit").addEventListener("click", function () { show("confirm"); });
    $("reportAnother").addEventListener("click", resetForAnother);
    $("mineBack").addEventListener("click", function () {
      show(Store.hasConsent() ? "shop" : "consent");
    });
    $("mineList").addEventListener("click", function (ev) {
      const edit = ev.target.closest("[data-edit]");
      if (edit) {
        openReturned(edit.getAttribute("data-edit"));
        return;
      }
      const del = ev.target.closest("[data-del]");
      if (del) deleteReport(del.getAttribute("data-del"), del);
    });
  }

  async function init() {
    bind();
    tickClock();
    clockTimer = setInterval(tickClock, 1000);
    S.loadCatalog().then(function (cat) {
      catalog = cat;
      if (state.step === "confirm") {
        if (state.prefillCode && !state.productCode && !state.newProduct) {
          const preset = productByCode(state.prefillCode);
          state.prefillCode = "";
          if (preset) applyPicked(preset);
        }
        renderResults($("productSearch").value);
        renderCc();
      }
    }).catch(function () {
      catalogError = "fail";
      if (state.step === "confirm") renderResults("");
    });
    const id = params.get("id");
    if (id) {
      try {
        const rec = await Store.get(id);
        if (rec && rec.status === "returned") {
          state.pendingReturnId = id;
          if (!Store.hasConsent()) {
            show("consent");
            return;
          }
          await openReturned(id);
          return;
        }
      } catch (e) {}
    }
    show(Store.hasConsent() ? "shop" : "consent");
  }

  init();
  void clockTimer;
})();
