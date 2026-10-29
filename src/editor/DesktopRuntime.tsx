import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RuntimeError, RuntimeSnapshot } from "../../desktop/bridge";
import { desktopBridge, listenForClose } from "./desktop";
import { DesktopUpdate } from "./DesktopUpdate";
import "./desktopRuntime.css";
import "./desktopWindow.css";

const ERROR_TEXT: Record<RuntimeError, string> = {
  STARTUP_FAILED: "内部の処理を起動できませんでした。",
  VERSION_MISMATCH: "内部の処理の版がアプリと合っていません。アプリを入れ直してください。",
  LEASE_TIMEOUT: "前回の終了処理が終わらず、起動できませんでした。",
  LEASE_DENIED: "別のDC-Designerが同じデータを使っているため、起動できませんでした。",
  WORKER_LOST: "内部の処理が止まりました。",
};

/**
 * 製品版だけ表示する起動状態。ready になるまで全面を覆って、下の画面を操作させない。
 * 画面（children）は最初に ready になってからマウントし（起動前に API を呼ばせない）、その後は API が止まっても編集中の内容を残すため外さない
 */
export function DesktopRuntime({ children, showUpdates = true }: { children: ReactNode; showUpdates?: boolean }) {
  const bridge = desktopBridge();
  const [snap, setSnap] = useState<RuntimeSnapshot | null>(null);
  const [retrying, setRetrying] = useState(false);
  const retryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!bridge) return;
    const root = document.documentElement;
    root.dataset.desktop = "";
    const syncTheme = () => bridge.window.setTheme(root.dataset.theme === "dark" ? "dark" : "light");
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { observer.disconnect(); delete root.dataset.desktop; };
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    const off = bridge.runtime.onStateChanged((s) => alive && setSnap(s));
    bridge.runtime.getState().then((s) => alive && setSnap((cur) => cur ?? s)).catch(() => {});
    return () => { alive = false; off(); };
  }, [bridge]);

  // 閉じる前の保存準備には、どの画面でも答える（ホームなど保存するものが無い画面でも閉じられるように）
  useEffect(() => listenForClose(), []);

  // 失敗したら「再試行」へキーボードの焦点を移す
  useEffect(() => { if (snap?.state === "failed") retryRef.current?.focus(); }, [snap?.state]);

  const [mounted, setMounted] = useState(!bridge);
  useEffect(() => { if (snap?.state === "ready") setMounted(true); }, [snap?.state]);

  const show = mounted || snap?.state === "ready";
  // 覆いの有無で返す形を変えない（子の並びが変わると、閉じる途中などで画面が付け直され、実行中の処理の結果を失う）
  const covered = !!bridge && snap?.state !== "ready";
  const state = snap ?? { state: "starting" as const, appVersion: "" };

  const retry = async () => {
    if (!bridge) return;
    setRetrying(true);
    try { setSnap(await bridge.runtime.retryStart()); } catch { /* 状態通知で更新される */ } finally { setRetrying(false); }
  };

  const failed = state.state === "failed";
  const title = failed ? "起動できませんでした" : state.state === "waiting-lease" ? "前回の終了処理を待っています" : state.state === "closing" ? "保存して終了しています" : "起動を確認しています";
  return (
    <>
    {show && children}
    {show && showUpdates && <DesktopUpdate />}
    {covered && <div className="desktop-runtime">
      <div className={`desktop-runtime-card${failed ? " failed" : ""}`} role="status" aria-live="polite">
        <p className="desktop-runtime-title">{title}</p>
        {failed && <p className="desktop-runtime-detail">{state.error ? ERROR_TEXT[state.error] : "原因を特定できませんでした。"}</p>}
        {failed && <button ref={retryRef} type="button" className="desktop-runtime-retry" disabled={retrying} onClick={retry}>再試行</button>}
      </div>
    </div>}
    </>
  );
}
