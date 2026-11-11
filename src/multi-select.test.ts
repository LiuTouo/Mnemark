import { describe, expect, it } from "vitest";
import { MultiSelectState } from "./multi-select";

describe("MultiSelectState", () => {
  it("toggles only while active and clears on exit", () => {
    const state = new MultiSelectState();
    state.toggle("a");
    expect(state.size).toBe(0);

    state.enter();
    state.toggle("a");
    state.toggle("b");
    state.toggle("a");
    expect(state.idsInOrder(["a", "b"])).toEqual(["b"]);

    state.exit();
    expect(state.active).toBe(false);
    expect(state.size).toBe(0);
  });

  it("selects and clears only the supplied visible results", () => {
    const state = new MultiSelectState();
    state.enter();
    state.toggle("hidden");
    state.toggleAllVisible(["a", "b"]);
    expect(state.idsInOrder(["hidden", "a", "b"])).toEqual(["hidden", "a", "b"]);
    expect(state.allVisibleSelected(["a", "b"])).toBe(true);

    state.toggleAllVisible(["a", "b"]);
    expect(state.idsInOrder(["hidden", "a", "b"])).toEqual(["hidden"]);
  });

  it("replaces the whole selection from a marquee rectangle", () => {
    const state = new MultiSelectState();
    state.enter();
    state.toggle("a");
    state.replace(["b", "c"]);
    expect(state.idsInOrder(["a", "b", "c", "d"])).toEqual(["b", "c"]);

    state.replace([]);
    expect(state.size).toBe(0);

    state.exit();
    state.replace(["a"]);
    expect(state.size).toBe(0);
  });

  it("prunes ids removed by eviction or dataset refresh", () => {
    const state = new MultiSelectState();
    state.enter();
    state.toggleAllVisible(["a", "b", "c"]);
    state.prune(["b", "c", "d"]);
    expect(state.idsInOrder(["a", "b", "c", "d"])).toEqual(["b", "c"]);
  });
});
