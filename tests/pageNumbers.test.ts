import { describe, expect, it } from "vitest";
import { addPageNumber, findPageNumber, isRenumberRequest, renumberPages } from "../src/editor/pageNumbers";
import { PosterSpecSchema, type PosterSpec } from "../src/schema";

const num = (text: string, extra: object = {}) => ({ id: "pn", type: "text", text, x: 1217, y: 677, w: 40, h: 24, size: 22, font: "Zen Kaku Gothic New", align: "right", fill: "#176bee", ...extra });
const slide = (title: string, ...layers: object[]): PosterSpec => PosterSpecSchema.parse({
  version: 1, meta: { title, width: 1333, height: 750 }, theme: "ocean",
  layers: [{ id: "bg", type: "background", fill: "#fff" }, ...layers],
});
const pageText = (s: PosterSpec) => findPageNumber(s)?.layer.text;

describe("isRenumberRequest", () => {
  it.each([
    "ポスター全体的に右下にスライド番号を振ってるんだけど、数字の並びがあっていないところがあるから修正を加えて。",
    "ページ番号を振り直して",
    "右下の番号がずれてるので直して",
    "スライド番号を連番にして",
    "fix the slide numbers",
  ])("拾う: %s", (t) => expect(isRenumberRequest(t)).toBe(true));
  it.each([
    "スライド18,19を1枚にまとめて",
    "ステップの番号を直して",
    "スライド番号を大きくして",
    "タイトルを修正して",
  ])("拾わない: %s", (t) => expect(isRenumberRequest(t)).toBe(false));
});

describe("findPageNumber", () => {
  it("下の隅の番号だけを拾い、本文中の丸数字は無視する", () => {
    const s = slide("x", { id: "step", type: "text", text: "4", x: 990, y: 587, w: 30, h: 30 }, num("14"));
    expect(findPageNumber(s)?.layer.id).toBe("pn");
    expect(findPageNumber(slide("x", { id: "step", type: "text", text: "4", x: 990, y: 587, w: 30, h: 30 }))).toBeNull();
  });
  it("グループの中の番号も拾う", () => {
    const s = slide("x", { id: "g", type: "group", x: 1000, y: 600, w: 300, h: 100, children: [num("P.3", { x: 217, y: 77 })] });
    expect(findPageNumber(s)).toMatchObject({ number: 3, x: 1217, y: 677 });
  });
});

describe("renumberPages", () => {
  it("並び順に合わせて書き換え、番号の無いスライドを返す", () => {
    const specs = [slide("D 1"), slide("D 2", num("2")), slide("D 10", num("10")), slide("D 11"), slide("D 4", num("4 / 9"))];
    const r = renumberPages(specs, "D");
    expect(r.specs.map(pageText)).toEqual([undefined, "2", "3", undefined, "5 / 5"]);
    expect(r.changed).toEqual([{ slide: 3, from: 10, to: 3 }, { slide: 5, from: 4, to: 5 }]);
    expect(r.missing).toEqual([1, 4]);
    expect(r.specs.map((s) => s.meta.title)).toEqual(["D 1", "D 2", "D 3", "D 4", "D 5"]);
    expect(r.specs[1]).toBe(specs[1]);
    expect(r.template?.layer.text).toBe("2");
  });
  it("見本の番号を複製して足す", () => {
    const specs = [slide("a", num("1")), slide("b", { id: "page-number", type: "text", text: "本文", x: 0, y: 0 })];
    const r = renumberPages(specs);
    const added = addPageNumber(r.specs[1], r.template!, 2, 2);
    expect(added.layers.at(-1)).toMatchObject({ id: "page-number-2", text: "2", x: 1217, y: 677, size: 22, fill: "#176bee" });
  });
});
