import { useEffect, useState } from "react";
import { version as devVersion } from "../../package.json";
import { desktopBridge, useDesktopVersion } from "./desktop";
import { BUG_TEMPLATE, buildFeedbackUrl, detectOs, FEEDBACK_KIND_LABELS, type FeedbackKind } from "./feedback";
import { Ico } from "./uiIcons";

/** 「要望・不具合を送る」フォーム。送ると GitHub の新規 Issue 画面（件名・本文入り）を既定のブラウザで開く */
export function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<FeedbackKind>("request");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [withEnv, setWithEnv] = useState(true);
  const desktop = !!desktopBridge();
  const desktopVersion = useDesktopVersion();
  useEffect(() => {
    // 先に受けて止める（エディタの Esc＝選択の解除まで動かさない）
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const pickKind = (next: FeedbackKind) => {
    // 不具合を選んだときだけ、まだ書いていなければ本文の雛形を入れる（雛形のまま種類を戻したら消す）
    if (next === "bug" && !body.trim()) setBody(BUG_TEMPLATE);
    else if (next !== "bug" && body === BUG_TEMPLATE) setBody("");
    setKind(next);
  };
  const send = () => {
    if (!title.trim()) return;
    const env = withEnv ? { appVersion: desktop ? desktopVersion : devVersion, desktop, os: detectOs() } : undefined;
    const url = buildFeedbackUrl({ kind, title, body, env });
    window.open(url, "_blank", "noopener,noreferrer");
    setTitle(""); setBody("");
    onClose();
  };
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
        <h2 id="feedback-title">要望・不具合を送る</h2>
        <div className="feedback-kinds" role="radiogroup" aria-label="種類">
          {(Object.keys(FEEDBACK_KIND_LABELS) as FeedbackKind[]).map((k, i) => (
            <label key={k}><input type="radio" name="feedback-kind" checked={kind === k} autoFocus={i === 0} onChange={() => pickKind(k)} /> {FEEDBACK_KIND_LABELS[k]}</label>
          ))}
        </div>
        <label className="feedback-field">件名（必須）
          <input type="text" value={title} maxLength={150} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="feedback-field">内容
          <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <label className="feedback-check"><input type="checkbox" checked={withEnv} onChange={(e) => setWithEnv(e.target.checked)} /> アプリの版と OS を添える</label>
        <p className="hint small">GitHub の Issue 作成画面をブラウザで開きます。送るには GitHub のアカウントが必要です。書いた内容は公開されます。個人情報や作品の内容は書かないでください。</p>
        <div className="row end">
          <button onClick={onClose}>キャンセル</button>
          <button className="primary" disabled={!title.trim()} onClick={send}>GitHub で送る</button>
        </div>
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
