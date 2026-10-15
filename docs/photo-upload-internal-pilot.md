# 價牌上載審核 — 內部骨架

給 Francis、Wing。呢份係可試嘅技術骨架，**未對公眾開放，亦未部署**。登入同拒絕通知唔喺範圍內。

Photo-tag upload review, internal skeleton. This is a pilot Francis can try. It is not a public launch and this pull request does not deploy it. Sign-in and rejection emails are out of scope.

## 做了什麼 / What landed

用家開一個內部頁，**先揀超市**（可以搜尋；清單未有就撳「清單冇？新增超市」輸入店名），再影價牌或者由相簿揀一張相，可以留低暱稱同電郵（兩項都可留空）。未揀超市唔可以影相或上傳。相同資料交去 Cloudflare Worker，寫入 R2 同 KV，並記下超市。新店名喺上傳成功之後先寫入共用清單，下一個人開頁會見到。管理員喺另一頁睇清單（縮圖、時間、超市、暱稱、電郵），可以按超市篩選。打開一筆可以改產品名、價錢、優惠，撳「跑 OCR 預填」先會叫現有嘅 `checker-vision-ocr` 讀相，並帶上嗰間超市。萬寧用而家嘅認字；其他店暫時用同一套，百佳預留咗之後先至自己嘅 parser。通過會標記做已通過，並寫入一條上架佇列；拒絕只改狀態同備註。

A person opens an internal page, picks a supermarket first (search the list, or add a name that is not listed), then takes or picks one price-tag photo. Nickname and email may stay blank. The photo controls stay off until a store is chosen. The Worker stores the image in R2 and the row, including the supermarket, in KV. A new store name is added to the shared list only after a successful upload, so the next visitor sees it. The admin list shows a thumbnail, time, supermarket, and the optional contact fields, and can filter by store. The detail screen edits product, price, and offer. **跑 OCR 預填** asks the existing `checker-vision-ocr` Worker to read the stored photo and passes that supermarket. 萬寧 uses the current parser. Other stores use the same parser for now. 百佳 has a reserved profile and no separate parser yet. Approve marks the row and appends a publish stub. Reject stores a note only.

用家部手機**唔會**跑 Tesseract，亦唔會直接叫 Google Vision。搜尋頁同每日價格更新冇改。

The phone does not run Tesseract and does not call Google Vision. Search and the daily price update are unchanged.

## 點樣試 / How to open it

頁面合併到 `main` 之前，GitHub Pages 未有呢兩頁。可以喺倉庫目錄開一個本機網頁伺服器：

Until this is merged, GitHub Pages will not serve the new pages. From the repo root:

```bash
python3 -m http.server 8080
```

用家（要自己帶旗標，搜尋頁冇連結）：

User page (the flag is required; search does not link here):

`http://127.0.0.1:8080/upload.html?pilot=1&uploadUrl=http://127.0.0.1:8787/`

`pilot=1` 會記喺呢個瀏覽器。關掉：打開 `upload.html?pilot=0`。

`uploadUrl` **唔會**寫入 localStorage，避免一條連結永久改指向。想記住位址先自己執行：

`pilot=1` is stored in this browser. Open `upload.html?pilot=0` to turn it off. The Worker URL from the query is not saved. To keep a URL:

```js
localStorage.setItem("pricewatch-photo-upload-url", "https://<name>.workers.dev/")
```

只接受 `https://*.workers.dev`，或者本機 `http://127.0.0.1`／`localhost`。

管理員：

`http://127.0.0.1:8080/admin-uploads.html`

喺頁面貼上 Worker 位址同 `ADMIN_KEY`。金鑰只留喺呢個分頁（sessionStorage），原始碼冇金鑰。`價錢管理` 頁有一條去審核頁嘅連結。

Paste the Worker URL and the `ADMIN_KEY` on that page. The key stays in the tab, not in source. `admin.html` links to the review page.

合併之後嘅 Pages 位址（仍要旗標，仍要 Worker 已部署而且 `UPLOAD_ENABLED=true`）：

After merge, still gated, and only after the Worker is deployed with uploads enabled:

`https://francischeung11240518.github.io/Checker/upload.html?pilot=1&uploadUrl=https://checker-photo-upload.<your-subdomain>.workers.dev/`

`https://francischeung11240518.github.io/Checker/admin-uploads.html`

## 未做 / Out of scope

- 用家登入、帳號、密碼。No user login.
- 拒絕或通過之後發電郵／推送。Reject does not notify anyone.
- 通過**唔會**寫入產品庫，亦唔會改消委會價。Approve appends a stub queue only. Next step is a manual merge.
- 公眾搜尋頁入口。No link from the public search page.
- 用家手機即時 OCR。No client-side OCR.

大過大約 800KB，或者唔係 jpeg／png／webp／gif（例如 iPhone HEIC），瀏覽器會先縮圖轉成 jpeg 再上傳。呢步只係縮圖，唔係認字，方便管理員之後叫雲端認字。

Photos over about 800KB, or types other than jpeg/png/webp/gif, are resized to JPEG in the browser before upload. That resize is not OCR. It keeps the file under the existing Vision size cap.

## Cloudflare 要人手做 / Manual setup

呢份 PR **冇**建立 bucket、冇寫入 secret、冇部署。

This PR does not create the bucket, set secrets, or deploy.

| 名稱 | 係咩 | 點設定 |
|---|---|---|
| R2 `PHOTOS` | 價牌原圖。Bucket 名 `checker-price-tags` | `npx wrangler r2 bucket create checker-price-tags` |
| KV `SUBMISSIONS` | 上載資料、待審索引、上架佇列 | `npx wrangler kv namespace create SUBMISSIONS`，將返回嘅 id 換走 `wrangler.jsonc` 入面嘅 `replace_before_deploy` |
| Secret `ADMIN_KEY` | 管理員請求頭 `X-Admin-Key` | `npx wrangler secret put ADMIN_KEY`（互動輸入，唔好寫入檔案） |
| `UPLOAD_ENABLED` | 上載開關，預設 `false` | 試用時改做 `"true"` 再部署 |
| Service `VISION_OCR` | 生產環境叫 `checker-vision-ocr`。同一帳戶用公開網址會被 Cloudflare 擋住 | `wrangler.jsonc` 嘅 `services`：`binding` `VISION_OCR`，`service` `checker-vision-ocr` |
| `VISION_OCR_URL` | 只係本機後備（`http://127.0.0.1:8788`） | 有 binding 時唔會用呢個網址。留空都可以預填 |
| `MAX_IMAGE_BYTES` | 解碼後上限，預設 4000000 | 可改 |
| `UPLOADS_PER_MINUTE` | 每個 IP 每分鐘大約 8 次 | 輕量限制，KV 計數唔係原子 |
| `VISION_OCR_MAX_BYTES` | 預設 900000，同現有認字 Worker 一致 | 太大就唔會送去 Vision |

Google Vision 金鑰**唔好**放喺呢個 Worker，亦唔好放進 git。金鑰仍然只喺 `checker-vision-ocr` 嘅 secret（`GOOGLE_VISION_API_KEY` 或 `GOOGLE_VISION_SERVICE_ACCOUNT`）。

Do not put a Google Vision key on this Worker or in git. Keys stay on `checker-vision-ocr`.

### 部署 / Deploy

```bash
cd workers/photo-upload
npm test
npx wrangler r2 bucket create checker-price-tags
npx wrangler kv namespace create SUBMISSIONS
```

將 KV id 寫入 `wrangler.jsonc`。確認 `UPLOAD_ENABLED` 仍然係 `false`，然後：

Paste the KV id into `wrangler.jsonc`. Leave `UPLOAD_ENABLED` as `false`, then:

```bash
npx wrangler secret put ADMIN_KEY
npx wrangler deploy
```

內部開跑先改：

When you want the pilot to accept photos:

1. `UPLOAD_ENABLED` = `"true"`
2. 確認 `services` 仍然綁 `VISION_OCR` → `checker-vision-ocr`（該 Worker 自己要 `VISION_OCR_ENABLED=true`，而且已有 Vision secret 同配額 KV）。唔好改用公開 `workers.dev` 網址。
3. 再 `npx wrangler deploy` 一次

本機：`cp .dev.vars.example .dev.vars`，改本地金鑰，然後 `npx wrangler dev`。`.dev.vars` 已 gitignore。

Local: copy `.dev.vars.example` to `.dev.vars`, then `npx wrangler dev`. `.dev.vars` is gitignored.

CORS 只反映 `https://francischeung11240518.github.io`，以及 `localhost`／`127.0.0.1`。

## 端點 / Endpoints

| 方法 | 路徑 | 誰 |
|---|---|---|
| `POST` | `/upload` | 用家。`multipart` 欄位 `image`、可選 `nickname`、`email`。亦接受 JSON `imageBase64`。 |
| `GET` | `/submissions?status=pending` | 管理員。亦可以 `approved`、`rejected`、`all`。 |
| `GET` | `/submissions/:id` | 管理員 |
| `GET` | `/submissions/:id/image` | 管理員。相唔公開。 |
| `PATCH` | `/submissions/:id` | 管理員。`action` 為 `approve`、`reject` 或 `save`。 |
| `POST` | `/submissions/:id/ocr` | 管理員。優先 `env.VISION_OCR.fetch`；本機先用 `VISION_OCR_URL`。 |
| `GET` | `/publish-queue` | 管理員。通過之後嘅上架骨架。 |

管理員請求要帶 `X-Admin-Key`。拒絕回應 `notified: false`。通過嘅 `nextStep` 寫明未寫入產品庫。

Admin routes require `X-Admin-Key`. Reject responses set `notified: false`. The approve stub says the product database was not updated.

## OCR 點接 / How prefill reaches Vision

`POST /submissions/:id/ocr` 由 R2 讀相，再以 `{ "consent": true, "mimeType", "imageBase64" }` 經 service binding `VISION_OCR` 叫現有 Worker。`GET /` 會回 `ocrViaBinding`。同一帳戶用 `fetch(https://….workers.dev)` 會被 Cloudflare 拒絕，所以有 binding 時唔會改走公開網址。`DOCUMENT_TEXT_DETECTION`、語言提示、US$15 刹車都留喺 `checker-vision-ocr`，呢度唔複製金鑰。

現有認字 Worker **唔回傳全文**，所以呢度 `rawText` 留空，只預填 `productName`、`price`、`offer`。空欄唔會洗走管理員已經打咗嘅字。

The existing OCR Worker does not return the full transcript, so `rawText` stays empty. Empty OCR fields do not wipe an admin's typed text.

如果 binding 同 `VISION_OCR_URL` 都未設定、相大過 `VISION_OCR_MAX_BYTES`，或者對方 kill switch 關閉，預填會失敗並顯示原因，通過／拒絕仍然可以用人手填。

## 測試 / Tests

```bash
cd workers/photo-upload && npm test
node --test test/photo-upload-flag.test.js
```
