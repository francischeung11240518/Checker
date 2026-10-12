/* Show approved user reports beside Consumer Council prices.
   Never writes product.prices. Never shows the shelf photo. */
(function () {
  const S = window.PricewatchShared;
  const Store = window.PricewatchReports;
  if (!S || !Store || typeof nowPricesHtml !== "function" || typeof cardsHtml !== "function") return;

  let byProduct = new Map();
  let loose = [];

  function newer(a, b) {
    const ta = a.publishedAt || a.reportedAt || a.updatedAt || "";
    const tb = b.publishedAt || b.reportedAt || b.updatedAt || "";
    return ta > tb;
  }

  function indexRows(rows) {
    byProduct = new Map();
    loose = [];
    const approved = (rows || []).filter(function (r) { return r.status === "approved" && r.price > 0; });
    for (let i = 0; i < approved.length; i++) {
      const r = approved[i];
      const known = r.productCode && typeof PRODUCTS !== "undefined"
        && PRODUCTS.some(function (p) { return p.code === r.productCode; });
      if (!known) {
        loose.push(r);
        continue;
      }
      if (!byProduct.has(r.productCode)) byProduct.set(r.productCode, new Map());
      const shops = byProduct.get(r.productCode);
      const prev = shops.get(r.shopCode);
      if (!prev || newer(r, prev)) shops.set(r.shopCode, r);
    }
  }

  function reportsFor(product) {
    if (!product || !product.code) return [];
    const shops = byProduct.get(product.code);
    if (!shops) return [];
    const list = Array.from(shops.values());
    const order = (typeof RETAILER_ORDER !== "undefined" && RETAILER_ORDER) || [];
    list.sort(function (a, b) {
      const ia = order.indexOf(a.shopCode);
      const ib = order.indexOf(b.shopCode);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return list;
  }

  function shopLabel(code) {
    if (typeof RETAILER !== "undefined" && RETAILER[code]) return RETAILER[code];
    return S.shopName(code);
  }

  function userSpan(r) {
    const bits = [];
    if (r.priceKind && r.priceKind !== "unknown") bits.push(S.kindLabel(r.priceKind));
    if (r.unit && r.unit !== "each") bits.push(S.unitLabel(r.unit));
    if (r.branch) bits.push(r.branch);
    const date = S.formatHKDate(r.reportedAt || r.publishedAt);
    if (date) bits.push(date);
    bits.push("非消委會");
    const offer = r.offerText
      ? '<span class="offer">' + escapeHtml(r.offerText) + "</span>"
      : "";
    return '<span class="price user-report"><span class="shelf-main"><span class="user-tag">用戶上報</span>'
      + escapeHtml(shopLabel(r.shopCode)) + " " + money(r.price) + "</span>"
      + offer
      + '<span class="offer">' + escapeHtml(bits.join(" · ")) + "</span></span>";
  }

  function userSpans(product) {
    return reportsFor(product).map(userSpan).join("");
  }

  const origNow = nowPricesHtml;
  nowPricesHtml = function (product) {
    const base = origNow(product);
    const extra = userSpans(product);
    if (!extra) return base;
    if (base.indexOf("暫時未有今日價") !== -1) {
      return '<p class="note">消委會暫時未有今日價。</p>' + extra;
    }
    return base + extra;
  };

  const origCards = cardsHtml;
  cardsHtml = function (results) {
    return (results || []).map(function (r) {
      const href = "report.html?code=" + encodeURIComponent(r.code)
        + (typeof activeShop === "string" && activeShop ? "&shop=" + encodeURIComponent(activeShop) : "");
      return '<article class="card">'
        + '<button type="button" class="card-hit" data-code="' + escapeHtml(r.code) + '">'
        + '<span class="brand">' + escapeHtml(brandLine(r)) + "</span>"
        + '<span class="pname">' + escapeHtml(r.name_zh || "") + "</span>"
        + '<span class="each">' + escapeHtml(eachPrice(r.name_zh, bestPay(r.prices))) + "</span>"
        + '<span class="prices">' + priceLine(r.prices, r.name_zh) + userSpans(r) + "</span>"
        + '<span class="tap">睇價格走勢</span>'
        + "</button>"
        + '<a class="report-link" href="' + href + '">上報價錢</a>'
        + packsHtml(r.code)
        + "</article>";
    }).join("");
  };
  void origCards;

  function placeReportButton(code) {
    let a = document.getElementById("reportThis");
    if (!a) {
      a = document.createElement("a");
      a.id = "reportThis";
      a.className = "report-link";
      a.textContent = "上報價錢";
      const block = document.getElementById("nowBlock");
      if (!block || !block.parentNode) return;
      block.insertAdjacentElement("afterend", a);
    }
    let href = "report.html?code=" + encodeURIComponent(code);
    if (typeof activeShop === "string" && activeShop) href += "&shop=" + encodeURIComponent(activeShop);
    a.href = href;
  }

  const origOpen = openDetail;
  openDetail = function (code, fromPop) {
    origOpen(code, fromPop);
    const detail = document.getElementById("detail");
    if (detail && !detail.hidden) placeReportButton(code);
  };

  function looseCard(r) {
    return '<article class="card">'
      + '<span class="brand">用戶上報 · 未入產品庫</span>'
      + '<span class="pname">' + escapeHtml(r.productName || "") + "</span>"
      + '<span class="prices">' + userSpan(r) + "</span>"
      + '<span class="tap">暫時冇消委會走勢</span>'
      + "</article>";
  }

  function appendLoose(query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q || !loose.length) return;
    const hits = loose.filter(function (r) {
      const hay = (String(r.productName || "") + " " + String(r.spec || "")).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    if (!hits.length) return;
    const box = document.getElementById("out");
    if (!box) return;
    const miss = box.querySelector(":scope > .miss");
    if (miss) miss.remove();
    const wrap = document.createElement("div");
    wrap.className = "loose-reports";
    wrap.innerHTML = '<p class="count">用戶上報（未入產品庫）</p>' + hits.map(looseCard).join("");
    box.appendChild(wrap);
  }

  const origRender = render;
  render = function (query) {
    origRender(query);
    const detail = document.getElementById("detail");
    if (detail && !detail.hidden) return;
    appendLoose(query);
  };

  function repaint() {
    const detail = document.getElementById("detail");
    if (detail && !detail.hidden && typeof chartCode === "string" && chartCode) {
      const product = PRODUCTS.find(function (p) { return p.code === chartCode; });
      const latest = document.getElementById("latest");
      if (product && latest) latest.innerHTML = nowPricesHtml(product);
      placeReportButton(chartCode);
      return;
    }
    const input = document.getElementById("q");
    render(input ? input.value : "");
  }

  async function reload() {
    try {
      const rows = await Store.list();
      indexRows(rows);
    } catch (e) {
      return;
    }
    repaint();
  }

  window.addEventListener("storage", function (ev) {
    if (ev.key === Store.TOUCH_KEY) reload();
  });
  try {
    const bc = new BroadcastChannel("pricewatch-reports");
    bc.onmessage = function () { reload(); };
  } catch (e) {}

  reload();
})();
