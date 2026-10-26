import { useCallback, useEffect, useState } from "react";
import type { DesktopBridge } from "../../desktop/bridge";
import type { Status } from "./api";
import { DESKTOP_ACCOUNT_CHANGED, deriveDesktopAccountView, describeDesktopAccount, isChatGPTReauthRequired, signInOutcome } from "./accountView";
import { Menu } from "./ui";
import { Ico } from "./uiIcons";

/** 製品版の左下: ChatGPT アカウント（EXE-SCR-004）。AI の選択・モデル・画像生成は製品版では出さない */
export function DesktopAccountBar({ bridge, status, onSignOut }: { bridge: DesktopBridge; status: Status | null; onSignOut: () => void }) {
  const [reauth, setReauth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "info" | "error"; text: string } | null>(null);
  const checkReauth = useCallback(() => {
    bridge.secrets.status().then((r) => setReauth(isChatGPTReauthRequired(r))).catch(() => setReauth(false));
  }, [bridge]);
  // 状態が変わるたび（サインイン・ログアウト後の更新）に資格情報の状態も見直す
  useEffect(checkReauth, [checkReauth, status]);

  const signIn = async (newAccount: boolean) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const outcome = signInOutcome(await bridge.auth.signIn({ newAccount }));
      setMessage(outcome);
    } catch {
      setMessage({ tone: "error", text: "ChatGPT でサインインできませんでした" });
    } finally {
      setBusy(false);
      window.dispatchEvent(new Event(DESKTOP_ACCOUNT_CHANGED));
      checkReauth();
    }
  };

  const view = deriveDesktopAccountView(status, reauth);
  const signedIn = view.kind === "signedIn" || view.kind === "noPlan";
  return (
    <div className="left-foot desktop-account">
      <Menu className="up settings-menu" fixed trigger={({ open, toggle }) => (
        <button className="account" aria-haspopup="dialog" aria-expanded={open} onClick={toggle} title="ChatGPT アカウント">
          <span className="account-pic"><span className="avatar">{(("email" in view && view.email) || "C").slice(0, 1).toUpperCase()}</span></span>
          <span className="account-name">{signedIn && "email" in view && view.email ? view.email : "ChatGPT アカウント"}</span>
          {view.kind !== "signedIn" && view.kind !== "loading" && <span className="dot warn tab-badge" aria-hidden />}
        </button>
      )}>
        {(close) => (
          <div className="settings-pop" role="dialog" aria-label="ChatGPT アカウント">
            <div className="settings-pop-head">
              <h3><Ico name="settings" /> ChatGPT アカウント</h3>
              <button className="icon-btn" aria-label="閉じる" onClick={close}><Ico name="x" /></button>
            </div>
            <div className="status-card">
              <div className="status-row">
                <span className="status-label">状態</span>
                <span className="status-val"><span className={"dot " + (view.kind === "signedIn" ? "ok" : "warn")} aria-hidden />{describeDesktopAccount(view)}</span>
              </div>
              {"email" in view && view.email && <div className="status-row"><span className="status-label">メール</span><span className="status-val">{view.email}</span></div>}
              {view.kind === "signedOut" && view.previousEmail && <p className="hint">前回のアカウント: {view.previousEmail}</p>}
              {busy && <p className="hint" role="status">ブラウザでサインインを続けてください</p>}
              {!busy && message && <p className={"hint " + message.tone} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p>}
              <div className="row end">
                {signedIn && <button disabled={busy} onClick={() => { close(); onSignOut(); }}>ログアウト</button>}
                <button disabled={busy} onClick={() => void signIn(true)}>別のアカウントでサインイン</button>
                {!(view.kind === "signedIn") && <button className="primary" disabled={busy} onClick={() => void signIn(false)}>サインイン</button>}
              </div>
              <div className="divider" />
              <p className="hint">AI 機能（レイアウト生成・修正）は今後の更新で使えるようになります。</p>
            </div>
          </div>
        )}
      </Menu>
    </div>
  );
}
