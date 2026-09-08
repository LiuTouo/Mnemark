import "./style.css";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);
const english = document.documentElement.lang === "en";
const labels = {
  play: english ? "Play demo" : "播放示範",
  pause: english ? "Pause" : "暫停",
};
const motionButton =
  document.querySelector<HTMLButtonElement>(".motion-toggle")!;
const systemMotion = matchMedia("(prefers-reduced-motion: reduce)");
let motionPreference: string | null = null;
try {
  motionPreference = localStorage.getItem("mnemark-site-motion");
} catch {
  /* Storage may be disabled. */
}
let media: gsap.MatchMedia | undefined;

function configureAnimations() {
  media?.revert();
  const reduced = motionPreference
    ? motionPreference === "reduced"
    : systemMotion.matches;
  document.documentElement.dataset.motion = reduced ? "reduced" : "full";
  motionButton.setAttribute("aria-pressed", String(reduced));
  motionButton.querySelector("span")!.textContent = reduced
    ? motionButton.dataset.off!
    : motionButton.dataset.on!;
  media = gsap.matchMedia();
  media.add(
    {
      desktop: "(min-width: 1100px) and (min-height: 700px)",
      any: "(min-width: 0px)",
    },
    (context) => {
      const desktop = context.conditions!.desktop && !reduced;
      const localCleanup: (() => void)[] = [];
      if (!reduced) {
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
          const play = chapter.querySelector<HTMLButtonElement>("[data-play]")!;
          const replay =
            chapter.querySelector<HTMLButtonElement>("[data-replay]")!;
          const controls =
            chapter.querySelector<HTMLElement>(".demo-controls")!;
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
          if (chapter.dataset.chapter === "search") {
            timeline.fromTo(
              frames[1].querySelector(".app-search > span"),
              { clipPath: "inset(0 100% 0 0)" },
              { clipPath: "inset(0 0% 0 0)", duration: 0.22, ease: "none" },
              0.17,
            );
          }
          const dragChip = chapter.querySelector(".drag-chip");
          if (dragChip)
            timeline.fromTo(
              dragChip,
              { x: 140, y: -45 },
              { x: 0, y: 0, duration: 0.28, ease: "none" },
              0.48,
            );
          timeline.eventCallback("onUpdate", () =>
            paintStep(timeline.progress()),
          );
          const resetPlayLabel = () => {
            play.querySelector("span")!.textContent = labels.play;
            play.setAttribute("aria-pressed", "false");
          };
          resetPlayLabel();
          timeline.eventCallback("onComplete", resetPlayLabel);
          controls.hidden = Boolean(desktop);
          if (desktop) {
            ScrollTrigger.create({
              trigger: chapter,
              start: "top 88px",
              end: "bottom bottom",
              animation: timeline,
              scrub: true,
              invalidateOnRefresh: true,
            });
          } else {
            // Same reversible timeline; mobile explicitly plays it over eight seconds.
            timeline.timeScale(1 / 8);
            const onPlay = () => {
              if (timeline.paused() || timeline.progress() === 1) {
                if (timeline.progress() === 1) timeline.progress(0);
                timeline.play();
                play.querySelector("span")!.textContent = labels.pause;
                play.setAttribute("aria-pressed", "true");
              } else {
                timeline.pause();
                resetPlayLabel();
              }
            };
            const onReplay = () => {
              timeline.restart();
              play.querySelector("span")!.textContent = labels.pause;
              play.setAttribute("aria-pressed", "true");
            };
            play.addEventListener("click", onPlay);
            replay.addEventListener("click", onReplay);
            const observer = new IntersectionObserver((entries) => {
              if (!entries[0].isIntersecting) {
                timeline.pause();
                resetPlayLabel();
              }
            });
            observer.observe(chapter);
            const onHidden = () => {
              if (document.hidden) {
                timeline.pause();
                resetPlayLabel();
              }
            };
            document.addEventListener("visibilitychange", onHidden);
            localCleanup.push(() => {
              play.removeEventListener("click", onPlay);
              replay.removeEventListener("click", onReplay);
              observer.disconnect();
              document.removeEventListener("visibilitychange", onHidden);
            });
          }
          if (reduced) {
            controls.hidden = true;
            timeline.progress(1).pause();
          } else {
            timeline.progress(0).pause();
          }
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
            behavior: reduced ? "instant" : "smooth",
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

motionButton.addEventListener("click", () => {
  motionPreference =
    document.documentElement.dataset.motion === "reduced" ? "full" : "reduced";
  try {
    localStorage.setItem("mnemark-site-motion", motionPreference);
  } catch {
    /* Optional preference. */
  }
  configureAnimations();
});
systemMotion.addEventListener("change", () => {
  if (!motionPreference) configureAnimations();
});

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
  ].find((element) => {
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
