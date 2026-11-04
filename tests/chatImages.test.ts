import { describe, expect, it } from "vitest";
import { imageAltOf, imagesOf, replyImageTarget } from "../src/editor/ChatLog";

describe("imagesOf", () => {
  it("古いログの image（1 枚）も images と同じく出せる", () => {
    expect(imagesOf({ image: "/generated/a.png" })).toEqual(["/generated/a.png"]);
    expect(imagesOf({ images: ["/generated/a.png", "/generated/b.png"] })).toEqual(["/generated/a.png", "/generated/b.png"]);
    expect(imagesOf({})).toEqual([]);
  });
});

describe("imageAltOf", () => {
  it("プロンプトを alt にし、長ければ切り、無ければ汎用の文にする", () => {
    expect(imageAltOf({ imageAlts: ["夕焼けの海"] }, 0)).toBe("夕焼けの海");
    expect(imageAltOf({ imageAlts: ["あ".repeat(80)] }, 0)).toBe(`${"あ".repeat(60)}…`);
    expect(imageAltOf({}, 0)).toBe("生成した画像");
    expect(imageAltOf({ imageAlts: ["猫"] }, 1)).toBe("生成した画像");
  });
});

describe("replyImageTarget", () => {
  it("返答が対象にしたデッキを開いていれば、そのスライドに生成する", () => {
    expect(replyImageTarget(["a", "x"], ["a", "b"], "b")).toEqual({ kind: "across", ids: ["a"] });
  });
  it("別のデッキ・ポスターに移っていたら止める", () => {
    expect(replyImageTarget(["a"], ["b", "c"], "b")).toEqual({ kind: "mismatch" });
    expect(replyImageTarget(["a"], null, "b")).toEqual({ kind: "mismatch" });
    expect(replyImageTarget(["a"], null, null)).toEqual({ kind: "mismatch" });
  });
  it("同じポスターか、対象の id が無い返答（保存前）は今開いているものに生成する", () => {
    expect(replyImageTarget(["a"], null, "a")).toEqual({ kind: "here" });
    expect(replyImageTarget([], null, "b")).toEqual({ kind: "here" });
  });
});
