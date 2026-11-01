import { useCallback, useEffect, useState } from "react";
import type { DesktopBridge } from "../../desktop/bridge";
import { api, type Status } from "./api";
import { codexSetup, describeCodexJob, useCodexSetup } from "./codexSetup";
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

const DESKTOP_IMAGE_LABELS: Record<string, string> = { gemini: "Gemini（API キー）", comfyui: "ComfyUI（この PC）", codex: "ChatGPT（Codex CLI）", placeholder: "仮の画像" };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const CODEX_SOURCE_LABELS: Record<string, string> = { app: "このアプリで入れた版", "codex-app": "Codex アプリの CLI", npm: "npm で入れた CLI", path: "PATH の CLI", configured: "指定した場所" };

/** Codex CLI の状態の文言 */
export function describeCodex(codex: Status["codex"]): string {
  if (!codex) return "確認中…";
  const where = codex.source ? CODEX_SOURCE_LABELS[codex.source] : codex.path;
  if (codex.state === "ready") return `使えます${where ? `（${where}）` : ""}`;
  if (codex.state === "signed_out") return `サインインしていません${where ? `（${where}）` : ""}`;
  return "Codex CLI が見つかりません";
}

/** Codex CLI の欄：状態と、入れる・サインインのボタン、進み具合（吹き出しを閉じても続く） */
export function CodexSetupRows({ codex, onStatusChanged }: { codex: Status["codex"]; onStatusChanged?: () => void }) {
  const { job, error } = useCodexSetup(onStatusChanged);
  const p = job?.progress;
  return (
    <>
      <div className="status-row">
        <span className="status-label">Codex</span>
        <span className="status-val"><span className={"dot " + (codex?.state === "ready" ? "ok" : "warn")} aria-hidden />{describeCodex(codex)}</span>
      </div>
      {job ? (
        <div className="codex-setup" role="status" aria-live="polite">
          {job.kind === "install"
            ? <progress className="codex-setup-progress" aria-label="Codex CLI を入れる進み具合" max={p?.step === "download" && p.total ? p.total : undefined} value={p?.step === "download" && p.total ? p.done ?? 0 : undefined} />
            : <span className="spinner" aria-hidden />}
          <p className="hint">{describeCodexJob(job)}</p>
          {job.kind === "login" && p?.url && <p className="hint"><a href={p.url} target="_blank" rel="noreferrer">ブラウザが開かないときはこちら</a></p>}
          <div className="row end"><button className="small" onClick={codexSetup.cancel}>中止</button></div>
        </div>
      ) : codex?.state === "not_found" ? (
        codex.canInstall ? <>
          <p className="hint">公式の GitHub から Codex CLI {codex.installVersion}（約 120MB）を取ってきて、このアプリ専用の場所に入れます。入れたあと、ブラウザで ChatGPT にサインインします。</p>
          <div className="row end"><button className="small primary" onClick={codexSetup.install}>Codex CLI を入れる</button></div>
        </> : <p className="hint">Codex CLI を入れて、下の「場所」に codex.exe を指定してください。</p>
      ) : codex?.state === "signed_out" ? <>
        <p className="hint">ChatGPT のプラン（Plus / Pro など）の枠で画像を作ります。ブラウザで ChatGPT にサインインしてください。</p>
        <div className="row end"><button className="small primary" onClick={codexSetup.login}>Codex にサインイン</button></div>
      </> : null}
      {error && <p className="hint" role="alert">{error}</p>}
    </>
  );
}

/** 製品版の「画像生成」欄（選択・Gemini の API キー・ComfyUI の URL・Codex CLI）。キーは画面に読み戻さない */
export function DesktopImageSettings({ bridge, status, imageChoices, imageProvider, onImageProvider, onStatusChanged }: {
  bridge: DesktopBridge;
  status: Status | null;
  imageChoices: string[];
  imageProvider: string | undefined;
  onImageProvider: (p: string) => void;
  onStatusChanged?: () => void;
}) {
  const [hasKey, setHasKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [keyError, setKeyError] = useState("");
  const [comfy, setComfy] = useState(status?.imageSettings?.comfyuiUrl ?? "");
  const [codexPath, setCodexPath] = useState(status?.imageSettings?.codexPath ?? "");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const loadKey = useCallback(() => {
    bridge.secrets.status().then((r) => {
      const list = r?.ok && Array.isArray(r.data) ? (r.data as { secretRef?: string; state?: string }[]) : [];
      setHasKey(list.some((e) => e.secretRef === "gemini/apiKey" && e.state === "configured"));
    }).catch(() => setHasKey(false));
  }, [bridge]);
  useEffect(loadKey, [loadKey]);
  // 保存済みの設定が届いたら入力欄に反映する
  const savedComfy = status?.imageSettings?.comfyuiUrl;
  const savedCodex = status?.imageSettings?.codexPath;
  useEffect(() => { if (savedComfy !== undefined) setComfy(savedComfy); }, [savedComfy]);
  useEffect(() => { if (savedCodex !== undefined) setCodexPath(savedCodex); }, [savedCodex]);

  const afterKeyChange = () => { loadKey(); onStatusChanged?.(); };
  const saveKey = async () => {
    const value = keyInput.trim();
    if (!value) return;
    setKeyError("");
    try {
      const r = await bridge.secrets.set("gemini", "apiKey", value);
      if (!r.ok) setKeyError(`キーを保存できませんでした（${r.error ?? "不明なエラー"}）`);
      else setKeyInput("");
    } catch { setKeyError("キーを保存できませんでした"); }
    afterKeyChange();
  };
  const removeKey = async () => {
    setKeyError("");
    try {
      const r = await bridge.secrets.remove("gemini/apiKey");
      if (!r.ok) setKeyError(`キーを消せませんでした（${r.error ?? "不明なエラー"}）`);
    } catch { setKeyError("キーを消せませんでした"); }
    afterKeyChange();
  };
  const saveSettings = async () => {
    setSaveError(""); setSaving(true);
    try {
      await api.setImageSettings({ comfyuiUrl: comfy.trim(), codexPath: codexPath.trim() });
      onStatusChanged?.();
    } catch (e) { setSaveError(errText(e)); }
    setSaving(false);
  };
  const choices = imageChoices.length ? imageChoices : ["placeholder"];
  return (
    <>
      <div className="status-row">
        <span className="status-label">画像生成</span>
        <span className="status-val">
          <select aria-label="画像生成プロバイダ" value={imageProvider ?? "placeholder"} onChange={(e) => onImageProvider(e.target.value)}>
            {choices.map((p) => <option key={p} value={p}>{DESKTOP_IMAGE_LABELS[p] ?? p}</option>)}
          </select>
        </span>
      </div>
      <p className="hint">Gemini・ComfyUI は透過非対応（白背景で生成）</p>
      <div className="status-row">
        <span className="status-label">Gemini</span>
        <span className="status-val"><span className={"dot " + (hasKey ? "ok" : "warn")} aria-hidden />{hasKey ? "API キーを保存済み" : "API キー未設定"}</span>
      </div>
      <div className="row">
        <input type="password" aria-label="Gemini の API キー" autoComplete="off" spellCheck={false} placeholder={hasKey ? "新しいキーで置き換える" : "API キーを貼り付け"} value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
        <button className="small" disabled={!keyInput.trim()} onClick={saveKey}>キーを保存</button>
        {hasKey && <button className="small" onClick={removeKey}>キーを消す</button>}
      </div>
      {keyError && <p className="hint" role="alert">{keyError}</p>}
      <div className="status-row">
        <span className="status-label">ComfyUI</span>
        <span className="status-val"><input type="text" aria-label="ComfyUI の URL" spellCheck={false} placeholder="http://127.0.0.1:8188" value={comfy} onChange={(e) => setComfy(e.target.value)} /></span>
      </div>
      <p className="hint">この PC で動いている ComfyUI だけ使えます。空なら既定（http://127.0.0.1:8188）。</p>
      <CodexSetupRows codex={status?.codex} onStatusChanged={onStatusChanged} />
      <div className="status-row">
        <span className="status-label">場所</span>
        <span className="status-val"><input type="text" aria-label="codex.exe の場所" spellCheck={false} placeholder="空なら自動検出（codex.exe の絶対パス）" value={codexPath} onChange={(e) => setCodexPath(e.target.value)} /></span>
      </div>
      <div className="row end"><button className="small" disabled={saving} onClick={saveSettings}>ComfyUI・Codex の設定を保存</button></div>
      {saveError && <p className="hint" role="alert">{saveError}</p>}
    </>
  );
}

/** 製品版の左下: ChatGPT アカウント（EXE-SCR-004）。AI の選択・モデルは製品版では出さない。画像生成の設定は出す */
export function DesktopAccountBar({ bridge, status, onSignOut, imageChoices = [], imageProvider, onImageProvider, onStatusChanged }: {
  bridge: DesktopBridge;
  status: Status | null;
  onSignOut: () => void;
  imageChoices?: string[];
  imageProvider?: string;
  onImageProvider?: (p: string) => void;
  onStatusChanged?: () => void;
}) {
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
              {status && onImageProvider && <>
                <DesktopImageSettings bridge={bridge} status={status} imageChoices={imageChoices} imageProvider={imageProvider} onImageProvider={onImageProvider} onStatusChanged={onStatusChanged} />
                <div className="divider" />
              </>}
              <p className="hint">AI 機能（レイアウト生成・修正）には、連携した ChatGPT のプラン枠を使います。</p>
            </div>
          </div>
        )}
      </Menu>
    </div>
  );
}
