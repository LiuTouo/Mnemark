import { createDemoCues } from "./demo-cues";
import { createAutoplayGroup } from "./autoplay";
import { startSmoothScroll } from "./smooth-scroll";
import "./style.css";
import "./demo.css";
import "./demo-cues.css";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);
const disposeSmoothScroll = startSmoothScroll();
import.meta.hot?.dispose(disposeSmoothScroll);
const english = document.documentElement.lang === "en";
const labels = {
  play: english ? "Play demo" : "播放示範",
  pause: english ? "Pause" : "暫停",
};
let media: gsap.MatchMedia | undefined;

function configureAnimations() {
  media?.revert();
  document.documentElement.dataset.motion = "full";
  media = gsap.matchMedia();
  media.add(
    {
      desktop: "(min-width: 1100px) and (min-height: 600px)",
      any: "(min-width: 0px)",
    },
    (context) => {
      const desktop = context.conditions!.desktop;
      const localCleanup: (() => void)[] = [];
      const autoplay = createAutoplayGroup(labels);
      localCleanup.push(() => autoplay.dispose());
      {
        const cloud = gsap.to(".cloud-track", {
          yPercent: -50,
          duration: 45,
          ease: "none",
          repeat: -1,
          paused: true,
        });
        let heroVisible = true;
        const updateCloud = () => cloud.paused(!heroVisible || document.hidden);
        const heroObserver = new IntersectionObserver((entries) => {
          heroVisible = entries[0].isIntersecting;
          updateCloud();
        });
        heroObserver.observe(document.querySelector(".hero")!);
        document.addEventListener("visibilitychange", updateCloud);
        localCleanup.push(() => {
          heroObserver.disconnect();
          document.removeEventListener("visibilitychange", updateCloud);
        });
      }

      document
        .querySelectorAll<HTMLElement>(".feature-chapter")
        .forEach((chapter) => {
          const frames = gsap.utils.toArray<HTMLElement>(
            chapter.querySelectorAll(".demo-frame"),
          );
          const steps = [
            ...chapter.querySelectorAll<HTMLElement>(".demo-steps li"),
          ];
          const count = chapter.querySelector(".demo-count")!;
          const progressBar = chapter.querySelector<HTMLElement>(
            ".demo-progress > span",
          )!;
          const paintStep = (progress: number) => {
            const step = Math.min(
              3,
              Math.max(0, Math.floor((progress - 0.15) / (0.65 / 2)) + 1),
            );
            chapter.dataset.progress = progress.toFixed(4);
            chapter.dataset.step = String(step);
            steps.forEach((element, index) =>
              element.classList.toggle("current", index === step),
            );
            count.textContent = `0${step + 1} — 04`;
          };
          const timeline = gsap.timeline({ paused: true });
          timeline.to({}, { duration: 1 });
          timeline.fromTo(
            progressBar,
            { scaleX: 0 },
            { scaleX: 1, duration: 1, ease: "none" },
            0,
          );
          for (let step = 1; step < 4; step++) {
            const at = 0.15 + (step - 1) * (0.65 / 2);
            timeline.to(
              frames[step - 1],
              { autoAlpha: 0, duration: 0.035, ease: "none" },
              at,
            );
            timeline.fromTo(
              frames[step],
              { autoAlpha: 0, y: 5 },
              { autoAlpha: 1, y: 0, duration: 0.035, ease: "none" },
              at,
            );
          }
          // Each operation has a visible motion of its own, rather than only swapping a list.
          const rise = (
            selector: string,
            from: gsap.TweenVars,
            at: number,
            duration = 0.2,
          ) => {
            const targets = chapter.querySelectorAll(selector);
            if (targets.length)
              timeline.fromTo(
                targets,
                from,
                {
                  x: 0,
                  y: 0,
                  scale: 1,
                  autoAlpha: 1,
                  duration,
                  ease: "power2.out",
                },
                at,
              );
          };
          switch (chapter.dataset.chapter) {
            case "capture":
              rise(
                '[data-frame="1"] .app-row',
                { y: -36, autoAlpha: 0, stagger: 0.02 },
                0.16,
              );
              rise(
                '[data-frame="3"] .capture-filtered',
                { y: 8, autoAlpha: 0 },
                0.8,
                0.1,
              );
              break;
            case "search":
              rise(
                '[data-frame="1"] .panel-position',
                { y: desktop ? 70 : 30, scale: 0.92, autoAlpha: 0 },
                0.15,
                0.1,
              );
              rise(
                '[data-frame="3"] .pasted-text',
                { y: 22, autoAlpha: 0 },
                0.8,
              );
              break;
            case "drawers":
              rise(
                '[data-frame="1"] .demo-dialog',
                { y: 26, scale: 0.9, autoAlpha: 0 },
                0.15,
                0.08,
              );
              rise('[data-frame="3"] .app-row', { x: -36, autoAlpha: 0 }, 0.8);
              break;
            case "pin":
              rise(
                '[data-frame="1"] .pinned-row',
                { y: 95, autoAlpha: 0.4 },
                0.15,
                0.28,
              );
              rise(
                '[data-frame="2"] .app-row:nth-child(2)',
                { x: 50, autoAlpha: 0 },
                0.48,
              );
              break;
            case "preview":
              rise(
                '[data-frame="2"] .note-dialog',
                { y: 22, scale: 0.92, autoAlpha: 0 },
                0.48,
                0.08,
              );
              rise(
                '[data-frame="3"] .preview-note',
                { y: 20, autoAlpha: 0 },
                0.8,
              );
              break;
            case "batch":
              rise(
                '[data-frame="1"] .fake-check',
                { scale: 0.25, autoAlpha: 0 },
                0.15,
              );
              rise(
                '[data-frame="2"] .batch-destination',
                { y: 45, scale: 0.9, autoAlpha: 0 },
                0.48,
              );
              rise(
                '[data-frame="3"] .app-row',
                { y: -38, autoAlpha: 0.3 },
                0.8,
              );
              break;
            case "settings":
              rise(
                '[data-frame="2"] .fake-toggle.is-on',
                { scale: 0.7, autoAlpha: 0.4 },
                0.48,
              );
              rise('[data-frame="3"] .exclusion', { y: 25, autoAlpha: 0 }, 0.8);
          }
          rise(
            '[data-frame="3"] .demo-notification',
            { y: 20, autoAlpha: 0 },
            0.8,
          );

          // Appy Camper Services: the illustration rises from 30vh and rotates from -10deg.
          // This entrance has its own scroll range, before the product operation starts.
          gsap.fromTo(
            chapter.querySelector(".demo-wrap"),
            {
              y: () => innerHeight * (desktop ? 0.3 : 0.1),
              rotation: desktop ? -10 : -4,
            },
            {
              y: 0,
              rotation: 0,
              ease: "power1.out",
              scrollTrigger: {
                trigger: chapter,
                start: desktop ? "top 60%" : "top 80%",
                end: desktop ? "top 88px" : "top 32%",
                scrub: true,
                invalidateOnRefresh: true,
              },
            },
          );
          gsap.fromTo(
            chapter.querySelector(".feature-story"),
            { y: desktop ? 65 : 25 },
            {
              y: 0,
              ease: "power2.out",
              scrollTrigger: {
                trigger: chapter,
                start: "top 85%",
                end: desktop ? "top 88px" : "top 32%",
                scrub: true,
                invalidateOnRefresh: true,
              },
            },
          );
          const inputCues = createDemoCues(chapter, english);
          localCleanup.push(() => inputCues.dispose());
          timeline.eventCallback("onUpdate", () => {
            inputCues.update(timeline.time());
            paintStep(Math.min(timeline.time(), 1));
            chapter.dataset.cycle = String(timeline.iteration());
          });
          if (desktop) {
            ScrollTrigger.create({
              trigger: chapter,
              start: "top 88px",
              endTrigger: ".feature-chapters",
              end: "bottom bottom",
              pin: chapter.querySelector<HTMLElement>(".feature-stage")!,
              pinSpacing: false,
              invalidateOnRefresh: true,
            });
          }
          autoplay.attach(chapter, timeline);
          paintStep(0);
          chapter.dataset.cycle = "1";
          inputCues.update(0);
        });

      const workflow =
        document.querySelector<HTMLElement>(".workflow-section")!;
      const windowElement =
        workflow.querySelector<HTMLElement>(".workflow-window")!;
      const track = workflow.querySelector<HTMLElement>(".workflow-track")!;
      const workflowCount = workflow.querySelector(".workflow-count")!;
      const overflow = () =>
        Math.max(
          0,
          track.scrollWidth -
            (windowElement.clientWidth -
              parseFloat(getComputedStyle(windowElement).paddingLeft) * 2),
        );
      if (desktop) {
        windowElement.scrollLeft = 0;
        const horizontal = gsap.to(track, {
          x: () => -overflow(),
          ease: "none",
          scrollTrigger: {
            trigger: workflow,
            start: "top 88px",
            end: () => `+=${Math.max(overflow(), innerHeight * 1.8)}`,
            pin: workflow.querySelector<HTMLElement>(".workflow-stage")!,
            scrub: true,
            invalidateOnRefresh: true,
            onUpdate: (self) => {
              workflowCount.textContent = `0${Math.min(4, Math.floor(self.progress * 4) + 1)} — 04`;
            },
          },
        });
        const keyboard = (event: KeyboardEvent) => {
          if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
          event.preventDefault();
          const trigger = horizontal.scrollTrigger!;
          const direction = event.key === "ArrowRight" ? 1 : -1;
          const progress = gsap.utils.clamp(
            0,
            1,
            trigger.progress + direction / 3,
          );
          window.scrollTo({
            top: trigger.start + progress * (trigger.end - trigger.start),
            behavior: "instant",
          });
        };
        windowElement.addEventListener("keydown", keyboard);
        localCleanup.push(() =>
          windowElement.removeEventListener("keydown", keyboard),
        );
      } else {
        const cards = [
          ...track.querySelectorAll<HTMLElement>(".workflow-card"),
        ];
        const previous =
          workflow.querySelector<HTMLButtonElement>("[data-previous]")!;
        const next = workflow.querySelector<HTMLButtonElement>("[data-next]")!;
        const updateCards = () => {
          const width =
            cards[0].offsetWidth + parseFloat(getComputedStyle(track).gap);
          const current = Math.min(
            3,
            Math.round(windowElement.scrollLeft / width),
          );
          const text = `0${current + 1} — 04`;
          workflowCount.textContent = text;
          workflow.querySelector(".workflow-controls > span")!.textContent =
            text;
          previous.disabled = windowElement.scrollLeft <= 1;
          next.disabled =
            windowElement.scrollLeft >=
            windowElement.scrollWidth - windowElement.clientWidth - 2;
        };
        const move = (direction: number) =>
          windowElement.scrollBy({
            left:
              direction *
              (cards[0].offsetWidth + parseFloat(getComputedStyle(track).gap)),
            behavior: "smooth",
          });
        const goBack = () => move(-1);
        const goNext = () => move(1);
        const keyboard = (event: KeyboardEvent) => {
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            move(event.key === "ArrowRight" ? 1 : -1);
          }
        };
        previous.addEventListener("click", goBack);
        next.addEventListener("click", goNext);
        windowElement.addEventListener("scroll", updateCards, {
          passive: true,
        });
        windowElement.addEventListener("keydown", keyboard);
        updateCards();
        localCleanup.push(() => {
          previous.removeEventListener("click", goBack);
          next.removeEventListener("click", goNext);
          windowElement.removeEventListener("scroll", updateCards);
          windowElement.removeEventListener("keydown", keyboard);
        });
      }
      return () => localCleanup.forEach((cleanup) => cleanup());
    },
  );
  ScrollTrigger.refresh();
}

const menu = document.querySelector<HTMLButtonElement>(".menu-toggle")!;
const nav = document.querySelector<HTMLElement>("#site-nav")!;
function closeMenu() {
  nav.classList.remove("open");
  menu.setAttribute("aria-expanded", "false");
}
menu.addEventListener("click", () => {
  const open = nav.classList.toggle("open");
  menu.setAttribute("aria-expanded", String(open));
});
nav.addEventListener("click", (event) => {
  if ((event.target as HTMLElement).closest("a")) closeMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && nav.classList.contains("open")) {
    closeMenu();
    menu.focus();
  }
});
document.addEventListener("click", (event) => {
  if (!(event.target as HTMLElement).closest(".site-header")) closeMenu();
});
matchMedia("(min-width:1100px)").addEventListener("change", closeMenu);

const localeLink = document.querySelector<HTMLAnchorElement>(".locale-link")!;
const localeBase = localeLink.href;
const sectionIds = [
  "top",
  "overview",
  "features",
  "for-you",
  "workflows",
  "maker",
  "download",
];
let scrollQueued = false;
function updateNavigation() {
  const current = sectionIds.reduce(
    (active, id) =>
      document.getElementById(id)!.getBoundingClientRect().top <= 180
        ? id
        : active,
    "top",
  );
  nav.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((link) => {
    if (link.hash === `#${current}`)
      link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
  const chapter = [
    ...document.querySelectorAll<HTMLElement>(".feature-chapter"),
  ]
    .reverse()
    .find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.top <= 180 && rect.bottom > 180;
    });
  localeLink.href = `${localeBase}#${chapter?.id || current}`;
  scrollQueued = false;
}
window.addEventListener(
  "scroll",
  () => {
    if (!scrollQueued) {
      scrollQueued = true;
      requestAnimationFrame(updateNavigation);
    }
  },
  { passive: true },
);
document
  .querySelector(".all-features")!
  .addEventListener("toggle", () => ScrollTrigger.refresh());
configureAnimations();
document.fonts.ready.then(() => {
  ScrollTrigger.refresh();
  // Restore hashes only after pinned layouts and font metrics have settled.
  const id = decodeURIComponent(location.hash.slice(1));
  if (id)
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: "instant", block: "start" });
  updateNavigation();
});
