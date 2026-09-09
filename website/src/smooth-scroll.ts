import Lenis from "lenis";
import "lenis/dist/lenis.css";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

export function startSmoothScroll() {
  const lenis = new Lenis({
    autoRaf: false,
    duration: 1.05,
    easing: (progress: number) => 1 - Math.pow(1 - progress, 4),
    smoothWheel: true,
    syncTouch: false,
    respectReducedMotion: false,
    allowNestedScroll: true,
    // Existing native anchors retain their URL, focus and scroll-padding behavior.
    anchors: false,
  });
  const tick = (seconds: number) => lenis.raf(seconds * 1000);
  const resize = () => lenis.resize();
  const reset = () =>
    lenis.scrollTo(window.scrollY, { immediate: true, force: true });
  const onKey = (event: KeyboardEvent) => {
    if (
      [
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "PageUp",
        "PageDown",
        "Home",
        "End",
        " ",
        "Tab",
      ].includes(event.key)
    )
      reset();
  };
  const onLink = (event: MouseEvent) => {
    if ((event.target as Element).closest("a[href]")) reset();
  };
  const onHidden = () => {
    if (document.hidden) reset();
  };

  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add(tick);
  gsap.ticker.lagSmoothing(0);
  ScrollTrigger.addEventListener("refresh", resize);
  // Explicit navigation must supersede an unfinished wheel animation.
  document.addEventListener("pointerdown", reset, { passive: true });
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("click", onLink, true);
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("hashchange", reset);

  return () => {
    gsap.ticker.remove(tick);
    ScrollTrigger.removeEventListener("refresh", resize);
    document.removeEventListener("pointerdown", reset);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("click", onLink, true);
    document.removeEventListener("visibilitychange", onHidden);
    window.removeEventListener("hashchange", reset);
    lenis.destroy();
  };
}
