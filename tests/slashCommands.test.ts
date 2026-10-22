import { describe, expect, it } from "vitest";
import { parseSlash, slashSuggestions } from "../src/editor/slashCommands";

const names = (input: string, deck = true) => slashSuggestions(input, deck).map((c) => c.name);

describe("slashSuggestions", () => {
  it("「/」だけなら全コマンド", () => expect(names("/")).toEqual(["image", "images", "undo", "renumber", "notes", "clear"]));
  it("前方一致で絞る", () => expect(names("/im")).toEqual(["image", "images"]));
  it("全角の「／」も可", () => expect(names("／un")).toEqual(["undo"]));
  it("デッキでなければ /renumber を出さない", () => expect(names("/r", false)).toEqual([]));
  it("/a4 はポスターモードだけ", () => {
    expect(slashSuggestions("/a", false, true).map((c) => c.name)).toEqual(["a4"]);
    expect(names("/a")).toEqual([]);
  });
  it("空白を打ったら閉じる", () => expect(names("/image ")).toEqual([]));
  it("ふつうの文では出さない", () => expect(names("タイトルを /大きく")).toEqual([]));
});

describe("parseSlash", () => {
  it("ふつうの発言は null", () => expect(parseSlash("タイトルを大きく", true)).toBeNull());
  it("「//」から始まる文は発言扱い", () => expect(parseSlash("//image 海", true)).toBeNull());
  it("内容つきのコマンド", () => {
    const r = parseSlash("/image  夕焼けの海\n水彩風 ", true);
    expect(r && "cmd" in r && [r.cmd.name, r.arg]).toEqual(["image", "夕焼けの海\n水彩風"]);
  });
  it("大文字・全角でも可", () => {
    const r = parseSlash("／UNDO", true);
    expect(r && "cmd" in r && r.cmd.name).toBe("undo");
  });
  it("/a4 は後ろの指示を書いても書かなくてもよい", () => {
    const a = parseSlash("/a4", false, true), b = parseSlash("/a4 タイトルは大きいまま", false, true);
    expect(a && "cmd" in a && [a.cmd.name, a.arg]).toEqual(["a4", ""]);
    expect(b && "cmd" in b && b.arg).toBe("タイトルは大きいまま");
    const c = parseSlash("/a4", true, false);
    expect(c && "error" in c && c.error).toContain("ポスターモード");
  });
  it.each([
    ["/foo", "ありません"],
    ["/image", "後ろに内容"],
    ["/renumber", "デッキ"],
  ])("%s はエラー", (input, msg) => {
    const r = parseSlash(input, input !== "/renumber");
    expect(r && "error" in r && r.error).toContain(msg);
  });
});
