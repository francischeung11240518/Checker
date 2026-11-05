# Checker 登入＋個人追蹤 Worker

GitHub Pages 靜態站唔可以保管鑰。登入同追蹤名單放喺呢個 Worker（`*.workers.dev`）。瀏覽器用 **Authorization: Bearer** 短命 JWT，**唔用**跨站 cookie（Safari／ITP 會擋 `github.io` → `workers.dev` 嘅第三方 cookie）。

預設 `AUTH_ENABLED=false`。未有 D1、`SESSION_SECRET`、Google client、Apple Services ID 之前，登入同追蹤 API 回 **403**。搜尋頁唔使登入都用到。

呢份 PR **唔會**部署，亦 **唔會**填真 OAuth client id。

## 第一版做咩／唔做咩

做：Google 登入同 Sign in with Apple（地位同等）、登出、每人一份追蹤（加／刪／列出，上限 50）。資料庫只存登入來源、`sub`、有先存嘅電郵／顯示名、產品編號同加入時間。**唔存價錢**。價錢由頁面入面嘅 `PRODUCTS`／`SERIES` 喺瀏覽器計。

唔做：密碼帳戶、Google 同 Apple 合併成一個戶、刪除帳戶掣、推送、分享名單。同一個真人用兩個登入＝**兩個帳戶、兩份名單**。

資料保留期 **未定**。schema 只係留低註解，等 Legal 先至決定。呢段係產品說明，唔係法律意見。

## 環境變數

`wrangler.toml` 嘅 `[vars]`（唔係秘密，可以入 git；而家 client id 留空）：

| 變數 | 預設 | 作用 |
|---|---|---|
| `AUTH_ENABLED` | `false` | Kill switch。只有 `true`／`on`／`1`／`yes` 先接受登入同追蹤。其他值，`POST /session`、`GET/POST/DELETE /watchlist`、`POST /logout` 全部 **403** `auth_disabled`。`GET /` 仍然 200，方便頁面知道未開放。 |
| `GOOGLE_CLIENT_ID` | 空 | Google OAuth **Web** client id（公開）。唔好發明假 id。 |
| `APPLE_SERVICES_ID` | 空 | Sign in with Apple 嘅 Services ID（公開），例如 `com.example.checker.web`。 |
| `APPLE_REDIRECT_URI` | 空 | 必須同 Apple Return URL **完全一致**。生產用 `https://francischeung11240518.github.io/Checker/`。本機試用先填你實際嘅 `http://localhost:埠/`。 |
| `WATCHLIST_MAX` | `50` | 每人上限。程式會夾死喺 50，調高都唔會超過。 |
| `SESSION_TTL_SECONDS` | `604800` | Bearer JWT 壽命，預設 7 日。短過 5 分鐘會跌返預設；最長 14 日。登出會喺 D1 撤銷呢張 token。 |

### 秘密（`wrangler secret put`，唔好 commit）

| 名 | 何時要 |
|---|---|
| `SESSION_SECRET` | **開旗標之前一定要有。** 用嚟簽自己嘅 Bearer JWT。建議 `openssl rand -base64 32`。至少 16 個字元。 |

第一版核實嘅係 Google／Apple **ID token**（簽章、`aud`、`iss`、過期），用佢哋公開 JWKS，**唔使** client secret，亦 **唔使** 把 Apple `.p8` 私鑰上傳去 Worker。

下面呢啲 **v1 唔會讀**。Apple 後台有時會叫你建立 Sign in with Apple key；建立咗就收好個 `.p8`，唔好 commit，亦唔使而家 `wrangler secret put`：

- `GOOGLE_CLIENT_SECRET`
- `APPLE_TEAM_ID`
- `APPLE_KEY_ID`
- `APPLE_PRIVATE_KEY`

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

## Francis：Sign in with Apple

**一定要付費 Apple Developer Program**（個人或公司，每年收費）。免費 Apple ID **唔夠**做正式 Sign in with Apple。

1. 用付費帳號入 Certificates, Identifiers & Profiles。
2. 建立一個 App ID（primary），啟用 Sign in with Apple。後台如果要你建立一條 Sign in with Apple **Key**，建立並下載 `.p8`（只得一次）。收好。v1 Worker **唔讀**呢條 key。
3. 建立 **Services ID**（網頁用），啟用 Sign in with Apple，綁上面個 App ID。
4. **Domains and Subdomains** 填 `francischeung11240518.github.io`（唔係 `workers.dev`）。
   - Apple 要你做域名驗證。驗證檔要放喺網域根：`https://francischeung11240518.github.io/.well-known/apple-developer-domain-association.txt`。
   - Checker 而家係專案頁 `…/Checker/`。驗證檔唔係放喺呢個 repo 嘅子路徑就得，要放喺 **user/organization Pages 根**（通常係另一個 `francischeung11240518.github.io` 倉庫）。
5. **Return URLs** 只填頁面，同 `APPLE_REDIRECT_URI` 逐個字元一樣：
   - `https://francischeung11240518.github.io/Checker/`
   - 本機試再加你嗰條 `http://localhost:埠/`
   - 回跳係 Apple JS popup 返去 Pages。Worker 只係之後收到 ID token，唔係 Apple 嘅 Return URL。
6. 將 Services ID 寫入 `APPLE_SERVICES_ID`。

Apple 可以隱藏電郵，名多數只喺第一次登入先俾。頁面容許冇顯示名／電郵。

## Cloudflare 部署（呢份 PR 唔會真係跑）

用 Francis 而家 Checker Workers 嗰個 Cloudflare 帳號（同 photo-upload、vision-ocr 同一個）。

```bash
cd workers/auth-watchlist
npm test
npx wrangler d1 create checker-auth-watchlist
```

將返回嘅 `database_id` 寫入 `wrangler.toml`（而家係 `replace_before_deploy`）。未綁定 `DB` 時，旗標開咗都會拒絕登入。

```bash
npx wrangler d1 migrations apply checker-auth-watchlist --remote
npx wrangler secret put SESSION_SECRET
# 確認 AUTH_ENABLED 仍然係 "false"，client id 可以先留空
npx wrangler deploy
```

部署完會有一條 `https://checker-auth-watchlist.<你的子網域>.workers.dev`。唔好估子網域。

然後先至：

1. 填好 `GOOGLE_CLIENT_ID`、`APPLE_SERVICES_ID`、`APPLE_REDIRECT_URI`。
2. 將 `AUTH_ENABLED` 改做 `"true"`，再 `npx wrangler deploy` 一次。
3. 將上面條 workers.dev 網址寫入倉庫根目錄 `auth-watchlist.js` 嘅 `AUTH_WORKER_URL`（公開位址，唔係秘密），推上 Pages。未寫之前，搜尋頁唔顯示登入掣。

私人試、未改檔：

```js
localStorage.setItem("checker-auth-worker-url", "https://checker-auth-watchlist.<子網域>.workers.dev")
```

或者開 `?authUrl=https://….workers.dev`（只限呢次，唔寫入 localStorage）。只接受 `https://*.workers.dev` 或本機 `localhost`／`127.0.0.1`。

`GET /` 回 `enabled`、公開 client id、Apple redirect、`maxItems`。唔回 secret。

## API

CORS 只放行 `https://francischeung11240518.github.io` 同 `http(s)://localhost`／`127.0.0.1`。預檢允許 `content-type` 同 `authorization`。

| 方法 | 路徑 | 說明 |
|---|---|---|
| `GET` | `/` | 狀態。旗標關閉都係 200。 |
| `POST` | `/session` | `{ "provider": "google"\|"apple", "idToken": "...", "name": "" }`。`name` 只係 Apple 第一次先用。成功回 `token`（Bearer）同 `user`。 |
| `GET` | `/session` | 要 Bearer。回而家嘅用戶。 |
| `POST` | `/logout` | 要 Bearer。撤銷呢張 token。瀏覽器都要清 localStorage。 |
| `GET` | `/watchlist` | `{ codes: [{ code, createdAt }], max }`。 |
| `POST` | `/watchlist` | `{ "code": "P000005418" }`。已有就 200；新加 201；滿 50 就 409 `limit`。 |
| `DELETE` | `/watchlist` | JSON `{ "code" }` 或 `?code=`。 |

產品編號會正規化成 `P`＋原有數字寬度（`p000000670` → `P000000670`）。**唔會**補零，以免 `P00001864` 撞到另一條 9 位編號。純數字 odd id（例如 `173520`）原樣儲存。

Google 同 Apple 即使 `sub` 一樣，都係兩行 `users`（`UNIQUE(provider, sub)`）。

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
