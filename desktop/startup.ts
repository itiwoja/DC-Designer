import type { App, BrowserWindow } from "electron";
import { APP_ORIGIN_URL } from "./appProtocol";
import type { Runtime } from "./runtime";

type StartupWindow = Pick<BrowserWindow, "isDestroyed" | "isMinimized" | "restore" | "focus" | "close" | "destroy" | "loadURL">;

type StartupDeps = {
  app: Pick<App, "requestSingleInstanceLock" | "quit" | "on" | "whenReady">;
  runtime: Pick<Runtime, "start" | "hasLiveWorker" | "forceStop">;
  getWindow: () => StartupWindow | null;
  createWindow: () => StartupWindow;
  isCloseApproved: () => boolean;
  /** ready 前の webContents 制限を登録する */
  hardenContents: () => void;
  /** セッション・更新・IPC・メニューを、この順番で用意する */
  prepare: () => void;
  checkUpdates: () => void;
  showStartupError: () => void;
};

/** 単一起動・窓のライフサイクルと起動失敗の後始末。Electron の実体は main から受け取る。 */
export async function startDesktop(deps: StartupDeps): Promise<void> {
  const { app, runtime, getWindow } = deps;
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  let startupFailed = false;
  app.on("second-instance", () => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on("before-quit", (e) => {
    const win = getWindow();
    if (startupFailed || deps.isCloseApproved() || !win || win.isDestroyed()) return;
    e.preventDefault();
    win.close();
  });
  app.on("will-quit", () => { if (runtime.hasLiveWorker()) void runtime.forceStop(); });
  app.on("window-all-closed", () => app.quit());

  try {
    deps.hardenContents();
    await app.whenReady();
    deps.prepare();
    runtime.start();
    const win = deps.createWindow();
    const loaded = win.loadURL(APP_ORIGIN_URL);
    // 更新確認は描画を待たせない。結果は更新マネージャーが保持する。
    deps.checkUpdates();
    await loaded;
  } catch {
    // 通常の終了・更新適用による loadURL の中断は起動失敗として扱わない。
    if (deps.isCloseApproved()) return;
    startupFailed = true;
    deps.showStartupError();
    try { await runtime.forceStop(); } catch { /* 終了イベントでも停止を試みる */ } finally {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.destroy();
      app.quit();
    }
  }
}
