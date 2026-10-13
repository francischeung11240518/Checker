/* Click-through: consent → shop → photo → OCR draft → confirm → pending.
   Local OCR stays in the browser. A failed read still allows hand entry.
   Internal cloud prefill is off unless CheckerCloudOcr is opted in. */
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
    photoUrl: "",
    photoHash: "",
    keepExistingPhoto: false,
    ocr: null,
    ocrExcerpt: "",
    ocrBlob: null,
    crop: { x: 0.14, y: 0.34, w: 0.72, h: 0.46 },
    cloudUsed: false,
    cloudTried: false,
    cloudNote: "",
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
  let workerPromise = null;
  let clockTimer = 0;
  let cloudBusy = false;
  let publicBannerDefault = "";

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
      cloud: "4. 雲端預填",
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
    syncInternalUi();
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
    const blob = await compressImage(file);
    setPhotoUrl(blob);
    state.keepExistingPhoto = false;
    resetCloudDraft();
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

  function getWorker() {
    if (!workerPromise) {
      if (!window.Tesseract) return Promise.reject(new Error("no-ocr"));
      workerPromise = window.Tesseract.createWorker("chi_tra+eng", 1, {
        logger: function (m) {
          const el = $("ocrStatus");
          if (el && state.step === "reading") el.textContent = ocrStatusText(m);
        },
      });
    }
    return workerPromise;
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

  function cloudApi() {
    return window.CheckerCloudOcr || null;
  }

  function cloudOn() {
    const api = cloudApi();
    return !!(api && api.enabled());
  }

  function resetCloudDraft() {
    state.ocrBlob = null;
    state.cloudUsed = false;
    state.cloudTried = false;
    state.cloudNote = "";
    const api = cloudApi();
    if (api) state.crop = api.defaultCrop();
  }

  function layoutCropBox() {
    const box = $("cropBox");
    if (!box || box.hidden) return;
    const c = state.crop;
    box.style.left = (c.x * 100) + "%";
    box.style.top = (c.y * 100) + "%";
    box.style.width = (c.w * 100) + "%";
    box.style.height = (c.h * 100) + "%";
  }

  function syncInternalUi() {
    const on = cloudOn();
    const banner = $("publicBanner");
    if (banner && !publicBannerDefault) publicBannerDefault = banner.textContent;
    if (banner && publicBannerDefault) {
      banner.textContent = on
        ? "內部試點模式（未對公眾開放）。上報仍然留喺呢部機。只有你喺草稿通知撳同意，先會把裁好嘅價牌小圖短暫上傳做預填。"
        : publicBannerDefault;
    }
    const note = $("internalCloudNote");
    if (note) note.hidden = !on;
    if (state.step !== "preview") return;
    const tools = $("cropTools");
    const box = $("cropBox");
    const stage = $("cropStage");
    if (tools) tools.hidden = !on;
    if (box) box.hidden = !on;
    if (stage) stage.classList.toggle("crop-on", on);
    const hint = $("previewHint");
    if (hint) {
      hint.textContent = on
        ? "黃框係價牌範圍。本機認字只用框內；若你之後同意，雲端亦只收呢一截，唔會預設傳成張貨架。"
        : "價錢同產品名要睇得清。如果影到人或者會員卡，請重拍。";
    }
    if (on) layoutCropBox();
  }

  async function prepareOcrBlob() {
    state.ocrBlob = null;
    const api = cloudApi();
    if (!api || !api.enabled()) return state.photoBlob;
    try {
      const cropped = await api.cropToBlob(state.photoBlob, state.crop);
      if (cropped) {
        state.ocrBlob = cropped;
        return cropped;
      }
    } catch (e) {}
    return state.photoBlob;
  }

  function offerCloudNow() {
    const api = cloudApi();
    if (!api) return false;
    return api.shouldOfferCloud({
      flagOn: api.enabled(),
      photoKind: state.photoKind,
      sensitive: !!state.sensitiveMessage,
      hasCrop: !!state.ocrBlob,
      ocr: state.ocr,
    });
  }

  function prepareCloudStep() {
    const api = cloudApi();
    const url = api ? api.workerUrl() : "";
    let host = "";
    try {
      host = url ? new URL(url).host : "";
    } catch (e) {
      host = "";
    }
    $("cloudHost").textContent = host
      ? "今次裁好嘅小圖會 POST 去內部代理：" + host + "（再由代理呼叫 Google，金鑰唔喺瀏覽器）。"
      : "未設定內部 Worker 位址，所以唔會上傳。你可以照常用本機或自己填。";
    $("cloudConsentCheck").checked = false;
    $("cloudAgree").disabled = true;
    $("cloudStatus").hidden = true;
    cloudBusy = false;
  }

  function applyCloudPrefill(data) {
    const api = cloudApi();
    state.cloudTried = true;
    state.cloudUsed = true;
    const weak = api ? api.localOcrWeak(state.ocr) : true;
    const name = api ? api.cleanName(data && data.productName) : "";
    const price = S.parsePrice(data && data.price);
    if (!state.ocr) {
      rememberOcr("", null);
      state.ocr.failed = true;
      state.ocr.confidence = "low";
    }
    if (price != null) {
      state.price = String(price);
      state.ocr.price = price;
      state.ocr.failed = false;
      if (state.ocr.confidence === "low") state.ocr.confidence = "mid";
    }
    if (name && (weak || !state.ocr.productGuess)) state.ocr.productGuess = name;
    state.cloudNote = "以下有雲端預填草稿（功能未定稿），可以錯。請改到啱，下一步要剔「我已核對」先可以提交。";
  }

  function cloudFallback(message) {
    state.cloudTried = true;
    state.cloudUsed = false;
    state.cloudNote = message || "雲端預填未能使用，已改由你自己填。可以照常提交。";
  }

  async function acceptCloud() {
    if (cloudBusy) return;
    if (!$("cloudConsentCheck").checked) return;
    if (state.photoKind === "receipt" || !state.ocrBlob) {
      cloudFallback("冇可上傳嘅價牌裁圖，已改由你自己填。");
      afterOcr();
      return;
    }
    const api = cloudApi();
    const url = api ? api.workerUrl() : "";
    if (!url) {
      cloudFallback("未設定內部 Worker 位址，已改由你自己填。");
      afterOcr();
      return;
    }
    cloudBusy = true;
    $("cloudAgree").disabled = true;
    $("cloudDecline").disabled = true;
    $("cloudStatus").hidden = false;
    $("cloudStatus").textContent = "送緊裁好嘅價牌…";
    let result = null;
    try {
      result = await api.postCrop(url, state.ocrBlob);
    } catch (e) {
      result = null;
    }
    $("cloudStatus").hidden = true;
    $("cloudDecline").disabled = false;
    cloudBusy = false;
    if (result && result.ok && result.data && (result.data.price || result.data.productName)) {
      applyCloudPrefill(result.data);
    } else {
      cloudFallback("雲端預填未能使用，已改由你自己填。可以照常提交。");
    }
    afterOcr();
  }

  function declineCloud() {
    cloudFallback("你揀咗只用本機／自己填。");
    afterOcr();
  }

  async function runOcr() {
    const token = ++ocrToken;
    show("reading");
    $("ocrStatus").textContent = "準備讀相…";
    let source = state.photoBlob;
    try {
      source = await prepareOcrBlob();
      if (token !== ocrToken) return;
      if (state.ocrBlob) $("ocrStatus").textContent = "讀緊價牌範圍…";
      const worker = await withTimeout(getWorker(), 40000);
      if (token !== ocrToken) return;
      const result = await withTimeout(worker.recognize(source), 45000);
      if (token !== ocrToken) return;
      const text = result && result.data ? result.data.text : "";
      const conf = result && result.data ? result.data.confidence : null;
      rememberOcr(text, conf);
    } catch (e) {
      if (token !== ocrToken) return;
      workerPromise = null;
      rememberOcr("", null);
      state.ocr.failed = true;
      state.ocr.confidence = "low";
    }
    if (token !== ocrToken) return;
    if (state.sensitiveMessage && !state.sensitiveAck) {
      afterOcr();
      return;
    }
    if (offerCloudNow()) {
      prepareCloudStep();
      show("cloud");
      return;
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
    if (state.cloudNote) $("draftNote").textContent = state.cloudNote;
    else $("draftNote").textContent = failed
      ? "讀唔到相入面嘅字，請自己填。填好先提交。"
      : "以下係系統讀相結果，請改到啱先提交。";
    const hint = $("priceHint");
    if (state.cloudUsed && state.ocr && state.ocr.price != null) {
      hint.textContent = "雲端預填咗價錢，請核對。預填可以錯。";
    } else {
      hint.textContent = state.ocr && state.ocr.price != null && !failed
        ? "系統讀到價錢，請核對。"
        : "請自己填價錢。";
    }
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
    if (!searchValue && state.ocr && state.ocr.productGuess && !state.productCode) {
      $("productSearch").value = "";
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
        cloud: state.cloudUsed ? "prefill" : (state.cloudTried ? "fallback" : ""),
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
    state.photoHash = "";
    state.keepExistingPhoto = false;
    state.ocr = null;
    state.ocrExcerpt = "";
    resetCloudDraft();
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
    state.ocrBlob = null;
    state.cloudUsed = false;
    state.cloudTried = false;
    state.cloudNote = "";
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
    function bindNudge(id, dx, dy, dw, dh) {
      const el = $(id);
      if (!el) return;
      el.addEventListener("click", function () {
        const api = cloudApi();
        if (!api) return;
        state.crop = api.nudgeCrop(state.crop, dx, dy, dw, dh);
        layoutCropBox();
      });
    }
    bindNudge("cropSmaller", 0, 0, -0.06, -0.06);
    bindNudge("cropLarger", 0, 0, 0.06, 0.06);
    bindNudge("cropUp", 0, -0.04, 0, 0);
    bindNudge("cropDown", 0, 0.04, 0, 0);
    bindNudge("cropLeft", -0.04, 0, 0, 0);
    bindNudge("cropRight", 0.04, 0, 0, 0);
    const cropBox = $("cropBox");
    if (cropBox) {
      cropBox.addEventListener("pointerdown", function (ev) {
        if (!cloudOn()) return;
        const img = $("previewImg");
        const rect = img.getBoundingClientRect();
        const start = {
          px: ev.clientX,
          py: ev.clientY,
          crop: { x: state.crop.x, y: state.crop.y, w: state.crop.w, h: state.crop.h },
        };
        if (cropBox.setPointerCapture) cropBox.setPointerCapture(ev.pointerId);
        function move(e) {
          const api = cloudApi();
          if (!api) return;
          const dx = rect.width ? (e.clientX - start.px) / rect.width : 0;
          const dy = rect.height ? (e.clientY - start.py) / rect.height : 0;
          state.crop = api.nudgeCrop(start.crop, dx, dy, 0, 0);
          layoutCropBox();
        }
        function up() {
          cropBox.removeEventListener("pointermove", move);
          cropBox.removeEventListener("pointerup", up);
          cropBox.removeEventListener("pointercancel", up);
        }
        cropBox.addEventListener("pointermove", move);
        cropBox.addEventListener("pointerup", up);
        cropBox.addEventListener("pointercancel", up);
        ev.preventDefault();
      });
    }
    $("disableCloud").addEventListener("click", function () {
      const api = cloudApi();
      if (api) api.disable();
      syncInternalUi();
      if (state.step === "cloud") {
        cloudFallback("已關閉雲端預填。請自己填。");
        afterOcr();
      }
    });
    $("cloudConsentCheck").addEventListener("change", function () {
      const api = cloudApi();
      const url = api ? api.workerUrl() : "";
      $("cloudAgree").disabled = !$("cloudConsentCheck").checked || !url || cloudBusy;
    });
    $("cloudAgree").addEventListener("click", function () { acceptCloud(); });
    $("cloudDecline").addEventListener("click", declineCloud);
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
    const api = cloudApi();
    if (api) {
      api.syncFromLocation();
      state.crop = api.defaultCrop();
    }
    syncInternalUi();
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
