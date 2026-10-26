/**
 * 画面へ `window.dcDesktop` だけを公開する（sandbox preload：electron 以外を require しない）。
 * 生の ipcRenderer・任意 channel は出さない
 */
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type DesktopBridge, type PrepareCloseRequest, type RuntimeSnapshot } from "./bridge";

/** 購読して解除関数を返す（IpcRendererEvent は画面へ渡さない） */
function subscribe<T>(channel: string, cb: (v: T) => void): () => void {
  const handler = (_e: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

const bridge: DesktopBridge = {
  request: (req) => ipcRenderer.invoke(IPC.request, req),
  runtime: {
    getState: () => ipcRenderer.invoke(IPC.getState),
    retryStart: () => ipcRenderer.invoke(IPC.retryStart),
    onStateChanged: (cb) => subscribe<RuntimeSnapshot>(IPC.stateChanged, cb),
  },
  secrets: {
    status: () => ipcRenderer.invoke(IPC.secretsStatus),
    set: (providerId, kind, value) => ipcRenderer.invoke(IPC.secretsSet, providerId, kind, value),
    remove: (secretRef) => ipcRenderer.invoke(IPC.secretsRemove, secretRef),
  },
  close: {
    onPrepare: (cb) => subscribe<PrepareCloseRequest>(IPC.prepareClose, cb),
    complete: (result) => { void ipcRenderer.invoke(IPC.completeClose, result).catch(() => {}); },
  },
};

contextBridge.exposeInMainWorld("dcDesktop", bridge);
