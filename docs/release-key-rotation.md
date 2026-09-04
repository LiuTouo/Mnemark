# Release 簽章金鑰輪替 Runbook

一把 minisign keypair 保護兩條更新 channel，對應兩個 trust root（今天同一把鑰）：

| Channel | Trust root 位置 | 誰驗證 |
| --- | --- | --- |
| Installed（NSIS + updater plugin） | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` | 已安裝的 app 用**自己 build 內嵌**的 pubkey 驗 `latest.json` 與安裝包 |
| Portable | `src-tauri/src/update.rs` → `UPDATE_PUBKEY` 常數 | 已安裝的 app 用**自己 build 內嵌**的 pubkey 驗 release manifest（#32） |

私密鑰只存在 GitHub secrets：`TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，位於 `release-signing` environment（非 repo 層級）。

## 核心約束：換鑰必須跨兩個 release

Client 永遠用「自己 build 內嵌的 pubkey」驗證下一版。直接換鑰簽新版，所有舊 client 會拒絕更新。所以：

- **Release X**：tag X 的**原始碼**已經換成新公鑰，但 GitHub secrets 還是**舊私鑰** → X 的產物用舊鑰簽。舊 client（內嵌舊公鑰）驗 X ✓；裝完 X 的 client 內嵌新公鑰。
- **X 之後**：GitHub secrets 換成新私鑰 → 之後的 release 用新鑰簽，client ≥ X 全部接受。

X 是唯一一座「舊鑰簽、新公鑰內嵌」的橋。懷疑外洩時，這座橋要儘快推出去。

## 定期輪替（無外洩跡象）

0. 前置：在**安全的機器**上操作；新私鑰不落 repo、不上聊天軟體。
1. 產生新 keypair：
   ```
   npx tauri signer generate -w <隨身碟或安全位置>/mnemark-new.key
   ```
   設強密碼。記下輸出的 public key（base64 單行，`tauri.conf.json` 現有格式同款）。
2. 開 PR：把 `tauri.conf.json` 的 `plugins.updater.pubkey` 與 `update.rs` 的 `UPDATE_PUBKEY` **都**換成新公鑰。跑測試（`UPDATE_PUBKEY` 相關測試會紅，因為測試 fixture 是舊鑰簽的——照 `update.rs` 測試註解重新產生 fixture，或確認測試本來就用獨立測試鑰）。
3. 合併後 tag release X（例：`v0.9.0`）。workflow 會在 `release-signing` environment 等你批准 → 批准 → 產物以**舊私鑰**簽出。
4. **驗證 X**：舊版 client 能更新到 X（updater 成功）；About 頁 portable 更新流程成功。
5. 換 secrets：repo Settings → Environments → `release-signing` → 更新 `TAURI_SIGNING_PRIVATE_KEY`（新私鑰全文，含 `untrusted comment:` 開頭）與 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。**刪除**舊私鑰的所有備份與本機檔案。
6. 之後第一個 release X+1 以新鑰簽。拿 X 的機器驗證能更新到 X+1。
7. 在 CHANGELOG 或 release notes 註記輪替完成日期。

## 疑似私鑰外洩（緊急）

同上流程，但：

- 跳過「定期」的從容排程——第 2、3 步當天完成。橋 release X 愈早上線，持有舊私鑰的攻擊者能偽造的 window 愈短。
- 攻擊者在 X 之前可偽造「更新版本號」的惡意 release讓 pre-X client 接受；X 上線後這個能力歸零。
- 檢查 GitHub audit log（Settings → Audit log）：异常的 secret 存取、未知裝置、workflow run 來源。
- 若懷疑攻擊者已發布偽造更新：除了換鑰，在 release 頁面刪除偽造資產、必要时撤销該 release，並在 X 的 release notes 說明。

### 舊私鑰遺失（無法簽橋 release）

雙 release 舞步需要舊私鑰簽橋版 X；鑰匙遺失時此路不通，改走單 release：

- 直接產生新 keypair、換兩處公鑰、secrets 換新私鑰，下個 release 以新鑰簽。
- **代價**：所有已安裝的舊版 client 內嵌舊公鑰，會拒絕新簽章的更新 — 自動更新靜默失效，必須手動下載安裝一次新版；之後恢復正常。（2026-09-04 即因此走了這條路：舊鑰 D9B038A8EBB93820 只存於 GitHub secrets，無法讀出。）

## 環境保護（一次性設定，輪替前先做）

1. Settings → Environments → New environment → `release-signing`。
2. Required reviewers：加入自己。Deployment branches/tags policy 允許所有 tag（release 由 `v*` tag 觸發）。
3. 把 `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 從 repo-level Actions secrets **搬到**這個 environment secrets（搬完刪 repo 層級的）。
4. `.github/workflows/release.yml` 的 job 已宣告 `environment: release-signing`。
5. 驗證：推一個測試 tag（可先在 fork/branch 用 `workflow_dispatch` 練習），run 應停在「Waiting for approval」，批准後才開始 build。

## 檢查表

- [ ] 新 keypair 產生於安全機器，私鑰僅存 secrets 與一次性安全媒體
- [ ] 兩處公鑰（`tauri.conf.json`、`UPDATE_PUBKEY`）同一個 commit 一起換
- [ ] 橋 release X 以舊鑰簽、內嵌新公鑰，pre-X client 實測可升級
- [ ] Secrets 換新後，X+1 以新鑰簽，X client 實測可升級
- [ ] 舊私鑰檔案全數銷毀
- [ ] 測試 suite 全綠（公鑰相關 fixture 已同步）
