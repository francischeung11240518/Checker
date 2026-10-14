/* Admin review for uploaded price-tag photos.
   The shared secret is typed into this page. It is not stored in source. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CheckerPhotoAdmin = api;
  if (typeof document !== "undefined") api.mount(document);
})(typeof window !== "undefined" ? window : null, function () {
  const URL_SESSION = "pricewatch-photo-admin-url";
  const KEY_SESSION = "pricewatch-photo-admin-key";

  function isWorkerUrlAllowed(url) {
    let parsed;
    try {
      parsed = new URL(String(url || "").trim());
    } catch (e) {
      return false;
    }
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname;
    if (parsed.protocol === "http:") return host === "localhost" || host === "127.0.0.1";
    if (parsed.protocol !== "https:") return false;
    if (host === "localhost" || host === "127.0.0.1") return true;
    if (!/^[a-z0-9.-]+$/.test(host)) return false;
    const parts = host.split(".");
    if (parts.length < 3) return false;
    if (parts.slice(-2).join(".") !== "workers.dev") return false;
    return parts.slice(0, -2).every(function (part) { return part.length > 0; });
  }

  function workerUrlFrom(search, storageGet) {
    const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
    const fromQuery = String(params.get("uploadUrl") || "").trim();
    if (fromQuery && isWorkerUrlAllowed(fromQuery)) return fromQuery;
    let stored = "";
    try { stored = storageGet ? storageGet(URL_SESSION) || "" : ""; } catch (e) { stored = ""; }
    stored = String(stored || "").trim();
    return isWorkerUrlAllowed(stored) ? stored : "";
  }

  function buildPatch(action, fields) {
    const src = fields || {};
    return {
      action: action,
      productName: src.productName || "",
      price: src.price || "",
      offer: src.offer || "",
      adminNote: src.adminNote || "",
    };
  }

  function statusLabel(status) {
    return { pending: "待審核", approved: "已通過", rejected: "已拒絕" }[status] || status;
  }

  function formatStamp(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso || "");
    return new Intl.DateTimeFormat("zh-HK", {
      timeZone: "Asia/Hong_Kong",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(d);
  }

  function mount(doc) {
    const workerInput = doc.getElementById("workerUrl");
    const keyInput = doc.getElementById("adminKey");
    const loadBtn = doc.getElementById("loadBtn");
    const forgetBtn = doc.getElementById("forgetBtn");
    const setupError = doc.getElementById("setupError");
    const filters = doc.getElementById("filters");
    const list = doc.getElementById("list");
    const detail = doc.getElementById("detail");
    const queueBtn = doc.getElementById("queueBtn");
    const queue = doc.getElementById("queue");
    const toast = doc.getElementById("toast");
    if (!workerInput || !keyInput || !loadBtn || !list || !detail) return;

    const state = { status: "pending", urls: [] };

    function sessionGet(key) {
      try { return sessionStorage.getItem(key) || ""; } catch (e) { return ""; }
    }
    function sessionSet(key, value) {
      try { sessionStorage.setItem(key, value); } catch (e) {}
    }
    function sessionRemove(key) {
      try { sessionStorage.removeItem(key); } catch (e) {}
    }
    function revoke() {
      state.urls.forEach(function (url) { URL.revokeObjectURL(url); });
      state.urls = [];
    }
    function setError(text) {
      setupError.hidden = !text;
      setupError.textContent = text || "";
    }
    function showToast(text) {
      toast.hidden = !text;
      toast.textContent = text || "";
    }
    function baseUrl() {
      const value = workerInput.value.trim();
      if (!isWorkerUrlAllowed(value)) return "";
      return value;
    }
    function authHeaders(json) {
      const headers = { "x-admin-key": keyInput.value };
      if (json) headers["content-type"] = "application/json";
      return headers;
    }

    const fromQuery = workerUrlFrom(location.search, function () { return ""; });
    workerInput.value = fromQuery || sessionGet(URL_SESSION);
    keyInput.value = sessionGet(KEY_SESSION);

    function remember() {
      if (baseUrl()) sessionSet(URL_SESSION, baseUrl());
      if (keyInput.value) sessionSet(KEY_SESSION, keyInput.value);
    }

    async function api(path, options) {
      const root = baseUrl();
      if (!root) throw new Error("bad-url");
      if (!keyInput.value.trim()) throw new Error("no-key");
      const res = await fetch(new URL(path, root), options || {});
      let data = null;
      const ctype = res.headers.get("content-type") || "";
      if (ctype.indexOf("application/json") !== -1) {
        try { data = await res.json(); } catch (e) { data = null; }
      }
      return { res: res, data: data };
    }

    function line(label, value) {
      const p = doc.createElement("p");
      const k = doc.createElement("span");
      k.className = "k";
      k.textContent = label;
      p.append(k, doc.createTextNode(value || "未填"));
      return p;
    }

    async function fillThumbs(items) {
      let cursor = 0;
      async function worker() {
        while (cursor < items.length) {
          const item = items[cursor];
          cursor += 1;
          const img = list.querySelector('[data-thumb="' + item.id + '"]');
          if (!img) continue;
          try {
            const out = await api("/submissions/" + item.id + "/image", { headers: authHeaders(false) });
            if (!out.res.ok) continue;
            const blob = await out.res.blob();
            const url = URL.createObjectURL(blob);
            state.urls.push(url);
            img.src = url;
          } catch (e) { /* thumbnail is optional */ }
        }
      }
      const count = Math.min(4, items.length);
      const jobs = [];
      for (let i = 0; i < count; i++) jobs.push(worker());
      await Promise.all(jobs);
    }

    function renderList(items) {
      revoke();
      list.replaceChildren();
      detail.hidden = true;
      detail.replaceChildren();
      list.hidden = false;
      filters.hidden = false;
      if (!items.length) {
        const empty = doc.createElement("p");
        empty.className = "empty";
        empty.textContent = state.status === "pending" ? "未有待審核嘅相。" : "呢個篩選未有紀錄。";
        list.append(empty);
        return;
      }
      items.forEach(function (item) {
        const btn = doc.createElement("button");
        btn.type = "button";
        btn.className = "row";
        btn.setAttribute("data-open", item.id);
        const img = doc.createElement("img");
        img.className = "thumb";
        img.alt = "";
        img.setAttribute("data-thumb", item.id);
        const text = doc.createElement("span");
        text.className = "rowtext";
        const title = doc.createElement("strong");
        title.textContent = formatStamp(item.createdAt);
        const nick = doc.createElement("span");
        nick.textContent = item.nickname ? item.nickname : "未填暱稱";
        const mail = doc.createElement("span");
        mail.textContent = item.email ? item.email : "未留電郵";
        text.append(title, nick, mail);
        btn.append(img, text);
        list.append(btn);
      });
      fillThumbs(items);
    }

    async function loadList() {
      setError("");
      queue.hidden = true;
      if (!baseUrl()) {
        setError("上載服務位址只可以係 workers.dev 或本機。");
        return;
      }
      if (!keyInput.value.trim()) {
        setError("請輸入管理員金鑰。");
        return;
      }
      loadBtn.disabled = true;
      try {
        const out = await api("/submissions?status=" + encodeURIComponent(state.status), {
          headers: authHeaders(false),
        });
        if (out.res.status === 401) {
          setError("管理員金鑰不正確。");
          return;
        }
        if (!out.res.ok || !out.data || !out.data.ok) {
          setError((out.data && out.data.message) || "載入失敗。");
          return;
        }
        remember();
        renderList(out.data.items || []);
      } catch (e) {
        setError(e && e.message === "bad-url" ? "上載服務位址不正確。" : "連唔上上載服務。");
      } finally {
        loadBtn.disabled = false;
      }
    }

    function field(label, id, value) {
      const wrap = doc.createElement("label");
      wrap.className = "field";
      wrap.append(doc.createTextNode(label));
      const input = doc.createElement("input");
      input.id = id;
      input.type = "text";
      input.value = value || "";
      wrap.append(input);
      return wrap;
    }

    async function openDetail(id) {
      setError("");
      showToast("");
      const out = await api("/submissions/" + id, { headers: authHeaders(false) });
      if (!out.res.ok || !out.data || !out.data.item) {
        setError((out.data && out.data.message) || "載入失敗。");
        return;
      }
      const item = out.data.item;
      revoke();
      list.hidden = true;
      filters.hidden = true;
      queue.hidden = true;
      detail.hidden = false;
      detail.replaceChildren();

      const back = doc.createElement("button");
      back.type = "button";
      back.className = "ghost";
      back.textContent = "返回清單";
      back.addEventListener("click", loadList);

      const img = doc.createElement("img");
      img.className = "shot";
      img.alt = "價牌";
      const when = line("時間", formatStamp(item.createdAt));
      const who = line("暱稱", item.nickname);
      const mail = line("電郵", item.email);
      const stateLine = line("狀態", statusLabel(item.status));

      detail.append(back, img, when, who, mail, stateLine);

      try {
        const photo = await api("/submissions/" + id + "/image", { headers: authHeaders(false) });
        if (photo.res.ok) {
          const blob = await photo.res.blob();
          const url = URL.createObjectURL(blob);
          state.urls.push(url);
          img.src = url;
        }
      } catch (e) { /* photo error stays a blank frame */ }

      const name = field("產品名", "productName", item.productName);
      const price = field("價錢", "price", item.price);
      const offer = field("優惠", "offer", item.offer);
      const noteWrap = doc.createElement("label");
      noteWrap.className = "field";
      noteWrap.append(doc.createTextNode("備註"));
      const hint = doc.createElement("span");
      hint.className = "hint";
      hint.textContent = "拒絕一定要寫。系統只會標記，唔會通知用家。";
      const note = doc.createElement("textarea");
      note.id = "adminNote";
      note.value = item.adminNote || "";
      noteWrap.append(hint, note);

      detail.append(name, price, offer, noteWrap);

      if (item.ocrError) {
        const err = doc.createElement("p");
        err.className = "warn";
        err.textContent = item.ocrError;
        detail.append(err);
      }
      if (item.publishStub && item.publishStub.nextStep) {
        const next = doc.createElement("p");
        next.className = "note";
        next.textContent = item.publishStub.nextStep;
        detail.append(next);
      }

      if (item.status !== "pending") return;

      const ocr = doc.createElement("button");
      ocr.type = "button";
      ocr.textContent = "跑 OCR 預填";
      const approve = doc.createElement("button");
      approve.type = "button";
      approve.className = "primary";
      approve.textContent = "通過並放入上架佇列";
      const reject = doc.createElement("button");
      reject.type = "button";
      reject.className = "danger";
      reject.textContent = "拒絕";
      detail.append(ocr, approve, reject);

      function fields() {
        return {
          productName: doc.getElementById("productName").value,
          price: doc.getElementById("price").value,
          offer: doc.getElementById("offer").value,
          adminNote: doc.getElementById("adminNote").value,
        };
      }

      ocr.addEventListener("click", async function () {
        ocr.disabled = true;
        ocr.textContent = "認字中…";
        setError("");
        try {
          const out = await api("/submissions/" + id + "/ocr", {
            method: "POST",
            headers: authHeaders(false),
          });
          const itemNow = out.data && out.data.item;
          if (itemNow) {
            doc.getElementById("productName").value = itemNow.productName || "";
            doc.getElementById("price").value = itemNow.price || "";
            doc.getElementById("offer").value = itemNow.offer || "";
          }
          if (!out.res.ok || !out.data || out.data.ok !== true) {
            setError((out.data && out.data.message) || "雲端認字暫時未能使用。");
            return;
          }
          showToast("已預填。請核對產品名、價錢同優惠，再決定通過或拒絕。");
        } catch (e) {
          setError("連唔上上載服務。");
        } finally {
          ocr.disabled = false;
          ocr.textContent = "跑 OCR 預填";
        }
      });

      approve.addEventListener("click", async function () {
        approve.disabled = true;
        setError("");
        try {
          const out = await api("/submissions/" + id, {
            method: "PATCH",
            headers: authHeaders(true),
            body: JSON.stringify(buildPatch("approve", fields())),
          });
          if (!out.res.ok || !out.data || out.data.ok !== true) {
            setError((out.data && out.data.message) || "未能通過。");
            return;
          }
          const next = out.data.publishStub && out.data.publishStub.nextStep
            ? out.data.publishStub.nextStep
            : "下一步先人手併入產品資料。";
          showToast("已標記通過，並寫入上架佇列。" + next);
          state.status = "pending";
          await loadList();
        } catch (e) {
          setError("連唔上上載服務。");
        } finally {
          approve.disabled = false;
        }
      });

      reject.addEventListener("click", async function () {
        if (!doc.getElementById("adminNote").value.trim()) {
          setError("請先寫低拒絕原因。系統唔會通知用家。");
          return;
        }
        reject.disabled = true;
        setError("");
        try {
          const out = await api("/submissions/" + id, {
            method: "PATCH",
            headers: authHeaders(true),
            body: JSON.stringify(buildPatch("reject", fields())),
          });
          if (!out.res.ok || !out.data || out.data.ok !== true) {
            setError((out.data && out.data.message) || "未能拒絕。");
            return;
          }
          showToast("已拒絕。只係標記同備註，未有通知用家。");
          await loadList();
        } catch (e) {
          setError("連唔上上載服務。");
        } finally {
          reject.disabled = false;
        }
      });
    }

    filters.addEventListener("click", function (ev) {
      const btn = ev.target.closest("[data-status]");
      if (!btn) return;
      state.status = btn.getAttribute("data-status");
      filters.querySelectorAll("[data-status]").forEach(function (el) {
        el.setAttribute("aria-pressed", el === btn ? "true" : "false");
      });
      showToast("");
      loadList();
    });

    list.addEventListener("click", function (ev) {
      const btn = ev.target.closest("[data-open]");
      if (!btn) return;
      openDetail(btn.getAttribute("data-open")).catch(function () {
        setError("連唔上上載服務。");
      });
    });

    loadBtn.addEventListener("click", function () {
      showToast("");
      loadList();
    });
    const setupForm = doc.getElementById("setupForm");
    if (setupForm) {
      setupForm.addEventListener("submit", function (ev) {
        ev.preventDefault();
        showToast("");
        loadList();
      });
    }
    forgetBtn.addEventListener("click", function () {
      keyInput.value = "";
      sessionRemove(KEY_SESSION);
      showToast("已唔再記住呢個分頁嘅金鑰。");
    });
    queueBtn.addEventListener("click", async function () {
      setError("");
      try {
        const out = await api("/publish-queue", { headers: authHeaders(false) });
        if (!out.res.ok || !out.data || !out.data.ok) {
          setError((out.data && out.data.message) || "載入失敗。");
          return;
        }
        queue.hidden = false;
        queue.replaceChildren();
        const items = out.data.items || [];
        if (!items.length) {
          const empty = doc.createElement("p");
          empty.className = "empty";
          empty.textContent = "上架佇列未有紀錄。";
          queue.append(empty);
          return;
        }
        items.slice().reverse().forEach(function (stub) {
          const card = doc.createElement("article");
          card.className = "card";
          const h = doc.createElement("h2");
          h.textContent = stub.productName || "未填產品名";
          card.append(h);
          card.append(line("價錢", stub.price));
          card.append(line("優惠", stub.offer));
          card.append(line("時間", formatStamp(stub.approvedAt)));
          const next = doc.createElement("p");
          next.className = "note";
          next.textContent = stub.nextStep || "";
          card.append(next);
          queue.append(card);
        });
      } catch (e) {
        setError("連唔上上載服務。");
      }
    });
  }

  return {
    URL_SESSION: URL_SESSION,
    KEY_SESSION: KEY_SESSION,
    isWorkerUrlAllowed: isWorkerUrlAllowed,
    workerUrlFrom: workerUrlFrom,
    buildPatch: buildPatch,
    statusLabel: statusLabel,
    formatStamp: formatStamp,
    mount: mount,
  };
});
