# Checker Vision OCR Worker（內部試點）

靜態 GitHub Pages 繼續用瀏覽器 Tesseract。呢個 Worker 只喺內部旗標打開、用家同意之後，接收**裁好嘅價牌小圖**，呼叫 Google Cloud Vision `DOCUMENT_TEXT_DETECTION`（`languageHints`: `zh-Hant`、`en`），回傳建議品名、價錢同優惠字句。處理完即棄原圖。

預設 kill switch 關閉。金鑰只放 Worker secret，唔好寫入 git，亦唔好放進 Pages 靜態檔。已上線嘅 Worker 要再部署先會用到新認字（見下面「部署」）。

公眾頁面預設唔會呼叫呢度。見倉庫 `docs/vision-ocr-internal-pilot.md`。

## 預算點計（US$15 硬上限）

定價以 [Cloud Vision API 定價](https://cloud.google.com/vision/pricing) 嘅 Text Detection 公開價做假設（上線前再對一次官方頁）：

| 檔 | 價 |
|---|---|
| 每月首 1,000 單位 | US$0 |
| 其後至 5,000,000 單位 | **US$1.50／1,000 單位** |

一次請求只送一個 `DOCUMENT_TEXT_DETECTION`，一張圖計 **1 個單位**（同 Text Detection 公開價）。`languageHints` 唔係另一個功能，唔另計單位。唔好再加 `TEXT_DETECTION`，否則一張圖會變兩個單位。

Francis 鎖定每月硬上限 **US$15**（付費部分）：

```text
付費單位上限 = 15 / 1.50 × 1,000 = 10,000 單位
80% 刹車     = floor(10,000 × 0.8) = 8,000 付費單位
月計數器停   = 免費 1,000 + 8,000 = 9,000 次請求
刹車時估計花費 = 8,000 / 1,000 × 1.50 = US$12
```

仲有約 US$3 空間，加上 Google 免費額。計數器係估計，唔等於帳單。請喺 GCP 帳單再設 **US$15 預算告警**。KV 計數唔係原子操作，並發下可能稍為超出幾次；80% 同每日上限就係緩衝。

每日預設 **50** 次（`DAILY_REQUEST_CAP`）。50 × 31 ≈ 1,550 次／月，多數月份只會用免費額加極少付費（約 550 × US$1.50／千 ≈ US$0.83）。月上限先至係預算閘；如果你把每日上限調高，月計數器會喺 9,000 次停。

失敗嘅 Vision 呼叫都會計一格（呼叫已經發出，唔會重試）。Kill switch 關閉、未同意、超大圖、來源唔啱，**唔會計數，亦唔會打去 Google**。

## 環境變數

`wrangler.toml` 嘅 `[vars]`（唔係秘密）：

| 變數 | 預設 | 作用 |
|---|---|---|
| `VISION_OCR_ENABLED` | `false` | Kill switch。只有 `true`／`on`／`1`／`yes` 先會打去 Google。其他值全部拒絕，並回傳明確錯誤。 |
| `DAILY_REQUEST_CAP` | `50` | 香港日曆每日請求上限。 |
| `MONTHLY_BUDGET_USD` | `15` | 付費硬上限（美元）。 |
| `MONTHLY_STOP_FRACTION` | `0.8` | 付費單位用到呢個比例就停。上限夾喺 0–1。 |
| `FREE_UNITS_PER_MONTH` | `1000` | 計數用嘅免費額假設。 |
| `PRICE_PER_THOUSAND_USD` | `1.50` | 計數用嘅單價假設。 |
| `MAX_IMAGE_BYTES` | `900000` | 解碼後圖片上限。 |

## 點設定秘密（唔好發明真 key，亦唔好 commit）

二擇一。如果兩個都有，**service account 優先**。

### API key

1. 喺 GCP 開一個只做試點嘅專案，綁定帳單，並設 US$15 預算告警。
2. 啟用 Cloud Vision API。
3. 建立 API key，限制只可呼叫 Vision API。
4. 寫入 Worker，唔好寫入檔案：

```bash
cd workers/vision-ocr
npx wrangler secret put GOOGLE_VISION_API_KEY
```

本機 `npx wrangler dev` 用 `.dev.vars`（已 gitignore）。可以抄 `.dev.vars.example`，再自己填 key。

### Service account

1. 建立 service account，只俾 Cloud Vision 用家角色（或更窄嘅 Vision 權限）。
2. 下載 JSON key（PKCS#8 PEM）。
3. 整份 JSON 作為一個 secret（一行都可以）：

```bash
npx wrangler secret put GOOGLE_VISION_SERVICE_ACCOUNT
```

Worker 用該 JSON 簽一個短命 JWT，向 `oauth2.googleapis.com` 換 access token，再以 `Authorization: Bearer` 呼叫 Vision。Token 只留喺記憶體。日誌唔會寫 key、JSON 或圖片。

## 部署（呢份 PR 唔會真係部署）

```bash
cd workers/vision-ocr
npm test
npx wrangler kv namespace create VISION_OCR_QUOTA
```

將返回嘅 id 寫入 `wrangler.toml` 嘅 `[[kv_namespaces]]`（而家係 `replace_before_deploy`）。未綁定 `QUOTA` 時，Worker **拒絕**打去 Google。

```bash
npx wrangler secret put GOOGLE_VISION_API_KEY
# 確認 VISION_OCR_ENABLED 仍然係 false，先部署骨架
npx wrangler deploy
# 內部開跑時先改 VISION_OCR_ENABLED = "true" 再部署一次
```

合併認字改動之後，已上線嘅 Worker **唔會**自動更新。SuperMarket 要用呢份 `workers/vision-ocr` 再執行 `npx wrangler deploy`。金鑰已經喺 Cloudflare secret，唔使再放，亦唔好寫入頁面。

`POST /` 或 `POST /ocr`。JSON：

```json
{ "consent": true, "mimeType": "image/jpeg", "imageBase64": "...", "storeId": "mannings", "storeName": "萬寧" }
```

`consent` 必須係 JSON 布林 `true`。亦接受 `multipart/form-data`：欄位 `image`（檔案）同 `consent=true`。`storeId` / `storeName` 可有可無。

成功時回 `productName`、`price`、`offer`（短優惠字句，例如「買2件$88」或「第二件半價」）、`packSize`（容量／件數，例如 `500ml`、`1.25L`、`60粒`、`8件`、`x8`；冇就係空字串），以及 `profile`、`parser`。唔回傳原文，唔落碟。

## 超市認字檔案 / Store parse profiles

價牌解析按超市揀 profile，對應喺 `src/profile.js`。

| 超市 | `storeId` | profile | 而家用邊個 parser |
|---|---|---|---|
| 萬寧 | `mannings` | `mannings` | `parse.js` 現有行為（萬寧價牌） |
| 百佳 | `parknshop` | `parknshop` | **未有**專用 parser。預留位，暫時跌返 `mannings` |
| 其他、未填 | 例如 `watsons` | `default` | 同樣跌返 `mannings` |

Shelf-tag parsing is chosen by supermarket. 萬寧 uses the current `parse.js` behavior. 百佳 has a reserved `parknshop` profile so a later parser can be registered without changing the caller. Every other store, including a missing store, uses that same parser for now.

之後要加百佳，只係喺 `PARSERS` 加一行，唔好而家寫第二套解析：

```js
// workers/vision-ocr/src/profile.js
export const PARSERS = {
  mannings: parseVisionResponse,
  // parknshop: parseParknshop,
};
```

`parser` 欄位先係真正跑咗嘅函數。`parknshop` 而家會回 `profile: "parknshop"`、`parser: "mannings"`。

CORS 只反映：

- `https://francischeung11240518.github.io`
- `http://localhost` 同 `http://127.0.0.1`（任何埠，方便本機試）

其他 `Origin` 會 403，而且唔會回 CORS header。

## 測試

```bash
cd workers/vision-ocr
npm test
```

測試用假 key 字串 `test-key-not-real`，唔會打去 Google。
