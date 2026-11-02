import { describe, expect, it } from "vitest";
import { routeChatRequest } from "../src/editor/chatRoute";

// スライド 5 を開いていて、全 19 枚
const deck = { current: 5, total: 19 };
const slides = (t: string) => routeChatRequest(t, { deck, poster: false });
const poster = (t: string) => routeChatRequest(t, { poster: true });

describe("routeChatRequest", () => {
  it("/ コマンドを先に見る", () => {
    expect(slides("/notes")).toMatchObject({ kind: "slash", cmd: { name: "notes" }, arg: "" });
    expect(poster("/image 夕焼けの海")).toMatchObject({ kind: "slash", cmd: { name: "image" }, arg: "夕焼けの海" });
    expect(slides("/nope").kind).toBe("slash-error");
    // デッキだけのコマンドはポスターでは使えない
    expect(poster("/notes").kind).toBe("slash-error");
    // ポスターだけのコマンドはスライドでは使えない
    expect(slides("/a4").kind).toBe("slash-error");
  });

  it("スライドのページ番号の振り直し", () => {
    expect(slides("ページ番号を振り直して")).toEqual({ kind: "renumber" });
  });

  it("台本が無いスライドにまとめて書く", () => {
    expect(slides("台本が無いスライドの台本を作って")).toEqual({ kind: "missing-notes" });
  });

  it("台本を書く対象のスライド", () => {
    expect(slides("このスライドの台本を書いて")).toEqual({ kind: "write-notes", targets: [5] });
    expect(slides("3枚目の台本を作って")).toEqual({ kind: "write-notes", targets: [3] });
    expect(slides("全スライドの台本を書き直して")).toEqual({ kind: "write-notes", targets: Array.from({ length: 19 }, (_, i) => i + 1) });
  });

  it("開いているスライドが分からず、番号も無い台本の依頼は、ふつうの修正にする", () => {
    expect(routeChatRequest("このスライドの台本を書いて", { deck: { current: 0, total: 3 }, poster: false })).toEqual({ kind: "edit" });
  });

  it("スライドの追加", () => {
    expect(slides("末尾にまとめのスライドを足して")).toEqual({ kind: "add-slide", position: 20 });
    expect(slides("新しいスライドを作って")).toEqual({ kind: "add-slide", position: 6 });
    // 開いているスライドが分からなければ追加しない
    expect(routeChatRequest("新しいスライドを作って", { deck: { current: 0, total: 3 }, poster: false }).kind).not.toBe("add-slide");
  });

  it("全スライドへの修正は、2 枚以上のときだけ", () => {
    expect(slides("全スライドの差し色を #F08C00 にして")).toEqual({ kind: "edit-across" });
    expect(routeChatRequest("全スライドの差し色を #F08C00 にして", { deck: { current: 1, total: 1 }, poster: false })).toEqual({ kind: "edit" });
  });

  it("当てはめる順番（全スライドへの修正より、台本・ページ番号の処理を先にする）", () => {
    expect(slides("全スライドの台本を書いて").kind).toBe("missing-notes");
    expect(slides("全スライドのページ番号を振り直して").kind).toBe("renumber");
  });

  it("ふつうの修正", () => {
    expect(slides("タイトルをもっと大きく目立たせて")).toEqual({ kind: "edit" });
  });

  it("ポスターでは、スライド向けの振り分けをしない", () => {
    for (const t of ["ページ番号を振り直して", "台本が無いスライドの台本を作って", "このスライドの台本を書いて", "新しいスライドを作って", "全スライドの差し色を #F08C00 にして"]) {
      expect(poster(t)).toEqual({ kind: "edit" });
    }
  });
});
