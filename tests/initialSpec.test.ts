import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let nav: typeof import("../src/editor/nav");
const getItem = vi.fn<(key: string) => string | null>();

beforeAll(async () => {
  vi.stubGlobal("location", { pathname: "/" });
  try { nav = await import("../src/editor/nav"); }
  finally { vi.unstubAllGlobals(); }
});
beforeEach(() => {
  getItem.mockReset().mockReturnValue(null);
  vi.stubGlobal("localStorage", { getItem });
});
afterEach(() => vi.unstubAllGlobals());

describe("loadInitialSpec", () => {
  it("控えがなければ背景だけの白紙ポスターを開く", () => {
    const spec = nav.loadInitialSpec();
    expect(spec.meta).toEqual({ title: "無題のポスター", width: 1000, height: 1414 });
    expect(spec.layers).toEqual([expect.objectContaining({ type: "background", w: 1000, h: 1414 })]);
    expect(getItem).toHaveBeenCalledWith("dc-designer:spec");
  });

  it("有効な控えがあれば編集内容を維持する", () => {
    const saved = { ...nav.BLANK_SPEC, meta: { title: "編集中の資料", width: 1333, height: 750 }, notes: "台本" };
    getItem.mockReturnValue(JSON.stringify(saved));
    expect(nav.loadInitialSpec()).toEqual(saved);
  });

  it.each(["{broken", '{"layers":[]}'])("壊れた控えは白紙へ戻す: %s", (raw) => {
    getItem.mockReturnValue(raw);
    expect(nav.loadInitialSpec()).toEqual(nav.BLANK_SPEC);
  });

  it("ストレージを読めなくても白紙を開ける", () => {
    getItem.mockImplementation(() => { throw new Error("storage unavailable"); });
    expect(nav.loadInitialSpec()).toEqual(nav.BLANK_SPEC);
  });

  it("白紙の編集が次の初期表示へ混ざらない", () => {
    const spec = nav.loadInitialSpec();
    spec.meta.title = "変更済み";
    spec.layers[0].w = 50;
    expect(nav.loadInitialSpec()).toEqual(nav.BLANK_SPEC);
  });
});
