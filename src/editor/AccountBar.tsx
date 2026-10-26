import { api, type AIProvider, type Status } from "./api";
import { DesktopAccountBar } from "./DesktopAccount";
import { desktopBridge } from "./desktop";
import { Menu } from "./ui";
import { Ico } from "./uiIcons";

const IMAGE_PROVIDER_LABELS: Record<string, string> = { openai: "OpenAI (gpt-image)", gemini: "Gemini", comfyui: "ComfyUI（ローカル）", codex: "Codex CLI（ChatGPT枠）" };
const AI_PROVIDER_LABELS: Record<AIProvider, string> = { chatgpt: "ChatGPT プラン", openrouter: "OpenRouter" };

/** 左下: ChatGPT のアカウント（サインイン）と AI の設定 */
/** レイアウト生成・AI 修正に使うモデルの選択（"" は自動）。選んだモデルが一覧から消えていても、そのまま表示する */
export function ModelSelect({ label, models, choice, autoModel, onChange, disabled, className }: {
  label: string;
  models: { slug: string; display_name: string }[];
  choice: string;
  autoModel?: string;
  onChange: (slug: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const name = (slug: string) => models.find((m) => m.slug === slug)?.display_name ?? slug;
  return (
    <select className={className} aria-label={label} title="レイアウト生成・AI 修正に使うモデル" value={choice} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">自動{autoModel ? `（${name(autoModel)}）` : ""}</option>
      {choice && !models.some((m) => m.slug === choice) && <option value={choice}>{choice}</option>}
      {models.map((m) => <option key={m.slug} value={m.slug}>{m.display_name}</option>)}
    </select>
  );
}

export function AccountBar({ status, imageChoices, imageProvider, onImageProvider, autoImages, onAutoImages, onChatGPTModel, onOpenRouterModel, onAIProvider, onSignOut }: {
  status: Status | null;
  imageChoices: string[];
  imageProvider: string | undefined;
  onImageProvider: (p: string) => void;
  autoImages: boolean;
  onAutoImages: (on: boolean) => void;
  onChatGPTModel: (model: string) => void;
  onOpenRouterModel: (model: string) => void;
  onAIProvider: (provider: AIProvider | "") => void;
  onSignOut: () => void;
}) {
  // 製品版はサインイン状態だけを扱う別の表示（開発版の表示は下のまま）
  const bridge = desktopBridge();
  if (bridge) return <DesktopAccountBar bridge={bridge} status={status} onSignOut={onSignOut} />;
  const gpt = status?.chatgpt;
  const ready = !!(gpt?.signedIn && gpt.planEnabled);
  const ai = status?.ai;
  // OpenRouter のキーが無く、選んでもいなければ（画面でも .env でも）ChatGPT だけなので、AI の切り替えは出さない
  const showOpenRouter = !!(ai?.openrouter || ai?.explicit === "openrouter");
  /** OpenRouter のキーはあるが一覧が取れない（キーが無効など） */
  const orError = ai?.openrouter?.modelsError;
  const previousEmail = gpt && !gpt.signedIn ? gpt.previousEmail : undefined;
  return (
    <div className="left-foot">
      {gpt?.signedIn ? (
        <Menu className="up" fixed trigger={({ open, toggle }) => (
          <button className="account" aria-haspopup="menu" aria-expanded={open} onClick={toggle} title={gpt.email}>
            <span className="account-pic">{gpt.picture ? <img src={gpt.picture} alt="" referrerPolicy="no-referrer" /> : <span className="avatar">{(gpt.name || gpt.email || "?").slice(0, 1).toUpperCase()}</span>}</span>
            <span className="account-name">{gpt.name || gpt.email || "ChatGPT"}</span>
          </button>
        )}>
          {(close) => (
            <div className="menu-list" role="menu">
              <div className="account-info">
                <strong>{gpt.name || "ChatGPT アカウント"}</strong>
                {gpt.email && <small>{gpt.email}</small>}
                <small>{gpt.planEnabled ? "ChatGPT プランを利用できます" : "ChatGPT プランの利用は未許可"}</small>
              </div>
              {!gpt.planEnabled && <button role="menuitem" onClick={api.chatgptLogin}>ChatGPT プランの利用を許可…</button>}
              <a role="menuitem" className="as-button" href={gpt.usageUrl} target="_blank" rel="noopener noreferrer">使用状況を管理 ↗</a>
              <button role="menuitem" onClick={() => { close(); api.chatgptLoginNewAccount(); }}>別のアカウントでログイン…</button>
              <div className="menu-sep" />
              <button role="menuitem" onClick={() => { close(); onSignOut(); }}>サインアウト</button>
            </div>
          )}
        </Menu>
      ) : status && <>
        <button className="chatgpt-btn" onClick={api.chatgptLogin} title={previousEmail ? `前回のアカウント（${previousEmail}）でサインインします` : "ChatGPT アカウントでサインインし、ChatGPT プランでレイアウトを生成します"}>
          ChatGPTでログイン
        </button>
        {previousEmail && <button className="link" onClick={api.chatgptLoginNewAccount} title="別の ChatGPT アカウント・ワークスペースでサインインします">別のアカウント</button>}
      </>}
      <Menu className="settings-menu" trigger={({ open, toggle }) => (
        <button className={"icon-btn" + (open ? " on" : "")} aria-haspopup="dialog" aria-expanded={open} onClick={toggle} title="AI の設定（ChatGPT・画像生成）" aria-label="AI の設定">
          <Ico name="settings" />{status && !ai?.provider && <span className="dot warn tab-badge" aria-hidden />}
        </button>
      )}>
        {(close) => (
          <div className="settings-pop" role="dialog" aria-label="AI の設定">
            <div className="settings-pop-head">
              <h3><Ico name="settings" /> AI の設定</h3>
              <button className="icon-btn" aria-label="閉じる" onClick={close}><Ico name="x" /></button>
            </div>
            <div className="status-card">
              {status && <>
                {ai && showOpenRouter && (
                  <div className="status-row">
                    <span className="status-label">AI</span>
                    <span className="status-val">
                      <select aria-label="レイアウト生成・AI 修正に使う AI" title="レイアウト生成・AI 修正・フォント提案に使う AI" value={ai.choice} onChange={(e) => onAIProvider(e.target.value as AIProvider | "")}>
                        <option value="">自動{ai.autoProvider ? `（${AI_PROVIDER_LABELS[ai.autoProvider]}）` : ""}</option>
                        {(Object.keys(AI_PROVIDER_LABELS) as AIProvider[]).map((p) => <option key={p} value={p}>{AI_PROVIDER_LABELS[p]}</option>)}
                      </select>
                    </span>
                  </div>
                )}
                <div className="status-row">
                  <span className="status-label">ChatGPT</span>
                  <span className="status-val">
                    <span className={"dot " + (ready ? "ok" : "warn")} aria-hidden />
                    {ready && gpt?.signedIn
                      ? <>プランを使用中 <a href={gpt.usageUrl} target="_blank" rel="noopener noreferrer">使用状況 ↗</a></>
                      : gpt?.signedIn
                        ? "このアカウントではプランを利用できません"
                        : "未サインイン（左下からサインイン）"}
                  </span>
                </div>
                {ready && gpt?.signedIn && gpt.models?.length ? (
                  <div className="status-row">
                    <span className="status-label">モデル</span>
                    <span className="status-val">
                      <ModelSelect label="ChatGPT のモデル" models={gpt.models} choice={gpt.modelChoice ?? ""} autoModel={gpt.autoModel} onChange={onChatGPTModel} />
                    </span>
                  </div>
                ) : ready && gpt?.signedIn && gpt.model && (
                  <div className="status-row">
                    <span className="status-label">モデル</span>
                    <span className="status-val">{gpt.model}</span>
                  </div>
                )}
                {ai && showOpenRouter && (
                  <div className="status-row">
                    <span className="status-label">OpenRouter</span>
                    <span className="status-val">
                      <span className={"dot " + (ai.openrouter && !orError ? "ok" : "warn")} aria-hidden />
                      {!ai.openrouter ? "API キー未設定（.env の OPENROUTER_API_KEY）" : orError ? <span title={orError}>API キーを確認してください（モデル一覧を取得できません）</span> : "API キーを設定済み"}
                    </span>
                  </div>
                )}
                {ai?.openrouter && (
                  <div className="status-row">
                    <span className="status-label">モデル</span>
                    <span className="status-val">
                      {ai.openrouter.models?.length
                        ? <ModelSelect label="OpenRouter のモデル" models={ai.openrouter.models} choice={ai.openrouter.modelChoice} autoModel={ai.openrouter.autoModel} onChange={onOpenRouterModel} />
                        : ai.openrouter.model}
                    </span>
                  </div>
                )}
                <div className="status-row">
                  <span className="status-label">画像生成</span>
                  <span className="status-val">
                    <select aria-label="画像生成プロバイダ" value={imageProvider} onChange={(e) => onImageProvider(e.target.value)}>
                      {imageChoices.map((p) => <option key={p} value={p}>{IMAGE_PROVIDER_LABELS[p] ?? p}</option>)}
                    </select>
                  </span>
                </div>
                {(imageProvider === "gemini" || imageProvider === "comfyui") && <p className="hint">※ {IMAGE_PROVIDER_LABELS[imageProvider]} は透過非対応。透過画像は OpenAI キーがあれば OpenAI で生成</p>}
                <div className="divider" />
              </>}
              <label className="check" title="ChatGPT がレイアウトを作ったり修正したりしたあと、未生成の画像をポスターの画風・配色に合わせてそのまま生成します">
                <input type="checkbox" checked={autoImages} onChange={(e) => onAutoImages(e.target.checked)} /> AI のレイアウト生成・修正のあと画像も自動で生成
              </label>
            </div>
          </div>
        )}
      </Menu>
    </div>
  );
}

/** 初回サインイン時の「ChatGPT プランを使用しています」の案内 */
export function WelcomeModal({ status, onClose }: { status: Status | null; onClose: () => void }) {
  const provider = status?.imageProvider;
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
        <h2 id="welcome-title">ChatGPT プランを使用しています</h2>
        <p>このアプリでのレイアウト生成・AI 修正には、あなたの ChatGPT プランが使われます。使用量は ChatGPT の設定で管理できます。</p>
        <p className="hint small">
          {provider === "codex"
            ? "画像生成は Codex CLI（ChatGPT ログイン）経由で、同じく ChatGPT プランの枠を使います。"
            : provider === "openai" || provider === "gemini"
              ? "画像生成は ChatGPT プランの対象外のため、.env の API キー（OpenAI / Gemini）を使います。"
              : "画像生成は ChatGPT プランの対象外です（API キーは使いません）。"}
        </p>
        <div className="row end">
          {status && <a className="as-button" href={status.chatgpt.usageUrl} target="_blank" rel="noopener noreferrer">使用状況を管理</a>}
          <button className="primary" autoFocus onClick={onClose}>OK</button>
        </div>
      </div>
    </div>
  );
}
