# Mnemosyne 後端設定

這份說明帶你把收藏庫的後端放到 Google。做完之後你會得到一條以 `/exec` 結尾的網址。之後的網頁會用這條網址讀寫**你自己的** Google 試算表。

資料只放在你的試算表。金鑰只放在 Apps Script 的指令碼屬性 `MNEMOSYNE_KEY`。

編輯器裡只需要貼三個檔案：`Code.gs`、`logic.js`、`appsscript.json`。`logic.test.js` 和 `fetch-samples.js` 是開發時檢查用的，不用貼。

## 1. 建立試算表

1. 打開 [Google 試算表](https://sheets.google.com)，建立一份空白試算表。
2. 名稱可以取 `Mnemosyne`。
3. 分頁先不用自己建。等等執行 `setup` 會建立名為 `items` 的分頁。

## 2. 貼上程式

1. 在試算表選單點 **擴充功能** → **Apps Script**。腳本會跟著這份試算表走。
2. 把預設的 `Code.gs` 內容全部換成這個資料夾裡的 `Code.gs`。
3. 左側檔案旁邊按 **＋** → **指令碼**，名稱填 `logic`，把 `logic.js` 的內容貼上去。
4. 存檔（磁碟圖示或 Ctrl+S / Cmd+S）。
5. 左側齒輪 **專案設定**，勾選 **在編輯器中顯示「appsscript.json」資訊清單檔案**。
6. 回到編輯器，打開 `appsscript.json`，用這個資料夾裡的內容取代，再存檔。時區會是台北。

## 3. 設定金鑰

1. 還是在 **專案設定**，找到 **指令碼屬性**。
2. 按 **新增指令碼屬性**。
3. 屬性填 `MNEMOSYNE_KEY`（大小寫要一樣）。
4. 值填一長串只有你知道的密碼，至少 20 個字，混合英文和數字。請自己產生，說明書裡沒有現成的密碼。
5. 按 **儲存指令碼屬性**。

## 4. 建立 items 分頁

1. 回到編輯器，上方函式選單選 `setup`，按 **執行**。
2. 第一次會要求授權。選你的 Google 帳號。
3. 若出現「Google 尚未驗證這個應用程式」，點 **進階**，再點 **前往（專案名稱）（不安全）**，然後 **允許**。這是你自己的腳本，權限用來修改這份試算表，以及讀取你存進去的網頁標題。
4. 執行完成後回到試算表，會看到 `items` 分頁。第一列是：

   `id`、`url`、`platform`、`title`、`summary`、`note`、`category`、`tags`、`createdAt`、`updatedAt`、`image`

第一列要留著。`tags` 在表格裡是逗號分隔的文字，例如 `閱讀, 稍後`。時間是 UTC，長得像 `2026-10-29T12:34:56.000Z`。

## 5. 部署成網頁應用程式

1. 右上角 **部署** → **新增部署作業**。
2. 齒輪旁的類型選 **網頁應用程式**。
3. **執行身分** 選 **我**。
4. **誰可以存取** 選 **任何人**。選單若寫「任何人，甚至匿名使用者」，選那個。之後放在 GitHub Pages 的網頁才叫得到這支程式，呼叫的人仍要帶金鑰。
5. 按 **部署**。若再問一次授權，按允許。
6. 複製網頁應用程式網址。要用結尾是 `/exec` 的那一條。

之後若改過程式： **部署** → **管理部署作業** → 鉛筆圖示 → 版本選 **新版本** → **部署**。網址維持不變，新版本才會生效。

## 6. 用 curl 確認

把 `YOUR_EXEC_URL` 換成剛才的網址，把 `YOUR_KEY` 換成你的金鑰。

在 Mac 或 Linux 打開「終端機」。Windows 請打開「命令提示字元」（cmd）。

列出收藏（一開始是空的）：

```bash
curl -L -sS -X POST "YOUR_EXEC_URL" -H "Content-Type: text/plain;charset=utf-8" --data "{\"key\":\"YOUR_KEY\",\"action\":\"list\"}"
```

新增一筆：

```bash
curl -L -sS -X POST "YOUR_EXEC_URL" -H "Content-Type: text/plain;charset=utf-8" --data "{\"key\":\"YOUR_KEY\",\"action\":\"add\",\"url\":\"https://example.com\",\"note\":\"試看看\",\"category\":\"閱讀\",\"tags\":\"測試,稍後\"}"
```

成功時會看到 `"ok": true`。清單一開始像這樣：

```json
{"ok":true,"items":[]}
```

金鑰不對時會看到：

```json
{"ok":false,"error":"unauthorized"}
```

這時候試算表不會被讀寫。請加上 `-L`，網址要用 `/exec`。金鑰放在 POST 內容裡，跟著 JSON 一起送出。

之後的網頁也用同樣的方式呼叫（`Content-Type` 用 `text/plain`，瀏覽器就不會先送 CORS preflight；Apps Script 不回應 preflight）：

```javascript
await fetch(YOUR_EXEC_URL, {
  method: 'POST',
  redirect: 'follow',
  headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  body: JSON.stringify({ key: YOUR_KEY, action: 'list' }),
});
```

## 7. 其他動作

`action` 可以是 `list`、`add`、`update`、`delete`、`preview`。

| action | 額外欄位 | 成功時 |
| --- | --- | --- |
| `list` | 無 | `{ "ok": true, "items": [ ... ] }`，新的在前 |
| `add` | `url`，可加 `note`、`category`、`tags` | `{ "ok": true, "duplicate": false, "item": { ... } }` |
| `preview` | `url` | `{ "ok": true, "preview": { "url", "platform", "title", "summary", "fetched" } }`，不寫入 |
| `update` | `id`，加上要改的欄位 | `{ "ok": true, "item": { ... } }` |
| `delete` | `id` | `{ "ok": true, "id": "..." }` |

同一網址再 `add` 一次時，回傳原本那筆，並帶 `"duplicate": true`，不會新增第二筆。比對前會去掉結尾斜線、`#` 片段，以及網址裡的帳號密碼。

`platform` 依網址自動判斷：`threads`（threads.net、threads.com）、`instagram`、`facebook`、`x`（x.com、twitter.com），其他是 `web`。標題和摘要從網頁的 `og:title`、`og:description`、`twitter:title`、`twitter:description`、`<title>`、`meta description` 讀取。網站擋下或讀取失敗時，這兩欄留空，連結仍會存起來。

`tags` 可以傳陣列 `["閱讀","稍後"]` 或字串 `"閱讀, 稍後"`。存進表格時是逗號分隔字串，回應裡是陣列。

`update` 可以改 `url`、`platform`、`title`、`summary`、`note`、`category`、`tags`。`updatedAt` 會更新。`id` 和 `createdAt` 維持原樣。

錯誤時 HTTP 仍是 200（Apps Script 的限制），請看 JSON：

`unauthorized`、`bad_request`、`invalid_url`、`not_found`、`unknown_action`、`not_setup`、`method_not_allowed`、`busy`、`internal_error`。

`not_setup` 表示還沒有正確的 `items` 分頁，再執行一次 `setup`。`GET` 只會回 `method_not_allowed`，不會讀寫資料。

## 更新縮圖欄位

若你已經部署過舊版，請再做一次這些事，網址不會變：

1. 把 `Code.gs` 和 `logic.js` 再貼上一次，存檔。
2. 函式選 `setup`，按 **執行**。這會在 `items` 最右邊補上 `image` 欄，原本的資料不會被改掉。
3. **部署** → **管理部署作業** → **編輯**（鉛筆）→ 版本選 **新版本** → **部署**。

舊的收藏沒有縮圖。可以分批補上（每次最多處理你給的筆數，預設 25）：

```bash
curl -L -sS -X POST "YOUR_EXEC_URL" -H "Content-Type: text/plain;charset=utf-8" --data "{\"key\":\"YOUR_KEY\",\"action\":\"backfillImages\",\"limit\":25}"
```

看到 `"remaining": 0` 就補完了。找不到圖的會記成 `-`，畫面就改顯示平台小圖。

## 更新分類

分類顏色和父子關係放在同一份試算表的 `categories` 分頁。若你已經部署過，請再做一次：

1. 把 `Code.gs` 和 `logic.js` 再貼上一次，存檔。
2. 函式選 `setup`，按 **執行**。沒有 `categories` 分頁時會建立它，其他分頁的資料不會被改。
3. **部署** → **管理部署作業** → **編輯**（鉛筆）→ 版本選 **新版本** → **部署**。網址維持不變。

第一次讀取分類時，若分頁是空的，會用你收藏裡已經出現過的分類名稱自動建立，並配上預設顏色。
