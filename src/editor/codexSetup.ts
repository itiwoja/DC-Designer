import { useEffect, useState } from "react";
import { api, type SetupProgress } from "./api";

/**
 * 製品版の Codex CLI の準備（入れる・サインイン）の実行状態。設定の吹き出しを閉じても続くよう、画面の部品の外で持つ。
 * 入れ終えてまだサインインしていなければ、続けてサインインを始める（ワンクリックで使えるところまで進める）
 */
export type CodexJob = { kind: "install" | "login"; progress?: SetupProgress };
export type CodexSetupState = { job: CodexJob | null; error: string };

let state: CodexSetupState = { job: null, error: "" };
let abort: AbortController | null = null;
const listeners = new Set<() => void>();
/** 終わったら（成功・失敗とも）状態を読み直す。最後に表示した部品のものを使う */
let onFinished: (() => void) | undefined;

function set(next: Partial<CodexSetupState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

const isAbort = (e: unknown) => (e as { name?: string })?.name === "AbortError";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function run(kind: CodexJob["kind"]): Promise<void> {
  if (state.job) return;
  abort = new AbortController();
  const signal = abort.signal;
  const onProgress = (progress: SetupProgress) => { if (state.job) set({ job: { ...state.job, progress } }); };
  set({ job: { kind }, error: "" });
  try {
    if (kind === "install") {
      const r = await api.installCodex(onProgress, signal);
      onFinished?.();
      if (!r.signedIn) {
        set({ job: { kind: "login" } });
        await api.loginCodex(onProgress, signal);
      }
    } else {
      await api.loginCodex(onProgress, signal);
    }
  } catch (e) {
    if (!isAbort(e)) set({ error: message(e) });
  } finally {
    abort = null;
    set({ job: null });
    onFinished?.();
  }
}

export const codexSetup = {
  install: () => run("install"),
  login: () => run("login"),
  cancel: () => abort?.abort(),
  clearError: () => set({ error: "" }),
  /** テスト用：状態を初期に戻す */
  reset: () => { abort?.abort(); abort = null; state = { job: null, error: "" }; listeners.forEach((l) => l()); },
};

/** 準備の状態を読む。onStatusChanged は終わったときに呼ぶ（状態の読み直し） */
export function useCodexSetup(onStatusChanged?: () => void): CodexSetupState {
  const [s, setS] = useState(state);
  useEffect(() => {
    const l = () => setS(state);
    listeners.add(l);
    l();
    return () => { listeners.delete(l); };
  }, []);
  useEffect(() => { onFinished = onStatusChanged; }, [onStatusChanged]);
  return s;
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

/** 進み具合の文言 */
export function describeCodexJob(job: CodexJob): string {
  const p = job.progress;
  if (job.kind === "login") return "ブラウザで ChatGPT にサインインしてください。終わると自動でここに戻ります。";
  if (!p || p.step === "download") {
    if (p?.total) return `ダウンロード中… ${Math.floor(((p.done ?? 0) / p.total) * 100)}%（${mb(p.done ?? 0)} / ${mb(p.total)} MB）`;
    return "ダウンロードの準備をしています…";
  }
  if (p.step === "verify") return "公式のファイルと一致するか確かめています…";
  return "このアプリ専用の場所に入れています…";
}
