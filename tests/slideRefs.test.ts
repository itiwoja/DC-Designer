import { describe, expect, it } from "vitest";
import { isWholeDeckRequest, slideRefs } from "../src/editor/slideRefs";

describe("slideRefs", () => {
  it.each([
    ["スライド8の内容をスライド5に反映", [8, 5]],
    ["スライド18,19の内容を一つにまとめて", [18, 19]],
    ["スライド18・19を1枚にまとめて", [18, 19]],
    ["スライド１８、１９", [18, 19]],
    ["18と19枚目", [18, 19]],
    ["スライド3〜5", [3, 4, 5]],
    ["p.2-3", [2, 3]],
    ["最後のスライド", [30]],
    ["次のスライド", [22]],
    ["スライド99", []],
  ])("%s", (text, want) => {
    expect(slideRefs(text, 21, 30)).toEqual(want);
  });
});

describe("isWholeDeckRequest", () => {
  it.each([
    ["授業スライド全体をそうして", true],
    ["全スライドの差し色を #F08C00 にして", true],
    ["ほかのスライドにも反映して", true],
    ["すべてのスライドの見出しを太字に", true],
    ["どのスライドも背景を白に", true],
    ["全ページのフォントをそろえて", true],
    ["このスライド全体のバランスを整えて", false],
    ["見出しを大きくして", false],
    ["スライド3の内容をスライド5に反映", false],
  ])("%s", (text, want) => {
    expect(isWholeDeckRequest(text)).toBe(want);
  });
});
