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

/** 更新の状態（docs/desktop-update-design.md の状態遷移） */
export type UpdateState = "idle" | "checking" | "upToDate" | "available" | "downloading" | "downloaded" | "preparingRestart" | "error";
export type UpdateErrorStage = "check" | "download";
/** 画面に出す案内。available：新版あり／progress：取得中／downloaded：再起動で更新／restarting：保存して再起動中／upToDate・error：手動確認の結果など */
export type UpdatePromptKind = "available" | "progress" | "downloaded" | "restarting" | "upToDate" | "error";
export type UpdatePromptAction = "later" | "background" | "close";
export type UpdateSnapshot = {
  state: UpdateState;
  currentVersion: string;
  latestVersion?: string;
  /** プレーンテキスト（最大 2,000 文字） */
  releaseNotes?: string;
  /** 最後に確認できた日時（ISO 8601） */
  checkedAt?: string;
  progress?: { transferred: number; total: number; percent: number };
  error?: { stage: UpdateErrorStage; message: string };
  /** 表示待ちの案内。答えるまで残り、再マウントしても出し直す */
  prompt?: { id: string; kind: UpdatePromptKind };
};

/** 生成の進み具合（server の Progress と同じ形） */
export type DesktopProgress = { phase: "thinking" | "writing"; attempt: number; chars?: number; items?: number };
export type DesktopCallOptions = {
  /** 取り消し・進み具合の対応付けに使う ID（画面が作る。/^[A-Za-z0-9-]{8,64}$/） */
  callId?: string;
  /** stream の操作だけ呼ばれる */
  onProgress?: (p: DesktopProgress) => void;
};

export type DesktopBridge = {
  /** 静的操作表（desktop/operations.ts）にある操作だけ */
  request(req: DesktopRequest, opts?: DesktopCallOptions): Promise<DesktopResult>;
  /** callId の要求を取り消す（main が内部 API への fetch を中断する。worker 側は接続切れで処理を中断する） */
  cancel(callId: string): void;
  runtime: {
    getState(): Promise<RuntimeSnapshot>;
    retryStart(): Promise<RuntimeSnapshot>;
    /** 解除関数を返す */
    onStateChanged(cb: (s: RuntimeSnapshot) => void): () => void;
  };
  window: {
    /** 標準の窓操作ボタンの色を画面のテーマに合わせる */
    setTheme(theme: "light" | "dark"): void;
  };
  /** 資格情報（EXE-FR-003）。値は読み戻せない。結果は { ok, data: 状態 } の形で返す */
  secrets: {
    status(): Promise<DesktopResult>;
    set(providerId: string, kind: string, value: string): Promise<DesktopResult>;
    remove(secretRef: string): Promise<DesktopResult>;
  };
  /**
   * ChatGPT のサインイン（EXE-SCR-004）。main が既定のブラウザで認可画面を開き、ループバックのコールバックを受けて完了する。
   * 成功は { ok: true, data: { result: "signed-in" | "no-plan" } }、キャンセル・失敗は { ok: false, error, code }。
   * 状態の取得は request({ operation: "status.get" })、ログアウトは request({ operation: "auth.logout" })
   */
  auth: {
    signIn(opts?: { newAccount?: boolean }): Promise<DesktopResult>;
    /** 進行中のサインインをやめる（signIn は { ok: false, code: "AUTH_CANCELLED" } で終わる） */
    cancel(): void;
    /** 進行中のサインインの認可画面を、既定のブラウザでもう一度開く */
    reopen(): void;
  };
  close: {
    /** 解除関数を返す */
    onPrepare(cb: (req: PrepareCloseRequest) => void): () => void;
    complete(result: PrepareCloseResult): void;
  };
  /** 更新（API-001〜007）。確認・取得・適用は main が持ち、画面は表示と操作だけ */
  update: {
    getState(): Promise<UpdateSnapshot>;
    check(): Promise<UpdateSnapshot>;
    download(version: string): Promise<UpdateSnapshot>;
    install(version: string): Promise<UpdateSnapshot>;
    respond(promptId: string, action: UpdatePromptAction): Promise<UpdateSnapshot>;
    /** 解除関数を返す */
    onStateChanged(cb: (s: UpdateSnapshot) => void): () => void;
  };
};

/** IPC channel 名（preload と main だけが使う） */
export const IPC = {
  request: "dc:api-request",
  getState: "dc:runtime-get-state",
  retryStart: "dc:runtime-retry",
  stateChanged: "dc:runtime-state",
  windowTheme: "dc:window-theme",
  prepareClose: "dc:prepare-close",
  completeClose: "dc:complete-close",
  secretsStatus: "dc:secrets-status",
  secretsSet: "dc:secrets-set",
  secretsRemove: "dc:secrets-remove",
  authSignIn: "dc:auth-sign-in",
  authCancel: "dc:auth-cancel",
  authReopen: "dc:auth-reopen",
  updateGetState: "dc:update-get-state",
  updateCheck: "dc:update-check",
  updateDownload: "dc:update-download",
  updateInstall: "dc:update-install",
  updateRespond: "dc:update-respond",
  /** main → 画面：UpdateSnapshot */
  updateState: "dc:update-state",
  /** main → 画面：{ callId, progress: DesktopProgress } */
  progress: "dc:api-progress",
  /** 画面 → main：callId */
  cancel: "dc:api-cancel",
} as const;
