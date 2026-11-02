import { describe, expect, it } from "vitest";
import { isMatchOthersRequest, isWholeDeckRequest, slideRefs } from "../src/editor/slideRefs";

describe("slideRefs", () => {
  it.each([
    ["スライド8の内容をスライド5に反映", [8, 5]],
    ["スライド18,19の内容を一つにまとめて", [18, 19]],
    ["スライド18・19を1枚にまとめて", [18, 19]],
    ["スライド１８、１９", [18, 19]],
    ["18と19枚目", [18, 19]],
    ["スライド3〜5", [3, 4, 5]],
    ["p.2-3", [2, 3]],
    ["8枚目~10枚目の台本の整合性を持たせて", [8, 9, 10]],
    ["8枚目から10枚目の台本を揃えて", [8, 9, 10]],
    ["スライド3から5の流れを整えて", [3, 4, 5]],
    ["スライド3〜スライド5", [3, 4, 5]],
    ["3枚目のタイトルと5枚目の本文を直して", [3, 5]],
    ["3か4枚目", [3, 4]],
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

describe("isMatchOthersRequest", () => {
  it.each([
    ["色味を他のスライドと合わせて", true],
    ["ほかのページと同じ配色にして", true],
    ["他のスライドの色に合わせて", true],
    ["ほかのページの配色にそろえて", true],
    ["残りのスライドに統一して", true],
    ["全スライドの差し色を #F08C00 にして", false],
    ["ほかのスライドにも反映して", false],
    ["他のスライドも合わせて", false],
    ["全スライドの色味をそろえて", false],
    ["全スライドの色を他のスライドと合わせて", false],
    ["スライド3の色をスライド5に合わせて", false],
  ])("%s", (text, want) => {
    expect(isMatchOthersRequest(text)).toBe(want);
  });
});
