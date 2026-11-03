import { describe, expect, it } from "vitest";
import { isPresenterPopup, pickSlideDisplay, pickViewDisplay, toPresenterDisplays } from "../desktop/presenterWindow";

const d = (id: number, w = 1920, h = 1080, label?: string) => ({ id, label, bounds: { width: w, height: h } });
const N = "dc-designer-presenter";

describe("isPresenterPopup", () => {
  it("名前・空の URL・編集窓からのときだけ true", () => {
    expect(isPresenterPopup({ url: "about:blank", frameName: N, fromEditor: true })).toBe(true);
    expect(isPresenterPopup({ url: "", frameName: N, fromEditor: true })).toBe(true);
  });
  it("どれか欠けると false", () => {
    expect(isPresenterPopup({ url: "about:blank", frameName: N, fromEditor: false })).toBe(false);
    expect(isPresenterPopup({ url: "about:blank", frameName: "x", fromEditor: true })).toBe(false);
    expect(isPresenterPopup({ url: "https://example.com", frameName: N, fromEditor: true })).toBe(false);
    expect(isPresenterPopup({ url: "app://dc-designer/", frameName: N, fromEditor: true })).toBe(false);
  });
});

describe("pickSlideDisplay", () => {
  const two = [d(1), d(2)];
  it("指定があって見つかればそれ", () => {
    expect(pickSlideDisplay(two, { requested: 2, hasView: true, editorDisplayId: 1, primaryId: 1 })).toBe(2);
  });
  it("見つからない指定は無視する", () => {
    expect(pickSlideDisplay(two, { requested: 9, hasView: false, editorDisplayId: 2, primaryId: 1 })).toBe(2);
  });
  it("発表者ビューがあり 2 画面以上ならメイン画面", () => {
    expect(pickSlideDisplay(two, { hasView: true, editorDisplayId: 2, primaryId: 1 })).toBe(1);
  });
  it("発表者ビューが無ければ編集窓の画面", () => {
    expect(pickSlideDisplay(two, { hasView: false, editorDisplayId: 2, primaryId: 1 })).toBe(2);
  });
  it("画面 1 つなら編集窓の画面、画面が無ければ null", () => {
    expect(pickSlideDisplay([d(5)], { hasView: true, editorDisplayId: 5, primaryId: 5 })).toBe(5);
    expect(pickSlideDisplay([], { hasView: false, editorDisplayId: null })).toBeNull();
  });
  it("編集窓の画面が不明ならメイン画面", () => {
    expect(pickSlideDisplay(two, { hasView: false, editorDisplayId: null, primaryId: 1 })).toBe(1);
  });
});

describe("pickViewDisplay", () => {
  it("画面 1 つならスライドと同じ（移さない）", () => {
    expect(pickViewDisplay([d(1)], 1, 1)).toBe(1);
  });
  it("編集窓が元いた画面がスライドと違えばそこ", () => {
    expect(pickViewDisplay([d(1), d(2), d(3)], 1, 3)).toBe(3);
  });
  it("同じなら別の画面の先頭", () => {
    expect(pickViewDisplay([d(1), d(2), d(3)], 1, 1)).toBe(2);
  });
  it("画面が無ければ null", () => {
    expect(pickViewDisplay([], null, null)).toBeNull();
  });
});

describe("toPresenterDisplays", () => {
  it("メイン画面を先頭にし、名前を付ける", () => {
    const r = toPresenterDisplays([d(2, 1366, 768), d(1)], 1);
    expect(r).toEqual([
      { id: 1, label: "メイン画面（1920×1080）", primary: true },
      { id: 2, label: "画面 2（1366×768）", primary: false },
    ]);
  });
  it("Display.label があれば使う", () => {
    expect(toPresenterDisplays([d(1, 1920, 1080, "DELL U2720Q")], 1)[0].label).toBe("DELL U2720Q（1920×1080）");
  });
  it("メインが後ろでも番号は他の画面の順", () => {
    const r = toPresenterDisplays([d(2), d(3), d(1)], 1);
    expect(r.map((x) => x.label)).toEqual(["メイン画面（1920×1080）", "画面 2（1920×1080）", "画面 3（1920×1080）"]);
  });
});
