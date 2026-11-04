import { useCallback, useEffect, useRef, useState } from "react";
import { version as devVersion } from "../../package.json";
import { desktopBridge, useDesktopVersion } from "./desktop";
import { api } from "./api";
import { BUG_TEMPLATE, buildFeedbackUrl, detectOs, feedbackErrorView, FEEDBACK_KIND_LABELS, FEEDBACK_MAX_BODY, FEEDBACK_SELECTABLE_KINDS, isGithubUrl, remainingLabel, type FeedbackKind } from "./feedback";
import { Ico } from "./uiIcons";

type Phase = { kind: "edit" } | { kind: "sending" } | { kind: "done"; number: number; url: string } | { kind: "error"; message: string; canFallback: boolean };

/** 「要望・不具合を送る」フォーム。アプリのサーバー経由で GitHub の Issue にして、番号を見せる。送れないときはブラウザの GitHub で送る予備を出す */
export function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<FeedbackKind>("request");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [withEnv, setWithEnv] = useState(true);
  const [phase, setPhase] = useState<Phase>({ kind: "edit" });
  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  const sendingRef = useRef(false);
  const desktop = !!desktopBridge();
  const desktopVersion = useDesktopVersion();
  const sending = phase.kind === "sending";
  // 送信中なら中断してから閉じる
  const close = useCallback(() => { abortRef.current?.abort(); onClose(); }, [onClose]);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; abortRef.current?.abort(); };
  }, []);
  useEffect(() => {
    // 先に受けて止める（エディタの Esc＝選択の解除まで動かさない）
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  const pickKind = (next: FeedbackKind) => {
    // 不具合を選んだときだけ、まだ書いていなければ本文の雛形を入れる（雛形のまま種類を戻したら消す）
    if (next === "bug" && !body.trim()) setBody(BUG_TEMPLATE);
    else if (next !== "bug" && body === BUG_TEMPLATE) setBody("");
    setKind(next);
  };
  const makeEnv = () => (withEnv ? { appVersion: desktop ? desktopVersion : devVersion, desktop, os: detectOs() } : undefined);
  const send = async () => {
    if (!title.trim() || sendingRef.current) return;
    sendingRef.current = true;
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase({ kind: "sending" });
    try {
      const res = await api.sendFeedback({ kind, title, body, env: makeEnv() }, ac.signal);
      if (aliveRef.current && !ac.signal.aborted) setPhase({ kind: "done", number: res.number, url: res.url });
    } catch (e) {
      if (aliveRef.current && !ac.signal.aborted) setPhase({ kind: "error", ...feedbackErrorView(e) });
    } finally {
      sendingRef.current = false;
    }
  };
  const sendByBrowser = () => {
    if (!title.trim()) return;
    window.open(buildFeedbackUrl({ kind, title, body, env: makeEnv() }), "_blank", "noopener,noreferrer");
    onClose();
  };
  const remaining = remainingLabel(body.length);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
        <h2 id="feedback-title">要望・不具合を送る</h2>
        {phase.kind === "done" ? (
          <>
            <p className="feedback-done" role="status">#{phase.number} として送りました。ありがとうございます。</p>
            <div className="row end">
              {isGithubUrl(phase.url) && <button onClick={() => window.open(phase.url, "_blank", "noopener,noreferrer")}>GitHub で見る</button>}
              <button className="primary" autoFocus onClick={onClose}>閉じる</button>
            </div>
          </>
        ) : (
          <>
            <div className="feedback-kinds" role="radiogroup" aria-label="種類">
              {FEEDBACK_SELECTABLE_KINDS.map((k, i) => (
                <label key={k}><input type="radio" name="feedback-kind" checked={kind === k} autoFocus={i === 0} disabled={sending} onChange={() => pickKind(k)} /> {FEEDBACK_KIND_LABELS[k]}</label>
              ))}
            </div>
            <label className="feedback-field">件名（必須）
              <input type="text" value={title} maxLength={150} disabled={sending} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="feedback-field">内容
              <textarea rows={8} value={body} maxLength={FEEDBACK_MAX_BODY} disabled={sending} onChange={(e) => setBody(e.target.value)} />
            </label>
            {remaining && <p className="feedback-count small">{remaining}</p>}
            <label className="feedback-check"><input type="checkbox" checked={withEnv} disabled={sending} onChange={(e) => setWithEnv(e.target.checked)} /> アプリの版と OS を添える</label>
            {phase.kind === "error" && (
              <div className="feedback-error" role="alert">
                <p>{phase.message}</p>
                {phase.canFallback && (
                  <>
                    <p>代わりにブラウザの GitHub で送れます。GitHub のアカウントが要ります。</p>
                    <button disabled={!title.trim()} onClick={sendByBrowser}>ブラウザの GitHub で送る</button>
                  </>
                )}
              </div>
            )}
            <p className="hint small">GitHub のアカウントは要りません。送った内容は GitHub の Issue として公開されます。個人情報や作品の内容は書かないでください。</p>
            <div className="row end">
              <button onClick={close}>キャンセル</button>
              <button className="primary" disabled={!title.trim() || sending} onClick={send}>{sending ? "送っています…" : "送る"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 左下の帯に置く「要望を送る」ボタン */
export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="icon-btn" onClick={() => setOpen(true)} title="要望・不具合を送る" aria-label="要望・不具合を送る"><Ico name="message" /></button>
      {open && <FeedbackDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/** 製品版の「ヘルプ → 要望・不具合を送る…」を受けてフォームを開く。どの画面（ホーム・ライブラリ・エディタ）でも効くよう、画面の土台に置く */
export function FeedbackMenuHost() {
  const bridge = desktopBridge();
  const [open, setOpen] = useState(false);
  useEffect(() => bridge?.feedback?.onOpen(() => setOpen(true)), [bridge]);
  return open ? <FeedbackDialog onClose={() => setOpen(false)} /> : null;
}
