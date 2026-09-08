import { renderDemoFrame } from "./demo";
import { copy, type Locale, type Feature, type FeatureId } from "./content";

type Release = {
  version: string;
  installer: string;
  portable: string;
  direct: boolean;
};
export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const lines = (value: string) => escapeHtml(value).replaceAll("\n", "<br>");

const paths: Record<string, string> = {
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  down: '<path d="M12 4v16m-6-6 6 6 6-6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 8V4H4v11h4"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  text: '<path d="M5 5h14M12 5v15M8 20h8"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 16 5-5 5 5 3-3 5 5"/>',
  file: '<path d="M14 3H5v18h14V8zM14 3v6h5M8 13h8M8 17h5"/>',
  link: '<path d="m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M13 17a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1" transform="translate(0 -2) scale(.95)"/>',
  pin: '<path d="m9 3 8 0-1 7 3 3H5l3-3zM12 13v8"/>',
  drawer:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18M9 8h6M9 16h6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  settings:
    '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="currentColor"/><circle cx="16" cy="12" r="2" fill="currentColor"/><circle cx="10" cy="18" r="2" fill="currentColor"/>',
  note: '<path d="M5 3h14v14l-4 4H5zM15 21v-4h4M8 8h8M8 12h6"/>',
  windows:
    '<path d="M3 5 11 4v8H3zM13 4l8-1v9h-8zM3 14h8v7l-8-1zM13 14h8v9l-8-1z" fill="currentColor" stroke="none"/>',
  play: '<path d="m8 4 12 8-12 8z"/>',
  pause: '<path d="M8 4v16M16 4v16"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  spark:
    '<path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z"/>',
};
export const icon = (name: string, cls = "") =>
  `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.copy}</svg>`;

function scenery() {
  return '<svg class="scenery" viewBox="0 0 320 190" aria-hidden="true"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#83999b"/><stop offset="1" stop-color="#dde1c6"/></linearGradient></defs><path fill="url(#sky)" d="M0 0h320v190H0z"/><circle cx="233" cy="52" r="22" fill="#f9eccb"/><path d="M0 150 82 57l103 105 62-90 73 87v31H0z" fill="#586d62"/><path d="m0 164 57-35 48 38 92-61 123 49v35H0z" fill="#253d38"/><path d="m0 185 65-13 68 12 82-20 105 20v6H0z" fill="#152e29"/></svg>';
}

function heroCards(locale: Locale) {
  const zh = locale === "zh";
  const cards = [
    `<div class="clip-card card-prompt"><span class="card-tag">${icon("spark")} ${zh ? "我的提示詞" : "MY PROMPTS"}</span><p>${zh ? "把複雜的想法，<br>說得簡單一點。" : "Make a complex idea<br>a little easier to understand."}</p><div class="card-rule"></div><small>AI ${zh ? "提示詞" : "prompts"} <span>↗</span></small></div>`,
    `<div class="clip-card card-image">${scenery()}<small>${icon("image")} ${zh ? "下一次的靈感" : "A little inspiration"}<span>PNG</span></small></div>`,
    `<div class="clip-card card-code"><span class="card-tag"><i class="tiny-dot"></i> WORKSPACE</span><pre><span>const</span> ideas = clipboard\n  .<b>find</b>("something good")\n  .<b>useAgain</b>();</pre><small>TypeScript <span>⌘ C</span></small></div>`,
    `<div class="clip-card card-file"><div class="file-art">${icon("file")}</div><p>${zh ? "專案提案.pdf" : "Project proposal.pdf"}</p><small>DOCUMENT <span>2.4 MB</span></small></div>`,
    `<div class="clip-card card-note"><span class="card-tag">${icon("note")} ${zh ? "給未來的自己" : "NOTE TO SELF"}</span><p>${zh ? "好點子，<br>值得被留下。" : "Good ideas<br>are worth keeping."}</p><small>${zh ? "剛剛複製" : "Just copied"}<span>01 / 07</span></small></div>`,
    `<div class="clip-card card-link"><div class="link-art">m<span>↗</span></div><p>github.com/LiuTouo</p><small>${icon("link")} ${zh ? "值得再次造訪" : "Worth another visit"}</small></div>`,
  ];
  return Array.from({ length: 3 }, (_, lane) => {
    const items = [
      cards[lane * 2],
      cards[lane * 2 + 1],
      cards[(lane * 2 + 2) % 6],
    ];
    return `<div class="cloud-lane lane-${lane}"><div class="cloud-track">${[...items, ...items].join("")}</div></div>`;
  }).join("");
}

function demoFrame(id: FeatureId, step: number, locale: Locale) {
  return renderDemoFrame(id, step, locale, icon);
}

function featureSection(feature: Feature, index: number, locale: Locale) {
  const c = copy[locale];
  return `<section class="feature-chapter" style="--chapter-order:${index + 1}" id="feature-${feature.id}" data-chapter="${feature.id}" aria-labelledby="title-${feature.id}">
    <div class="feature-stage wrap">
      <div class="feature-name"><span class="index">${String(index + 1).padStart(2, "0")} / 07</span><span>${escapeHtml(feature.name)}</span><span class="feature-line"></span></div>
      <div class="feature-story"><h3 id="title-${feature.id}">${lines(feature.title)}</h3><p>${escapeHtml(feature.description)}</p><ol class="demo-steps">${feature.steps.map((s, i) => `<li data-step="${i}" class="${i === 0 ? "current" : ""}"><span>${String(i + 1).padStart(2, "0")}</span>${escapeHtml(s)}</li>`).join("")}</ol><p class="feature-detail">${escapeHtml(feature.detail)}</p></div>
      <div class="demo-wrap"><div class="demo-caption"><span><i class="tiny-dot"></i>${c.demo}</span><span class="demo-count">01 — 04</span></div><div class="demo-canvas" role="img" aria-label="${escapeHtml(feature.name + ": " + feature.steps.join(" → "))}">${Array.from({ length: 4 }, (_, s) => demoFrame(feature.id, s, locale)).join("")}</div><div class="demo-progress"><span></span></div><div class="demo-bottom"><span class="scrub-hint">${icon("down")}${c.demoHint}</span><div class="demo-controls" hidden><button type="button" data-play>${icon("play")}<span>${c.playback}</span></button><button type="button" data-replay>${c.replay}</button></div><span class="demo-key">${index === 1 ? "Ctrl + Shift + V" : "MNEMARK"}</span></div></div>
    </div>
  </section>`;
}

export function renderPage(locale: Locale, base: string, release: Release) {
  const c = copy[locale];
  const url = `https://liutouo.github.io${base}`;
  const pageUrl = url + (locale === "en" ? "en/" : "");
  const anchors = ["overview", "features", "for-you", "workflows", "maker"];
  const buttonLabel = release.direct ? c.download : c.fallback;
  const downloadButtons = `<div class="download-actions"><a class="button button-primary" href="${escapeHtml(release.installer)}">${icon("windows")}<span>${buttonLabel}</span>${icon("arrow")}</a><a class="portable-link" href="${escapeHtml(release.portable)}">${c.portable}${icon("arrow")}</a></div>`;
  const head = `<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#111312"><title>${escapeHtml(c.title)}</title><meta name="description" content="${escapeHtml(c.description)}"><link rel="icon" href="${base}icon.svg" type="image/svg+xml"><link rel="canonical" href="${pageUrl}"><link rel="alternate" hreflang="zh-Hant" href="${url}"><link rel="alternate" hreflang="en" href="${url}en/"><link rel="alternate" hreflang="x-default" href="${url}"><meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(c.title)}"><meta property="og:description" content="${escapeHtml(c.description)}"><meta property="og:url" content="${pageUrl}"><meta property="og:image" content="${url}social.png"><meta property="og:locale" content="${locale === "zh" ? "zh_TW" : "en_US"}">`;
  const body = `<a class="skip-link" href="#main">${c.skip}</a>
  <header class="site-header"><a class="brand" href="#top" aria-label="Mnemark — ${c.top}"><img src="${base}icon.svg" width="36" height="36" alt=""><span>IA_LiuT<span class="brand-caption">MAKER OF MNEMARK</span></span></a><button class="menu-toggle" type="button" aria-expanded="false" aria-controls="site-nav">${c.menu}<span>+</span></button><nav id="site-nav" aria-label="${c.menu}">${anchors.map((a, i) => `<a href="#${a}">${c.nav[i]}</a>`).join("")}<a class="locale-link" href="${base}${locale === "zh" ? "en/" : ""}" lang="${locale === "zh" ? "en" : "zh-Hant"}" aria-label="${c.language}">${icon("globe")}${locale === "zh" ? "EN" : "繁中"}</a><a class="nav-download" href="#download">${locale === "zh" ? "下載" : "Download"}${icon("arrow")}</a></nav></header>
  <main id="main"><section class="hero" id="top" aria-labelledby="hero-title"><div class="cloud" aria-hidden="true">${heroCards(locale)}</div><div class="hero-center"><div class="eyebrow"><span class="status-dot"></span>${c.label}</div><h1 id="hero-title">Mnemark<span class="title-dot">.</span></h1><p class="hero-line">${lines(c.heroLine)}</p>${downloadButtons}<div class="hero-meta">${c.platform}<span> / </span>${c.open}</div></div><div class="hero-bottom wrap"><a href="#overview" class="scroll-link">${icon("down")}<span>${c.scroll}<small>01 — 06</small></span></a><p>${lines(c.heroDesc)}</p></div></section>
  <section id="overview" class="overview wrap section-space" aria-labelledby="overview-title"><div class="section-label"><span>01 / ${c.nav[0]}</span>${icon("copy")}</div><div class="overview-grid"><h2 id="overview-title">${lines(c.introTitle)}</h2><div><p class="large-copy">${c.introText}</p><p class="muted">${c.introNote}</p></div></div><div class="quick-flow">${c.quick.map((step, i) => `<div><span class="quick-num">0${i + 1}</span>${icon(["copy", "grid", "search", "arrow"][i])}<h3>${step}</h3><kbd>${["Ctrl + C", "Ctrl + Shift + V", locale === "zh" ? "關鍵字 / ↑ ↓" : "Keyword / ↑ ↓", "Enter"][i]}</kbd></div>`).join("")}</div></section>
  <section id="features" class="features-heading wrap section-space" aria-labelledby="features-title"><div class="section-label"><span>02 / ${c.nav[1]}</span><span>7 FEATURES. ONE WORKFLOW.</span></div><div class="section-heading"><h2 id="features-title">${lines(c.featuresTitle)}</h2><p>${c.featureLead}<br><span class="muted">${c.scrollHelp} ↓</span></p></div></section>
  <div class="feature-chapters">${c.features.map((f, i) => featureSection(f, i, locale)).join("")}</div>
  <div class="feature-facts wrap"><details class="all-features"><summary>${c.allFeatures}<span>+</span></summary><div class="facts-grid">${c.details.map(([title, text]) => `<div><h3>${title}</h3><p>${text}</p></div>`).join("")}</div></details></div>
  <section id="for-you" class="audience wrap section-space" aria-labelledby="audience-title"><div class="section-label"><span>03 / ${c.nav[2]}</span>${icon("spark")}</div><div class="section-heading"><h2 id="audience-title">${lines(c.audienceTitle)}</h2><p>${c.audienceLead}</p></div><div class="audience-grid">${c.audiences.map(([n, title, text], i) => `<article><span class="audience-number">${n}</span>${icon(["spark", "text", "image", "settings"][i])}<h3>${title}</h3><p>${text}</p></article>`).join("")}</div></section>
  <section id="workflows" class="workflow-section" aria-labelledby="workflow-title"><div class="workflow-stage"><div class="wrap"><div class="section-label"><span>04 / ${c.nav[3]}</span><span class="workflow-count">01 — 04</span></div><div class="section-heading"><h2 id="workflow-title">${lines(c.workflowTitle)}</h2><p>${c.workflowLead}</p></div></div><div class="workflow-window" tabindex="0" aria-label="${c.nav[3]}"><div class="workflow-track">${c.workflows.map(([tag, title, lead, steps, result], i) => `<article class="workflow-card"><div class="workflow-card-top"><span>${tag}</span>${icon(["spark", "text", "image", "settings"][i])}</div><h3>${lines(title as string)}</h3><p>${lead}</p><ol>${(steps as string[]).map((s, n) => `<li><span>0${n + 1}</span>${s}</li>`).join("")}</ol><div class="workflow-result">${result}${icon("arrow")}</div><span class="workflow-watermark" aria-hidden="true">0${i + 1}</span></article>`).join("")}</div></div><div class="workflow-controls wrap"><button type="button" data-previous aria-label="${c.previous}">${icon("arrow", "reverse")}</button><span>01 — 04</span><button type="button" data-next aria-label="${c.next}">${icon("arrow")}</button></div></div></section>
  <section id="maker" class="maker wrap section-space" aria-labelledby="maker-title"><div class="section-label"><span>05 / ${c.nav[4]}</span><span>INDEPENDENTLY MADE</span></div><div class="maker-grid"><div class="maker-art" aria-label="IA_LiuT"><div class="maker-orbit"></div><span>IA<span class="maker-slash">_</span><br>LiuT<span class="title-dot">.</span></span><small>${c.creatorRole}</small></div><div><h2 id="maker-title">${lines(c.creatorTitle)}</h2><p>${lines(c.creatorBody)}</p><a class="text-link" href="https://github.com/LiuTouo">${c.creatorLink}${icon("arrow")}</a></div></div></section>
  <section id="download" class="download-section section-space"><div class="wrap"><div class="section-label"><span>06 / ${locale === "zh" ? "開始使用" : "GET STARTED"}</span><span>${escapeHtml(release.version) || "WINDOWS"}</span></div><div class="download-heading"><h2>${lines(c.finalTitle)}</h2><p>${c.finalLead}</p>${downloadButtons}<p class="download-platform">${c.platform}</p></div><div class="download-info"><div><h3>${c.installTitle}</h3><p>${c.installBody}</p></div><div><h3>${c.portableTitle}</h3><p>${c.portableBody}</p></div><div><h3>WebView2</h3><p>${c.requirement}</p><a href="https://developer.microsoft.com/microsoft-edge/webview2/">${c.webview} ↗</a></div></div><ol class="start-steps">${c.startSteps.map((s, i) => `<li><span>0${i + 1}</span>${s}</li>`).join("")}</ol><a class="release-link" href="https://github.com/LiuTouo/Mnemark/releases/latest">${c.releases} ↗</a></div></section></main>
  <footer class="site-footer wrap"><a class="footer-wordmark" href="#top">Mnemark<span>.</span></a><div class="footer-bottom"><span>© ${new Date().getFullYear()} IA_LiuT · ${c.footer}</span><a href="https://github.com/LiuTouo/Mnemark/blob/main/LICENSE">${c.license}</a><a href="#top">${c.top} ↑</a></div></footer>`;
  return { head, body };
}
