import { describe, expect, it } from "vitest";
import { formatDateJa, formatMB, versionAnchor } from "../../src/lib/format.ts";

describe("format", () => {
  it("formatDateJa は JST で 0 埋めなしに出す", () => {
    expect(formatDateJa("2026-10-30T05:52:59Z")).toBe("2026年10月30日");
    expect(formatDateJa("2026-01-05T00:00:00Z")).toBe("2026年1月5日");
  });
  it("formatDateJa は UTC の夜を JST の翌日にする", () => {
    expect(formatDateJa("2026-10-30T15:00:00Z")).toBe("2026年10月31日");
    expect(formatDateJa("2026-12-31T15:30:00Z")).toBe("2027年1月1日");
  });
  it("formatMB は 1 MB = 1,048,576 バイトで小数 1 桁", () => {
    expect(formatMB(123810973)).toBe("118.1 MB");
    expect(formatMB(1048576)).toBe("1.0 MB");
  });
  it("versionAnchor", () => {
    expect(versionAnchor("1.0.6")).toBe("v1-0-6");
    expect(versionAnchor("1.1.0-beta.1")).toBe("v1-1-0-beta-1");
  });
});
