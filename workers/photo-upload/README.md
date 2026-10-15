# Checker photo-upload Worker（內部骨架）

用家上傳一張價牌。呢個 Worker 將圖放入 R2、資料放入 KV，等管理員審核。預設唔接受上傳。

Google Vision 金鑰唔放喺呢度。撳「跑 OCR 預填」時，Worker 用 service binding `VISION_OCR` 叫現有 `checker-vision-ocr`（該 Worker 先用 `DOCUMENT_TEXT_DETECTION`）。唔好用公開 `workers.dev` 網址打去同一帳戶嘅 Worker，Cloudflare 會擋。

產品說明（中英）：[`../../docs/photo-upload-internal-pilot.md`](../../docs/photo-upload-internal-pilot.md)。

This pull request does not deploy the Worker. Create the R2 bucket, KV namespace, and `ADMIN_KEY` yourself before `wrangler deploy`.

## Bindings

| Binding | Kind | Name |
|---|---|---|
| `PHOTOS` | R2 | bucket `checker-price-tags` |
| `SUBMISSIONS` | KV | metadata, `pending:{id}`, `publish-queue`, `stores:custom` |
| `VISION_OCR` | service | Worker `checker-vision-ocr` |
| `ADMIN_KEY` | secret | header `X-Admin-Key` |

`wrangler.jsonc` vars (not secrets):

| Var | Default | Role |
|---|---|---|
| `UPLOAD_ENABLED` | `false` | Only `true` / `on` / `1` / `yes` accepts `POST /upload`. |
| `MAX_IMAGE_BYTES` | `4000000` | Decoded image cap. |
| `UPLOADS_PER_MINUTE` | `8` | Soft per-IP cap. The counter is not atomic. |
| `VISION_OCR_URL` | empty | Local fallback only (`http://127.0.0.1:8788`). Production uses the `VISION_OCR` binding. |
| `VISION_OCR_MAX_BYTES` | `900000` | Skip Vision when the stored photo is larger than the existing OCR Worker allows. |

## Commands

```bash
cd workers/photo-upload
npm test
npx wrangler r2 bucket create checker-price-tags
npx wrangler kv namespace create SUBMISSIONS
```

Replace `replace_before_deploy` in `wrangler.jsonc` with the KV id. Then:

```bash
npx wrangler secret put ADMIN_KEY
npx wrangler deploy
```

`secret put` prompts for the value. Do not commit it, and do not pass it on the command line.

Leave `UPLOAD_ENABLED` at `false` for the first deploy. When Francis is ready to try uploads, set it to `"true"` and deploy again. Prefill uses the `VISION_OCR` service binding, not a public URL. `VISION_OCR_URL` is only for `wrangler dev` when the binding is not available. The vision-ocr Worker still needs its own secret, quota KV, and `VISION_OCR_ENABLED=true`. See [`../vision-ocr/README.md`](../vision-ocr/README.md). `GET /` reports `ocrViaBinding: true` when the binding is present.

Local dev:

```bash
cp .dev.vars.example .dev.vars
npx wrangler dev
```

`.dev.vars` is gitignored. The example key is a placeholder.

If `wrangler dev` rejects the placeholder KV id, create the namespace and paste the real id first. Local dev still uses simulated storage unless you pass `--remote`.

## 超市 / Supermarket

上傳一定要帶超市。`storeId` 同 `storeName` 可以喺 multipart 或 JSON。空白會回 `store_required`（「請先揀超市。」）。

Every upload must include a supermarket (`storeId` and/or `storeName`, multipart or JSON). A blank value returns `store_required`.

種子清單用返程式入面已有嘅中文名（萬寧、屈臣氏、百佳、惠康、AEON、Market Place、龍豐、大昌、莎莎），再加一田同 759阿信屋。別名唔分大小寫同空格，例如 `Mannings`、`759` 會用返第一次見到嘅顯示名。

The seed list reuses the app's existing Chinese names, plus 一田 and 759阿信屋. Matching ignores case and spaces and keeps the first-seen spelling.

`GET /stores` 唔使管理員金鑰，回種子加 KV 入面用家加過嘅名（`stores:custom`）。新名喺上傳成功時先寫入，上限 200 個。同名唔會再開一列。

`GET /stores` needs no admin key. It returns the seed plus names saved from successful uploads. New names are written on upload, capped at 200, and duplicates do not create a second row.

管理員清單會顯示超市，可以用 `GET /submissions?status=pending&store=<id>` 篩選。

The admin list shows the supermarket. Filter with `store` on the submissions query.

跑 OCR 時，呢個 Worker 會把該筆嘅 `storeId` / `storeName` 交俾 `checker-vision-ocr`。邊個 parser 由 vision-ocr 揀，見 [`../vision-ocr/README.md`](../vision-ocr/README.md) 嘅「超市認字檔案」。

OCR prefill forwards that submission's store. Profile selection lives in the vision-ocr Worker.

## Routes

`POST /upload` is public to the GitHub Pages origin and localhost, and it is still behind `UPLOAD_ENABLED`. `GET /stores` is public to those same origins and does not require `UPLOAD_ENABLED`.

Admin routes require `X-Admin-Key`: list, detail, image, `PATCH` (`approve` / `reject` / `save`), `POST .../ocr`, `GET /publish-queue`.

Approve writes `publish:{id}` and appends `publish-queue`. It does not write the product database. Reject stores `adminNote` and returns `notified: false`. No email is sent.

CORS allows:

- `https://francischeung11240518.github.io`
- `http://localhost` and `http://127.0.0.1` (any port)

## Tests

```bash
cd workers/photo-upload
npm test
```

Tests use the fake admin key `test-admin-key` and never call Google.
