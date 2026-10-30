import { useCallback, useEffect, useState } from "react";
import type { DesktopBridge } from "../../desktop/bridge";
import type { Status } from "./api";
import { DESKTOP_ACCOUNT_CHANGED, DESKTOP_SIGN_IN_STARTED, deriveDesktopAccountView, describeDesktopAccount, isChatGPTReauthRequired, isDesktopSigningIn, runDesktopSignIn } from "./accountView";
import { Menu } from "./ui";
import { Ico } from "./uiIcons";

/** ブラウザでのサインインを待っているあいだ true（どの画面から始めたサインインでも） */
export function useDesktopSigningIn(): boolean {
  const [busy, setBusy] = useState(isDesktopSigningIn);
  useEffect(() => {
    const sync = () => setBusy(isDesktopSigningIn());
    window.addEventListener(DESKTOP_SIGN_IN_STARTED, sync);
    window.addEventListener(DESKTOP_ACCOUNT_CHANGED, sync);
    return () => { window.removeEventListener(DESKTOP_SIGN_IN_STARTED, sync); window.removeEventListener(DESKTOP_ACCOUNT_CHANGED, sync); };
  }, []);
  return busy;
}

/** サインインの待ち中の案内と、取り消し・ブラウザの開き直し */
export function SignInWaiting({ bridge }: { bridge: DesktopBridge }) {
  return (
    <div role="status">
      <p className="hint">ブラウザでサインインを続けてください。終わると自動で DC-Designer に戻ります。</p>
      <div className="row end">
        <button className="small" onClick={() => bridge.auth.reopen()} title="認可画面を閉じてしまったときに、もう一度開きます">ブラウザをもう一度開く</button>
        <button className="small" onClick={() => bridge.auth.cancel()}>取り消す</button>
      </div>
    </div>
  );
}

/** 製品版の左下: ChatGPT アカウント（EXE-SCR-004）。AI の選択・モデル・画像生成は製品版では出さない */
export function DesktopAccountBar({ bridge, status, onSignOut }: { bridge: DesktopBridge; status: Status | null; onSignOut: () => void }) {
  const [reauth, setReauth] = useState(false);
  const busy = useDesktopSigningIn();
  const checkReauth = useCallback(() => {
    bridge.secrets.status().then((r) => setReauth(isChatGPTReauthRequired(r))).catch(() => setReauth(false));
  }, [bridge]);
  // 状態が変わるたび（サインイン・ログアウト後の更新）に資格情報の状態も見直す
  useEffect(checkReauth, [checkReauth, status]);

  // 結果はトーストで知らせる（useChatGPTAuth）。ここでは資格情報の状態だけ見直す
  const signIn = (newAccount: boolean) => { if (!busy) void runDesktopSignIn(bridge, newAccount).then(checkReauth); };

  const view = deriveDesktopAccountView(status, reauth);
  const signedIn = view.kind === "signedIn" || view.kind === "noPlan";
  return (
    <div className="left-foot desktop-account">
      <Menu className="up settings-menu" fixed trigger={({ open, toggle }) => (
        <button className="account" aria-haspopup="dialog" aria-expanded={open} onClick={toggle} title="ChatGPT アカウント">
          <span className="account-pic"><span className="avatar">{(("email" in view && view.email) || "C").slice(0, 1).toUpperCase()}</span></span>
          <span className="account-name">{busy ? "サインイン中…" : signedIn && "email" in view && view.email ? view.email : "ChatGPT アカウント"}</span>
          {!busy && view.kind !== "signedIn" && view.kind !== "loading" && <span className="dot warn tab-badge" aria-hidden />}
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
              {view.kind !== "signedIn" && <p className="hint">この連携には ChatGPT Plus / Pro などの対象プランが必要です。無料プランは非対応です。手動編集・保存・書き出しはサインインせずに使えます。</p>}
              {view.kind === "signedOut" && view.previousEmail && <p className="hint">前回のアカウント: {view.previousEmail}</p>}
              {busy ? <SignInWaiting bridge={bridge} /> : (
                <div className="row end">
                  {signedIn && <button onClick={() => { close(); onSignOut(); }}>ログアウト</button>}
                  <button onClick={() => signIn(true)}>別のアカウントでサインイン</button>
                  {!(view.kind === "signedIn") && <button className="primary" onClick={() => signIn(false)}>サインイン</button>}
                </div>
              )}
              <div className="divider" />
              <p className="hint">AI 機能（レイアウト生成・修正）には、連携した ChatGPT のプラン枠を使います。</p>
            </div>
          </div>
        )}
      </Menu>
    </div>
  );
}
