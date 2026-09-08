# Mnemark 官網

獨立的繁中／英文靜態網站，使用 Vite、TypeScript、GSAP。網站不呼叫 Tauri、不讀取訪客剪貼簿，也沒有帳號、後端或追蹤服務。畫面中的產品操作使用示範資料。

## 開發與驗證

需要 Node.js 24。

```sh
npm ci --prefix website
npm run dev --prefix website
npm test --prefix website
npm run build --prefix website
npm run test:browser --prefix website
```

第一次使用瀏覽器測試時，在 `website/` 執行 `npx playwright install chromium`。CI 會安裝 Linux 所需系統依賴。

開發網址為 `http://127.0.0.1:5173/Mnemark/`；正式建置預覽使用 `npm run preview --prefix website`。英文入口為 `en/`。`SITE_BASE` 可覆寫預設 `/Mnemark/`，修改正式網址時也要同步檢查 canonical 與部署目的地。

`src/content.ts` 保存兩種語言的內容；`src/page.ts` 共用模板於建置期輸出完整 HTML；`src/main.ts` 僅增強動畫與導覽。原始 `index.html` 是 Vite 模板，請使用建置產物，而不是直接雙擊來源檔。

## 下載與版本

建置時取得 GitHub 最新正式 release，僅接受本專案的 Windows x64 安裝檔及可攜檔。缺少任一檔案、API 限流或離線時，CTA 會改連 Releases 頁並明示要前往 GitHub 選擇下載。瀏覽器端不呼叫 GitHub API，不猜測版本化檔名。

官網功能依目前 v0.8.1 專案原始碼核對。之後修改產品時，應同步檢查文案、操作示意與以下界線：搜尋不是全文／OCR／語意搜尋；檔案是路徑參照；抽屜保存獨立於歷史持久化；釘選不代表預設跨重啟保存。

## GitHub Pages

工作流程位於 `.github/workflows/website.yml`：

- PR：建置、下載解析測試、瀏覽器測試，不部署。
- 官網變更進入 `main` 或手動觸發：通過檢查後部署。
- `release` workflow 成功完成：從可信的 `main` 重建網站，更新下載連結。
- 只上傳 `website/dist`。Actions 全部固定為 commit SHA，沿用倉庫政策。

GitHub Pages 發佈來源需為 GitHub Actions。預設網址：<https://liutouo.github.io/Mnemark/>。

## 素材

- icon 衍生自倉庫的 `mnemark_icon.svg`，僅調整 viewBox 以適合網站顯示。
- 插圖、卡片、產品示意皆由 HTML／CSS／SVG 製作，沒有複用 Appy Camper 的照片、商標或字型。
- 字型為專案既有 IBM Plex Sans TC，子集版本及 SIL OFL 授權位於 `public/fonts/`。
- 文案新增中文字後，在倉庫根目錄執行：

```sh
uv run --with fonttools --with brotli python website/scripts/subset-fonts.py
```

- `public/social.png` 是本網站的社群分享預覽。內容或品牌更新後，以網站畫面重新產生。
- 作者區使用 `IA_LiuT` 字樣，不含尚未提供的頭貼、履歷或評價。

## 設計規格

見 [分鏡](docs/storyboard.md)、[Effect Library](docs/effects/README.md) 與 [動畫錄影](docs/previews/motion.mp4)。修改動態行為後，驗證正向／反向捲動、快速跳章、語言切換、手機及一般筆電視窗；不要將依進度變化的操作改成不可逆事件累加。

背景依最新設計要求預設播放，不提供動態開關，舊的 `mnemark-site-motion` 儲存值不再使用。網站不以系統動態偏好停用整段示範；離開首屏或切到背景頁籤時仍暫停背景循環。可用 `node website/scripts/capture-motion.mjs`（需本機 ffmpeg）重新錄製動畫證據。
