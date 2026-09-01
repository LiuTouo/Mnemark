import { describe, expect, it } from "vitest";
import { rectContains } from "./geometry";

describe("rectContains", () => {
  const rect = { left: 0, top: 0, right: 100, bottom: 40 };

  it("includes points on and inside every edge", () => {
    expect(rectContains(rect, 0, 0)).toBe(true);
    expect(rectContains(rect, 50, 20)).toBe(true);
    expect(rectContains(rect, 100, 40)).toBe(true);
  });

  it("excludes points beyond an edge", () => {
    expect(rectContains(rect, 101, 20)).toBe(false);
    expect(rectContains(rect, 50, 41)).toBe(false);
  });
});
