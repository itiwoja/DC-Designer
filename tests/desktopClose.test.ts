import { afterEach, describe, expect, it, vi } from "vitest";
import { listenForClose, registerCloseSave } from "../src/editor/desktop";

afterEach(() => vi.unstubAllGlobals());

function setup() {
  let prepare!: (req: { requestId: string }) => void;
  const off = vi.fn();
  const bridge = { close: { onPrepare: vi.fn((cb: typeof prepare) => { prepare = cb; return off; }), complete: vi.fn() } };
  vi.stubGlobal("window", { dcDesktop: bridge });
  vi.stubGlobal("document", { activeElement: { blur: vi.fn() } });
  const unlisten = listenForClose();
  return { bridge, off, unlisten, fire: (requestId: string) => prepare({ requestId }) };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("閉じる前の保存準備", () => {
  it("全部の保存が済んでから1回だけ allSaved:true で complete する", async () => {
    const { bridge, fire, unlisten } = setup();
    let release!: () => void;
    const slow = vi.fn(() => new Promise<boolean>((r) => { release = () => r(true); }));
    const fast = vi.fn(async () => true);
    const un1 = registerCloseSave(slow), un2 = registerCloseSave(fast);
    fire("r1");
    await settle();
    expect(fast).toHaveBeenCalled();
    expect(bridge.close.complete).not.toHaveBeenCalled();
    release();
    await settle();
    expect(bridge.close.complete).toHaveBeenCalledTimes(1);
    expect(bridge.close.complete).toHaveBeenCalledWith({ requestId: "r1", allSaved: true, busy: false });
    un1(); un2(); unlisten();
  });

  it("1つでも失敗（false / 例外）なら allSaved:false", async () => {
    const { bridge, fire, unlisten } = setup();
    const un1 = registerCloseSave(async () => true), un2 = registerCloseSave(async () => { throw new Error("x"); });
    fire("r2");
    await settle();
    expect(bridge.close.complete).toHaveBeenCalledWith({ requestId: "r2", allSaved: false, busy: false });
    un1(); un2(); unlisten();
  });

  it("保存関数が無い画面（ホームなど）でも allSaved:true で答える", async () => {
    const { bridge, fire, unlisten } = setup();
    fire("r3");
    await settle();
    expect(bridge.close.complete).toHaveBeenCalledWith({ requestId: "r3", allSaved: true, busy: false });
    unlisten();
  });

  it("解除で購読をやめる。製品版でなければ何もしない", () => {
    const { off, unlisten } = setup();
    unlisten();
    expect(off).toHaveBeenCalled();
    vi.stubGlobal("window", {});
    expect(() => listenForClose()()).not.toThrow();
    expect(() => registerCloseSave(async () => true)()).not.toThrow();
  });
});
