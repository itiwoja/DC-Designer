// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withOffscreenPoster } from "../src/render/offscreen";
import { buildExportSvg } from "../src/render/svg";
import { PosterSpecSchema } from "../src/schema";

const spec = PosterSpecSchema.parse({
  version: 1, theme: "ocean", meta: { width: 500, height: 400, title: "描画確認" },
  layers: [{ id: "group", name: "グループ", type: "group", x: 0, y: 0, w: 500, h: 400, children: [
    { id: "shape", type: "shape", shape: "rect", x: 10, y: 20, w: 100, h: 100, fill: { type: "linear", angle: 45, stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }] } },
  ] }],
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1)); // 背景窓と同じくフレームを発火させない
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("共通の画面外描画", () => {
  it("背景窓でも完了し、並行描画の定義 ID を隔離し、処理後に DOM を片付ける", async () => {
    const before = document.body.childElementCount;
    const callback = vi.fn(async (svg: SVGSVGElement) => {
      expect(svg.parentElement!.style.width).toBe("500px");
      const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const el of svg.querySelectorAll("[fill], [clip-path]")) {
        const value = el.getAttribute("fill") ?? el.getAttribute("clip-path") ?? "";
        const id = value.match(/^url\(#(.+)\)$/)?.[1];
        if (id) expect(svg.querySelector(`[id="${id}"]`)).not.toBeNull();
      }
      return svg.outerHTML;
    });
    const a = withOffscreenPoster(spec, callback), b = withOffscreenPoster(spec, callback);
    await vi.advanceTimersByTimeAsync(100);
    const [first, second] = await Promise.all([a, b]);
    expect(first).not.toBe(second);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(2);
    expect(document.body.childElementCount).toBe(before);
  });

  it("フォントの準備が終わるまで書き出しを始めない", async () => {
    let ready!: () => void;
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready: new Promise<void>((resolve) => { ready = resolve; }) } });
    try {
      const callback = vi.fn(async () => "done");
      const result = withOffscreenPoster(spec, callback);
      await vi.advanceTimersByTimeAsync(500);
      expect(callback).not.toHaveBeenCalled();
      ready();
      await vi.advanceTimersByTimeAsync(100);
      expect(await result).toBe("done");
    } finally { Reflect.deleteProperty(document, "fonts"); }
  });

  it("書き出し失敗でも画面外 DOM を残さない", async () => {
    const before = document.body.childElementCount;
    const result = withOffscreenPoster(spec, async () => { throw new Error("failed"); });
    const checked = expect(result).rejects.toThrow("failed");
    await vi.advanceTimersByTimeAsync(100);
    await checked;
    expect(document.body.childElementCount).toBe(before);
  });

  it("接頭辞付きの SVG でもトップレベルだけにレイヤー属性を付ける", async () => {
    const result = withOffscreenPoster(spec, (svg) => buildExportSvg(svg, spec, { embedFonts: false }));
    await vi.advanceTimersByTimeAsync(100);
    const doc = new DOMParser().parseFromString(await result, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelector('[data-layer-id="group"]')?.getAttribute("inkscape:label")).toBe("グループ");
    expect(doc.querySelector('[data-layer-id="shape"]')?.hasAttribute("inkscape:label")).toBe(false);
    expect(doc.documentElement.getAttribute("width")).toBe("500");
  });
});
