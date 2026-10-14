# Checker photo-upload Worker（內部骨架）

用家上傳一張價牌。呢個 Worker 將圖放入 R2、資料放入 KV，等管理員審核。預設唔接受上傳。

Google Vision 金鑰唔放喺呢度。撳「跑 OCR 預填」時，Worker 用 service binding `VISION_OCR` 叫現有 `checker-vision-ocr`（該 Worker 先用 `DOCUMENT_TEXT_DETECTION`）。唔好用公開 `workers.dev` 網址打去同一帳戶嘅 Worker，Cloudflare 會擋。

產品說明（中英）：[`../../docs/photo-upload-internal-pilot.md`](../../docs/photo-upload-internal-pilot.md)。

This pull request does not deploy the Worker. Create the R2 bucket, KV namespace, and `ADMIN_KEY` yourself before `wrangler deploy`.

## Bindings

| Binding | Kind | Name |
|---|---|---|
| `PHOTOS` | R2 | bucket `checker-price-tags` |
| `SUBMISSIONS` | KV | metadata, `pending:{id}`, `publish-queue` |
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

## Routes

`POST /upload` is public to the GitHub Pages origin and localhost, and it is still behind `UPLOAD_ENABLED`.

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
