import type { FeatureId } from "./content";

type Cue = {
  id: string;
  kind: "click" | "hover" | "keys" | "type" | "drag" | "scroll";
  frame: number;
  start: number;
  press: number;
  end: number;
  target?: string;
  destination?: string;
  keys?: string[];
  label: [string, string];
  typed?: string;
};
const cues: Record<FeatureId, Cue[]> = {
  capture: [
    {
      id: "copy-text",
      kind: "keys",
      frame: 0,
      start: 0.01,
      press: 0.05,
      end: 0.15,
      target: ".source-text",
      keys: ["Ctrl", "C"],
      label: ["複製文字", "Copy text"],
    },
    {
      id: "copy-image",
      kind: "keys",
      frame: 1,
      start: 0.17,
      press: 0.2,
      end: 0.29,
      target: ".source-image",
      keys: ["Ctrl", "C"],
      label: ["複製圖片", "Copy image"],
    },
    {
      id: "copy-file",
      kind: "keys",
      frame: 1,
      start: 0.3,
      press: 0.325,
      end: 0.415,
      target: ".source-file",
      keys: ["Ctrl", "C"],
      label: ["複製檔案", "Copy file"],
    },
    {
      id: "open-history",
      kind: "keys",
      frame: 1,
      start: 0.425,
      press: 0.45,
      end: 0.52,
      keys: ["Ctrl", "Shift", "V"],
      label: ["叫出最近紀錄", "Open recent copies"],
    },
    {
      id: "filter-images",
      kind: "click",
      frame: 2,
      start: 0.63,
      press: 0.755,
      end: 0.83,
      target: ".app-tabs > span:nth-child(3)",
      label: ["點擊「圖片」分類", "Click Images"],
    },
    {
      id: "select-image",
      kind: "hover",
      frame: 3,
      start: 0.835,
      press: 0.9,
      end: 0.94,
      target: ".app-row .row-main",
      label: ["只剩剛複製的圖片可選", "Only the copied image remains"],
    },
  ],
  search: [
    {
      id: "open-history",
      kind: "keys",
      frame: 0,
      start: 0.01,
      press: 0.105,
      end: 0.18,
      keys: ["Ctrl", "Shift", "V"],
      label: ["叫出歷史面板", "Open history"],
    },
    {
      id: "focus-search",
      kind: "keys",
      frame: 1,
      start: 0.24,
      press: 0.27,
      end: 0.3,
      target: ".app-search",
      keys: ["/"],
      label: ["聚焦搜尋欄", "Focus search"],
    },
    {
      id: "type-search",
      kind: "type",
      frame: 1,
      start: 0.285,
      press: 0.3,
      end: 0.43,
      target: ".app-search",
      typed: ".app-search > span",
      label: ["輸入「摘要」", "Type “summary”"],
    },
    {
      id: "select-result",
      kind: "keys",
      frame: 1,
      start: 0.435,
      press: 0.46,
      end: 0.53,
      target: ".app-row:first-child",
      keys: ["↓"],
      label: ["選取搜尋結果", "Select the result"],
    },
    {
      id: "paste",
      kind: "keys",
      frame: 2,
      start: 0.7,
      press: 0.775,
      end: 0.85,
      target: ".app-row:first-child",
      keys: ["Enter"],
      label: ["貼回原本程式", "Paste back into your app"],
    },
  ],
  drawers: [
    {
      id: "new-drawer",
      kind: "click",
      frame: 0,
      start: 0.01,
      press: 0.12,
      end: 0.17,
      target: ".new-drawer",
      label: ["點擊「新增抽屜」", "Click New drawer"],
    },
    {
      id: "name-drawer",
      kind: "type",
      frame: 1,
      start: 0.24,
      press: 0.25,
      end: 0.35,
      target: ".dialog-input",
      typed: ".cue-typed",
      label: ["輸入「AI 提示詞」", "Type “AI prompts”"],
    },
    {
      id: "create-drawer",
      kind: "click",
      frame: 1,
      start: 0.36,
      press: 0.44,
      end: 0.49,
      target: ".dialog-save",
      label: ["點擊「建立」", "Click Create"],
    },
    {
      id: "drag-to-drawer",
      kind: "drag",
      frame: 2,
      start: 0.52,
      press: 0.59,
      end: 0.775,
      target: ".app-row:first-child .row-handle",
      destination: ".drawer-destination",
      label: [
        "按住拖曳把手，拖入後放開",
        "Hold the handle, drag, then release",
      ],
    },
  ],
  pin: [
    {
      id: "pin-reply",
      kind: "click",
      frame: 0,
      start: 0.01,
      press: 0.12,
      end: 0.17,
      target: ".app-row:nth-child(3) .row-pin",
      label: ["點擊項目旁的釘選", "Click the pin beside the item"],
    },
    {
      id: "copy-another",
      kind: "keys",
      frame: 1,
      start: 0.32,
      press: 0.44,
      end: 0.5,
      keys: ["Ctrl", "C"],
      label: ["在其他程式複製新內容", "Copy new content in another app"],
    },
    {
      id: "copy-pinned",
      kind: "click",
      frame: 2,
      start: 0.62,
      press: 0.765,
      end: 0.84,
      target: ".pinned-row .row-copy",
      label: ["點擊「複製」，保留面板", "Click Copy; keep the panel open"],
    },
  ],
  preview: [
    {
      id: "hover-preview",
      kind: "hover",
      frame: 0,
      start: 0.01,
      press: 0.12,
      end: 0.18,
      target: ".app-row:first-child .row-main",
      label: ["移到項目上預覽，不需點擊", "Hover to preview; no click needed"],
    },
    {
      id: "open-more",
      kind: "click",
      frame: 1,
      start: 0.22,
      press: 0.285,
      end: 0.325,
      target: ".app-row:first-child .row-more",
      label: ["點擊「更多」", "Click More"],
    },
    {
      id: "choose-note",
      kind: "click",
      frame: 1,
      start: 0.33,
      press: 0.435,
      end: 0.48,
      target: ".menu-note",
      label: ["點擊「備註」", "Click Note"],
    },
    {
      id: "type-note",
      kind: "type",
      frame: 2,
      start: 0.54,
      press: 0.55,
      end: 0.66,
      target: ".dialog-input",
      typed: ".cue-typed",
      label: ["輸入使用提醒", "Type a reminder"],
    },
    {
      id: "save-note",
      kind: "click",
      frame: 2,
      start: 0.68,
      press: 0.765,
      end: 0.84,
      target: ".dialog-save",
      label: ["點擊「儲存」", "Click Save"],
    },
  ],
  batch: [
    {
      id: "enable-multi",
      kind: "click",
      frame: 0,
      start: 0.01,
      press: 0.12,
      end: 0.18,
      target: ".batch-toolbar > span",
      label: ["開啟多選", "Enable multi-select"],
    },
    {
      id: "check-first",
      kind: "click",
      frame: 1,
      start: 0.18,
      press: 0.24,
      end: 0.28,
      target: ".app-row:nth-child(1) .fake-check",
      label: ["勾選第一筆", "Select the first item"],
    },
    {
      id: "check-second",
      kind: "click",
      frame: 1,
      start: 0.28,
      press: 0.32,
      end: 0.36,
      target: ".app-row:nth-child(2) .fake-check",
      label: ["勾選第二筆", "Select the second item"],
    },
    {
      id: "check-third",
      kind: "click",
      frame: 1,
      start: 0.36,
      press: 0.4,
      end: 0.43,
      target: ".app-row:nth-child(3) .fake-check",
      label: ["勾選第三筆", "Select the third item"],
    },
    {
      id: "choose-destination",
      kind: "click",
      frame: 1,
      start: 0.415,
      press: 0.455,
      end: 0.5,
      target: ".batch-toolbar > b > svg:first-child",
      label: ["點擊「加入抽屜」", "Click Add to drawer"],
    },
    {
      id: "save-batch",
      kind: "click",
      frame: 2,
      start: 0.58,
      press: 0.765,
      end: 0.84,
      target: ".menu-project",
      label: ["選擇「專案素材」", "Choose Project material"],
    },
  ],
  settings: [
    {
      id: "open-theme",
      kind: "click",
      frame: 0,
      start: 0.005,
      press: 0.055,
      end: 0.08,
      target: ".setting-line:nth-of-type(2) b",
      label: ["點開主題選單", "Open the theme menu"],
    },
    {
      id: "choose-dark",
      kind: "click",
      frame: 0,
      start: 0.08,
      press: 0.135,
      end: 0.18,
      target: ".menu-dark",
      label: ["選擇「深色」", "Choose Dark"],
    },
    {
      id: "enable-history",
      kind: "click",
      frame: 1,
      start: 0.28,
      press: 0.44,
      end: 0.5,
      target: ".setting-line:nth-of-type(3) .fake-toggle",
      label: ["開啟歷史保存", "Enable history persistence"],
    },
    {
      id: "review-exclusions",
      kind: "scroll",
      frame: 2,
      start: 0.62,
      press: 0.75,
      end: 0.84,
      target: ".settings-body",
      label: ["向下捲動，查看排除程式", "Scroll down to review excluded apps"],
    },
  ],
};

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const ease = (value: number) => value * value * (3 - 2 * value);

export function createDemoCues(chapter: HTMLElement, english: boolean) {
  const canvas = chapter.querySelector<HTMLElement>(".demo-canvas")!;
  const wrapper = chapter.querySelector<HTMLElement>(".demo-wrap")!;
  const script = cues[chapter.dataset.chapter as FeatureId];
  const pointer = document.createElement("div");
  pointer.className = "demo-cue-pointer";
  pointer.setAttribute("aria-hidden", "true");
  pointer.innerHTML =
    '<svg viewBox="0 0 24 30"><path d="M2 2v24l7-7 5 9 4-2-5-9h10z" fill="#fff" stroke="#24252a" stroke-width="1.5"/></svg><span class="cue-wheel">↕</span>';
  const ring = document.createElement("span");
  ring.className = "demo-cue-ring";
  ring.setAttribute("aria-hidden", "true");
  canvas.append(pointer, ring);
  const caption = chapter.querySelector<HTMLElement>(
    ".demo-caption > span:first-child",
  )!;
  const oldCaption = caption.innerHTML;
  const hud = document.createElement("span");
  hud.className = "demo-cue-hud";
  caption.replaceChildren(hud);
  const targets = new Map<string, HTMLElement>();
  const fullText = new Map<HTMLElement, string>();
  const resolve = (frame: number, selector: string) => {
    const key = `${frame}:${selector}`;
    if (!targets.has(key)) {
      const element = canvas.querySelector<HTMLElement>(
        `[data-frame="${frame}"] ${selector}`,
      );
      if (!element)
        throw new Error(`Missing demo action target: ${chapter.id} ${key}`);
      targets.set(key, element);
    }
    return targets.get(key)!;
  };
  for (const cue of script) {
    if (cue.target) resolve(cue.frame, cue.target);
    if (cue.destination) resolve(cue.frame, cue.destination);
    if (cue.typed) {
      const element = resolve(cue.frame, cue.typed);
      fullText.set(element, element.textContent || "");
    }
  }
  let activeTarget: HTMLElement | undefined;
  let previousLabel = "";
  // Cache only the real frames: the loop bridge must stay in the initial state.
  const copyCards = [
    ...canvas.querySelectorAll<HTMLElement>(".copy-source[data-copy-kind]"),
  ].map((element) => ({
    element,
    cue: script.find((cue) => cue.id === `copy-${element.dataset.copyKind}`)!,
  }));

  const point = (element: HTMLElement) => {
    const box = element.getBoundingClientRect();
    const area = canvas.getBoundingClientRect();
    const matrix = new DOMMatrix(getComputedStyle(wrapper).transform);
    const inverse = new DOMMatrix([
      matrix.a,
      matrix.b,
      matrix.c,
      matrix.d,
      0,
      0,
    ]).inverse();
    const center = new DOMPoint(
      box.left + box.width / 2 - area.left - area.width / 2,
      box.top + box.height / 2 - area.top - area.height / 2,
    ).matrixTransform(inverse);
    return {
      x: center.x + canvas.clientWidth / 2,
      y: center.y + canvas.clientHeight / 2,
    };
  };
  const menu = (
    selector: string,
    frame: number,
    anchor: string,
    visible: boolean,
  ) => {
    const element = canvas.querySelector<HTMLElement>(selector);
    if (!element) return;
    const position = point(resolve(frame, anchor));
    element.style.left = `${Math.max(8, Math.min(canvas.clientWidth - element.offsetWidth - 8, position.x - element.offsetWidth + 12))}px`;
    element.style.top = `${position.y + 12}px`;
    element.style.opacity = visible ? "1" : "0";
    element.style.visibility = visible ? "visible" : "hidden";
  };

  return {
    update(time: number) {
      canvas
        .querySelector('[data-frame="1"].scenario-search .app-panel')
        ?.classList.toggle("search-pending", time < 0.43);
      canvas
        .querySelector(
          '[data-frame="1"].scenario-search .search-matches .app-row',
        )
        ?.classList.toggle(
          "row-selected",
          time >= cues.search.find((cue) => cue.id === "select-result")!.press,
        );
      for (const { element, cue } of copyCards) {
        element.classList.toggle(
          "is-copying",
          time >= cue.press && time < cue.end,
        );
        element.classList.toggle("is-copied", time >= cue.end);
      }
      menu(
        '[data-frame="1"] .note-menu',
        1,
        ".app-row:first-child .row-more",
        time >= 0.3 && time < 0.475,
      );
      menu(
        '[data-frame="0"] .theme-menu',
        0,
        ".setting-line:nth-of-type(2) b",
        time >= 0.06 && time < 0.15,
      );
      if (chapter.dataset.chapter === "batch") {
        canvas
          .querySelectorAll<HTMLElement>('[data-frame="1"] .app-row')
          .forEach((row, index) =>
            row.classList.toggle(
              "cue-unchecked",
              time < [0.24, 0.32, 0.4][index],
            ),
          );
        const count = [0.24, 0.32, 0.4].filter((at) => time >= at).length;
        const text = canvas.querySelector(
          '[data-frame="1"] .batch-toolbar > span',
        )?.lastChild;
        if (text?.nodeType === Node.TEXT_NODE)
          text.textContent = english
            ? ` ${count} items selected`
            : ` 已選取 ${count} 筆`;
      }
      for (const cue of script)
        if (cue.typed) {
          const element = resolve(cue.frame, cue.typed);
          const original = fullText.get(element)!;
          const nextText = original.slice(
            0,
            Math.round(
              original.length *
                clamp((time - cue.press) / (cue.end - cue.press)),
            ),
          );
          if (element.textContent !== nextText) element.textContent = nextText;
        }
      let index = -1;
      script.forEach((cue, i) => {
        if (time >= cue.start) index = i;
      });
      activeTarget?.classList.remove("cue-target");
      activeTarget = undefined;
      ring.style.opacity = "0";
      const ghost = canvas.querySelector<HTMLElement>(".drag-chip");
      if (ghost) ghost.style.opacity = "0";
      const cue = script[index];
      if (!cue || time > 0.94) {
        pointer.style.opacity = "0";
        pointer.dataset.pressing = "false";
        hud.classList.remove("is-pressed");
        hud.textContent = english ? "Automatic walkthrough" : "自動操作示範";
        previousLabel = "";
        return;
      }
      if (previousLabel !== cue.id) {
        hud.replaceChildren();
        const label = document.createElement("span");
        label.textContent = cue.label[english ? 1 : 0];
        hud.append(label);
        for (const key of cue.keys || []) {
          const element = document.createElement("kbd");
          element.textContent = key;
          hud.append(element);
        }
        previousLabel = cue.id;
      }
      const target = cue.target ? resolve(cue.frame, cue.target) : undefined;
      const prior = script[index - 1];
      const from = prior?.target
        ? point(resolve(prior.frame, prior.destination || prior.target))
        : { x: canvas.clientWidth * 0.8, y: canvas.clientHeight * 0.78 };
      const to = target ? point(target) : from;
      const travel = ease(clamp((time - cue.start) / (cue.press - cue.start)));
      let x = from.x + (to.x - from.x) * travel;
      let y = from.y + (to.y - from.y) * travel;
      let pressing =
        cue.kind === "click" && time >= cue.press && time < cue.press + 0.028;
      if (cue.kind === "drag" && time >= cue.press) {
        const destination = resolve(cue.frame, cue.destination!);
        const end = point(destination);
        const progress = ease(
          clamp((time - cue.press) / (cue.end - cue.press)),
        );
        x = to.x + (end.x - to.x) * progress;
        y =
          to.y + (end.y - to.y) * progress - Math.sin(progress * Math.PI) * 12;
        pressing = time < cue.end;
        if (ghost) {
          ghost.style.left = `${x - 10}px`;
          ghost.style.top = `${y + 6}px`;
          ghost.style.opacity = String(
            time < cue.end ? 1 : 1 - clamp((time - cue.end) / 0.025),
          );
        }
        activeTarget = destination;
      } else if (target && time >= cue.press && time <= cue.end)
        activeTarget = target;
      if (cue.kind === "drag")
        hud.querySelector("span")!.textContent =
          time < cue.press
            ? english
              ? "Move to the drag handle"
              : "移到拖曳把手"
            : time < cue.end
              ? english
                ? "Hold left mouse to drag"
                : "按住滑鼠左鍵拖曳"
              : english
                ? "Release to save in the drawer"
                : "放開滑鼠，存入抽屜";
      activeTarget?.classList.add("cue-target");
      pointer.style.opacity = cue.kind === "keys" ? "0" : "1";
      pointer.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      pointer.classList.toggle("is-holding", cue.kind === "drag" && pressing);
      pointer.classList.toggle(
        "is-scrolling",
        cue.kind === "scroll" && time >= cue.press && time <= cue.end,
      );
      pointer.dataset.action = cue.id;
      pointer.dataset.pressing = String(pressing);
      pointer.dataset.kind = cue.kind;
      hud.classList.toggle("is-pressed", time >= cue.press && time <= cue.end);
      canvas
        .querySelectorAll(".hotkey-callout")
        .forEach((el) =>
          el.classList.toggle(
            "cue-target",
            cue.kind === "keys" &&
              cue.id === "open-history" &&
              time >= cue.press &&
              time < cue.end,
          ),
        );
      const ringTime = cue.kind === "drag" ? cue.end : cue.press;
      if (
        (cue.kind === "click" || cue.kind === "drag") &&
        time >= ringTime &&
        time < ringTime + 0.028
      ) {
        const pulse = clamp((time - ringTime) / 0.028);
        ring.style.left = `${x}px`;
        ring.style.top = `${y}px`;
        ring.style.opacity = String(1 - pulse);
        ring.style.transform = `translate(-50%, -50%) scale(${0.65 + pulse * 1.2})`;
      }
    },
    dispose() {
      canvas
        .querySelector(
          '[data-frame="1"].scenario-search .search-matches .app-row',
        )
        ?.classList.remove("row-selected");
      canvas
        .querySelector('[data-frame="1"].scenario-search .app-panel')
        ?.classList.add("search-pending");
      copyCards.forEach(({ element }) =>
        element.classList.remove("is-copying", "is-copied"),
      );
      canvas
        .querySelectorAll(".cue-target")
        .forEach((element) => element.classList.remove("cue-target"));
      fullText.forEach((text, element) => {
        element.textContent = text;
      });
      pointer.remove();
      ring.remove();
      caption.innerHTML = oldCaption;
    },
  };
}
