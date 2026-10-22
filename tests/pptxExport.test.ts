import { describe, expect, it } from "vitest";
import { isPlainText, textTransparency } from "../src/render/export";
import { resolveTheme } from "../src/themes";

const theme = resolveTheme("dark" as never, undefined);
const text = (fill: unknown) => ({ id: "t", type: "text", text: "a", x: 0, y: 0, w: 10, h: 10, size: 10, font: "heading", fill }) as never;

describe("isPlainText", () => {
  it("単色はテキストボックス", () => {
    expect(isPlainText(text("#ff0000"), theme)).toBe(true);
  });
  it("グラデーションは対象外", () => {
    expect(isPlainText(text({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }] }), theme)).toBe(false);
  });
});

describe("textTransparency", () => {
  it("opacity を透明度 0〜100 にする", () => {
    expect(textTransparency(undefined)).toBe(0);
    expect(textTransparency(1)).toBe(0);
    expect(textTransparency(0.5)).toBe(50);
    expect(textTransparency(0)).toBe(100);
  });
});
