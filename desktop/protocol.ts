/**
 * Electron main と API worker（utilityProcess）の親子 IPC の約束事（段階1）。
 * token は main が起動ごとに作り、この IPC でだけ渡す（コマンドライン・環境変数・URL・ログに出さない）
 */

/** main と worker の取り決めの版。合わなければ main は failed にする */
export const API_PROTOCOL_VERSION = 1;

/** 内部 API の認証ヘッダー名 */
export const DESKTOP_TOKEN_HEADER = "x-dc-desktop-token";
/** 画面の固定 origin（main が中継時に Origin へ付ける。API はこれ以外を拒否する） */
export const DESKTOP_ORIGIN = "app://dc-designer";

/** 起動の監視期限・lease 待ちの期限・保存後の停止待ちの期限（AI 推奨値） */
export const STARTUP_TIMEOUT_MS = 30_000;
export const LEASE_TIMEOUT_MS = 30_000;
export const STOP_TIMEOUT_MS = 30_000;

/** main → worker */
export type MainToWorker =
  /** 起動直後に1回だけ送る */
  | { type: "init"; token: string; instanceId: string; appVersion: string }
  /** 新しい書き込み要求の受付を止め、進行中の書き込みが終わったら drained を返す */
  | { type: "drain"; requestId: string }
  /** drain を取り消して受付を再開する（終了をやめて編集へ戻るとき） */
  | { type: "resume"; requestId: string }
  /** 正常終了（server.close → lease を閉じる → process.exit(0)） */
  | { type: "shutdown" };

/** worker → main */
export type WorkerToMain =
  /** lease が使用中で待っている（画面に「前回の終了処理を待っています」を出す） */
  | { type: "lease-waiting" }
  /** lease を取れず期限切れ・先取り・拒否。書き込みは始めていない */
  | { type: "lease-failed"; reason: "timeout" | "denied" }
  /** 127.0.0.1:0 で listen できた */
  | { type: "ready"; port: number; instanceId: string; apiProtocolVersion: number; appVersion: string }
  | { type: "drained"; requestId: string; busy: boolean }
  | { type: "resumed"; requestId: string }
  /** 起動に失敗した（秘密値・絶対 path を含めない分類だけ） */
  | { type: "fatal"; code: "LISTEN_FAILED" | "INIT_INVALID" | "INTERNAL" };

/** GET /api/desktop/health の応答（token 必須） */
export type DesktopHealth = { instanceId: string; apiProtocolVersion: number; appVersion: string; ready: true };

/** utilityProcess に渡してよい環境変数（これ以外は渡さない） */
export const WORKER_ENV_ALLOWLIST = ["SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "PATH"] as const;

/** userRoot（%LOCALAPPDATA%/DC-Designer/）の下の領域 */
export const USER_ROOT_DIRS = ["workspace", "assets", "browser", "fonts", "secrets", "runtime", "cache", "logs"] as const;

/**
 * worker の環境変数で渡す保存先（userRoot の下）。
 * DATA_DIR=<userRoot>/workspace、GENERATED_DIR=<userRoot>/assets/generated、DC_DESIGNER_CONFIG_DIR=<userRoot>/secrets
 * と、製品版であることを示す DC_DESIGNER_DESKTOP=1、lease 名のもとになる DC_DESIGNER_USER_ROOT
 */
export const DESKTOP_ENV_FLAG = "DC_DESIGNER_DESKTOP";
