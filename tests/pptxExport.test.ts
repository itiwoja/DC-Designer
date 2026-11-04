import { describe, expect, it, vi } from "vitest";
import { buildDeckPptx, deckConcurrency, formatDeckTiming, isPlainText, textTransparency } from "../src/render/export";
import { PosterSpecSchema } from "../src/schema";
import { resolveTheme } from "../src/themes";

vi.mock("../src/render/offscreen", () => ({
  withOffscreenPoster: async (_spec: unknown, fn: (svg: unknown) => Promise<unknown>) => {
    await new Promise((r) => setTimeout(r, 1));
    return fn({ querySelector: () => null });
  },
}));
vi.mock("../src/editor/api", () => ({ api: { embedFonts: async () => ({ fonts: [] }) } }));

const theme = resolveTheme("dark" as never, undefined);
const text = (fill: unknown) => ({ id: "t", type: "text", text: "a", x: 0, y: 0, w: 10, h: 10, size: 10, font: "heading", fill }) as never;

describe("isPlainText", () => {
  it("単色はテキストボックス", () => {
    expect(isPlainText(text("#ff0000"), theme)).toBe(true);
  });
  it("グラデーションは対象外", () => {
    expect(isPlainText(text({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }] }), theme)).toBe(false);
  });
});

describe("textTransparency", () => {
  it("opacity を透明度 0〜100 にする", () => {
    expect(textTransparency(undefined)).toBe(0);
    expect(textTransparency(1)).toBe(0);
    expect(textTransparency(0.5)).toBe(50);
    expect(textTransparency(0)).toBe(100);
  });
});

describe("buildDeckPptx の進み具合と計測", () => {
  const slide = (n: number) => PosterSpecSchema.parse({
    meta: { title: `s${n}`, width: 400, height: 300 },
    theme: "dark",
    layers: [{ id: "t", name: "文字", type: "text", text: "a", x: 0, y: 0, w: 100, h: 40, size: 20, font: "body", fill: "#ff0000" }],
  });

  it("単調に増え、最後の工程が終わったときにだけ 100 になる", async () => {
    vi.stubGlobal("CSS", { escape: (v: string) => v });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const calls: [number, number, string | undefined][] = [];
    const blob = await buildDeckPptx([slide(1), slide(2), slide(3), slide(4)], (d, t, p) => calls.push([d, t, p]));
    expect(blob).toBeInstanceOf(Blob);
    const pct = calls.map(([d, t]) => (d / t) * 100);
    expect(pct[0]).toBe(0);
    expect(pct).toEqual([...pct].sort((a, b) => a - b));
    expect(pct.filter((v) => v >= 100)).toHaveLength(1);
    expect(pct.at(-1)).toBe(100);
    expect(Math.max(...pct.slice(0, -1))).toBeLessThan(100);
    expect(calls.at(-2)![2]).toBe("finish"); // スライドの準備が終わったあとにも「仕上げ」の段階がある
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0]![0]).toMatch(/^\[pptx\] 4 枚 .*準備 .* \/ write .* \/ 仕上げ .*同時 3/);
    info.mockRestore();
    vi.unstubAllGlobals();
  });

  it("同時に処理する枚数は localStorage で変えられる（1〜6、読めなければ 3）", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null });
    expect(deckConcurrency()).toBe(3);
    for (const [v, want] of [["5", 5], ["1", 1], ["6", 6], ["0", 3], ["7", 3], ["2.5", 3], ["x", 3]] as const) {
      store.set("dc.pptxConcurrency", v);
      expect(deckConcurrency()).toBe(want);
    }
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); } });
    expect(deckConcurrency()).toBe(3);
    vi.unstubAllGlobals();
  });

  it("計測の 1 行（メモリは取れたときだけ）", () => {
    const t = { slides: 12, total: 3400, prepare: 2100, write: 800, finish: 500, concurrency: 3 };
    expect(formatDeckTiming(t)).toBe("[pptx] 12 枚 3.4s（準備 2.1s / write 0.8s / 仕上げ 0.5s）同時 3");
    expect(formatDeckTiming({ ...t, heapBytes: 200 * 1048576 })).toMatch(/同時 3 メモリ最大 200MB$/);
  });
});
