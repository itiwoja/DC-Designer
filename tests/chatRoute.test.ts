import { describe, expect, it } from "vitest";
import { imagePromptOf, isTransparentRequest, routeChatRequest } from "../src/editor/chatRoute";

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

  it("ほかのスライドをお手本にする修正は、今のスライドだけを直す", () => {
    expect(slides("色味を他のスライドと合わせて")).toEqual({ kind: "edit" });
    expect(slides("ほかのページと同じ配色にして")).toEqual({ kind: "edit" });
    expect(slides("他のスライドの色に合わせて")).toEqual({ kind: "edit" });
  });

  it("全スライドへの修正は、2 枚以上のときだけ", () => {
    expect(slides("全スライドの差し色を #F08C00 にして")).toEqual({ kind: "edit-across" });
    expect(slides("ほかのスライドにも反映して")).toEqual({ kind: "edit-across" });
    expect(slides("全スライドの色味をそろえて")).toEqual({ kind: "edit-across" });
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

  it("画像を作る依頼は画像生成に回す", () => {
    expect(slides("海の写真を作って")).toEqual({ kind: "image", prompt: "海の写真", transparent: false, redo: false });
    expect(poster("夕焼けの海のイラストを描いて")).toMatchObject({ kind: "image", prompt: "夕焼けの海のイラスト" });
    expect(poster("猫の写真を入れて")).toMatchObject({ kind: "image" });
    expect(poster("桜の画像を生成してください")).toMatchObject({ kind: "image", prompt: "桜の画像" });
    expect(poster("ロケットの画像を追加して")).toMatchObject({ kind: "image" });
  });

  it("透過の依頼は文から読み取る", () => {
    expect(poster("猫のイラストを背景なしで作って")).toMatchObject({ kind: "image", transparent: true });
    expect(poster("透過で星のイラストを作って")).toMatchObject({ kind: "image", transparent: true });
    expect(isTransparentRequest("海の写真を作って")).toBe(false);
  });

  it("選択中の画像を作り直す依頼", () => {
    expect(poster("この画像を水彩風に作り直して")).toMatchObject({ kind: "image", redo: true });
    expect(poster("写真を再生成して")).toMatchObject({ kind: "image", redo: true });
  });

  it("既存の画像の編集・位置の指定・ほかの修正との同居は AI の修正に回す", () => {
    for (const t of [
      "画像を消して", "この画像を右に動かして", "写真を大きくして", "その写真を削除して", "画像はいらない",
      "右下に海の写真を入れて", "背景に写真を入れて", "写真を入れて、タイトルを大きくして",
      "画像入りのスライドを作って", "写真付きのポスターを作って", "この写真を使ってチラシを作って",
    ]) {
      expect(poster(t), t).toEqual({ kind: "edit" });
    }
    expect(slides("画像入りのスライドを作って").kind).toBe("add-slide");
    expect(slides("全スライドに写真を入れて")).toEqual({ kind: "edit-across" });
  });

  it("画像の依頼でも / コマンドと台本が先", () => {
    expect(poster("/image 海の写真を作って").kind).toBe("slash");
    expect(slides("このスライドの台本を書いて").kind).toBe("write-notes");
  });

  it("依頼文から説明を取り出す", () => {
    expect(imagePromptOf("海の写真を作って")).toBe("海の写真");
    expect(imagePromptOf("写真を入れて")).toBe("写真");
    expect(imagePromptOf("青い空を作ってください。")).toBe("青い空");
  });
});
