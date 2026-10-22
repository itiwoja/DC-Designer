import { describe, expect, it } from "vitest";
import { isMissingNotesRequest, isWriteNotesRequest } from "../src/editor/notes";
import { notesLength, slideContent } from "../src/notes";
import { PosterSpecSchema } from "../src/schema";

describe("isMissingNotesRequest", () => {
  it.each([
    "台本が書かれていないスライドに台本を書いて",
    "台本が無いスライドの台本を作って",
    "全スライドの台本を書いて",
    "残りのスライドにもノートを追加して",
    "空の台本を埋めて",
  ])("拾う: %s", (t) => expect(isMissingNotesRequest(t)).toBe(true));
  it.each([
    "このスライドの台本を書いて",
    "台本をもっと短くして",
    "タイトルが無いので追加して",
    "全部のスライドの文字を大きくして",
    "働き方は様々ってのはIT業界は黙々とコードを打つだけの人じゃないということを言いたい。\nそれも含めて台本を書き換えて",
    "全スライドの台本を書き直して",
  ])("拾わない: %s", (t) => expect(isMissingNotesRequest(t)).toBe(false));
});

describe("isWriteNotesRequest", () => {
  it.each([
    "このスライドの台本を書いて",
    "3枚目の台本を作って",
    "台本を書き直して",
    "台本を短めに書いて",
    "働き方は様々ってのはIT業界は黙々とコードを打つだけの人じゃないということを言いたい。\nそれも含めて台本を書き換えて",
    "全スライドの台本を書き直して",
  ])("拾う: %s", (t) => expect(isWriteNotesRequest(t)).toBe(true));
  it.each([
    "台本をもっと短くして",
    "台本に「よろしくお願いします」と書いて",
    "タイトルを書き直して",
  ])("拾わない: %s", (t) => expect(isWriteNotesRequest(t)).toBe(false));
});

describe("slideContent", () => {
  const spec = (layers: unknown[]) => PosterSpecSchema.parse({ meta: { title: "t" }, theme: "ocean", layers });
  it("文字を上の行から、同じ行は左から並べる（グループの中は親の位置を足す）", () => {
    const s = spec([
      { id: "b", type: "text", text: "右", x: 500, y: 300, w: 200, h: 60 },
      { id: "a", type: "text", text: "見出し", x: 0, y: 0, w: 800, h: 100 },
      { id: "g", type: "group", x: 0, y: 290, children: [{ id: "c", type: "text", text: "左", x: 20, y: 0, w: 200, h: 60 }] },
      { id: "h", type: "text", text: "隠し", x: 0, y: 600, visible: false },
    ]);
    expect(slideContent(s).texts).toEqual(["見出し", "左", "右"]);
  });
  it("チェックリストの項目と画像の説明も拾う", () => {
    const s = spec([
      { id: "l", type: "component", component: "checklist", props: { items: ["速い", "安い"] }, x: 0, y: 0 },
      { id: "i", type: "image", asset: { prompt: "海辺の写真" }, x: 0, y: 200 },
      { id: "p", type: "component", component: "polaroid", props: { src: "/a.png", caption: "合宿の様子" }, x: 0, y: 400 },
      { id: "q", type: "image", src: "/b.png", x: 0, y: 600 },
    ]);
    expect(slideContent(s)).toEqual({ texts: ["・速い\n・安い"], images: ["海辺の写真", "合宿の様子", "（説明なし）"] });
  });
});

describe("notesLength", () => {
  it("空白を除いた字数の中央値と範囲", () => {
    expect(notesLength(["あいうえお", undefined, "", "あい う", "あいうえおかきくけこ"])).toEqual({ median: 5, min: 3, max: 10, count: 3 });
  });
  it("台本が無ければ null", () => expect(notesLength([undefined, " "])).toBeNull());
});
