import { describe, expect, it } from "vitest";
import { resolveCloseIntent } from "./settings-close";

describe("resolveCloseIntent", () => {
  it("asks for confirmation on the first close attempt of a dirty form", () => {
    expect(resolveCloseIntent({ saving: false, dirty: true, armed: false })).toBe("arm");
  });

  it("closes on the second attempt after the user was warned", () => {
    expect(resolveCloseIntent({ saving: false, dirty: true, armed: true })).toBe("hide");
  });

  it("closes a clean form without confirmation", () => {
    expect(resolveCloseIntent({ saving: false, dirty: false, armed: false })).toBe("hide");
  });

  it("never closes while a save is in flight", () => {
    expect(resolveCloseIntent({ saving: true, dirty: true, armed: true })).toBe("ignore");
  });
});
