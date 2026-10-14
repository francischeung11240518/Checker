# 超市價格搜尋

本站供朋友私人試用。

價格資料來自消費者委員會「網上價格一覽」（Online Price Watch），經 [DATA.GOV.HK](https://data.gov.hk/) 公開數據。使用或轉載時須註明資料出處。

本站沒有廣告，亦非消費者委員會官方網站。

## 影相上報價錢（私人試用／本機暫存）

用同一個瀏覽器就可以試。資料留喺呢部機（IndexedDB），唔會上傳，亦唔會爬超市網站。

1. 開搜尋頁，撳「我要上報」或者產品上嘅「上報價錢」（亦可以直接開 `report.html`）。
2. 同意之後揀超市，影價牌或者上傳。系統會喺你部機試吓讀價錢同產品名填草稿（英文同繁體中文，資料由 jsDelivr 載入）；讀唔到都可以自己填。核對完先提交。
3. 提交後係「待審核」，搜尋頁未會顯示。
4. 用同一部機開 `admin.html`，撳「用戶上報」。可以睇相同欄位、對住消委會價，然後通過、退回或者拒絕。
5. 通過之後，返搜尋或者開返嗰隻產品，消委會價旁邊會多一行「用戶上報」。消委會現價唔會被覆蓋，公開頁唔會顯示原圖。

換瀏覽器、換電話，或者清咗網站資料，上報同相片就會冇。

## 內部雲端讀價（預設關閉）

公眾頁只用瀏覽器認字，唔會上傳價牌。內部試點先本機、讀唔到先可選雲端預填，每月 Vision 用量硬封頂 US$15，而且要你同意先會傳裁好嘅小圖。未完成法律閘門之前唔對公眾開放。

說明：[`docs/vision-ocr-internal-pilot.md`](docs/vision-ocr-internal-pilot.md)。Worker：[`workers/vision-ocr/README.md`](workers/vision-ocr/README.md)。

## 價牌上載審核（內部骨架，預設關閉）

用家影價牌上傳，管理員再睇相、可選雲端預填，然後通過或拒絕。搜尋頁未有入口。用家頁唔會喺手機認字。未有登入，拒絕亦未會通知。

說明：[`docs/photo-upload-internal-pilot.md`](docs/photo-upload-internal-pilot.md)。Worker：[`workers/photo-upload/README.md`](workers/photo-upload/README.md)。
