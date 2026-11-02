import { describe, expect, it } from "vitest";
import { textStyleKey, toggleTextStyle } from "../src/editor/textStyle";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
  textStyleKey({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

describe("textStyleKey", () => {
  it("Ctrl/Cmd+B は太字、Ctrl/Cmd+U は下線", () => {
    expect(key("b", { ctrlKey: true })).toBe("bold");
    expect(key("B", { metaKey: true })).toBe("bold");
    expect(key("u", { ctrlKey: true })).toBe("underline");
  });
  it("修飾キーなし・Shift/Alt 付き・ほかのキーは対象外", () => {
    expect(key("b")).toBeNull();
    expect(key("b", { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(key("u", { ctrlKey: true, altKey: true })).toBeNull();
    expect(key("i", { ctrlKey: true })).toBeNull();
  });
});

describe("toggleTextStyle", () => {
  it("太字なら通常に、通常なら太字にする", () => {
    expect(toggleTextStyle([{ id: "a", weight: 700 } as any], "bold")).toEqual([{ id: "a", patch: { weight: 400 } }]);
    expect(toggleTextStyle([{ id: "a", weight: 400 } as any], "bold")).toEqual([{ id: "a", patch: { weight: 700 } }]);
  });
  it("複数選択で太さが混ざっていれば全部太字にする", () => {
    const r = toggleTextStyle([{ id: "a", weight: 900 }, { id: "b", weight: 300 }] as any, "bold");
    expect(r.map((x) => x.patch.weight)).toEqual([700, 700]);
  });
  it("下線を付け外しする", () => {
    expect(toggleTextStyle([{ id: "a" } as any], "underline")[0].patch).toEqual({ underline: true });
    expect(toggleTextStyle([{ id: "a", underline: true } as any], "underline")[0].patch).toEqual({ underline: undefined });
  });
});
