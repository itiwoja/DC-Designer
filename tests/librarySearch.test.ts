// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Deck, SavedPoster } from "../src/editor/api";
import { matchesDeck, matchesSpec } from "../src/editor/Library";
import { PosterSpecSchema } from "../src/schema";

// ライブラリの検索。スライド名（meta.title）は画面に出ないので当てず、画面に出ている名前と本文だけを見る
const spec = (title: string, text?: string) =>
  PosterSpecSchema.parse({
    meta: { title, width: 1000, height: 1414 },
    theme: "ocean",
    layers: text === undefined ? [] : [{ id: "t", type: "text", text, x: 0, y: 0, w: 100, h: 50 }],
  });
const poster = (id: string, title: string, text?: string): SavedPoster => ({ id, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", spec: spec(title, text) });

describe("単体のポスターの検索（matchesSpec）", () => {
  it("一覧に出ているタイトルに当たる", () => {
    expect(matchesSpec(spec("夏祭り 2"), "2")).toBe(true);
  });

  it("本文に当たる", () => {
    expect(matchesSpec(spec("無関係", "お知らせ本文"), "お知らせ")).toBe(true);
  });

  it("当たらない語では外れる。空の検索語は全部当たる", () => {
    expect(matchesSpec(spec("夏祭り", "本文"), "冬")).toBe(false);
    expect(matchesSpec(spec("夏祭り", "本文"), "")).toBe(true);
  });
});

describe("デッキの検索（matchesDeck）", () => {
  const deck: Deck = {
    id: "d1",
    name: "春の発表",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    slides: [
      { id: "s1", title: "夏休みの計画", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "s2", title: "まとめ", updatedAt: "2026-01-01T00:00:00Z" },
    ],
  };
  const posterById = new Map([
    ["s1", poster("s1", "夏休みの計画", "導入の文章")],
    ["s2", poster("s2", "まとめ", "締めの文章")],
  ]);

  it("スライド名にだけ含まれる文字列ではデッキが当たらない", () => {
    // 「夏休み」はスライド名（夏休みの計画）にだけある。画面に出ていないので当たらない
    expect(matchesDeck(deck, posterById, "夏休み")).toBe(false);
    expect(matchesDeck(deck, posterById, "まとめ")).toBe(false);
  });

  it("デッキ名では当たる", () => {
    expect(matchesDeck(deck, posterById, "春の")).toBe(true);
  });

  it("スライドの本文では当たる", () => {
    expect(matchesDeck(deck, posterById, "締め")).toBe(true);
  });

  it("スライドのポスターが読み込めていなくても、スライド名では当たらない", () => {
    expect(matchesDeck(deck, new Map(), "まとめ")).toBe(false);
  });

  it("「2」で検索しても、スライド名「〜 2」や数値の既定値（文字の大きさ・位置など）には当たらない", () => {
    const d: Deck = { ...deck, slides: [{ id: "s3", title: "まとめ 2", updatedAt: "2026-01-01T00:00:00Z" }] };
    const byId = new Map([["s3", poster("s3", "まとめ 2", "本文")]]);
    expect(matchesDeck(d, byId, "2")).toBe(false);
    expect(matchesDeck(d, new Map([["s3", poster("s3", "まとめ", "第2回")]]), "2")).toBe(true);
  });

  it("パーツの文字には当たり、パスの d やアニメーションの設定など画面に出ない値には当たらない", () => {
    const s = PosterSpecSchema.parse({ meta: { title: "x", width: 1000, height: 1414 }, theme: "ocean", layers: [
      { id: "p", type: "shape", shape: "path", d: "M 10 20 L 30 40", fill: "$primary", x: 0, y: 0, w: 100, h: 100 },
      { id: "c", type: "component", component: "bubble", props: { text: "ここに吹き出し", shape: "cloud" }, x: 0, y: 0, w: 100, h: 100 },
      { id: "l", type: "component", component: "checklist", props: { items: ["持ち物リスト"] }, x: 0, y: 0, w: 100, h: 100, animation: { effect: "fade", start: "click", duration: 500, delay: 0 } },
    ] });
    expect(matchesSpec(s, "吹き出し")).toBe(true);
    expect(matchesSpec(s, "持ち物")).toBe(true);
    for (const q of ["10", "m ", "cloud", "click", "bubble"]) expect(matchesSpec(s, q)).toBe(false);
  });
});

