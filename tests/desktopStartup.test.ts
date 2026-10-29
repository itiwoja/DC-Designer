import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { startDesktop } from "../desktop/startup";

function setup() {
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    whenReady: vi.fn(async () => {}),
  });
  const win = {
    isDestroyed: vi.fn(() => false), isMinimized: vi.fn(() => false),
    restore: vi.fn(), focus: vi.fn(), close: vi.fn(), destroy: vi.fn(), loadURL: vi.fn(async () => {}),
  };
  const deps = {
    app: app as unknown as Parameters<typeof startDesktop>[0]["app"],
    runtime: { start: vi.fn(), hasLiveWorker: vi.fn(() => true), forceStop: vi.fn(async () => true) },
    getWindow: () => win,
    createWindow: vi.fn(() => win),
    isCloseApproved: vi.fn(() => false),
    hardenContents: vi.fn(), prepare: vi.fn(), checkUpdates: vi.fn(), showStartupError: vi.fn(),
  };
  return { app, win, deps };
}

describe("exe の起動", () => {
  it("二重起動では窓・worker・更新確認を始めない", async () => {
    const { app, deps } = setup();
    app.requestSingleInstanceLock.mockReturnValue(false);
    await startDesktop(deps);
    expect(app.quit).toHaveBeenCalledOnce();
    expect(deps.hardenContents).not.toHaveBeenCalled();
    expect(app.whenReady).not.toHaveBeenCalled();
    expect(deps.runtime.start).not.toHaveBeenCalled();
    expect(deps.createWindow).not.toHaveBeenCalled();
    expect(deps.checkUpdates).not.toHaveBeenCalled();
  });

  it("ready の後に依存処理を用意し、画面読み込み中も更新確認を始める", async () => {
    const { app, win, deps } = setup();
    let ready!: () => void, loaded!: () => void;
    app.whenReady.mockReturnValue(new Promise((resolve) => { ready = resolve; }));
    win.loadURL.mockReturnValue(new Promise((resolve) => { loaded = resolve; }));
    const started = startDesktop(deps);
    expect(deps.hardenContents).toHaveBeenCalledOnce();
    expect(deps.prepare).not.toHaveBeenCalled();
    ready();
    await Promise.resolve();
    expect(deps.prepare).toHaveBeenCalledOnce();
    expect(deps.prepare.mock.invocationCallOrder[0]).toBeLessThan(deps.runtime.start.mock.invocationCallOrder[0]);
    expect(deps.runtime.start.mock.invocationCallOrder[0]).toBeLessThan(deps.createWindow.mock.invocationCallOrder[0]);
    expect(win.loadURL).toHaveBeenCalledExactlyOnceWith("app://dc-designer/");
    expect(deps.checkUpdates).toHaveBeenCalledOnce();
    loaded();
    await started;
    expect(app.quit).not.toHaveBeenCalled();
  });

  it.each(["prepare", "createWindow", "loadURL"] as const)("%s の失敗は案内して worker を止め、窓を破棄して終了する", async (step) => {
    const { app, win, deps } = setup();
    if (step === "loadURL") win.loadURL.mockRejectedValue(new Error("ERR_FAILED"));
    else deps[step].mockImplementation(() => { throw new Error("failed"); });
    await startDesktop(deps);
    expect(deps.showStartupError).toHaveBeenCalledOnce();
    expect(deps.runtime.forceStop).toHaveBeenCalledOnce();
    expect(win.destroy).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
    const preventDefault = vi.fn();
    app.emit("before-quit", { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("worker の停止に失敗しても窓を残さず終了する", async () => {
    const { app, win, deps } = setup();
    win.loadURL.mockRejectedValue(new Error("failed"));
    deps.runtime.forceStop.mockRejectedValue(new Error("lost"));
    await expect(startDesktop(deps)).resolves.toBeUndefined();
    expect(win.destroy).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("通常の終了による読み込み中断は起動エラーを出さない", async () => {
    const { win, deps } = setup();
    win.loadURL.mockRejectedValue(new Error("ERR_ABORTED"));
    deps.isCloseApproved.mockReturnValue(true);
    await startDesktop(deps);
    expect(deps.showStartupError).not.toHaveBeenCalled();
  });

  it("二重起動時は既存窓に焦点を戻し、終了時は保存の調停を通す", async () => {
    const { app, win, deps } = setup();
    await startDesktop(deps);
    win.isMinimized.mockReturnValue(true);
    app.emit("second-instance");
    expect(win.restore).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    const preventDefault = vi.fn();
    app.emit("before-quit", { preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(win.close).toHaveBeenCalledOnce();
    deps.isCloseApproved.mockReturnValue(true);
    app.emit("before-quit", { preventDefault });
    expect(win.close).toHaveBeenCalledOnce();
    app.emit("will-quit");
    expect(deps.runtime.forceStop).toHaveBeenCalledOnce();
  });
});
