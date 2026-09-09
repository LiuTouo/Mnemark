import type { FeatureId, Locale } from "./content";

type Icon = (name: string) => string;
type Row = {
  kind: string;
  text: string;
  source: string;
  selected?: boolean;
  pinned?: boolean;
  checked?: boolean;
};

function rows(items: Row[], icon: Icon) {
  return items
    .map(
      (item, index) =>
        `<div data-demo-row="${index}" class="app-row ${item.selected ? "row-selected" : ""} ${item.pinned ? "pinned-row" : ""} ${item.checked ? "row-checked" : ""}"><span class="row-handle"><svg viewBox="0 0 12 18" aria-hidden="true"><path d="M3 3h1m4 0h1M3 8h1m4 0h1M3 13h1m4 0h1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>${item.checked ? `<span class="fake-check">${icon("check")}</span>` : `<div class="row-kind kind-${item.kind}">${icon(item.kind)}</div>`}<div class="row-main"><p>${item.text}</p><small>${item.source}</small></div><span class="row-actions"><span class="row-action row-pin">${icon("pin")}</span><span class="row-action row-copy">${icon("copy")}</span><span class="row-action row-more">···</span></span></div>`,
    )
    .join("");
}

function panel(body: string, icon: Icon, title = "Mnemark", extra = "") {
  return `<div class="app-panel ${extra}"><div class="app-title"><span class="app-mark">m</span><strong>${title}</strong><span class="app-title-right">${icon("grid")}${icon("drawer")}</span></div>${body}</div>`;
}

function searchBar(text: string, icon: Icon, active = false) {
  return `<div class="app-search ${active ? "is-searching" : ""}">${icon("search")}<span>${text}</span><kbd>/</kbd></div>`;
}

function tabs(zh: boolean, selected = 0) {
  return `<div class="app-tabs">${(zh ? ["全部", "文字", "圖片", "檔案", "連結"] : ["All", "Text", "Images", "Files", "Links"]).map((text, index) => `<span class="${index === selected ? "selected" : ""}">${text}</span>`).join("")}</div>`;
}

function footer(zh: boolean, text = "") {
  return `<div class="app-footer"><span>${text || (zh ? "↑ ↓ 選取" : "↑ ↓ Select")}</span><span>↵ ${zh ? "貼上" : "Paste"}</span></div>`;
}

function previewImage() {
  return '<div class="mini-landscape"><div class="landscape-sun"></div><div class="landscape-mountain"></div><span>WEEKEND / 04</span></div>';
}

export function renderDemoFrame(
  id: FeatureId,
  step: number,
  locale: Locale,
  icon: Icon,
) {
  const zh = locale === "zh";
  const prompt = zh
    ? "摘要這份文件的三個重點"
    : "Write a summary of this document in three points";
  const reply = zh
    ? "收到，謝謝你的更新。我會在確認後回覆。"
    : "Thanks for the update. I'll get back to you once confirmed.";
  const placeholder = zh ? "搜尋剪貼簿歷史…" : "Search clipboard history…";
  const promptRow: Row = {
    kind: "text",
    text: prompt,
    source: "ChatGPT · 10:42",
    selected: true,
  };
  const replyRow: Row = {
    kind: "text",
    text: reply,
    source: "Outlook · 09:15",
  };
  const imageRow: Row = {
    kind: "image",
    text: zh ? "專案靈感.png" : "Project inspiration.png",
    source: "Snipping Tool · 10:43",
  };
  const fileRow: Row = {
    kind: "file",
    text: zh ? "專案提案.pdf" : "Project proposal.pdf",
    source: "Explorer · 10:44",
  };
  const queryRow: Row = {
    kind: "link",
    text: "https://github.com/LiuTouo/Mnemark",
    source: "Chrome · 10:40",
  };
  let body = "";
  let scene = "";
  let notification = "";

  if (id === "capture") {
    scene = `<div class="copy-sources"><div class="copy-source source-text">${icon("text")}<span>${zh ? "會議紀錄" : "Meeting notes"}</span><p>${zh ? "把好的想法留下來。" : "Keep the good ideas."}</p></div><div class="copy-source source-image">${previewImage()}</div><div class="copy-source source-file">${icon("file")}<span>proposal.pdf</span></div></div>`;
    const captures =
      step === 0
        ? [
            {
              kind: "text",
              text: zh ? "把好的想法留下來。" : "Keep the good ideas.",
              source: "Notepad · 10:41",
            },
          ]
        : step === 1
          ? [fileRow, imageRow, promptRow]
          : [fileRow, imageRow, promptRow, queryRow];
    body = panel(
      searchBar(placeholder, icon) +
        tabs(zh, step === 3 ? 2 : 0) +
        (step === 3
          ? `<div class="capture-preview">${previewImage()}<span>${zh ? "專案靈感.png · 圖片" : "Project inspiration.png · Image"}</span></div>`
          : `<div class="app-list">${rows(captures, icon)}</div>`) +
        footer(
          zh,
          zh
            ? "複製內容，自動收進歷史"
            : "Copied content, collected automatically",
        ),
      icon,
    );
    if (step < 2) {
      body = "";
      scene += `<div class="capture-waiting">${icon("copy")}<span>${zh ? "照常複製，Mnemark 在背景記錄" : "Copy as usual. Mnemark records in the background."}</span></div>`;
    }
  } else if (id === "search") {
    scene = `<div class="source-editor"><div class="editor-heading">${icon("spark")} ${zh ? "新的 AI 對話" : "A new AI conversation"}<span>+</span></div><p class="editor-greeting">${zh ? "今天，想完成什麼？" : "What will you work on today?"}</p><div class="editor-compose">${step === 3 ? `<span class="pasted-text">${prompt}</span><b>↑</b>` : `<span>${zh ? "輸入訊息…" : "Message…"}</span>`}</div></div>`;
    if (step > 0 && step < 3)
      body = panel(
        searchBar(zh ? "摘要" : "summary", icon, true) +
          tabs(zh) +
          `<div class="app-list">${rows([promptRow], icon)}</div>` +
          `<div class="search-result-note">${zh ? "1 個相符項目" : "1 matching item"}</div>` +
          footer(
            zh,
            step === 2
              ? zh
                ? "已選取 · 按 Enter 貼上"
                : "Selected · Enter to paste"
              : "",
          ),
        icon,
      );
    if (step === 0)
      scene += `<div class="hotkey-callout"><kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>V</kbd></div>`;
    if (step === 3)
      notification = zh ? "已貼回原本的程式" : "Pasted back into your app";
  } else if (id === "drawers") {
    const name = zh ? "AI 提示詞" : "AI prompts";
    const sidebar = `<aside class="app-drawers"><small>${zh ? "我的抽屜" : "MY DRAWERS"}</small><div>${icon("drawer")}${zh ? "工作回覆" : "Work replies"}</div>${step >= 2 ? `<div class="drawer-active drawer-destination">${icon("drawer")}${name}<b>${step === 3 ? 1 : 0}</b></div>` : ""}<div class="new-drawer">+ ${zh ? "新增抽屜" : "New drawer"}</div></aside>`;
    body = panel(
      searchBar(step === 3 ? name : placeholder, icon) +
        `<div class="app-workspace">${sidebar}<div class="app-list">${rows(step === 3 ? [promptRow] : [promptRow, replyRow, queryRow], icon)}</div></div>` +
        footer(
          zh,
          step === 3
            ? zh
              ? "抽屜中保存 1 則內容"
              : "1 saved item in this drawer"
            : "",
        ),
      icon,
    );
    if (step === 1)
      scene += `<div class="demo-dialog"><small>${zh ? "新增抽屜" : "New drawer"}</small><div class="dialog-input"><span class="cue-typed">${name}</span><i></i></div><span class="dialog-save">${zh ? "建立" : "Create"}</span></div>`;
    if (step === 2)
      scene += `<div class="drag-chip">${icon("text")}<span>${prompt}</span></div>`;
    if (step === 3)
      notification = zh
        ? "提示詞，有了自己的位置"
        : "Your prompt has a place of its own";
  } else if (id === "pin") {
    const recent: Row = {
      kind: "text",
      text: zh ? "週四 14:00 專案討論" : "Thursday 14:00 · Project meeting",
      source: "Teams · 11:05",
    };
    const items =
      step === 0
        ? [recent, queryRow, { ...replyRow, selected: true }]
        : [
            { ...replyRow, pinned: true, selected: true },
            ...(step >= 2 ? [fileRow] : []),
            recent,
            queryRow,
          ];
    body = panel(
      searchBar(placeholder, icon) +
        tabs(zh) +
        (step > 0
          ? `<div class="pin-label">${icon("pin")}${zh ? "已釘選" : "PINNED"} · 1 / 10</div>`
          : "") +
        `<div class="app-list">${rows(items, icon)}</div>` +
        footer(
          zh,
          step === 3
            ? zh
              ? "已複製 · 面板保持開啟"
              : "Copied · Panel stays open"
            : "",
        ),
      icon,
    );
    scene = `<div class="pin-guide">${icon("pin")}<span>${zh ? "常用回覆，留在最上面。" : "Your everyday reply, always on top."}</span></div>`;
    if (step === 3)
      notification = zh
        ? "只複製，不關閉面板"
        : "Copy only. Keep your panel open.";
  } else if (id === "preview") {
    const preview = `<aside class="app-preview"><small>${zh ? "內容預覽" : "CONTENT PREVIEW"}</small><h4>${prompt}</h4><p class="preview-body">${zh ? "請依照以下結構整理：<br>1. 核心問題<br>2. 重要發現<br>3. 下一步行動<br><br>使用清楚、簡潔的語言。" : "Please use this structure:<br>1. The core problem<br>2. Key findings<br>3. Next steps<br><br>Keep the language clear and concise."}</p>${step === 3 ? `<div class="preview-note">${icon("note")}${zh ? "每週整理會議紀錄時使用" : "Use for the weekly meeting recap"}</div>` : ""}<small>ChatGPT · 10:42 · 1.2 KB</small></aside>`;
    body = panel(
      searchBar(placeholder, icon) +
        `<div class="app-workspace"><div class="app-list">${rows([promptRow, { kind: "text", text: zh ? "檢查這段文案的語氣" : "Review the tone of this copy", source: "ChatGPT · 09:30" }], icon)}</div>${step >= 1 ? preview : `<div class="preview-placeholder">${icon("note")}<span>${zh ? "選取內容，展開預覽" : "Select an item to preview"}</span></div>`}</div>` +
        footer(zh),
      icon,
      "Mnemark",
      "has-preview",
    );
    if (step === 1)
      scene = `<div class="demo-cue-menu note-menu"><span class="menu-note">${icon("note")}${zh ? "備註" : "Note"}</span></div>`;
    if (step === 2)
      scene = `<div class="demo-dialog note-dialog"><small>${zh ? "編輯備註" : "Edit note"}</small><div class="dialog-input"><span class="cue-typed">${zh ? "每週整理會議紀錄時使用" : "Use for the weekly meeting recap"}</span><i></i></div><span class="dialog-save">${zh ? "儲存" : "Save"}</span></div>`;
  } else if (id === "batch") {
    const items: Row[] = [
      imageRow,
      fileRow,
      {
        kind: "text",
        text: zh ? "提案重點與時程" : "Proposal milestones and timeline",
        source: "Notepad · 11:00",
      },
      queryRow,
    ];
    const toolbar = `<div class="batch-toolbar"><span>${icon("check")} ${step === 0 ? (zh ? "多選模式" : "Multi-select") : step === 3 ? (zh ? "已保存 3 筆" : "3 items saved") : zh ? "已選取 3 筆" : "3 items selected"}</span><b>${icon("drawer")}${icon("file")}</b></div>`;
    body = panel(
      searchBar(placeholder, icon) +
        toolbar +
        `<div class="app-list">${rows(
          items.map((item, index) => ({
            ...item,
            checked: step >= 1 && index < 3,
          })),
          icon,
        )}</div>` +
        footer(
          zh,
          step === 3
            ? zh
              ? "已加入「專案素材」"
              : "Added to Project material"
            : "",
        ),
      icon,
    );
    if (step === 2)
      scene = `<div class="demo-cue-menu batch-menu"><small>${zh ? "加入抽屜" : "Add to drawer"}</small><span class="menu-project">${icon("drawer")}${zh ? "專案素材" : "Project material"}</span></div>`;
    if (step === 3)
      scene = `<div class="batch-destination">${icon("drawer")}<span>${zh ? "專案素材" : "Project material"}</span><b>+3</b></div>`;
    if (step === 3) notification = "";
  } else {
    const item = (label: string, value: string) =>
      `<div class="setting-line"><span>${label}</span><b>${value}</b></div>`;
    const toggle = (on: boolean) =>
      `<span class="fake-toggle ${on ? "is-on" : ""}"></span>`;
    body = panel(
      `<div class="settings-body"><h4>${zh ? "行為與外觀" : "Behavior & appearance"}</h4>${item(zh ? "全域快捷鍵" : "Global shortcut", "Ctrl + Shift + V")}${item(zh ? "外觀主題" : "Appearance", step === 0 ? (zh ? "淺色" : "Light") : zh ? "深色" : "Dark")}${item(zh ? "保存歷史紀錄" : "Save history", toggle(step >= 2))}${item(zh ? "預覽內容" : "Content preview", toggle(true))}${step === 3 ? `<div class="exclusion"><span>${zh ? "不記錄這些程式" : "Do not record these apps"}</span><p>1Password · Bitwarden · KeePass</p></div>` : `<div class="local-note">${icon("drawer")}${zh ? "剪貼簿資料在本機管理" : "Clipboard data stays local"}</div>`}</div>`,
      icon,
      zh ? "設定" : "Settings",
      `settings-panel ${step === 0 ? "light-demo" : ""}`,
    );
    scene = `<div class="settings-guide">${icon("settings")}<span>${zh ? "讓工具配合你的習慣。" : "Make the tool fit your habits."}</span></div>`;
    if (step === 0)
      scene += `<div class="demo-cue-menu theme-menu"><span>${zh ? "跟隨系統" : "System"}</span><span>${zh ? "淺色" : "Light"}</span><span class="menu-dark">${zh ? "深色" : "Dark"}</span></div>`;
  }
  return `<div class="demo-frame scenario-${id}" data-frame="${step}" ${step > 0 ? 'style="opacity:0;visibility:hidden"' : ""}><div class="demo-surface">${body ? `<div class="panel-position">${body}</div>` : ""}${scene}${notification ? `<div class="demo-notification">${icon("check")}<span>${notification}</span></div>` : ""}</div></div>`;
}
