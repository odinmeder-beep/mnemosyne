# Mnemosyne Chrome 擴充功能

把目前的分頁存進你的收藏。金鑰只放在這台瀏覽器，不會寫進程式裡。

## 安裝

1. 到 GitHub 下載這個專案的 zip，解壓縮。
2. 打開 Chrome，網址列輸入 `chrome://extensions`。
3. 打開右上角的**開發人員模式**。
4. 按**載入未封裝項目**。
5. 選解壓縮後的 `extension` 資料夾，不是整個專案。

## 使用

按工具列的 Mnemosyne 圖示，或快捷鍵 **Alt+Shift+S**，會打開儲存視窗。網址和標題會帶入目前的分頁。分類來自 `listCategories`，可以勾選多個。按**儲存**會呼叫後端的 `add`。

第一次先按視窗裡的**前往設定**，貼上和網頁相同的金鑰。

如果快捷鍵沒有作用，打開 `chrome://extensions/shortcuts`，把「儲存目前的分頁」設成 Alt+Shift+S。Chrome 不一定會自動套用建議的按鍵。
