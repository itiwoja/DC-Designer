import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFonts, parseExpect, parseFaces } from "../server/fonts";
import { FONT_BY_ID, FONT_CATALOG, fontCovers, scriptsFor } from "../src/fonts";

const execFileMock = vi.hoisted(() => vi.fn((...args: unknown[]) => (args.at(-1) as (e: null, r: { stdout: string; stderr: string }) => void)(null, { stdout: "", stderr: "" })));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

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

describe("フォントの route 入力と install の expect", () => {
  let cache: string;
  beforeEach(() => {
    cache = mkdtempSync(join(tmpdir(), "fonts-install-"));
    process.env.FONT_CACHE_DIR = cache;
    execFileMock.mockClear();
  });
  afterEach(() => {
    delete process.env.FONT_CACHE_DIR;
    delete process.env.DC_DESIGNER_DESKTOP;
    rmSync(cache, { recursive: true, force: true });
  });

  it("parseFaces はカタログ外・weight 違い・17 件以上を 400 にする", () => {
    expect(parseFaces([{ family: "Noto Sans JP", weight: 400 }])).toEqual([{ family: "Noto Sans JP", weight: 400 }]);
    for (const bad of [[{ family: "Nope", weight: 400 }], [{ family: "Noto Sans JP", weight: 450 }], Array.from({ length: 17 }, () => ({ family: "Noto Sans JP", weight: 400 })), "x"]) {
      expect(() => parseFaces(bad)).toThrowError(expect.objectContaining({ status: 400 }));
    }
  });

  it("expect が合わなければ 409 で、登録処理（PowerShell など）を呼ばない", async () => {
    const wrong = [{ family: "Noto Sans JP", weight: 400, sha256: "0".repeat(64) }, { family: "Noto Sans JP", weight: 700, sha256: "0".repeat(64) }];
    await expect(installFonts(["Noto Sans JP"], wrong)).rejects.toMatchObject({ status: 409 });
    // face 集合が足りない場合も 409
    await expect(installFonts(["Noto Sans JP"], wrong.slice(0, 1))).rejects.toMatchObject({ status: 409 });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("製品版では expect が無いと 400", async () => {
    process.env.DC_DESIGNER_DESKTOP = "1";
    await expect(installFonts(["Noto Sans JP"])).rejects.toMatchObject({ status: 400 });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("parseExpect は形式が不正なら 400", () => {
    expect(() => parseExpect([{ family: "Noto Sans JP", weight: 400, sha256: "zz" }])).toThrowError(expect.objectContaining({ status: 400 }));
  });
});
