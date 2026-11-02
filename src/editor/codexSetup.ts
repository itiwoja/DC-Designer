import { useEffect, useState } from "react";
import { DESKTOP_ACCOUNT_CHANGED } from "./accountView";
import { api, type SetupProgress } from "./api";
import type { DesktopResult } from "../../desktop/bridge";

/**
 * 製品版の Codex CLI の準備（入れる・サインイン）の実行状態。設定の吹き出しを閉じても続くよう、画面の部品の外で持つ。
 * 入れ終えてまだサインインしていなければ、続けてサインインを始める（ワンクリックで使えるところまで進める）。
 * ChatGPT へのサインインが済んだときにも ensure で自動で進める
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

/**
 * ChatGPT へのサインインに続けて、画像生成用の Codex も使えるところまで進める。
 * Codex CLI を自動で探し、見つかってサインインしていなければサインイン、見つからず入れられる PC なら
 * 裏で取ってきてからサインインする。使える・入れられない・状態が読めないときは何もしない
 */
async function ensure(): Promise<void> {
  if (state.job) return;
  const codex = await api.status().then((s) => s.codex).catch(() => undefined);
  if (!codex || state.job) return;
  if (codex.state === "signed_out") return run("login");
  if (codex.state === "not_found" && codex.canInstall) return run("install");
}

export const codexSetup = {
  install: () => run("install"),
  login: () => run("login"),
  ensure,
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

/**
 * どの画面（エディタのアカウント欄・AI 機能の案内・ホーム）から始めたサインインでも、
 * ChatGPT にサインインできたら画像生成用の Codex も続けて準備する。
 * ホームとエディタは同時には出ないので、出ている画面で 1 回だけ使う
 */
export function useCodexAfterSignIn(): void {
  useEffect(() => {
    const onChanged = (e: Event) => {
      const res = (e as CustomEvent<DesktopResult | undefined>).detail;
      if (res?.ok && (res.data as { result?: unknown } | null)?.result === "signed-in") void ensure();
    };
    window.addEventListener(DESKTOP_ACCOUNT_CHANGED, onChanged);
    return () => window.removeEventListener(DESKTOP_ACCOUNT_CHANGED, onChanged);
  }, []);
}

/** 準備中にボタンなどへ出す短い文言 */
export const codexJobLabel = (job: CodexJob) => (job.kind === "install" ? "画像生成を準備中…" : "Codex にサインイン中…");

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

/** 進み具合の文言 */
export function describeCodexJob(job: CodexJob): string {
  const p = job.progress;
  if (job.kind === "login") return "画像生成（Codex）用に、ブラウザで ChatGPT にサインインしてください。AI 機能と同じアカウントを選んでください。終わると自動でここに戻ります。";
  if (!p || p.step === "download") {
    if (p?.total) return `ダウンロード中… ${Math.floor(((p.done ?? 0) / p.total) * 100)}%（${mb(p.done ?? 0)} / ${mb(p.total)} MB）`;
    return "ダウンロードの準備をしています…";
  }
  if (p.step === "verify") return "公式のファイルと一致するか確かめています…";
  return "このアプリ専用の場所に入れています…";
}
