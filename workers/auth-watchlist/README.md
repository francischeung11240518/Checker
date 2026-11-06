# Checker 登入＋個人追蹤 Worker

GitHub Pages 靜態站唔可以保管鑰。登入同追蹤名單放喺呢個 Worker（`*.workers.dev`）。瀏覽器用 **Authorization: Bearer** 短命 JWT，**唔用**跨站 cookie（Safari／ITP 會擋 `github.io` → `workers.dev` 嘅第三方 cookie）。

已部署 Worker 的 `AUTH_ENABLED` 係 `"true"`（kill switch 已開）。健康檢查係 `GET /`（唔係 `/health`），回 `enabled: true`。搜尋頁唔使登入都用到；登入掣同追蹤介面喺 Worker 回 `enabled: true` 先顯示。第一版只用 Google。

Worker 已部署：`https://checker-auth-watchlist.checker-francis.workers.dev`。公開 Google client id 同 D1 `database_id` 已寫入 `wrangler.toml`。`SESSION_SECRET` 只可以 `wrangler secret put`，唔好 commit。

## 第一版做咩／唔做咩

做：Google 登入、登出、每人一份追蹤（加／刪／列出，上限 50）。資料庫只存登入來源、`sub`、有先存嘅電郵／顯示名、產品編號同加入時間。**唔存價錢**。價錢由頁面入面嘅 `PRODUCTS`／`SERIES` 喺瀏覽器計。

唔做：Sign in with Apple（見下面「之後先」）、密碼帳戶、刪除帳戶掣、推送、分享名單。

資料保留期 **未定**。schema 只係留低註解，等 Legal 先至決定。呢段係產品說明，唔係法律意見。

## 環境變數

`wrangler.toml` 嘅 `[vars]`（唔係秘密，可以入 git；公開 client id 已填，已部署 Worker 的 `AUTH_ENABLED` 係 `"true"`）：

| 變數 | 而家 | 作用 |
|---|---|---|
| `AUTH_ENABLED` | `true` | Kill switch。已部署 Worker 已開。只有 `true`／`on`／`1`／`yes` 先接受登入同追蹤。其他值，`POST /session`、`GET/POST/DELETE /watchlist`、`POST /logout` 全部 **403** `auth_disabled`。健康檢查係 `GET /`（唔係 `/health`），關閉都仍然 200，方便頁面知道未開放。 |
| `GOOGLE_CLIENT_ID` | `175392803528-9840t8fvs62gur5sa5p9immqkpkid3k6.apps.googleusercontent.com` | Google OAuth **Web** client id（公開，已寫入 `wrangler.toml`）。唔好把 client secret 寫入 git。 |
| `WATCHLIST_MAX` | `50` | 每人上限。程式會夾死喺 50，調高都唔會超過。 |
| `SESSION_TTL_SECONDS` | `604800` | Bearer JWT 壽命，預設 7 日。短過 5 分鐘會跌返預設；最長 14 日。登出會喺 D1 撤銷呢張 token。 |

### 秘密（`wrangler secret put`，唔好 commit）

| 名 | 何時要 |
|---|---|
| `SESSION_SECRET` | 用嚟簽自己嘅 Bearer JWT。至少 16 個字元。唔好 commit。 |

第一版核實嘅係 Google **ID token**（簽章、`aud`、`iss`、過期），用 Google 公開 JWKS，**唔使** client secret。

`GOOGLE_CLIENT_SECRET` **v1 唔會讀**。唔好 commit。

本機 `npx wrangler dev` 用 `.dev.vars`（已 gitignore）。可以抄 `.dev.vars.example`。

## Francis：Google 登入

1. 開一個 GCP 專案（或用現有嘅）。
2. OAuth 同意畫面用 External，加測試用戶就得；公開之前唔使轉正式。
3. 建立 **OAuth 2.0 Client ID**，類型係 **Web application**。
4. **Authorized JavaScript origins** 加：
   - `https://francischeung11240518.github.io`
   - 本機：`http://localhost:8080`（或者你實際用嘅埠）
5. 呢版係瀏覽器攞 ID token，再交俾 Worker 核實，**Worker 唔收 Google 回跳**。如果個 console 仍然要填 **Authorized redirect URI**，只填 `https://francischeung11240518.github.io/Checker/`，唔好再加一堆未用嘅位址。
6. 將 **Client ID** 寫入 `wrangler.toml` 嘅 `GOOGLE_CLIENT_ID`（呢個 id 係公開嘅，頁面都會見到）。**唔好**把 client secret 寫入 git。

## 之後先：Sign in with Apple

Francis（2026-11-06）決定而家唔做。正式 Sign in with Apple 要**付費** Apple Developer Program；免費 Apple ID 唔夠。`users.provider` 仍然可以係 `apple`，但 `POST /session` 對 `"provider": "apple"` 回 **400** `apple_disabled`，唔會核實 Apple token。頁面亦冇「用 Apple 繼續」。

## Cloudflare 部署

用 Francis 而家 Checker Workers 嗰個 Cloudflare 帳號（同 photo-upload、vision-ocr 同一個）。

Worker 已部署：`https://checker-auth-watchlist.checker-francis.workers.dev`。

`wrangler.toml` 已有 D1 名稱 `checker-auth-watchlist`、`database_id` `2ddb2690-d53c-48a7-949d-8118b8fe6762`，同公開 `GOOGLE_CLIENT_ID`。倉庫根目錄 `auth-watchlist.js` 嘅 `AUTH_WORKER_URL` 已係上面條網址（無尾斜線）。

**Kill switch 已開。** 已部署 Worker 的 `AUTH_ENABLED` 係 `"true"`。健康檢查係 `GET /`（唔係 `/health`）。搜尋頁喺 Worker 回 `enabled: true` 先顯示登入掣同追蹤介面。秘密（包括 `SESSION_SECRET`）只用 `npx wrangler secret put`，唔好 commit。

預設已經指向已部署嘅 Worker。私人試另一條網址先至要改：

```js
localStorage.setItem("checker-auth-worker-url", "https://checker-auth-watchlist.<子網域>.workers.dev")
```

或者開 `?authUrl=https://….workers.dev`（只限呢次，唔寫入 localStorage）。只接受 `https://*.workers.dev` 或本機 `localhost`／`127.0.0.1`。查詢同 localStorage 會蓋過 `AUTH_WORKER_URL`。

`GET /` 回 `enabled`、公開 Google client id、`providers: ["google"]`、`maxItems`。唔回 secret。

## API

CORS 只放行 `https://francischeung11240518.github.io` 同 `http(s)://localhost`／`127.0.0.1`。預檢允許 `content-type` 同 `authorization`。

| 方法 | 路徑 | 說明 |
|---|---|---|
| `GET` | `/` | 健康檢查（唔係 `/health`）。回 `enabled`。旗標關閉都係 200。 |
| `POST` | `/session` | `{ "provider": "google", "idToken": "..." }`。成功回 `token`（Bearer）同 `user`。`apple` 回 400。 |
| `GET` | `/session` | 要 Bearer。回而家嘅用戶。 |
| `POST` | `/logout` | 要 Bearer。撤銷呢張 token。瀏覽器都要清 localStorage。 |
| `GET` | `/watchlist` | `{ codes: [{ code, createdAt }], max }`。 |
| `POST` | `/watchlist` | `{ "code": "P000005418" }`。已有就 200；新加 201；滿 50 就 409 `limit`。 |
| `DELETE` | `/watchlist` | JSON `{ "code" }` 或 `?code=`。 |

產品編號會正規化成 `P`＋原有數字寬度（`p000000670` → `P000000670`）。**唔會**補零，以免 `P00001864` 撞到另一條 9 位編號。純數字 odd id（例如 `173520`）原樣儲存。

`users` 有 `UNIQUE(provider, sub)`。v1 只會寫入 `google`。

## 頁面

搜尋頁 `index.html` 加咗頂欄「登入」、結果卡同詳情嘅「加入追蹤／已追蹤」，同首頁區塊「我的追蹤」（唔係獨立頁）。未登入仍然可以搜尋、睇今日大幅變動、睇詳情。

「我的追蹤」用而家頁面嘅今日價、`histStats`（優惠後同標價高低都顯示），同前一日用「升／跌／差不多」加「由 $A 到 $B」。總庫冇咗嘅編號顯示「暫時未有／已唔再提供」。登入掣附近有一段短私隱說明。第一版冇刪除帳戶掣。

倉庫冇第二份搜尋頁要同步。

## 測試

`npm test` 要 **Node.js 22 或更新**。`worker.test.js` 用內建 `node:sqlite` 做 D1 替身，Node 22 先有。`package.json` 嘅 `engines.node` 係 `>=22`。

編號正規化（`test/codes.test.js`）同頁面測試（倉庫根 `node --test test/auth-watchlist-page.test.js`）唔用 `node:sqlite`。有內建 test runner 嘅較舊 Node（18+）仍然可以單獨跑過。

```bash
cd workers/auth-watchlist
npm test
node --test test/codes.test.js
node --test ../../test/auth-watchlist-page.test.js
```
