import { useCallback, useEffect, useRef, useState } from "react";
import { Ico } from "./uiIcons";

export type Notice = { id: number; kind: "info" | "success" | "error"; text: string; action?: { label: string; run: () => void } };
/**
 * 実行中の処理（画面右下に出す）。abort があればキャンセルできる。
 * 何段階かある処理では step（何段階目か）・stepStartedAt（その段階の開始時刻）・detail（その段階の中の様子）も出す
 */
export type Busy = {
  label: string; startedAt: number; abort?: AbortController; progress?: [number, number];
  step?: [number, number]; stepStartedAt?: number; detail?: string;
};

/** 通知（最大 3 件）。エラー以外は数秒で消える */
export function useNotices() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setNotices((n) => n.filter((x) => x.id !== id)), []);
  const notify = useCallback((n: Omit<Notice, "id">) => {
    const id = ++seq.current;
    setNotices((list) => [...list.slice(-2), { ...n, id }]);
    if (n.kind !== "error") setTimeout(() => dismiss(id), n.action ? 8000 : 3500);
  }, [dismiss]);
  return { notices, notify, dismiss };
}

export function Toasts({ busy, notices, onDismiss }: { busy: Busy | null; notices: Notice[]; onDismiss: (id: number) => void }) {
  // 処理中は経過秒数を表示するため 1 秒ごとに再描画
  const [, tick] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);
  const elapsed = busy ? Math.floor((Date.now() - busy.startedAt) / 1000) : 0;
  const stepElapsed = busy?.stepStartedAt ? Math.floor((Date.now() - busy.stepStartedAt) / 1000) : undefined;

  return (
    <div className="toasts" aria-live="polite">
      {busy && (
        <div className="toast">
          <span className="spinner" />
          <span className="busy-text">
            <span>{busy.step && `${busy.step[0]}/${busy.step[1]} `}{busy.label}{busy.progress ? `（${busy.progress[0]} / ${busy.progress[1]}）` : "…"}</span>
            {busy.detail && <span className="busy-detail">{busy.detail}</span>}
          </span>
          {elapsed >= 2 && (
            <span className="elapsed">{stepElapsed !== undefined && stepElapsed !== elapsed ? `${stepElapsed}秒（合計 ${elapsed}秒）` : `${elapsed}秒`}</span>
          )}
          {busy.abort && <button className="toast-btn" onClick={() => busy.abort!.abort()}>キャンセル</button>}
          {busy.progress && <span className="bar" style={{ width: `${(busy.progress[0] / busy.progress[1]) * 100}%` }} />}
        </div>
      )}
      {notices.map((n) => (
        <div key={n.id} className={`toast ${n.kind}`} role={n.kind === "error" ? "alert" : "status"}>
          {n.kind === "error" ? <Ico name="alert" /> : n.kind === "success" ? <Ico name="check" /> : null}<span>{n.text}</span>
          {n.action && <button className="toast-btn" onClick={() => { n.action!.run(); onDismiss(n.id); }}>{n.action.label}</button>}
          <button className="toast-x" aria-label="閉じる" onClick={() => onDismiss(n.id)}><Ico name="x" size={14} /></button>
        </div>
      ))}
    </div>
  );
}
