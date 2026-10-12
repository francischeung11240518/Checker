/* Admin review for same-device photo reports.
   Approve publishes structured fields only. Consumer Council prices stay untouched. */
(function () {
  const S = window.PricewatchShared;
  const Store = window.PricewatchReports;
  if (!S || !Store) return;

  const panel = document.getElementById("panel-reports");
  if (!panel) return;

  let filter = "pending";
  let catalog = null;
  let photoUrl = "";
  let openId = "";
  let thumbUrls = [];

  function revokeThumbs() {
    thumbUrls.forEach(function (url) { URL.revokeObjectURL(url); });
    thumbUrls = [];
  }

  function revokePhoto() {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = "";
  }

  function statusLabel(status) {
    return { pending: "待審核", approved: "已通過", returned: "退回改", rejected: "已拒絕" }[status] || status;
  }

  function flagsFor(row) {
    const flags = [];
    if (row._duplicate) flags.push("重複相");
    if (row._far) flags.push("同消委會差好遠");
    return flags;
  }

  function decorate(rows) {
    const counts = new Map();
    rows.forEach(function (r) {
      if (!r.photoHash || r.status === "rejected") return;
      counts.set(r.photoHash, (counts.get(r.photoHash) || 0) + 1);
    });
    return rows.map(function (r) {
      const copy = Object.assign({}, r);
      copy._duplicate = !!(r.photoHash && counts.get(r.photoHash) > 1 && r.status !== "rejected");
      const product = catalog && r.productCode ? catalog.byCode.get(r.productCode) : null;
      const cc = S.ccOffer(product, r.shopCode);
      copy._cc = cc;
      copy._far = !!(cc && S.isFarFromCc(r.price, cc.shelf));
      return copy;
    });
  }

  function ccText(row) {
    if (!row.productCode) return "未配對站內產品，暫時冇消委會價可對。通過唔會寫入消委會價。";
    if (!catalog) return "消委會產品庫載入中…";
    if (!catalog.byCode.get(row.productCode)) return "搵唔到呢個產品編號。通過唔會改消委會價。";
    if (!row._cc) {
      return "消委會未有 " + S.shopName(row.shopCode) + " 嘅現價。通過只會另外標「用戶上報」。";
    }
    const offer = row._cc.zh || row._cc.en;
    return "消委會現價 " + S.formatMoney(row._cc.shelf)
      + (offer ? "（" + offer + "）" : "")
      + "。通過只會並排顯示「用戶上報」，唔會覆蓋呢個價。";
  }

  async function showList() {
    openId = "";
    revokePhoto();
    const list = document.getElementById("reportList");
    const detail = document.getElementById("reportDetail");
    list.hidden = false;
    detail.hidden = true;
    detail.innerHTML = "";
    let rows = [];
    try {
      rows = await Store.list();
    } catch (e) {
      list.innerHTML = '<p class="empty">呢個瀏覽器未能讀取上報。</p>';
      return;
    }
    const decorated = decorate(rows);
    const counts = { pending: 0, approved: 0, returned: 0, rejected: 0 };
    decorated.forEach(function (r) {
      if (counts[r.status] != null) counts[r.status] += 1;
    });
    document.querySelectorAll("[data-report-filter]").forEach(function (btn) {
      const id = btn.getAttribute("data-report-filter");
      const on = id === filter;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      const base = { pending: "待審", approved: "已通過", returned: "退回", rejected: "已拒絕" }[id];
      btn.textContent = base + " " + (counts[id] || 0);
    });
    const shown = decorated.filter(function (r) { return r.status === filter; });
    shown.sort(function (a, b) { return String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")); });
    revokeThumbs();
    if (!shown.length) {
      list.innerHTML = '<p class="empty">呢個篩選未有上報。用同一部機交一條先會出現喺度。</p>';
      return;
    }
    const cards = await Promise.all(shown.map(async function (r) {
      let img = '<div class="thumb ph">無圖</div>';
      if (r.hasPhoto && r.status !== "rejected") {
        const blob = await Store.getPhoto(r.id);
        if (blob) {
          const url = URL.createObjectURL(blob);
          thumbUrls.push(url);
          img = '<img class="thumb" alt="只供審核嘅價牌縮圖" src="' + url + '">';
        }
      } else if (r.status === "rejected") {
        img = '<div class="thumb ph">已刪圖</div>';
      }
      const flags = flagsFor(r);
      return '<article class="card"><div class="report-row">' + img + "<div><h2>"
        + S.escapeHtml(r.productName || "未填產品") + "</h2><p class=\"shop\">"
        + S.escapeHtml(S.shopName(r.shopCode))
        + (r.branch ? " · " + S.escapeHtml(r.branch) : "")
        + "</p><p><span class=\"k\">價錢</span>" + S.escapeHtml(S.formatMoney(r.price)) + "</p><p><span class=\"k\">時間</span>"
        + S.escapeHtml(S.formatHKWhen(r.reportedAt || r.createdAt)) + "</p><p><span class=\"k\">讀相</span>"
        + S.escapeHtml(S.confidenceLabel(r.ocr && r.ocr.confidence))
        + (r.photoKind === "receipt" ? " · 收據" : " · 價牌")
        + "</p>"
        + (flags.length ? '<p class="warn">' + S.escapeHtml(flags.join("、")) + "</p>" : "")
        + '<p class="state">' + S.escapeHtml(statusLabel(r.status)) + "</p></div></div>"
        + '<div class="actions"><button type="button" data-open="' + S.escapeHtml(r.id) + '">打開</button></div></article>';
    }));
    list.innerHTML = cards.join("");
  }

  function readEditor(row) {
    const price = S.parsePrice(document.getElementById("admPrice").value);
    const newProduct = document.getElementById("admNew").checked;
    const picked = document.getElementById("admPicked").getAttribute("data-code") || "";
    const typed = document.getElementById("admNewName").value.trim().slice(0, 80);
    return {
      shopCode: document.getElementById("admShop").value,
      branch: document.getElementById("admBranch").value.trim().slice(0, 40),
      productCode: newProduct ? "" : picked,
      productName: newProduct ? typed : (document.getElementById("admPicked").getAttribute("data-name") || row.productName || ""),
      newProduct: newProduct,
      spec: document.getElementById("admSpec").value.trim().slice(0, 40),
      price: price,
      offerText: document.getElementById("admOffer").value.trim().slice(0, 40),
      unit: document.getElementById("admUnit").value,
      priceKind: document.querySelector("#admKind [aria-pressed='true']")
        ? document.querySelector("#admKind [aria-pressed='true']").getAttribute("data-adm-kind")
        : (row.priceKind || "unknown"),
      note: document.getElementById("admNote").value.trim().slice(0, 40),
    };
  }

  function renderProductHits(query) {
    const box = document.getElementById("admHits");
    if (!box) return;
    if (!catalog) {
      box.innerHTML = '<p class="sub">產品庫載入中…</p>';
      return;
    }
    const hits = S.searchCatalog(catalog, query);
    if (!query.trim()) {
      box.innerHTML = "";
      return;
    }
    if (!hits.length) {
      box.innerHTML = '<p class="sub">搵唔到。可以標記新貨。</p>';
      return;
    }
    box.innerHTML = hits.map(function (p) {
      return '<button type="button" data-adm-pick="' + S.escapeHtml(p.c) + '">' + S.escapeHtml(S.productTitle(p)) + "</button>";
    }).join("");
  }

  function setPicked(code, name) {
    const el = document.getElementById("admPicked");
    el.setAttribute("data-code", code || "");
    el.setAttribute("data-name", name || "");
    el.textContent = code ? ("已揀：" + name) : "未揀站內產品";
    refreshCcPreview();
  }

  function refreshCcPreview() {
    const box = document.getElementById("admCc");
    if (!box || !openId) return;
    const editedShop = document.getElementById("admShop").value;
    const editedCode = document.getElementById("admNew").checked
      ? ""
      : (document.getElementById("admPicked").getAttribute("data-code") || "");
    const price = S.parsePrice(document.getElementById("admPrice").value);
    const fake = { productCode: editedCode, shopCode: editedShop, price: price, _cc: null };
    if (catalog && editedCode) {
      const product = catalog.byCode.get(editedCode);
      fake._cc = S.ccOffer(product, editedShop);
    }
    let text = ccText(fake);
    if (fake._cc && price != null && S.isFarFromCc(price, fake._cc.shelf)) {
      text += " 同消委會差好遠，請再睇清楚先通過。";
    }
    box.textContent = text;
  }

  async function showDetail(id) {
    const row = await Store.get(id);
    if (!row) {
      showList();
      return;
    }
    openId = id;
    revokePhoto();
    const list = document.getElementById("reportList");
    const detail = document.getElementById("reportDetail");
    list.hidden = true;
    detail.hidden = false;
    let img = '<p class="sub">冇相。</p>';
    if (row.status === "rejected" || !row.hasPhoto) {
      img = '<p class="sub">原圖已刪或者冇有留低。公開頁本來就唔顯示相。</p>';
    } else {
      const blob = await Store.getPhoto(id);
      if (blob) {
        photoUrl = URL.createObjectURL(blob);
        img = '<img id="admPhoto" class="review-photo" alt="只供審核嘅原圖" src="' + photoUrl + '">';
      }
    }
    const decorated = decorate([row])[0];
    const kindButtons = S.PRICE_KINDS.map(function (k) {
      const on = (row.priceKind || "unknown") === k.id;
      return '<button type="button" data-adm-kind="' + k.id + '" aria-pressed="' + (on ? "true" : "false") + '">'
        + S.escapeHtml(k.label) + "</button>";
    }).join("");
    const shopOptions = S.SHOPS.map(function (s) {
      return '<option value="' + s.code + '"' + (s.code === row.shopCode ? " selected" : "") + ">"
        + S.escapeHtml(s.name) + "</option>";
    }).join("");
    const unitOptions = S.UNITS.map(function (u) {
      return '<option value="' + u.id + '"' + (u.id === (row.unit || "each") ? " selected" : "") + ">"
        + S.escapeHtml(u.label) + "</option>";
    }).join("");
    const flags = flagsFor(decorated);
    detail.innerHTML = '<button type="button" id="admBack">返回列表</button>'
      + '<div class="review-grid"><div>' + img
      + '<p class="sub">撳相可以放大。公開頁唔會顯示呢張相。</p></div><div>'
      + "<p><span class=\"k\">狀態</span>" + S.escapeHtml(statusLabel(row.status)) + "</p>"
      + "<p><span class=\"k\">時間</span>" + S.escapeHtml(S.formatHKWhen(row.reportedAt || row.createdAt)) + "</p>"
      + "<p><span class=\"k\">讀相</span>" + S.escapeHtml(S.confidenceLabel(row.ocr && row.ocr.confidence))
      + (row.ocr && row.ocr.failed ? "（讀唔到）" : "") + "</p>"
      + (flags.length ? '<p class="warn">' + S.escapeHtml(flags.join("、")) + "</p>" : "")
      + (row.returnReason ? "<p>上次退回：" + S.escapeHtml(row.returnReason) + "</p>" : "")
      + (row.rejectReason ? "<p>拒絕原因：" + S.escapeHtml(row.rejectReason) + "</p>" : "")
      + '<label class="field">超市<select id="admShop">' + shopOptions + "</select></label>"
      + '<label class="field">分店<input id="admBranch" type="text" maxlength="40" value="' + S.escapeHtml(row.branch || "") + '"></label>'
      + '<label class="field">搜尋產品<input id="admSearch" type="search" autocomplete="off" placeholder="打產品名"></label>'
      + '<div id="admHits" class="picks"></div>'
      + '<p id="admPicked" data-code="' + S.escapeHtml(row.productCode || "") + '" data-name="'
      + S.escapeHtml(row.newProduct ? "" : (row.productName || "")) + '"></p>'
      + '<label class="choice"><input type="checkbox" id="admNew"' + (row.newProduct ? " checked" : "") + ">庫入面搵唔到</label>"
      + '<label class="field" id="admNewWrap">新貨名稱<input id="admNewName" type="text" maxlength="80" value="'
      + S.escapeHtml(row.newProduct ? (row.productName || "") : "") + '"></label>'
      + '<label class="field">規格<input id="admSpec" type="text" maxlength="40" value="' + S.escapeHtml(row.spec || "") + '"></label>'
      + '<label class="field">價錢<input id="admPrice" type="text" inputmode="decimal" value="' + S.escapeHtml(row.price != null ? String(row.price) : "") + '"></label>'
      + '<label class="field">優惠<input id="admOffer" type="text" maxlength="40" value="' + S.escapeHtml(row.offerText || "") + '"></label>'
      + '<label class="field">單位<select id="admUnit">' + unitOptions + "</select></label>"
      + '<p class="sub">邊種價</p><div class="stack row" id="admKind">' + kindButtons + "</div>"
      + '<label class="field">備註（唔公開）<input id="admNote" type="text" maxlength="40" value="' + S.escapeHtml(row.note || "") + '"></label>'
      + (row.ocr && row.ocr.excerpt ? '<p class="sub">系統讀到（長數字已遮）：' + S.escapeHtml(row.ocr.excerpt) + "</p>" : "")
      + '<p id="admCc" class="card"></p>'
      + '<p id="admErr" class="warn" hidden></p>'
      + '<div class="stack">'
      + '<button type="button" class="primary" id="admApprove">通過並公開</button>'
      + '<div id="admApproveBox" hidden><p>確定通過？公開頁只顯示店、貨、價、時間同可選分店，唔顯示相，亦唔會改消委會現價。</p>'
      + '<div class="stack row"><button type="button" class="primary" id="admApproveYes">確定通過</button><button type="button" id="admApproveNo">取消</button></div></div>'
      + '<button type="button" id="admReturn">退回改</button>'
      + '<div id="admReturnBox" hidden>'
      + '<div class="stack row">'
      + '<button type="button" data-reason="價唔清">價唔清</button>'
      + '<button type="button" data-reason="影到人">影到人</button>'
      + '<button type="button" data-reason="對錯貨">對錯貨</button>'
      + "</div>"
      + '<label class="field">退回原因<input id="admReturnText" type="text" maxlength="40" placeholder="揀上面或者自己寫"></label>'
      + '<button type="button" class="primary" id="admReturnYes">確定退回</button>'
      + "</div>"
      + '<button type="button" id="admReject">拒絕並刪圖</button>'
      + '<div id="admRejectBox" hidden>'
      + '<div class="stack row">'
      + '<button type="button" data-reject="影到人面">影到人面</button>'
      + '<button type="button" data-reject="會員卡或個人資料">會員卡或個人資料</button>'
      + '<button type="button" data-reject="明顯假">明顯假</button>'
      + "</div>"
      + '<label class="field">拒絕原因<input id="admRejectText" type="text" maxlength="40"></label>'
      + '<p class="sub">確定之後，原圖會喺呢部機刪走。</p>'
      + '<button type="button" class="primary" id="admRejectYes">確定拒絕並刪圖</button>'
      + "</div></div></div></div>";

    setPicked(row.productCode || "", row.newProduct ? "" : (row.productName || ""));
    const newWrap = document.getElementById("admNewWrap");
    newWrap.hidden = !row.newProduct;
    document.getElementById("admPhoto") && document.getElementById("admPhoto").addEventListener("click", function () {
      this.classList.toggle("big");
    });
    document.getElementById("admBack").addEventListener("click", showList);
    document.getElementById("admSearch").addEventListener("input", function () {
      renderProductHits(this.value);
    });
    document.getElementById("admHits").addEventListener("click", function (ev) {
      const btn = ev.target.closest("[data-adm-pick]");
      if (!btn || !catalog) return;
      const p = catalog.byCode.get(btn.getAttribute("data-adm-pick"));
      if (!p) return;
      document.getElementById("admNew").checked = false;
      newWrap.hidden = true;
      setPicked(p.c, S.productTitle(p));
      if (!document.getElementById("admSpec").value) document.getElementById("admSpec").value = p.nz || "";
    });
    document.getElementById("admNew").addEventListener("change", function () {
      newWrap.hidden = !this.checked;
      if (this.checked) setPicked("", "");
      else refreshCcPreview();
    });
    ["admShop", "admPrice"].forEach(function (id) {
      document.getElementById(id).addEventListener("input", refreshCcPreview);
      document.getElementById(id).addEventListener("change", refreshCcPreview);
    });
    document.getElementById("admKind").addEventListener("click", function (ev) {
      const btn = ev.target.closest("[data-adm-kind]");
      if (!btn) return;
      document.querySelectorAll("#admKind [data-adm-kind]").forEach(function (el) {
        el.setAttribute("aria-pressed", el === btn ? "true" : "false");
      });
    });
    document.getElementById("admApprove").addEventListener("click", function () {
      document.getElementById("admApproveBox").hidden = false;
      document.getElementById("admReturnBox").hidden = true;
      document.getElementById("admRejectBox").hidden = true;
    });
    document.getElementById("admApproveNo").addEventListener("click", function () {
      document.getElementById("admApproveBox").hidden = true;
    });
    document.getElementById("admApproveYes").addEventListener("click", function () { act("approved"); });
    document.getElementById("admReturn").addEventListener("click", function () {
      document.getElementById("admReturnBox").hidden = false;
      document.getElementById("admApproveBox").hidden = true;
      document.getElementById("admRejectBox").hidden = true;
    });
    detail.querySelectorAll("[data-reason]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.getElementById("admReturnText").value = btn.getAttribute("data-reason");
      });
    });
    document.getElementById("admReturnYes").addEventListener("click", function () { act("returned"); });
    document.getElementById("admReject").addEventListener("click", function () {
      document.getElementById("admRejectBox").hidden = false;
      document.getElementById("admApproveBox").hidden = true;
      document.getElementById("admReturnBox").hidden = true;
    });
    detail.querySelectorAll("[data-reject]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.getElementById("admRejectText").value = btn.getAttribute("data-reject");
      });
    });
    document.getElementById("admRejectYes").addEventListener("click", function () { act("rejected"); });
    refreshCcPreview();
  }

  async function act(status) {
    const err = document.getElementById("admErr");
    const current = await Store.get(openId);
    if (!current) return;
    const edited = readEditor(current);
    if (status === "approved") {
      if (edited.price == null) {
        err.hidden = false;
        err.textContent = "請填正確價錢。";
        return;
      }
      if (!edited.productName) {
        err.hidden = false;
        err.textContent = "請揀產品或者填新貨名稱。";
        return;
      }
    }
    let reason = "";
    if (status === "returned") {
      reason = document.getElementById("admReturnText").value.trim().slice(0, 40);
      if (!reason) {
        err.hidden = false;
        err.textContent = "請揀或者寫退回原因。";
        return;
      }
    }
    if (status === "rejected") {
      reason = document.getElementById("admRejectText").value.trim().slice(0, 40);
      if (!reason) {
        err.hidden = false;
        err.textContent = "請揀或者寫拒絕原因。";
        return;
      }
    }
    const now = new Date().toISOString();
    const meta = Object.assign({}, current, edited, {
      status: status,
      updatedAt: now,
      returnReason: status === "returned" ? reason : "",
      rejectReason: status === "rejected" ? reason : (status === "approved" ? "" : current.rejectReason || ""),
      publishedAt: status === "approved" ? now : (current.publishedAt || ""),
    });
    if (status !== "approved") meta.publishedAt = current.publishedAt || "";
    if (status === "approved") meta.publishedAt = now;
    try {
      await Store.save(meta, status === "rejected" ? null : undefined);
    } catch (e) {
      err.hidden = false;
      err.textContent = "儲存失敗。";
      return;
    }
    filter = status === "approved" ? "approved" : (status === "returned" ? "returned" : "rejected");
    showList();
  }

  document.getElementById("reportFilters").addEventListener("click", function (ev) {
    const btn = ev.target.closest("[data-report-filter]");
    if (!btn) return;
    filter = btn.getAttribute("data-report-filter");
    showList();
  });
  document.getElementById("reportList").addEventListener("click", function (ev) {
    const btn = ev.target.closest("[data-open]");
    if (!btn) return;
    showDetail(btn.getAttribute("data-open"));
  });
  document.body.addEventListener("click", function (ev) {
    const sec = ev.target.closest("[data-section-btn]");
    if (sec && sec.getAttribute("data-section-btn") === "reports") showList();
  });

  S.loadCatalog().then(function (cat) { catalog = cat; }).catch(function () { catalog = null; });

  if (location.hash === "#reports") {
    const btn = document.querySelector('[data-section-btn="reports"]');
    if (btn) btn.click();
  }
})();
