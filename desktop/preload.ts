/**
 * 画面へ `window.dcDesktop` だけを公開する（sandbox preload：electron 以外を require しない）。
 * 生の ipcRenderer・任意 channel は出さない
 */
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type DesktopBridge, type DesktopProgress, type PrepareCloseRequest, type RuntimeSnapshot, type UpdateSnapshot } from "./bridge";

/** 購読して解除関数を返す（IpcRendererEvent は画面へ渡さない） */
function subscribe<T>(channel: string, cb: (v: T) => void): () => void {
  const handler = (_e: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

const bridge: DesktopBridge = {
  request: async (req, opts) => {
    const callId = opts?.callId;
    const onProgress = opts?.onProgress;
    // 関数は IPC へ送れないので callId だけ渡す。結果が返ったら（成功・失敗とも）購読を解除する
    const off = callId && onProgress
      ? subscribe<{ callId?: unknown; progress?: DesktopProgress }>(IPC.progress, (m) => {
          if (m && m.callId === callId && m.progress) onProgress(m.progress);
        })
      : null;
    try {
      return await ipcRenderer.invoke(IPC.request, req, callId ? { callId } : undefined);
    } finally {
      off?.();
    }
  },
  cancel: (callId) => { void ipcRenderer.invoke(IPC.cancel, callId).catch(() => {}); },
  runtime: {
    getState: () => ipcRenderer.invoke(IPC.getState),
    retryStart: () => ipcRenderer.invoke(IPC.retryStart),
    onStateChanged: (cb) => subscribe<RuntimeSnapshot>(IPC.stateChanged, cb),
  },
  window: {
    setTheme: (theme) => { void ipcRenderer.invoke(IPC.windowTheme, theme).catch(() => {}); },
  },
  secrets: {
    status: () => ipcRenderer.invoke(IPC.secretsStatus),
    set: (providerId, kind, value) => ipcRenderer.invoke(IPC.secretsSet, providerId, kind, value),
    remove: (secretRef) => ipcRenderer.invoke(IPC.secretsRemove, secretRef),
  },
  auth: {
    signIn: (opts) => ipcRenderer.invoke(IPC.authSignIn, { newAccount: opts?.newAccount === true }),
  },
  close: {
    onPrepare: (cb) => subscribe<PrepareCloseRequest>(IPC.prepareClose, cb),
    complete: (result) => { void ipcRenderer.invoke(IPC.completeClose, result).catch(() => {}); },
  },
  update: {
    getState: () => ipcRenderer.invoke(IPC.updateGetState),
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    download: (version) => ipcRenderer.invoke(IPC.updateDownload, version),
    install: (version) => ipcRenderer.invoke(IPC.updateInstall, version),
    respond: (promptId, action) => ipcRenderer.invoke(IPC.updateRespond, promptId, action),
    onStateChanged: (cb) => subscribe<UpdateSnapshot>(IPC.updateState, cb),
  },
};

contextBridge.exposeInMainWorld("dcDesktop", bridge);
