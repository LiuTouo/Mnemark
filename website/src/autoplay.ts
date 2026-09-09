import { ScrollTrigger } from "gsap/ScrollTrigger";

const DEMO_SECONDS = 9.5;
const LOOP_FADE_SECONDS = 0.44;

// Scroll controls the lesson surfaces only. Each visible demo has its own clock.
export function createAutoplayGroup(labels: { play: string; pause: string }) {
  const updates: (() => void)[] = [];
  const disposers: (() => void)[] = [];
  let scheduled = 0;
  const sync = () => {
    scheduled = 0;
    updates.forEach((update) => update());
  };
  const requestSync = () => {
    if (!scheduled) scheduled = requestAnimationFrame(sync);
  };
  const onVisibility = () => {
    cancelAnimationFrame(scheduled);
    sync();
  };
  window.addEventListener("scroll", requestSync, { passive: true });
  document.addEventListener("visibilitychange", onVisibility);
  ScrollTrigger.addEventListener("refresh", requestSync);

  return {
    attach(chapter: HTMLElement, timeline: gsap.core.Timeline) {
      const canvas = chapter.querySelector<HTMLElement>(".demo-canvas")!;
      const play = chapter.querySelector<HTMLButtonElement>("[data-play]")!;
      const replay = chapter.querySelector<HTMLButtonElement>("[data-replay]")!;
      chapter.querySelector<HTMLElement>(".demo-controls")!.hidden = false;
      let manuallyPaused = false;

      // Crossfade to an unmodified opening frame before the timeline wraps.
      // The matching first frame replaces this bridge at the loop boundary.
      const bridge = canvas
        .querySelector<HTMLElement>('[data-frame="0"]')!
        .cloneNode(true) as HTMLElement;
      bridge.removeAttribute("data-frame");
      bridge.classList.add("demo-loop-bridge");
      bridge.setAttribute("aria-hidden", "true");
      bridge.style.opacity = "0";
      bridge.style.visibility = "hidden";
      canvas.append(bridge);
      timeline.fromTo(
        bridge,
        { autoAlpha: 0 },
        { autoAlpha: 1, duration: LOOP_FADE_SECONDS / DEMO_SECONDS, ease: "none" },
        1,
      );
      timeline.to(
        canvas.querySelector('[data-frame="3"]'),
        { autoAlpha: 0, duration: LOOP_FADE_SECONDS / DEMO_SECONDS, ease: "none" },
        1,
      );
      timeline
        .repeat(-1)
        .timeScale(1 / DEMO_SECONDS)
        .pause(0);

      const update = () => {
        const rect = canvas.getBoundingClientRect();
        const header = document
          .querySelector(".site-header")!
          .getBoundingClientRect().bottom;
        const top = Math.max(header + 2, rect.top + 2);
        const bottom = Math.min(innerHeight - 2, rect.bottom - 2);
        const x = Math.min(
          innerWidth - 2,
          Math.max(2, rect.left + rect.width / 2),
        );
        // Pinned lessons can intersect the viewport while covered by the next lesson.
        const visible =
          bottom > top &&
          [top + 1, (top + bottom) / 2, bottom - 1].some(
            (y) =>
              document.elementFromPoint(x, y)?.closest(".feature-chapter") ===
              chapter,
          );
        const paused = document.hidden || !visible || manuallyPaused;
        timeline.paused(paused);
        play.querySelector("span")!.textContent = paused
          ? labels.play
          : labels.pause;
        play.setAttribute("aria-pressed", String(!paused));
        play.querySelector("svg")!.innerHTML = paused
          ? '<path d="m8 4 12 8-12 8z"/>'
          : '<path d="M8 4v16M16 4v16"/>';
        chapter.dataset.playing = String(!paused);
      };
      const toggle = () => {
        manuallyPaused = !manuallyPaused;
        update();
      };
      const restart = () => {
        manuallyPaused = false;
        timeline.restart();
        update();
      };
      play.addEventListener("click", toggle);
      replay.addEventListener("click", restart);
      updates.push(update);
      disposers.push(() => {
        play.removeEventListener("click", toggle);
        replay.removeEventListener("click", restart);
        bridge.remove();
      });
      requestSync();
    },
    dispose() {
      cancelAnimationFrame(scheduled);
      window.removeEventListener("scroll", requestSync);
      document.removeEventListener("visibilitychange", onVisibility);
      ScrollTrigger.removeEventListener("refresh", requestSync);
      disposers.forEach((dispose) => dispose());
    },
  };
}
