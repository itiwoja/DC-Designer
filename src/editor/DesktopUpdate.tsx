import { useEffect, useRef, useState } from "react";
import type { UpdatePromptAction, UpdateSnapshot } from "../../desktop/bridge";
import { desktopBridge } from "./desktop";

const RELEASES_URL = "https://github.com/itiwoja/DC-Designer/releases";

const formatMB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * 製品版の更新案内（SCR-001〜003）。表示待ちの案内は main が持ち、ここは表示と操作だけ。
 * 初期フォーカスは「あとで」側に置き、Enter だけで不意に更新・再起動しない。Esc は保留
 */
export function DesktopUpdate() {
  const bridge = desktopBridge();
  const [snap, setSnap] = useState<UpdateSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const laterRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    const off = bridge.update.onStateChanged((s) => alive && setSnap(s));
    bridge.update.getState().then((s) => alive && setSnap((cur) => cur ?? s)).catch(() => {});
    return () => { alive = false; off(); };
  }, [bridge]);

  const prompt = snap?.prompt;
  useEffect(() => { if (prompt) laterRef.current?.focus(); }, [prompt?.id]);

  const respond = (action: UpdatePromptAction) => {
    if (!bridge || !prompt) return;
    bridge.update.respond(prompt.id, action).then(setSnap).catch(() => {});
  };

  useEffect(() => {
    if (!prompt || prompt.kind === "restarting") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      respond(prompt.kind === "progress" ? "background" : "later");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (!bridge || !snap || !prompt) return null;
  const version = snap.latestVersion ?? "";
  const run = async (fn: () => Promise<UpdateSnapshot>) => {
    setBusy(true);
    try { setSnap(await fn()); } catch { /* 状態通知で更新される */ } finally { setBusy(false); }
  };

  let title = "";
  let body: React.ReactNode = null;
  let actions: React.ReactNode = null;
  switch (prompt.kind) {
    case "available":
      title = "新しいバージョンがあります";
      body = <>
        <p>現在 {snap.currentVersion} → 最新 {version}</p>
        {snap.releaseNotes && <pre className="desktop-update-notes">{snap.releaseNotes}</pre>}
        <p className="desktop-update-hint">ダウンロード後も、再起動するまで作業を続けられます。 <a href={`${RELEASES_URL}/tag/v${encodeURIComponent(version)}`} target="_blank" rel="noreferrer">更新内容の詳細</a></p>
      </>;
      actions = <>
        <button ref={laterRef} onClick={() => respond("later")}>あとで</button>
        <button className="primary" disabled={busy} onClick={() => run(() => bridge.update.download(version))}>更新する</button>
      </>;
      break;
    case "progress": {
      const p = snap.progress;
      title = "更新をダウンロードしています";
      body = <>
        <progress className="desktop-update-progress" max={100} value={p && p.total > 0 ? p.percent : undefined} />
        <p className="desktop-update-hint">{p && p.total > 0 ? `${Math.floor(p.percent)}%（${formatMB(p.transferred)} / ${formatMB(p.total)}）` : "準備しています…"}</p>
      </>;
      actions = <button ref={laterRef} onClick={() => respond("background")}>バックグラウンドで続ける</button>;
      break;
    }
    case "downloaded":
      title = "更新の準備ができました";
      body = <p>作業を保存してアプリを再起動し、{version} に更新します。</p>;
      actions = <>
        <button ref={laterRef} onClick={() => respond("later")}>あとで</button>
        <button className="primary" disabled={busy} onClick={() => run(() => bridge.update.install(version))}>保存して再起動</button>
      </>;
      break;
    case "restarting":
      title = "保存を確認しています";
      body = <p>保存が終わったら、アプリを再起動して更新します。</p>;
      break;
    case "upToDate":
      title = "最新のバージョンです";
      body = <p>DC-Designer {snap.currentVersion} は最新です。</p>;
      actions = <button ref={laterRef} onClick={() => respond("close")}>閉じる</button>;
      break;
    case "error":
      title = snap.error?.stage === "download" ? "更新を取得できませんでした" : "更新を確認できませんでした";
      body = <p>{snap.error?.message}</p>;
      actions = <>
        <button ref={laterRef} onClick={() => respond("close")}>閉じる</button>
        {snap.error?.stage === "download" && snap.state === "available" &&
          <button className="primary" disabled={busy} onClick={() => run(() => bridge.update.download(version))}>再試行</button>}
      </>;
      break;
  }

  return (
    <div className="modal-backdrop desktop-update">
      <div className="modal confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="desktop-update-title">
        <h2 id="desktop-update-title">{title}</h2>
        {body}
        {actions && <div className="row end">{actions}</div>}
      </div>
    </div>
  );
}
