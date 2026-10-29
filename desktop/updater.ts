/**
 * 起動時の更新確認と適用の調停（docs/desktop-update-design.md）。
 * 状態とポップアップの表示待ちは main がここで1つだけ持つ。electron には依存せず、更新ライブラリ・再起動は deps で受け取る
 */
import type { UpdateErrorStage, UpdatePromptAction, UpdatePromptKind, UpdateSnapshot } from "./bridge";

export const CHECK_TIMEOUT_MS = 10_000;
/** 期限切れの後も実際の問い合わせを待つ上限（これを過ぎたら次の確認を受け付ける） */
export const CHECK_LOCK_MAX_MS = 60_000;
export const MANUAL_CHECK_INTERVAL_MS = 30_000;
export const PROGRESS_INTERVAL_MS = 250;
export const NOTES_MAX_CHARS = 2_000;

/** electron-updater の AppUpdater のうち使う部分 */
export type UpdaterLike = {
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo: { version: string; releaseNotes?: unknown } } | null>;
  downloadUpdate(): Promise<unknown>;
  on(event: "download-progress", cb: (p: { transferred: number; total: number; percent: number }) => void): unknown;
};

export type UpdateDeps = {
  updater: UpdaterLike;
  currentVersion: string;
  /** 状態が変わるたびに画面へ送る */
  onState: (s: UpdateSnapshot) => void;
  /** 保存確認のうえで終了して更新を適用する。保存できず中止したときは resolve して戻る */
  restartToInstall: () => Promise<void>;
  now?: () => number;
};

const ERROR_TEXT: Record<UpdateErrorStage, string> = {
  check: "更新を確認できませんでした。インターネットの接続を確かめて、あとでもう一度お試しください。",
  download: "更新を取得できませんでした。もう一度お試しください。",
};

/** releaseNotes（GitHub の Release 本文の HTML、または版ごとの配列）を表示用のプレーンテキストにする */
export function notesToText(notes: unknown): string | undefined {
  const raw = Array.isArray(notes)
    ? notes.map((n) => (n && typeof n === "object" && typeof (n as { note?: unknown }).note === "string" ? (n as { note: string }).note : "")).join("\n")
    : typeof notes === "string" ? notes : "";
  const text = raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|h[1-6]|div|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "・")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return undefined;
  return text.length > NOTES_MAX_CHARS ? `${text.slice(0, NOTES_MAX_CHARS)}…` : text;
}

export function createUpdateManager(deps: UpdateDeps) {
  const now = deps.now ?? Date.now;
  let snap: UpdateSnapshot = { state: "idle", currentVersion: deps.currentVersion };
  let promptSeq = 0;
  let checkGen = 0;
  let checking = false;
  let lastManualCheck = -Infinity;
  let lastProgressAt = -Infinity;

  const emit = () => deps.onState(snap);
  const set = (patch: Partial<UpdateSnapshot>) => { snap = { ...snap, ...patch }; emit(); };
  const prompt = (kind: UpdatePromptKind) => ({ id: `p${++promptSeq}`, kind });

  deps.updater.on("download-progress", (p) => {
    if (snap.state !== "downloading") return;
    const t = now();
    // 進み具合の通知は 4回／秒まで
    if (t - lastProgressAt < PROGRESS_INTERVAL_MS && p.percent < 100) return;
    lastProgressAt = t;
    set({ progress: { transferred: p.transferred, total: p.total, percent: Math.max(0, Math.min(100, p.percent)) } });
  });

  /**
   * 公開済みの正式版を確認する。自動確認（起動時）は新版のときだけ案内し、失敗しても知らせない。
   * 手動確認は結果を必ず案内する（30秒以内の再確認は通信せず今の状態を案内する）
   */
  async function check({ manual }: { manual: boolean }): Promise<UpdateSnapshot> {
    if (snap.state === "downloading") { if (manual) set({ prompt: prompt("progress") }); return snap; }
    if (snap.state === "downloaded") { if (manual) set({ prompt: prompt("downloaded") }); return snap; }
    if (snap.state === "preparingRestart") return snap;
    if (checking) return snap;
    if (manual) {
      if (now() - lastManualCheck < MANUAL_CHECK_INTERVAL_MS && snap.state !== "idle") {
        set({ prompt: prompt(snap.state === "available" ? "available" : snap.state === "upToDate" ? "upToDate" : "error") });
        return snap;
      }
      lastManualCheck = now();
    }
    const gen = ++checkGen;
    checking = true;
    set({ state: "checking", error: undefined });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), CHECK_TIMEOUT_MS); });
    // 期限切れのあとも、実際の問い合わせが終わるまで（最長 CHECK_LOCK_MAX_MS）は次の確認を重ねない
    const unlock = () => { if (gen === checkGen) checking = false; };
    const lockTimer = setTimeout(unlock, CHECK_LOCK_MAX_MS);
    const real = deps.updater.checkForUpdates();
    void real.then(unlock, unlock).finally(() => clearTimeout(lockTimer));
    try {
      const r = await Promise.race([real, timeout]);
      if (gen !== checkGen) return snap;
      if (r === "timeout") throw new Error("timeout");
      const latest = r?.updateInfo?.version;
      if (r && r.isUpdateAvailable && typeof latest === "string") {
        set({
          state: "available", latestVersion: latest, releaseNotes: notesToText(r.updateInfo.releaseNotes),
          checkedAt: new Date(now()).toISOString(), prompt: prompt("available"),
        });
      } else {
        set({ state: "upToDate", latestVersion: latest, releaseNotes: undefined, checkedAt: new Date(now()).toISOString(), ...(manual ? { prompt: prompt("upToDate") } : {}) });
      }
    } catch {
      if (gen !== checkGen) return snap;
      // 確認できなかったことは「最新版」と区別する
      set({ state: "error", error: { stage: "check", message: ERROR_TEXT.check }, ...(manual ? { prompt: prompt("error") } : {}) });
    } finally {
      clearTimeout(timer);
    }
    return snap;
  }

  /** 案内した版の取得を始める（画面から版以外は受け取らない） */
  async function download(version: unknown): Promise<UpdateSnapshot> {
    if (snap.state !== "available" || version !== snap.latestVersion) return snap;
    lastProgressAt = -Infinity;
    set({ state: "downloading", progress: { transferred: 0, total: 0, percent: 0 }, error: undefined, prompt: prompt("progress") });
    try {
      await deps.updater.downloadUpdate();
      set({ state: "downloaded", progress: undefined, prompt: prompt("downloaded") });
    } catch {
      set({ state: "available", progress: undefined, error: { stage: "download", message: ERROR_TEXT.download }, prompt: prompt("error") });
    }
    return snap;
  }

  /** 取得済みの版で、保存を確かめてから再起動して適用する。保存できず中止したら downloaded に戻す */
  async function install(version: unknown): Promise<UpdateSnapshot> {
    if (snap.state !== "downloaded" || version !== snap.latestVersion) return snap;
    set({ state: "preparingRestart", prompt: prompt("restarting") });
    try {
      await deps.restartToInstall();
    } finally {
      // await の間に set で書き換わるので、型の絞り込みを外して今の状態を見る
      if ((snap as UpdateSnapshot).state === "preparingRestart") set({ state: "downloaded", prompt: undefined });
    }
    return snap;
  }

  /** ポップアップへの答え。今出ている案内の ID と一致するときだけ閉じる */
  function respond(promptId: unknown, action: unknown): UpdateSnapshot {
    const valid: UpdatePromptAction[] = ["later", "background", "close"];
    if (!snap.prompt || promptId !== snap.prompt.id || !valid.includes(action as UpdatePromptAction)) return snap;
    if (snap.prompt.kind === "restarting") return snap;
    set({ prompt: undefined });
    return snap;
  }

  return { check, download, install, respond, snapshot: () => snap };
}

export type UpdateManager = ReturnType<typeof createUpdateManager>;
