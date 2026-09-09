# smooth-wheel

## 行為

滾輪輸入設定目標位置，頁面以約 1.05 秒的 ease-out 曲線追上目標。停止輸入後仍有短暫減速收尾；新輸入或反方向滾輪可立即改變目標，不鎖住使用者。這個時間是單次輸入的收斂時間，不是刻意延後開始移動。

實作使用 Lenis 1.3，`smoothWheel:true`、`duration:1.05`、`easing:1-(1-t)^4`，`syncTouch:false` 保留手機原生觸控慣性。依既有設計要求保持動態預設開啟，不新增調整按鈕。

Lenis 由 GSAP ticker 驅動（autoRaf:false），scroll 事件同步 ScrollTrigger.update；章節的進場、固定及覆蓋因此跟隨平滑後的位置。產品 demo 仍使用自己的 11 秒播放時鐘，沒有連接到捲動進度。

點擊、鍵盤導覽與章節連結會取消尚未結束的滾輪慣性，保留既有原生 hash、焦點及 scroll-padding 行為。離開頁籤時取消慣性；demo 立即暫停，避免背景時鐘間隔造成跳播。ScrollTrigger refresh 後同步量測頁面尺寸。開發熱更新會移除 ticker 與事件處理並銷毀 Lenis。

## 驗證

- 480px 滾輪輸入後，60ms 內尚未抵達終點，停止輸入後仍持續移動，最後準確停在 480px。
- 反向輸入能減速並抵達新位置，不殘留原方向的移動。
- 慣性尚未停止時點擊章節連結，不會被舊目標拉回。
- 檢查原有章節固定、覆蓋、手機、語言切換與 demo 自動重播回歸測試。

依據：[Lenis 官方整合說明](https://github.com/darkroomengineering/lenis#gsap-scrolltrigger)。
