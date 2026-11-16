// Focus rings only for keyboard (Tab) navigation. Chromium keeps the
// "recently used keyboard" heuristic after one Tab, so pointer clicks would
// otherwise still show the focus outline.

function setKeyboardNav(on: boolean): void {
  document.body.classList.toggle("keyboard-nav", on);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Tab") setKeyboardNav(true);
});
document.addEventListener("pointerdown", () => setKeyboardNav(false));
