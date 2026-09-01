import { describe, expect, it } from "vitest";
import { insertBefore, moveOne } from "./reorder";

describe("moveOne up/down boundaries", () => {
  const abc = ["A", "B", "C"];

  it("moves B down one slot", () => {
    expect(moveOne(abc, 1, 1)).toEqual(["A", "C", "B"]);
  });

  it("moves B up one slot", () => {
    expect(moveOne(abc, 1, -1)).toEqual(["B", "A", "C"]);
  });

  it("moves the first item down one slot", () => {
    expect(moveOne(abc, 0, 1)).toEqual(["B", "A", "C"]);
  });

  it("moves the last item up one slot", () => {
    expect(moveOne(abc, 2, -1)).toEqual(["A", "C", "B"]);
  });

  it("first item cannot move up (boundary no-op)", () => {
    expect(moveOne(abc, 0, -1)).toEqual(abc);
  });

  it("last item cannot move down (boundary no-op)", () => {
    expect(moveOne(abc, 2, 1)).toEqual(abc);
  });
});

describe("insertBefore", () => {
  it("moves an id before a target", () => {
    expect(insertBefore(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
  });

  it("appends when beforeId is null", () => {
    expect(insertBefore(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
  });

  it("appends when the target id is missing", () => {
    expect(insertBefore(["a", "b"], "b", "nope")).toEqual(["a", "b"]);
  });

  it("keeps the canonical order when dropped at the current insertion point", () => {
    expect(insertBefore(["a", "b", "c"], "b", "c")).toEqual(["a", "b", "c"]);
  });

  it("moves an item to either edge", () => {
    expect(insertBefore(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(insertBefore(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
  });
});
