import { describe, expect, it } from "vitest";
import { FONT_BY_ID, FONT_CATALOG, fontCovers, scriptsFor } from "../src/fonts";

describe("フォントカタログ", () => {
  it("ID とファミリー名が重複しない", () => {
    expect(FONT_BY_ID.size).toBe(FONT_CATALOG.length);
    expect(new Set(FONT_CATALOG.map((f) => f.family)).size).toBe(FONT_CATALOG.length);
    expect(FONT_BY_ID.get("noto-sans-jp")?.family).toBe("Noto Sans JP");
    expect(FONT_BY_ID.get("m-plus-1-code")?.role).toBe("mono");
  });

  it("文字の範囲で表示できるかを判定する", () => {
    const kana = { script: "kana" as const };
    const latin = { script: "latin" as const };
    expect(fontCovers(kana, "ようこそ！ハロウィン 2026")).toBe(true);
    expect(fontCovers(kana, "説明会のご案内")).toBe(false);
    expect(fontCovers(latin, "Open Campus 2026!")).toBe(true);
    expect(fontCovers(latin, "Open Campus、2026")).toBe(false);
    expect(fontCovers({ script: "ja" }, "説明会")).toBe(true);
    expect(scriptsFor("Hello")).toEqual(["ja", "kana", "latin"]);
    expect(scriptsFor("ありがとう")).toEqual(["ja", "kana"]);
    expect(scriptsFor("感謝")).toEqual(["ja"]);
  });
});
