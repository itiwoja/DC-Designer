// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fontFiles, embedFonts } = vi.hoisted(() => ({ fontFiles: vi.fn(), embedFonts: vi.fn() }));
vi.mock("../src/editor/api", () => ({ api: { fontFiles, embedFonts } }));

import { buildFontCss } from "../src/render/export";
import { newExportCache, toDataUrl } from "../src/render/svg";

/** <text> 要素だけを返す最小の SVG ルート */
const root = (texts: { family: string; weight?: number }[]) =>
  ({
    querySelectorAll: () => ({
      forEach: (fn: (t: unknown) => void) =>
        texts.forEach((t) =>
          fn({
            getAttribute: (n: string) => (n === "font-family" ? `'${t.family}', sans-serif` : n === "font-weight" ? String(t.weight ?? 400) : null),
            textContent: "作品の文字",
          }),
        ),
    }),
  }) as unknown as Element;

beforeEach(() => { fontFiles.mockReset(); embedFonts.mockReset(); });

describe("buildFontCss", () => {
  it("API の応答から @font-face を作り、作品の文字は送らない", async () => {
    fontFiles.mockImplementation(async (faces: { family: string; weight: number }[]) => ({
      files: faces.map((f) => ({ ...f, sha256: "x", data: "QUJD" })),
      failed: [],
    }));
    const css = await buildFontCss(root([{ family: "Noto Sans JP", weight: 700 }]));
    expect(css).toContain("font-family: 'Noto Sans JP'; font-weight: 700; src: url(data:font/ttf;base64,QUJD) format('truetype');");
    expect(JSON.stringify(fontFiles.mock.calls)).not.toContain("作品");
    expect(fontFiles).toHaveBeenCalledWith([{ family: "Noto Sans JP", weight: 700 }]);
  });

  it("英数字だけのフォントには Noto Sans JP を一緒に入れる", async () => {
    fontFiles.mockImplementation(async (faces: { family: string; weight: number }[]) => ({ files: faces.map((f) => ({ ...f, sha256: "x", data: "QQ==" })), failed: [] }));
    await buildFontCss(root([{ family: "Inter", weight: 400 }]));
    expect(fontFiles.mock.calls[0][0]).toEqual([
      { family: "Inter", weight: 400 },
      { family: "Noto Sans JP", weight: 400 },
    ]);
  });

  it("失敗した face はスキップして続行し、16 件ずつに分ける", async () => {
    const texts = [100, 200, 300, 400, 500, 600, 700, 800, 900].flatMap((weight) => [{ family: "Noto Sans JP", weight }, { family: "Inter", weight }]);
    fontFiles.mockImplementationOnce(async (faces: { family: string; weight: number }[]) => ({
      files: faces.slice(1).map((f) => ({ ...f, sha256: "x", data: "QQ==" })),
      failed: [{ ...faces[0], code: "FONT_FETCH_FAILED" }],
    }));
    fontFiles.mockImplementationOnce(async () => { throw new Error("boom"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const css = await buildFontCss(root(texts));
    expect(fontFiles).toHaveBeenCalledTimes(2);
    expect(fontFiles.mock.calls[0][0]).toHaveLength(16);
    expect(css.match(/@font-face/g)).toHaveLength(15);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("書き出し1回の間のキャッシュ", () => {
  it("同じフォントは何枚目のスライドでも api.fontFiles に1回しか頼まず、同時に頼んでも重ならない", async () => {
    fontFiles.mockImplementation(async (faces: { family: string; weight: number }[]) => ({ files: faces.map((f) => ({ ...f, sha256: "x", data: "QUJD" })), failed: [] }));
    const cache = newExportCache();
    const [a, b] = await Promise.all([
      buildFontCss(root([{ family: "Noto Sans JP", weight: 700 }]), cache),
      buildFontCss(root([{ family: "Noto Sans JP", weight: 700 }]), cache),
    ]);
    const c = await buildFontCss(root([{ family: "Noto Sans JP", weight: 700 }, { family: "Noto Sans JP", weight: 400 }]), cache);
    expect(a).toBe(b);
    expect(c).toContain("font-weight: 400");
    expect(c).toContain("font-weight: 700");
    // 1 回目で 700、3 回目で足りない 400 だけ
    expect(fontFiles.mock.calls.map((x) => x[0])).toEqual([[{ family: "Noto Sans JP", weight: 700 }], [{ family: "Noto Sans JP", weight: 400 }]]);
  });

  it("cache を渡さなければ従来どおり毎回頼む", async () => {
    fontFiles.mockImplementation(async (faces: { family: string; weight: number }[]) => ({ files: faces.map((f) => ({ ...f, sha256: "x", data: "QQ==" })), failed: [] }));
    await buildFontCss(root([{ family: "Noto Sans JP", weight: 700 }]));
    await buildFontCss(root([{ family: "Noto Sans JP", weight: 700 }]));
    expect(fontFiles).toHaveBeenCalledTimes(2);
  });

  it("同じ画像 URL は fetch を1回しかしない", async () => {
    const fetchMock = vi.fn(async () => new Response("x", { headers: { "Content-Type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const cache = newExportCache();
      const urls = await Promise.all([toDataUrl("/logo.png", cache), toDataUrl("/logo.png", cache), toDataUrl("/bg.png", cache)]);
      await toDataUrl("/logo.png", cache);
      expect(urls[0]).toBe(urls[1]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await toDataUrl("/logo.png"); // cache なしは取り直す
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally { vi.unstubAllGlobals(); }
  });
});
