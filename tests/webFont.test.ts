import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fontFiles } = vi.hoisted(() => ({ fontFiles: vi.fn() }));
vi.mock("../src/editor/api", () => ({ api: { fontFiles } }));

const added: unknown[] = [];
const faces: { family: string; opts: { weight: string } }[] = [];
const links: { href: string }[] = [];

class FakeFontFace {
  constructor(public family: string, public data: ArrayBuffer, public opts: { weight: string }) { faces.push(this); }
  load = async () => this;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.resetModules();
  fontFiles.mockReset();
  added.length = faces.length = links.length = 0;
  vi.stubGlobal("FontFace", FakeFontFace);
  vi.stubGlobal("document", {
    fonts: { add: (f: unknown) => added.push(f) },
    createElement: () => { const l = { href: "" }; links.push(l); return l; },
    head: { appendChild: () => {} },
  });
});
afterEach(() => vi.unstubAllGlobals());

const reply = (family: string, weight: number) => ({ files: [{ family, weight, sha256: "x", data: "QUJD" }], failed: [] });

describe("ensureWebFont", () => {
  it("開発版は Google の CSS link を作る", async () => {
    vi.stubGlobal("window", {});
    const { ensureWebFont } = await import("../src/fonts");
    ensureWebFont("Noto Sans JP");
    ensureWebFont("Noto Sans JP");
    expect(links).toHaveLength(1);
    expect(links[0].href).toContain("fonts.googleapis.com");
    expect(links[0].href).not.toContain("text=");
    expect(fontFiles).not.toHaveBeenCalled();
  });

  it("製品版は最も近い weight の face だけ API から取り、FontFace で登録する。同じ face は二重に取らない", async () => {
    vi.stubGlobal("window", { dcDesktop: {} });
    fontFiles.mockImplementation(async (f: { family: string; weight: number }[]) => reply(f[0].family, f[0].weight));
    const { ensureWebFont } = await import("../src/fonts");
    ensureWebFont("Zen Kaku Gothic New", 600); // カタログは 300,400,500,700,900 → 500 と 700 の中間は 500 に近い順で決まる
    ensureWebFont("Zen Kaku Gothic New", 600);
    await flush();
    expect(fontFiles).toHaveBeenCalledTimes(1);
    const w = fontFiles.mock.calls[0][0][0].weight;
    expect([500, 700]).toContain(w);
    expect(faces[0].opts).toEqual({ weight: String(w) });
    expect(added).toHaveLength(1);
    expect(links).toHaveLength(0);
    ensureWebFont("Zen Kaku Gothic New"); // 未指定は 400
    await flush();
    expect(fontFiles).toHaveBeenCalledTimes(2);
    expect(fontFiles.mock.calls[1][0][0].weight).toBe(400);
  });

  it("失敗しても例外を投げず、次回再試行できる", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { dcDesktop: {} });
    fontFiles.mockRejectedValueOnce(new Error("denied"));
    fontFiles.mockImplementation(async (f: { family: string; weight: number }[]) => reply(f[0].family, f[0].weight));
    const { ensureWebFont } = await import("../src/fonts");
    expect(() => ensureWebFont("Noto Sans JP")).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(added).toHaveLength(0);
    ensureWebFont("Noto Sans JP"); // 直後は再試行しない
    await vi.advanceTimersByTimeAsync(0);
    expect(fontFiles).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31_000);
    ensureWebFont("Noto Sans JP");
    await vi.advanceTimersByTimeAsync(0);
    expect(fontFiles).toHaveBeenCalledTimes(2);
    expect(added).toHaveLength(1);
    vi.useRealTimers();
  });
});
