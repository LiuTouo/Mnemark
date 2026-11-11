import { describe, expect, it } from "vitest";
import { clipRect, idsInRect, marqueeRect } from "./marquee";

const rows = [
  { id: "a", rect: { left: 0, top: 0, right: 100, bottom: 50 } },
  { id: "b", rect: { left: 0, top: 50, right: 100, bottom: 100 } },
  { id: "c", rect: { left: 0, top: 100, right: 100, bottom: 150 } },
];

describe("marquee selection geometry", () => {
  it("normalizes a drag made in any direction", () => {
    expect(marqueeRect({ x: 90, y: 140 }, { x: 10, y: 70 }))
      .toEqual({ left: 10, top: 70, right: 90, bottom: 140 });
  });

  it("selects every row the rectangle overlaps", () => {
    expect(idsInRect(marqueeRect({ x: 10, y: 40 }, { x: 90, y: 110 }), rows))
      .toEqual(["a", "b", "c"]);
    expect(idsInRect(marqueeRect({ x: 10, y: 20 }, { x: 90, y: 60 }), rows))
      .toEqual(["a", "b"]);
    expect(idsInRect(marqueeRect({ x: 10, y: 20 }, { x: 90, y: 50 }), rows))
      .toEqual(["a"]);
  });

  it("ignores rows outside the drag area", () => {
    expect(idsInRect(marqueeRect({ x: 200, y: 0 }, { x: 300, y: 200 }), rows)).toEqual([]);
    expect(idsInRect(marqueeRect({ x: 10, y: 10 }, { x: 10, y: 140 }), rows)).toEqual([]);
  });

  it("clips the drawn rectangle to the list box", () => {
    const bounds = { left: 0, top: 40, right: 100, bottom: 120 };
    expect(clipRect({ left: 10, top: 0, right: 50, bottom: 200 }, bounds))
      .toEqual({ left: 10, top: 40, right: 50, bottom: 120 });
    expect(clipRect({ left: 0, top: 0, right: 100, bottom: 20 }, bounds)).toBeNull();
  });
});
