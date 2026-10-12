import { describe, expect, it } from "vitest";
import { formatBytes } from "./format";

describe("formatBytes", () => {
  it("renders bytes below 1 KiB verbatim", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("switches to one-decimal KB at 1 KiB", () => {
    expect(formatBytes(1024)).toBe("1.0KB");
    expect(formatBytes(851968)).toBe("832.0KB");
  });

  it("switches to one-decimal MB at 1 MiB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0MB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0MB");
  });
});
