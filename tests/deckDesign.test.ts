import { describe, expect, it } from "vitest";
import { PosterSpecSchema, type Layer, type PosterSpec } from "../src/schema";
import { deckDesignPrompt, keepDeckDesign, summarizeDeckDesign, wantsDesignChange, type DeckDesign } from "../src/deckDesign";

const W = 1280, H = 720;
const slide = (n: number, extra: Layer[] = [], over: Partial<PosterSpec> = {}): PosterSpec => PosterSpecSchema.parse({
  meta: { title: `s${n}`, width: W, height: H }, theme: "ocean",
  layers: [
    { id: "bg", type: "background", fill: "$bg" },
    { id: "band", type: "shape", shape: "rect", x: 0, y: 0, w: W, h: 80, fill: "$primary" },
    { id: "title", type: "text", text: `見出し${n}`, x: 80, y: 120, w: 1000, h: 80, font: "display", size: 56, weight: 800, fill: "$ink" },
    { id: "body", type: "text", text: `本文${n}`, x: 80, y: 260, w: 1000, h: 200, font: "body", size: 28, weight: 400, fill: "$ink" },
    { id: "page", type: "text", text: String(n), x: 1160, y: 660, w: 60, h: 40, font: "body", size: 20, weight: 400, fill: "$muted", align: "right" },
    ...extra,
  ],
  ...over,
});
const deck = [slide(1), slide(2), slide(3)];
const design = summarizeDeckDesign(deck)!;
const keep = (edited: PosterSpec, instruction: string, selectedIds?: string[]) => keepDeckDesign(deck[0], edited, design, instruction, selectedIds);
const without = (s: PosterSpec, id: string): PosterSpec => ({ ...s, layers: s.layers.filter((l) => l.id !== id) });
const patch = (s: PosterSpec, id: string, p: object): PosterSpec => ({ ...s, layers: s.layers.map((l) => (l.id === id ? { ...l, ...p } as Layer : l)) });

describe("summarizeDeckDesign", () => {
  it("3 枚のデッキから theme・共通要素・フォント・色を出す", () => {
    expect(design.slides).toBe(3);
    expect(design.theme).toBe("ocean");
    expect(design.themeOverride).toBeUndefined();
    expect(design.common.map((c) => c.role)).toEqual(expect.arrayContaining(["ページ番号", "ヘッダーの帯"]));
    expect(design.common.every((c) => c.count === 3)).toBe(true);
    expect(design.fonts[0]).toMatchObject({ font: "body", weight: 400 });
    expect(design.colors.map((c) => c.color)).toEqual(expect.arrayContaining(["$bg", "$primary", "$ink", "$muted"]));
    expect(design.heading).toMatchObject({ x: 80, y: 120, size: 56, font: "display" });
    expect(design.margin).toEqual({ left: 80, right: 60 });
  });
  it("1 枚なら undefined", () => expect(summarizeDeckDesign([slide(1)])).toBeUndefined());
  it("themeOverride は多数派", () => {
    const o = { colors: { primary: "#f00" } };
    expect(summarizeDeckDesign([slide(1, [], { themeOverride: o }), slide(2, [], { themeOverride: o }), slide(3)])?.themeOverride).toEqual(o);
  });
});

describe("wantsDesignChange", () => {
  it.each(["配色を変えて", "色味を他のスライドと合わせて", "赤色に", "青色で", "色を変えて", "フォントを変えて", "テーマを替えて", "ポップな雰囲気に", "全体のデザインを変えて", "背景色を白に", "ダークモードにして", "落ち着いた感じに", "ライトモード", "ブランドカラーにして", "ＴＯＮＥ トーンを一新"])("true: %s", (t) => expect(wantsDesignChange(t)).toBe(true));
  it.each(["このスライドをリデザインして", "もっと見やすく作り直して", "レイアウトを整えて", "情報を整理して", "強弱をつけて", "色々直して", "いろいろ入れて", "景色の写真を入れて", "特色について書いて", "顔色を伺う話", "色んな例を足して"])("false: %s", (t) => expect(wantsDesignChange(t)).toBe(false));
});

describe("keepDeckDesign", () => {
  it("何も崩れていなければ同じ参照", () => {
    const r = keep(patch(deck[0], "body", { text: "書き換え" }), "リデザインして");
    expect(r.restored).toEqual([]);
    expect(keep(deck[0], "リデザインして").spec).toBe(deck[0]);
  });
  it("リデザインで theme・themeOverride・font・帯の削除・ページ番号の移動が戻る", () => {
    let e: PosterSpec = { ...deck[0], theme: "night", themeOverride: { colors: { primary: "#0f0" } } };
    e = patch(e, "body", { font: "hand" });
    e = patch(without(e, "band"), "page", { x: 100, y: 100 });
    const r = keep(e, "このスライドをリデザインして");
    expect(r.restored).toEqual(["テーマと配色", "フォント", "ヘッダーの帯", "ページ番号"]);
    expect(r.spec.theme).toBe("ocean");
    expect(r.spec.themeOverride).toBeUndefined();
    expect(r.spec.layers.map((l) => l.id)).toEqual(deck[0].layers.map((l) => l.id));
    expect(r.spec.layers.find((l) => l.id === "page")).toMatchObject({ x: 1160, y: 660 });
    expect(r.spec.layers.find((l) => l.id === "body")).toMatchObject({ font: "body" });
  });
  it("ポップな配色でリデザインなら戻さない", () => {
    const e = { ...without(deck[0], "band"), theme: "night" };
    const r = keep(e, "ポップな配色でリデザインして");
    expect(r.restored).toEqual([]);
    expect(r.spec).toBe(e);
  });
  it("ページ番号を消してでは番号は戻らないが theme は戻る", () => {
    const r = keep({ ...without(deck[0], "page"), theme: "night" }, "ページ番号を消して");
    expect(r.restored).toEqual(["テーマと配色"]);
    expect(r.spec.layers.some((l) => l.id === "page")).toBe(false);
    expect(r.spec.theme).toBe("ocean");
  });
  it("selectedIds に帯があれば戻さない", () => {
    const e = without(deck[0], "band");
    expect(keep(e, "整理して", ["band"]).spec).toBe(e);
    expect(keep(e, "整理して").restored).toEqual(["ヘッダーの帯"]);
  });
});

describe("deckDesignPrompt", () => {
  it("決まり・theme・共通要素が入り、長すぎない", () => {
    const p = deckDesignPrompt(design);
    expect(p).toContain("# デッキのデザイン（ほかのスライドと共通。保つこと）");
    expect(p).toContain("リデザイン");
    expect(p).toContain("theme: ocean");
    expect(p).toContain("ページ番号");
    expect(p).toContain("ヘッダーの帯");
    expect(p.length).toBeLessThan(3000);
  });
  it("長い text は 40 文字に切る", () => {
    const d: DeckDesign = { ...design, common: [{ role: "フッター", count: 2, layer: { ...(design.common[0].layer as Layer), type: "text", text: "あ".repeat(100) } as Layer }] };
    expect(deckDesignPrompt(d)).not.toContain("あ".repeat(41));
  });
});

describe("共通要素はスライドの枠の要素だけ", () => {
  it("全スライドで同じ位置・同じ書式の見出しや本文は共通要素にせず、リデザインで動かしても戻さない", () => {
    const same = [1, 2, 3].map((n) => PosterSpecSchema.parse({
      meta: { title: `s${n}`, width: W, height: H }, theme: "ocean",
      layers: [
        { id: "title", type: "text", text: `見出し${n}`, x: 80, y: 60, w: 1000, h: 80, font: "display", size: 56, weight: 800, fill: "$ink" },
        { id: "body", type: "text", text: `本文${n}`, x: 80, y: 260, w: 1000, h: 200, font: "body", size: 28, weight: 400, fill: "$ink" },
        { id: "card", type: "shape", shape: "rect", x: 300, y: 250, w: 600, h: 300, fill: "$surface" },
      ],
    }));
    const d = summarizeDeckDesign(same)!;
    expect(d.common).toEqual([]);
    const moved = patch(patch(same[0], "title", { x: 400, y: 300 }), "card", { x: 0, y: 0 });
    expect(keepDeckDesign(same[0], moved, d, "このスライドをリデザインして").spec).toBe(moved);
  });
});
