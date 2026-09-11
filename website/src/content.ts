export type Locale = "zh" | "en";
export type FeatureId =
  "capture" | "search" | "drawers" | "pin" | "preview" | "batch" | "settings";
export interface Feature {
  id: FeatureId;
  name: string;
  title: string;
  description: string;
  steps: [string, string, string, string];
  detail: string;
}

const zhFeatures: Feature[] = [
  {
    id: "capture",
    name: "內容記錄",
    title: "剛剛複製的，\n都在這裡。",
    description:
      "一句靈感、一張截圖，或一份要交付的檔案。照常複製，讓 Mnemark 在背景接住這些工作片段。",
    steps: [
      "照常複製一段文字",
      "再依序複製圖片與檔案",
      "叫出歷史，依新到舊顯示三筆",
      "點選圖片分類，只留下圖片",
    ],
    detail:
      "支援文字、圖片、檔案與連結分類；相同內容再次複製會更新時間，不重複堆積。檔案保存路徑參照，並非備份。",
  },
  {
    id: "search",
    name: "額外功能：搜尋",
    title: "少一次尋找。\n多一點專注。",
    description:
      "最近複製的內容可以直接選取貼上。需要找較早的項目時，再用關鍵字搜尋。",
    steps: [
      "按 Ctrl + Shift + V",
      "搜尋「摘要」",
      "滑鼠點擊搜尋結果",
      "立即貼回原本的程式",
    ],
    detail:
      "搜尋項目預覽、來源程式與視窗標題。按 / 聚焦搜尋，Enter 貼上，Esc 關閉；也可啟用 j／k 導覽。",
  },
  {
    id: "drawers",
    name: "抽屜分類",
    title: "常用的內容，\n有自己的位置。",
    description:
      "為提示詞、工作回覆與專案素材各留一個抽屜。整理一次，下次需要時就從熟悉的位置取用。",
    steps: [
      "點擊「新增抽屜」",
      "輸入名稱並建立抽屜",
      "把提示詞拖進抽屜",
      "選取抽屜，再次使用",
    ],
    detail:
      "抽屜可新增、重新命名、刪除及拖曳排序。保存項目獨立於一般歷史，關閉程式後仍能取用。",
  },
  {
    id: "pin",
    name: "釘選重用",
    title: "重要的，\n一直在手邊。",
    description:
      "每天會用到的那幾段內容，留在清單最上方。需要連續操作時，也能只複製，讓面板保持開啟。",
    steps: [
      "點擊常用回覆旁的釘選",
      "將項目釘選",
      "新的紀錄進來，釘選仍在頂部",
      "只複製，繼續留在面板",
    ],
    detail:
      "最多釘選 10 則，不受容量淘汰；釘選與歷史一樣，是否跨重啟保留取決於歷史持久化設定。",
  },
  {
    id: "preview",
    name: "預覽與備註",
    title: "看清楚，\n再貼出去。",
    description:
      "長提示詞不必憑第一行猜。展開預覽、查看來源，再留一句給下次自己的使用提醒。",
    steps: [
      "先預覽圖片縮圖，再預覽文字",
      "點開「更多」並選擇備註",
      "輸入備註並儲存",
      "內容與使用提醒一起查看",
    ],
    detail:
      "預覽包含內容、來源、擷取時間與大小。備註會跟隨項目保存到抽屜；備註不參與搜尋。",
  },
  {
    id: "batch",
    name: "批次整理",
    title: "一次選好。\n一起整理。",
    description:
      "專案結束後，把值得留下的片段一起收好。多選、分類、清理，讓工作區保持剛剛好的秩序。",
    steps: [
      "開啟多選模式",
      "勾選需要保存的三筆項目",
      "選擇要加入的專案抽屜",
      "確認內容已批次保存",
    ],
    detail:
      "可全選目前可見項目、批次加入抽屜、刪除歷史或移除抽屜項目。歷史刪除提供 3 秒復原時間。",
  },
  {
    id: "settings",
    name: "依你習慣設定",
    title: "你的工作流，\n你來決定。",
    description:
      "從熟悉的快捷鍵到舒服的主題，從歷史容量到哪些程式不記錄。讓工具配合你的工作方式。",
    steps: [
      "點開外觀主題選單",
      "選擇深色主題",
      "開啟歷史保存",
      "向下查看排除程式清單",
    ],
    detail:
      "剪貼簿資料在本機管理。更新檢查與下載會連線；程式排除依複製當下的前景應用程式判斷。",
  },
];
const enFeatures: Feature[] = [
  {
    id: "capture",
    name: "Clipboard history",
    title: "Copied a moment ago.\nHere when you need it.",
    description:
      "A good thought, a screenshot, a file ready to share. Copy as you normally would. Mnemark keeps those working pieces close.",
    steps: [
      "Copy a piece of text",
      "Copy the image, then the file",
      "Open all three copies, newest first",
      "Click Images to show only the image",
    ],
    detail:
      "Text, images, files and links. Copying the same content updates its timestamp instead of adding a duplicate. Files are path references, not backups.",
  },
  {
    id: "search",
    name: "Extra: search",
    title: "Less looking.\nMore doing.",
    description:
      "Recent copies are ready to select right away. When you need an older item, search a keyword to find it.",
    steps: [
      "Press Ctrl + Shift + V",
      "Search for “summary”",
      "Click the search result",
      "Paste immediately into your app",
    ],
    detail:
      "Search item previews, source apps and window titles. Press / to focus search, Enter to paste, Esc to dismiss. Optional j/k navigation is available.",
  },
  {
    id: "drawers",
    name: "Organize in drawers",
    title: "A place for the things\nyou use again.",
    description:
      "Give prompts, work replies and project material a drawer of their own. Organize once. Find them somewhere familiar next time.",
    steps: [
      "Click New drawer",
      "Enter a name and create the drawer",
      "Drag your prompt into it",
      "Open the drawer and use it again",
    ],
    detail:
      "Create, rename, delete and reorder drawers. Saved drawer items are independent of regular history and remain available after restarting.",
  },
  {
    id: "pin",
    name: "Pin & reuse",
    title: "The important things.\nWithin reach.",
    description:
      "Keep your everyday snippets at the top of the list. Copy without closing the panel when your next action is already waiting.",
    steps: [
      "Click the pin beside a frequent reply",
      "Pin the item",
      "New entries arrive; your pin stays on top",
      "Copy and keep the panel open",
    ],
    detail:
      "Pin up to 10 items to protect them from capacity eviction. Like other history, pins survive restarts only when history persistence is enabled.",
  },
  {
    id: "preview",
    name: "Preview & notes",
    title: "See the whole thing.\nThen hit paste.",
    description:
      "A long prompt deserves more than a first-line guess. Preview its contents, check the source, and leave a useful note for your future self.",
    steps: [
      "Preview the image thumbnail, then the text",
      "Open More and choose Note",
      "Type a note and save it",
      "Read the content and its reminder together",
    ],
    detail:
      "Preview content, source, capture time and size. Notes travel with saved drawer items. Notes are not included in search.",
  },
  {
    id: "batch",
    name: "Batch actions",
    title: "Select together.\nSort together.",
    description:
      "When a project wraps up, save the pieces worth keeping. Select, organize and clear out, without repeating every single click.",
    steps: [
      "Turn on multi-select",
      "Select three items to keep",
      "Choose a project drawer",
      "Confirm the items have been saved",
    ],
    detail:
      "Select visible items, add them to drawers, delete history or remove drawer items in batches. History deletions have a 3-second undo window.",
  },
  {
    id: "settings",
    name: "Make it yours",
    title: "Your workflow.\nYour way.",
    description:
      "Familiar shortcuts. A comfortable theme. Control over history limits and excluded apps. A small tool that fits the way you work.",
    steps: [
      "Open the appearance menu",
      "Choose the dark theme",
      "Enable history persistence",
      "Scroll down to review excluded apps",
    ],
    detail:
      "Clipboard data is managed locally. Update checks and downloads use the network. App exclusions use the foreground app at the time of copying.",
  },
];

export const copy = {
  zh: {
    lang: "zh-Hant",
    title: "Mnemark — 讓每次複製，都成為下次的捷徑",
    description:
      "Windows 剪貼簿管理工具。記錄文字、圖片與檔案，搜尋、釘選、抽屜分類，一鍵貼回工作。支援繁中與英文，提供安裝版及可攜版。",
    nav: ["介紹", "功能", "適用對象", "工作流", "製作者"],
    menu: "選單",
    skip: "跳至主要內容",
    language: "Switch to English",
    download: "下載 Windows 版",
    portable: "免安裝版本",
    releases: "查看版本與所有下載",
    fallback: "前往 GitHub 選擇下載",
    platform: "Windows 10 / 11 · 64 位元",
    open: "開源 · 本機管理",
    heroTag: "把複製，變成累積。",
    heroLine: "讓每次複製，\n都成為下次的捷徑。",
    heroDesc: "文字、圖片、檔案與靈感。\n找回你複製過的內容，接著把工作做好。",
    scroll: "往下探索",
    scrollHelp: "停下來，看它如何運作",
    label: "為日常工作而做",
    introTitle: "你的剪貼簿，\n值得多一點記憶。",
    introText:
      "好的提示詞，不該每次重找。常用的回覆，不必一再重打。Mnemark 接住你複製過的片段，讓它們在下一次工作裡繼續派上用場。",
    introNote:
      "按下快捷鍵，歷史面板就會顯示最近複製的項目。選取需要的內容，直接貼回原本的程式。",
    quick: ["照常複製", "叫出最近紀錄", "選取並貼回"],
    optionalSearch: "額外功能：需要找較早的內容時，可以使用搜尋。",
    optionalSearchLink: "查看搜尋示範",
    featuresTitle: "小工具。\n讓工作順手的大本事。",
    featureLead: "常用功能與進階工具，讓工作更順手。",
    demo: "功能操作示意",
    playback: "播放示範",
    pause: "暫停",
    replay: "重播",
    demoHint: "自動循環播放",
    allFeatures: "完整功能、快捷鍵與使用須知",
    audienceTitle: "用電腦工作的人。\n也是常常重複的人。",
    audienceLead:
      "把時間留給判斷、創作與解決問題。重複取用的片段，交給一個熟悉的位置。",
    audiences: [
      [
        "01",
        "經常使用 AI 的你",
        "把常用提示詞存進抽屜，少一次回到舊對話裡翻找。",
      ],
      [
        "02",
        "處理大量回覆的你",
        "把郵件範本、常見答覆與會議資訊整理好，保持回覆一致。",
      ],
      [
        "03",
        "研究與創作中的你",
        "在文章、圖片與文件之間切換，讓剛剛找到的素材保持可取用。",
      ],
      [
        "04",
        "寫程式、解問題的你",
        "收好常用指令與程式碼片段，把注意力留給眼前的問題。",
      ],
    ],
    workflowTitle: "放進日常，\n就知道順手。",
    workflowLead: "使用情境 / 不是真實使用者評價",
    workflows: [
      [
        "AI WORKFLOW",
        "從好提示詞，\n開始下一次對話。",
        "不用記得它藏在哪個聊天視窗。",
        [
          "複製已驗證的提示詞",
          "存入「AI 提示詞」抽屜",
          "需要時呼叫面板，再次貼上",
        ],
        "少找一次，多想一步。",
      ],
      [
        "EVERYDAY REPLIES",
        "熟悉的問題，\n有準備好的回覆。",
        "把常見答覆整理成你的工作語言。",
        ["複製常用回覆", "釘選或放進工作抽屜", "貼上後，依情境調整"],
        "回覆更順，細節仍由你決定。",
      ],
      [
        "RESEARCH & CREATE",
        "靈感分散，\n素材不用跟著散。",
        "為手邊專案留一個暫存與整理的地方。",
        ["複製文字、圖片與連結", "預覽並挑選需要的內容", "批次收進專案抽屜"],
        "接著研究，不必回頭找。",
      ],
      [
        "BUILD & DEBUG",
        "熟悉的指令，\n不必再查一次。",
        "把會再用到的小片段放到手邊。",
        ["複製指令或程式碼", "加入備註，標明用途", "取用、確認，再貼回編輯器"],
        "把專注留給真正的問題。",
      ],
    ],
    previous: "上一張情境",
    next: "下一張情境",
    creatorTitle: "一個人的製作。\n很多人的日常。",
    creatorRole: "Mnemark 製作者",
    creatorBody:
      "找到、整理、再次使用。\n讓一個小工具，成為工作裡熟悉的一部分。",
    creatorLink: "到 GitHub 看看",
    finalTitle: "下一次複製，\n就從這裡開始。",
    finalLead: "讓散落的工作片段，有個隨時能回去的地方。",
    installTitle: "安裝版",
    installBody: "一般安裝流程；可在設定啟用自動更新。",
    portableTitle: "可攜版",
    portableBody: "單一執行檔，免安裝；從關於頁面手動檢查更新。",
    requirement:
      "需要 Microsoft Edge WebView2 Runtime。Windows 11 與多數已更新的 Windows 10 已具備。",
    webview: "WebView2 下載說明",
    startSteps: [
      "照常複製文字、圖片或檔案",
      "Ctrl + Shift + V 叫出最近紀錄",
      "選取項目，按 Enter 或點擊貼上",
    ],
    footer: "讓工作片段，繼續派上用場。",
    license: "GPL-3.0 開源授權",
    top: "回到頂端",
    features: zhFeatures,
    details: [
      [
        "鍵盤與面板",
        "Ctrl+Shift+V 開關面板；/ 搜尋；方向鍵選取；Enter 貼上；Esc 關閉。可啟用 j/k 導覽。左 Alt 或星號按鈕開關抽屜，兩組快捷鍵皆可調整。點擊面板外會關閉；複製按鈕只複製，不關閉。",
      ],
      [
        "保存與容量",
        "歷史預設保存在本機；想要程式關閉就清除歷史，可在設定取消勾選持久化。停用會刪除已存歷史，釘選也遵循此設定。抽屜項目獨立保存，不受這個開關影響。可調整文字與圖片容量；超過限制先淘汰未釘選舊項目，釘選最多 10 則。",
      ],
      [
        "搜尋、預覽與檔案",
        "搜尋比對預覽、來源程式與視窗標題，不是全文、OCR、語意或備註搜尋。過長文字可能截斷、圖片可能壓縮。檔案只保存路徑參照，來源檔案必須仍存在；可改為貼上路徑。",
      ],
      [
        "隱私與暫停",
        "剪貼簿資料在本機管理。預設排除 1Password、Bitwarden、KeePass，依複製當下的前景程式判斷，不能辨識所有敏感內容或背景擴充套件。系統匣可暫停記錄，恢復時不補抓暫停期間的內容。",
      ],
      [
        "外觀、啟動與更新",
        "支援繁中／英文、主題、不透明度、縮放、預覽開關與登入時啟動。安裝版支援可選的自動更新，可攜版手動更新。更新檢查、下載及外部連結會使用網路。",
      ],
      [
        "使用邊界",
        "目前支援 Windows 10/11 x64，需要 WebView2。無內建 AI 生成、帳號或雲同步。對較高權限視窗可能無法自動貼上，此時內容留在剪貼簿，可自行按 Ctrl+V。",
      ],
    ],
  },
  en: {
    lang: "en",
    title: "Mnemark — Make every copy a shortcut for next time",
    description:
      "A Windows clipboard manager for your everyday work. Find copied text, images and files. Search, pin, organize in drawers, and paste back into your app. Installer and portable downloads.",
    nav: ["Overview", "Features", "For you", "Workflows", "Maker"],
    menu: "Menu",
    skip: "Skip to content",
    language: "切換繁體中文",
    download: "Download for Windows",
    portable: "Portable version",
    releases: "Release notes & all downloads",
    fallback: "Choose a download on GitHub",
    platform: "Windows 10 / 11 · 64-bit",
    open: "Open source · Local data",
    heroTag: "Copy. Keep. Carry on.",
    heroLine: "Make every copy\na shortcut for next time.",
    heroDesc:
      "Text, images, files and good ideas.\nFind what you copied. Get on with your work.",
    scroll: "Scroll to explore",
    scrollHelp: "Watch each feature in action",
    label: "Made for everyday work",
    introTitle: "Your clipboard.\nWith a little more memory.",
    introText:
      "Good prompts shouldn't need finding twice. Familiar replies shouldn't need writing again. Mnemark keeps the pieces you copy ready for the next thing you do.",
    introNote:
      "Press the shortcut to see your recent copies in the history panel. Select what you need and paste it straight back into your app.",
    quick: ["Copy as usual", "Open recent copies", "Select and paste"],
    optionalSearch:
      "An extra when you need it: use search to find older content.",
    optionalSearchLink: "See search in action",
    featuresTitle: "A small tool.\nA smoother working day.",
    featureLead: "Everyday essentials, with extras when you need them.",
    demo: "Product walkthrough",
    playback: "Play demo",
    pause: "Pause",
    replay: "Replay",
    demoHint: "Autoplay · continuous loop",
    allFeatures: "All features, shortcuts & things to know",
    audienceTitle: "For people who work.\nAnd do things twice.",
    audienceLead:
      "Keep your time for thinking, creating and solving. Give the pieces you reuse a familiar place to live.",
    audiences: [
      [
        "01",
        "For your AI workflow",
        "Keep useful prompts in a drawer, instead of digging through yesterday's conversation.",
      ],
      [
        "02",
        "For everyday communication",
        "Organize email templates, common replies and meeting details to stay consistent.",
      ],
      [
        "03",
        "For research and creative work",
        "Move between articles, images and documents without losing the material you just found.",
      ],
      [
        "04",
        "For building and debugging",
        "Keep useful commands and code snippets nearby. Give the actual problem your attention.",
      ],
    ],
    workflowTitle: "Fits into your day.\nFeels like it belongs.",
    workflowLead: "Example workflows / Not customer testimonials",
    workflows: [
      [
        "AI WORKFLOW",
        "A better starting point\nfor your next conversation.",
        "You don't need to remember which chat it came from.",
        [
          "Copy a prompt that works",
          "Save it in your AI prompts drawer",
          "Bring up the panel and paste it again",
        ],
        "Less searching. More thinking.",
      ],
      [
        "EVERYDAY REPLIES",
        "Familiar questions.\nA reply ready to go.",
        "Build a small collection in your own working voice.",
        [
          "Copy your usual reply",
          "Pin it or add it to a work drawer",
          "Paste, then tailor it to the moment",
        ],
        "A smoother reply. Still your judgment.",
      ],
      [
        "RESEARCH & CREATE",
        "Ideas can wander.\nYour material doesn't have to.",
        "Give a project somewhere to collect its useful pieces.",
        [
          "Copy text, images and links",
          "Preview and select what matters",
          "Add the items to a project drawer",
        ],
        "Keep researching. Skip the retracing.",
      ],
      [
        "BUILD & DEBUG",
        "The command you know.\nWithout another lookup.",
        "Keep the little pieces you'll need again within reach.",
        [
          "Copy a command or code snippet",
          "Add a note about when to use it",
          "Retrieve, review and paste into your editor",
        ],
        "Focus on the actual problem.",
      ],
    ],
    previous: "Previous workflow",
    next: "Next workflow",
    creatorTitle: "Made by one.\nFor everyday people.",
    creatorRole: "Creator of Mnemark",
    creatorBody:
      "Find it. Organize it. Use it again.\nA small tool with a familiar place in your day.",
    creatorLink: "Meet the project on GitHub",
    finalTitle: "Your next copy\nstarts here.",
    finalLead:
      "Give the scattered pieces of your work a place to come back to.",
    installTitle: "Installer",
    installBody:
      "A familiar setup process. Optional automatic updates in settings.",
    portableTitle: "Portable",
    portableBody:
      "One executable, no installation. Check for updates manually in About.",
    requirement:
      "Requires Microsoft Edge WebView2 Runtime. Included with Windows 11 and most updated Windows 10 systems.",
    webview: "Get WebView2",
    startSteps: [
      "Copy text, images or files",
      "Ctrl + Shift + V opens recent copies",
      "Select an item, then press Enter or click",
    ],
    footer: "Give your working pieces a second life.",
    license: "GPL-3.0 open source",
    top: "Back to top",
    features: enFeatures,
    details: [
      [
        "Keyboard & panel",
        "Ctrl+Shift+V toggles the panel; / focuses search; arrows select; Enter pastes; Esc closes. Optional j/k navigation. Left Alt or the star toggles drawers; both shortcuts are configurable. Clicking outside closes the panel. Copy-only keeps it open.",
      ],
      [
        "Storage & capacity",
        "History is saved locally by default; to clear history when the app closes, uncheck persistence in Settings. Disabling persistence removes saved history. Pins follow this setting. Drawer items are saved independently. Text and image limits are configurable; oldest unpinned items are evicted first. Up to 10 pins.",
      ],
      [
        "Search, preview & files",
        "Search matches previews, source apps and window titles; not full text, OCR, semantics or notes. Long text may be truncated and images compressed. Files are path references and must still exist; pasting as path text is optional.",
      ],
      [
        "Privacy & pausing",
        "Clipboard data is managed locally. 1Password, Bitwarden and KeePass are excluded by default using the foreground app at copy time. This cannot identify every sensitive item or background extension. Pause recording from the tray; paused copies are not captured later.",
      ],
      [
        "Appearance, startup & updates",
        "Traditional Chinese and English, themes, opacity, scaling, preview controls and startup on sign-in. Optional automatic updates for the installer; manual updates for portable. Update checks, downloads and external links use the network.",
      ],
      [
        "Compatibility & limits",
        "Windows 10/11 x64 with WebView2. No built-in AI generation, accounts or cloud sync. Automatic paste into elevated windows may be unavailable; content stays on the clipboard for manual Ctrl+V.",
      ],
    ],
  },
};
