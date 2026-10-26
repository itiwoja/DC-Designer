/**
 * preload が画面へ公開する `window.dcDesktop` の型（段階1）。
 * 生の ipcRenderer・任意 channel・URL・path は公開しない。Error は IPC を越えると code / status が落ちるので、結果は値で返す
 */
import type { DesktopRequest } from "./operations";

export type RuntimeState = "starting" | "waiting-lease" | "ready" | "failed" | "closing";

export type RuntimeError =
  | "STARTUP_FAILED" | "VERSION_MISMATCH" | "LEASE_TIMEOUT" | "LEASE_DENIED" | "WORKER_LOST";

export type RuntimeSnapshot = { state: RuntimeState; appVersion: string; error?: RuntimeError };

export type DesktopResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; code?: string; status?: number };

/** main → 画面：閉じる前の保存準備（requestId ごとに1回だけ答える） */
export type PrepareCloseRequest = { requestId: string };
/** 画面 → main：保存準備の結果。allSaved が false か busy が true なら main は閉じない */
export type PrepareCloseResult = { requestId: string; allSaved: boolean; busy: boolean };

export type DesktopBridge = {
  /** 段階1の静的操作表（desktop/operations.ts）にある操作だけ */
  request(req: DesktopRequest): Promise<DesktopResult>;
  runtime: {
    getState(): Promise<RuntimeSnapshot>;
    retryStart(): Promise<RuntimeSnapshot>;
    /** 解除関数を返す */
    onStateChanged(cb: (s: RuntimeSnapshot) => void): () => void;
  };
  close: {
    /** 解除関数を返す */
    onPrepare(cb: (req: PrepareCloseRequest) => void): () => void;
    complete(result: PrepareCloseResult): void;
  };
};

/** IPC channel 名（preload と main だけが使う） */
export const IPC = {
  request: "dc:api-request",
  getState: "dc:runtime-get-state",
  retryStart: "dc:runtime-retry",
  stateChanged: "dc:runtime-state",
  prepareClose: "dc:prepare-close",
  completeClose: "dc:complete-close",
} as const;
