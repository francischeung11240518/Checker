# 雲端讀價牌 — 內部試點骨架

**只供 Francis／內部試。** 公眾 GitHub Pages 預設關閉。未做齊下面 Legal 閘門之前，唔好當正式功能開畀真實用戶。

呢份係技術骨架同操作說明，**唔係法律意見**，唔代替香港執業律師。

相關草稿：[`vision-ocr-upload-notice-draft-zh.md`](vision-ocr-upload-notice-draft-zh.md)。Worker：[`../workers/vision-ocr/README.md`](../workers/vision-ocr/README.md)。

本機貨架認字已經包含萬寧價牌修復（冇 $、上標小數）。消委會公開數據路徑冇改，亦冇爬超市網站。

## 架構（B+C）

1. 用家影相。內部旗標打開時，預覽有一個價牌黃框（預設中下範圍，高度略為加大，以便包到價錢下面嗰行產品名；最大約 85% 邊長，**唔會預設成張貨架**）。
2. 瀏覽器先喺你部機做貨架認字（英文讀價錢，繁體讀產品名，會處理冇 $ 同上標）。讀到合理價錢（信心中或高，而且有價錢）就預填，**唔上雲**。黃框只係之後如果你同意先會上傳嘅範圍。
3. 讀唔到、冇價錢，或者信心低，先問上傳通知。用家剔同意並撳「同意並繼續」之後，先 `POST` 裁好嘅 JPEG。
4. Cloudflare Worker 檢查 kill switch、同意、每日／每月配額、來源同大小，先呼叫 Google Cloud Vision `DOCUMENT_TEXT_DETECTION`（`languageHints` 為 `zh-Hant` 同 `en`，唔另計單位）。
5. 回傳建議品名、價錢同優惠字句做預填（優惠填入上報精靈嘅優惠欄）。用家仍然要改，並且剔「我已核對」先可以提交。
6. Worker 唔通、kill switch 關閉、或者用家拒絕：返本機／人手填，提交唔會壞。

收據**永遠唔上雲**。本機讀到可能係會員、電話或地址嘅字，亦唔會再送去雲端。人面偵測未包括喺呢個骨架（避免多一個 Vision 功能同額外計費）；影相提示仍然要求避開人面同會員卡。

本機 IndexedDB 照舊留低你部機嘅相做審核。雲端請求唔經呢個儲存，Worker **唔寫 R2、唔留原圖**。審計日誌只有時間、成功／失敗、位元組數、配額計數。

## US$15 硬上限同刹車

Google Vision Text Detection／Document Text Detection 公開價（見 [定價頁](https://cloud.google.com/vision/pricing)，上線前再核對）：每月首 **1,000** 單位免費，之後 **US$1.50／1,000**。一次 `DOCUMENT_TEXT_DETECTION`、一張圖 = 1 單位。唔好同 `TEXT_DETECTION` 一齊送。

```text
付費單位上限 = 15 / 1.50 × 1,000 = 10,000
80% 刹車     = 8,000 付費單位
月計數停線   = 1,000 免費 + 8,000 = 9,000 次
估計花費     ≈ US$12（低過 US$15）
```

Worker 環境變數（詳見 Worker README）：

1. `DAILY_REQUEST_CAP` 預設 **50**／日（香港日曆）。
2. 月計數器去到上面 9,000 次就拒絕（`MONTHLY_BUDGET_USD=15`、`MONTHLY_STOP_FRACTION=0.8`）。
3. `VISION_OCR_ENABLED` 預設 **false**。關閉時每個雲端請求回明確錯誤，頁面改人手／本機。
4. API key 或 service account JSON 只用 `wrangler secret put`。靜態頁冇 key。

請另外喺 GCP 設 US$15 預算告警。Worker 計數係估計，KV 唔係原子加總。

## 點樣只俾 Francis 試（公眾頁唔會自己開）

`report-cloud-ocr.js` 入面 `INTERNAL_CLOUD_OCR` **必須維持 `false`**。唔好為咗試用改成 `true` 再部署 Pages。

喺自己部瀏覽器：

1. 部署 Worker 並設定 secret、KV。開跑前先把 `VISION_OCR_ENABLED` 設做 `true`。
2. 打開（位址換做你自己嘅 `*.workers.dev`）：

   `https://francischeung11240518.github.io/Checker/report.html?cloudOcr=1&cloudOcrUrl=https://<name>.workers.dev/`

3. 同意畫面會顯示實際 host。唔同意就唔會 POST。
4. `cloudOcr=1` 會寫入呢個瀏覽器嘅 `localStorage` 鍵 `pricewatch-internal-cloud-ocr=1`，之後唔使再帶 query 都保持內部模式。**Worker 位址唔會由 query 寫入 localStorage**（避免一條連結永久改指向）。想記住位址，喺該瀏覽器執行：

   `localStorage.setItem("pricewatch-cloud-ocr-url", "https://<name>.workers.dev/")`

   只接受 `https://*.workers.dev` 或本機 `http://localhost`／`127.0.0.1`。
5. 關閉：畫面「關閉雲端預填」，或者打開 `report.html?cloudOcr=0`。

未設定 Worker 位址時，即使旗標打開都**唔會上傳**，只可以本機或人手填。

本機試 Worker：`npx wrangler dev`，頁面用 `http://127.0.0.1:<頁面埠>/report.html?cloudOcr=1&cloudOcrUrl=http://127.0.0.1:8787/`。

## PDPO 要點（指標，唔係法律意見）

條件可行的方向係：自願、只為預填、最小化、可拒絕。未完成通知／同意／供應商條款之前，唔好對真實用戶開通。主風險係《個人資料（私隱）條例》（第 486 章）同跨境，唔係爬蟲。《消費者委員會條例》係第 216 章；版權一般係第 528 章。

呢個骨架對齊嘅緩解：

- 上傳前草稿通知加同意；可以揀只用本機／自己填。
- 先裁價牌再傳；預設唔傳成張多產品貨架。
- Worker 認完即棄，唔長期存原圖；日誌冇圖。
- 金鑰只喺 Worker。每日上限、約 US$15 月度刹車、kill switch。
- 收據同讀到疑似個人資料嘅字唔走雲端。

未做、上線公眾前仍要人做：供應商 DPA／關閉再訓練或人工覆核（以 Google 官方設定為準）、私隱政策更新（處理者、跨境、保留、投訴可指 PCPD）、執業律師睇最終文案。通知正文而家係**草稿**。

## 明確唔做

- 唔對真實公眾用戶預設開雲端上傳。
- 唔一次填晒成排多個產品。
- 本機貨架認字同雲端預填一齊保留；雲端仍然預設關閉。
- 唔把 Vision key 放進瀏覽器或 git。
- 唔改消委會開放數據，唔爬超市網。
