import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { importPptx } from "../import/pptx";
import { importPdf } from "../import/pdf";
import { PDF_FILE_ACCEPT } from "../import/pdfDocument";
import { findPendingAssets } from "../schema";
import { api, AUTH_CHANNEL, deckBySlide, type Deck, type SavedPoster, type Status, type Template } from "./api";
import type { DesktopResult } from "../../desktop/bridge";
import { DESKTOP_ACCOUNT_CHANGED, isSignInCancelled, signInOutcome } from "./accountView";
import { useDesktopSigningIn } from "./DesktopAccount";
import { codexJobLabel, codexSetup, describeCodexJob, useCodexAfterSignIn, useCodexSetup } from "./codexSetup";
import { desktopBridge, useDesktopVersion } from "./desktop";
import { BLANK_SLIDE_SPEC, BLANK_SPEC, IMPORT_NOTICE_KEY, HOME_URL, openDeckInEditor, openInEditor } from "./nav";
import { isShownDeck, MODE_KEYS, MODES, modeHomeUrl, modeLibraryUrl, modeOfDeck, readLastId, type AppMode } from "./mode";
import { ask, PosterFrame, SpecFrame, ThemeMenu, useLoadWithRetry } from "./ui";
import { PPTX_ACCEPT } from "./specOps";
import { Ico } from "./uiIcons";
import { useSignInWatch } from "./useChatGPTAuth";
import { blockPageFileDrop, homeDropLabel, pickHomeDrop } from "./fileDrop";
import { useFileDrop } from "./useFileDrop";

const RECENT_MAX = 8;

/** モードごとのアイコンの色（start-ico の修飾クラス） */
const MODE_ICO: Record<AppMode, string> = { poster: "", slides: " alt" };

/** 「3 分前」「昨日」のような相対表記。古いものは日付 */
function fmtAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "いま";
  if (m < 60) return `${m} 分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 時間前`;
  const d = Math.floor(h / 24);
  if (d === 1) return "昨日";
  if (d < 7) return `${d} 日前`;
  return new Date(iso).toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
}

type Recent =
  | { kind: "poster"; id: string; title: string; updatedAt: string; poster: SavedPoster; pending: number }
  | { kind: "deck"; id: string; title: string; updatedAt: string; deck: Deck; cover: SavedPoster | undefined; pending: number };

/** mode なし: 作るものを選ぶ画面（`/`）。mode あり: そのモードのホーム（`?mode=`） */
export function Home({ mode }: { mode?: AppMode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [posters, setPosters] = useState<SavedPoster[] | null>(null);
  const [decks, setDecks] = useState<Deck[] | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  /** 名前を変えているテンプレートの id */
  const [renamingTpl, setRenamingTpl] = useState<string | null>(null);
  const [apiError, setApiError] = useState(false);
  const [busy, setBusy] = useState<{ label: string; progress?: [number, number] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pdfInput = useRef<HTMLInputElement>(null);

  useEffect(() => { document.title = mode ? `${MODES[mode].label} - DC-Designer` : "DC-Designer"; }, [mode]);

  // API サーバーは Vite より起動が遅いので、取れるまで再試行する。サインインの結果（別タブ）が届いたら取り直す
  const load = useCallback(async () => {
    const [st, p, d] = await Promise.all([api.status(), api.posters(), api.decks()]);
    setStatus(st);
    setPosters(p.posters);
    setDecks(d.decks);
    // テンプレートが取れなくても（API が古いなど）ホームの他の部分は出す
    setTemplates((await api.templates().catch(() => ({ templates: [] as Template[] }))).templates);
    setApiError(false);
  }, []);
  const reload = useLoadWithRetry(load, () => setApiError(true));
  useEffect(() => {
    const ch = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(AUTH_CHANNEL) : null;
    ch?.addEventListener("message", reload);
    return () => ch?.close();
  }, [reload]);
  // 結果が別タブから届かなくても、サインインが済んだら取り直す
  useSignInWatch(reload);
  // 製品版：サインイン（既定のブラウザ）が終わったら取り直す。ホームにはトーストが無いので失敗はここに出す
  const signingIn = useDesktopSigningIn();
  const appVersion = useDesktopVersion();
  useEffect(() => {
    const onChanged = (e: Event) => {
      const res = (e as CustomEvent<DesktopResult | undefined>).detail;
      const outcome = res && !isSignInCancelled(res) ? signInOutcome(res) : null;
      if (outcome?.tone === "error") setError(outcome.text);
      reload();
    };
    window.addEventListener(DESKTOP_ACCOUNT_CHANGED, onChanged);
    return () => window.removeEventListener(DESKTOP_ACCOUNT_CHANGED, onChanged);
  }, [reload]);

  // ホームからサインインしたときも、画像生成用の Codex を続けて準備する（エディタのアカウント欄はここには出ない）
  useCodexAfterSignIn();
  const { job: codexJob, error: codexError } = useCodexSetup(reload);
  useEffect(() => {
    if (codexError) setError(`画像生成（Codex）の準備ができませんでした: ${codexError}`);
  }, [codexError]);

  const gpt = status?.chatgpt;

  const posterById = useMemo(() => new Map((posters ?? []).map((p) => [p.id, p])), [posters]);
  const deckOfSlide = useMemo(() => deckBySlide(decks), [decks]);

  /** そのモードの成果物だけを更新順に並べる（poster: 単体のポスター、slides: スライドのデッキ。以前の版の Instagram の投稿は出さない） */
  const recent = useMemo<Recent[]>(() => {
    if (!posters || !decks || !mode) return [];
    const items: Recent[] = [];
    if (mode === "poster") {
      for (const p of posters) {
        if (deckOfSlide.has(p.id)) continue;
        items.push({ kind: "poster", id: p.id, title: p.spec.meta.title || "無題のポスター", updatedAt: p.updatedAt, poster: p, pending: findPendingAssets(p.spec).length });
      }
    } else {
      for (const d of decks) {
        if (!isShownDeck(d) || modeOfDeck(d) !== mode) continue;
        const slides = d.slides.map((s) => posterById.get(s.id)).filter((p): p is SavedPoster => !!p);
        const updatedAt = slides.reduce((a, p) => (p.updatedAt > a ? p.updatedAt : a), d.updatedAt);
        items.push({ kind: "deck", id: d.id, title: d.name, updatedAt, deck: d, cover: slides[0], pending: slides.reduce((a, p) => a + findPendingAssets(p.spec).length, 0) });
      }
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [posters, decks, mode, posterById, deckOfSlide]);

  /** そのモードのテンプレートだけ（API は更新が新しい順で返す） */
  const modeTemplates = useMemo(() => templates.filter((t) => t.mode === mode), [templates, mode]);

  /** モード選択画面に出す、モードごとの成果物数 */
  const counts = useMemo<Record<AppMode, number> | null>(() => {
    if (!posters || !decks) return null;
    const c: Record<AppMode, number> = { poster: posters.filter((p) => !deckOfSlide.has(p.id)).length, slides: 0 };
    for (const d of decks) if (isShownDeck(d)) c[modeOfDeck(d)]++;
    return c;
  }, [posters, decks, deckOfSlide]);

  /** 「続きから編集」に出す、このモードで最後に開いていたもの（別のモードの成果物なら出さない） */
  const current = useMemo(() => {
    if (!mode || !posters) return null;
    const id = readLastId(mode);
    const p = id ? posterById.get(id) : undefined;
    if (!p) return null;
    const deck = deckOfSlide.get(p.id);
    if ((deck && !isShownDeck(deck)) || modeOfDeck(deck) !== mode) return null;
    return { poster: p, deck };
  }, [mode, posters, posterById, deckOfSlide]);

  const act = async (label: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy({ label });
    setError(null);
    try { await fn(); }
    catch (e) { setError((e as Error).message); setBusy(null); }
  };

  // ---------- 始め方 ----------
  const startBlank = () => act("白紙のポスターを用意中", async () => openInEditor(await api.createPoster(BLANK_SPEC), "poster"));
  const startBlankDeck = () => act("白紙のプロジェクトを用意中", async () => {
    const deck = await api.createDeck("無題のプレゼンテーション", [BLANK_SLIDE_SPEC]);
    openInEditor(await api.poster(deck.slides[0].id), "slides");
  });
  const openPptx = (file: File) => act(`${file.name} を読み込み中`, async () => {
    const res = await importPptx(file, file.name, {
      onImage: async (blob, mediaType) => (await api.uploadBlob(blob, mediaType)).src,
      onProgress: (done, total) => setBusy((b) => b && { ...b, progress: [done, total] }),
    });
    const deck = await api.createDeck(res.name, res.slides);
    openInEditor(await api.poster(deck.slides[0].id), "slides");
  });
  const openPdf = (file: File) => act(`${file.name} を編集用に読み込み中`, async () => {
    const res = await importPdf(file, {
      onImage: async (blob, mediaType) => (await api.uploadBlob(blob, mediaType)).src,
      onProgress: (done, total) => setBusy((b) => b && { ...b, progress: [done, total] }),
    });
    const poster = res.slides.length === 1
      ? await api.createPoster(res.slides[0])
      : await api.poster((await api.createDeck(res.name, res.slides)).slides[0].id);
    try {
      sessionStorage.setItem(IMPORT_NOTICE_KEY, res.warnings.length
        ? `PDFを読み込みました。${res.warnings.join(" ")}`
        : "PDFを読み込みました。文字・枠・罫線・画像を選択して編集できます。フォントや改行は元のPDFと異なる場合があります。");
    } catch { /* ストレージが使えなくても読み込みは続ける */ }
    openInEditor(poster, res.slides.length === 1 ? "poster" : "slides");
  });
  // ページのどこにファイルをドロップしても開ける（PDF はどのホームでも、.pptx はモード選択画面とスライドのホーム）
  const dropLabel = homeDropLabel(mode);
  const drop = useFileDrop((files) => {
    const picked = pickHomeDrop(files, mode);
    if (!picked) return;
    if ("error" in picked) { setError(picked.error); return; }
    if (picked.kind === "pdf") openPdf(picked.file);
    else openPptx(picked.file);
  }, { disabled: !dropLabel || !!busy });
  // ドロップ先の外（対応していないモードなど）に落としても、ブラウザがファイルを開いてしまわないようにする
  useEffect(blockPageFileDrop, []);
  /** ドラッグ中に全面に出す案内 */
  const dropVeil = drop.over && dropLabel && (
    <div className="drop-veil" role="status" aria-live="polite">
      <span className="drop-veil-box"><Ico name="folder" size={28} />{dropLabel}</span>
    </div>
  );
  const startFromTemplate = (t: Template) => act("テンプレートから作成中", async () => {
    const res = await api.useTemplate(t.id);
    openInEditor(res.poster, t.mode);
  });
  const removeTemplate = async (t: Template) => {
    if (busy) return;
    if (!await ask({ title: "テンプレートを削除しますか？", message: `「${t.name}」を削除します。この操作は取り消せません（このテンプレートから作った${MODES[t.mode].item}は残ります）。`, ok: "削除", danger: true })) return;
    setError(null);
    try {
      await api.deleteTemplate(t.id);
      setTemplates((await api.templates()).templates);
    } catch (e) { setError((e as Error).message); }
  };
  /** テンプレートの名前を変える（空・変わらないときは何もしない） */
  const renameTemplate = async (t: Template, name: string) => {
    setRenamingTpl(null);
    if (!name.trim() || name.trim() === t.name) return;
    setError(null);
    try {
      const u = await api.renameTemplate(t.id, name.trim());
      setTemplates((ts) => ts.map((x) => (x.id === u.id ? u : x)));
    } catch (e) { setError((e as Error).message); }
  };
  const openRecent = (r: Recent) => {
    if (r.kind === "poster") openInEditor(r.poster, "poster");
    else openDeckInEditor(r.deck, posterById);
  };

  /** サムネイル。縦横比が違っても高さをそろえるため、固定高さの枠の中に比率どおりの箱を置く */
  const thumb = (p: SavedPoster | undefined, extra?: React.ReactNode) => (
    <span className="home-thumb-wrap">
      <span className="lib-thumb home-thumb" style={{ aspectRatio: `${p?.spec.meta.width ?? 1000} / ${p?.spec.meta.height ?? 1414}`, height: `min(100%, calc(100cqw * ${(p?.spec.meta.height ?? 1414) / (p?.spec.meta.width ?? 1000)}))` }}>
        {p && <PosterFrame poster={p} />}
      </span>
      {extra}
    </span>
  );

  // 状態が届くまでは、ログイン画面もホームも出さない（更新やホームへ戻るたびにログイン画面が一瞬出ないように）
  if (!status) {
    return (
      <div className="home login-screen">
        <header className="topbar home-topbar">
          <span className="spacer" />
          <ThemeMenu />
        </header>
        <main className="login-main">
          {apiError && <p className="lib-error" role="alert">API サーバーに接続できません。`npm run dev` が起動しているか確認してください。接続できたら自動で読み込みます。</p>}
        </main>
      </div>
    );
  }

  // サインインしていなければ、ログインの誘導だけを出す（サインインの結果は別タブから届き、load で取り直す）。
  // OpenRouter を使う状態（キーがあり、ChatGPT を選んでもいない）ならサインインなしで使えるので、ホームを出す。
  // 製品版は未サインインでもローカル編集ができるのでホームを出す（サインインはアカウント表示から）
  if (!desktopBridge() && !gpt?.signedIn && status.ai?.provider !== "openrouter") {
    const previousEmail = gpt && !gpt.signedIn ? gpt.previousEmail : undefined;
    return (
      <div className="home login-screen">
        <header className="topbar home-topbar">
          <span className="spacer" />
          <ThemeMenu />
        </header>
        <main className="login-main">
          <div className="login-card">
            <h1>DC-Designer</h1>
            <p>ChatGPT のプラン枠でレイアウト生成・AI 修正が使えます。<br />この連携には ChatGPT Plus / Pro などの対象プランが必要です。無料プランは非対応です。</p>
            <button className="primary login-btn" autoFocus onClick={api.chatgptLogin}>ChatGPTでログイン</button>
            {previousEmail && <>
              <p className="login-sub">前回: {previousEmail}</p>
              <button className="login-alt" onClick={api.chatgptLoginNewAccount}>別のアカウントでログイン</button>
            </>}
          </div>
        </main>
      </div>
    );
  }

  const topbarRight = (
    <>
      {appVersion && <span className="app-version" title="DC-Designer のバージョン">v{appVersion}</span>}
      <ThemeMenu />
      {gpt?.signedIn ? (
        <span className="home-account" title={gpt.email}>
          {/* 製品版は外部の画像を読み込まない */}
          {gpt.picture && !desktopBridge() && <img src={gpt.picture} alt="" />}
          <span>{gpt.name || gpt.email || "ChatGPT"}</span>
          {!gpt.planEnabled && <small className="warn">プラン利用不可</small>}
          {codexJob && <small role="status" title={describeCodexJob(codexJob)}>{codexJobLabel(codexJob)}
            {" "}<button className="small" onClick={codexSetup.cancel}>中止</button></small>}
        </span>
      ) : desktopBridge() && signingIn ? (
        <span className="home-signin-wait" role="status">
          ブラウザでサインインを続けてください
          <button className="small" onClick={() => desktopBridge()?.auth.reopen()} title="認可画面を閉じてしまったときに、もう一度開きます">開き直す</button>
          <button className="small" onClick={() => desktopBridge()?.auth.cancel()}>取り消す</button>
        </span>
      ) : desktopBridge() ? (
        // 製品版の AI は ChatGPT プランだけ（OpenRouter は使えない）。ホームからもサインインできる
        <button
          className="home-signin" onClick={api.chatgptLogin}
          title="既定のブラウザで ChatGPT にサインインします。ChatGPT Plus / Pro などの対象プランが必要です（無料プランは非対応）"
        >
          ChatGPT にサインイン（対象の有料プラン）
        </button>
      ) : (
        <span className="home-account" title="レイアウト生成・AI 修正は OpenRouter の API キーで行います（ChatGPT にはエディタ左下からサインインできます）">
          <span>OpenRouter</span>
        </span>
      )}
    </>
  );

  // モードを選ぶ画面
  if (!mode) {
    return (
      <div className={"home" + (drop.over ? " drop-over" : "")} {...drop.props}>
        {dropVeil}
        <header className="topbar home-topbar">
          <span className="spacer" />
          {topbarRight}
        </header>
        <main className="home-main">
          <h1 className="home-hero">何を作りますか？</h1>
          <section className="home-starts mode-cards" aria-label="作るものを選ぶ">
            {MODE_KEYS.map((k) => (
              <button key={k} className="home-start" disabled={!!busy} onClick={() => (location.href = modeHomeUrl(k))}>
                <span className={`start-ico${MODE_ICO[k]}`}><Ico name={MODES[k].icon} size={22} /></span>
                <strong>{MODES[k].label}</strong>
                <small>{MODES[k].note}{counts && <span className="mode-count">・{counts[k]} 件</span>}</small>
              </button>
            ))}
            <button className="home-start" disabled={!!busy} onClick={() => pdfInput.current?.click()}>
            <span className="start-ico alt"><Ico name="folder" size={22} /></span><strong>PDFを開いて編集</strong><small>文字・枠・画像を部品として編集（20MB・20ページまで・ここにドロップしてもよい）</small>
            </button>
            <input ref={pdfInput} type="file" accept={PDF_FILE_ACCEPT} aria-label="編集するPDF" hidden disabled={!!busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) openPdf(f); }} />
          </section>
          {error && <p className="lib-error" role="alert">{error} <button className="small" onClick={() => setError(null)}>閉じる</button></p>}
        </main>
        {busy && <div className="home-busy" role="status" aria-live="polite"><span className="spinner" aria-hidden />{busy.label}{busy.progress ? `（${busy.progress[0]} / ${busy.progress[1]} 枚）` : "…"}</div>}
      </div>
    );
  }

  const info = MODES[mode];
  return (
    <div className={"home" + (drop.over ? " drop-over" : "")} {...drop.props}>
      {dropVeil}
      <header className="topbar home-topbar">
        <button onClick={() => (location.href = HOME_URL)} title="作るものを選ぶ画面へ戻る"><Ico name="arrowLeft" /> モードを選ぶ</button>
        <h1 className="home-mode-title">{info.label}</h1>
        <span className="spacer" />
        <button onClick={() => (location.href = modeLibraryUrl(mode))} title={`作成した${info.item}の一覧`}><Ico name="folder" /> 成果物</button>
        {topbarRight}
      </header>

      <main className="home-main">
        <h2 className="home-hero">{info.label}を作る</h2>
        {/* 白紙とテンプレートを 1 本の帯に横並びにする（Canva のホームのように、作り始めの候補をまとめて見せる） */}
        <section className="home-create" aria-label="新しく作る">
          <div className="home-create-head">
            <h2>新しく作る</h2>
            <small>白紙か、保存したテンプレートから始めます</small>
          </div>
          <ul className="home-carousel">
            <li>
              <button className="home-card home-blank-card" disabled={!!busy} onClick={mode === "poster" ? startBlank : startBlankDeck} title={mode === "poster" ? "白紙の A4 縦（1000×1414）ポスター" : "白紙の 16:9 スライド 1 枚から始める"}>
                <span className="home-thumb-wrap">
                  <span className="home-blank-sheet" style={{ aspectRatio: mode === "poster" ? "1000 / 1414" : "16 / 9", height: `min(100%, calc(100cqw * ${mode === "poster" ? 1414 / 1000 : 9 / 16}))` }}><Ico name="plus" size={26} /></span>
                </span>
                <strong className="lib-title">{mode === "poster" ? "A4 でスタート" : "0 から作る"}</strong>
                <small>{mode === "poster" ? "白紙の A4 縦" : "白紙の 16:9"}</small>
              </button>
            </li>
              {modeTemplates.map((t) => {
                const first = t.specs[0];
                return (
                  <li key={t.id} className="home-template">
                    <button className="home-card home-template-card" disabled={!!busy || !first} onClick={() => startFromTemplate(t)} title="このテンプレートから新しく作る">
                      <span className="home-thumb-wrap">
                        <span className="lib-thumb home-thumb" style={{ aspectRatio: `${first?.meta.width ?? 1000} / ${first?.meta.height ?? 1414}`, height: `min(100%, calc(100cqw * ${(first?.meta.height ?? 1414) / (first?.meta.width ?? 1000)}))` }}>
                          {first && <SpecFrame spec={first} />}
                        </span>
                        <span className="home-template-tag"><Ico name="copy" size={11} />テンプレート{t.mode === "slides" && `・${t.specs.length} 枚`}</span>
                      </span>
                      <strong className="lib-title">{t.mode === "slides" && <Ico name="slides" size={13} />}{t.name}</strong>
                      <small className="home-template-cta"><Ico name="plus" size={12} />このデザインで作る</small>
                    </button>
                    {renamingTpl === t.id ? (
                      <input
                        className="home-template-name" autoFocus defaultValue={t.name} maxLength={100} aria-label="テンプレートの名前"
                        onBlur={(e) => renameTemplate(t, e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setRenamingTpl(null); }}
                      />
                    ) : (
                      <button className="small home-template-rename" disabled={!!busy} onClick={() => setRenamingTpl(t.id)} aria-label={`テンプレート「${t.name}」の名前を変更`}>名前変更</button>
                    )}
                    <button className="small home-template-del" disabled={!!busy} onClick={() => removeTemplate(t)} title="テンプレートを削除" aria-label={`テンプレート「${t.name}」を削除`}>×</button>
                  </li>
                );
              })}
          </ul>
          {modeTemplates.length === 0 && <p className="home-create-hint">成果物やエディタのメニューから「テンプレートとして保存」すると、ここに並んで同じデザインで始められます。</p>}
        </section>

        <section className="home-starts home-opens" aria-label="ファイルから始める">
          {mode === "poster" ? (<>
            <button className="home-start" disabled={!!busy} onClick={() => pdfInput.current?.click()}>
              <span className="start-ico alt"><Ico name="folder" size={22} /></span><strong>PDFを開いて編集</strong><small>文字・枠・画像を部品として編集（20MB・20ページまで・ここにドロップしてもよい）</small>
            </button>
            <input ref={pdfInput} type="file" accept={PDF_FILE_ACCEPT} aria-label="編集するPDF" hidden disabled={!!busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) openPdf(f); }} />
          </>) : (
            <label className={`home-start${busy ? " disabled" : ""}`}>
              <span className="start-ico alt"><Ico name="folder" size={22} /></span><strong>PowerPoint（.pptx）を開く</strong><small>既存のファイルを読み込む（ここにドロップしてもよい）</small>
              <input type="file" accept={PPTX_ACCEPT} hidden disabled={!!busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) openPptx(f); }} />
            </label>
          )}
        </section>

        {current && (
          <section className="home-section">
            <h2>続きから編集</h2>
            <button className="home-continue" onClick={() => openInEditor(current.poster, mode)} title="エディタで開く">
              {thumb(current.poster, <span className="badge">編集中</span>)}
              <span className="home-continue-body">
                <strong>{current.deck ? current.deck.name : current.poster.spec.meta.title || "無題のポスター"}</strong>
                {current.deck && <span>スライド {current.deck.slides.findIndex((s) => s.id === current.poster.id) + 1} / {current.deck.slides.length} 枚目</span>}
                <small>更新 {fmtAgo(current.poster.updatedAt)}</small>
              </span>
            </button>
          </section>
        )}

        <section className="home-section">
          <div className="home-section-head">
            <h2>最近の{info.item}</h2>
            {recent.length > 0 && <a href={modeLibraryUrl(mode)}>すべて見る（{recent.length}）<Ico name="chevronRight" size={14} /></a>}
          </div>
          {apiError && !posters ? (
            <p className="lib-error" role="alert">API サーバーに接続できません。`npm run dev` が起動しているか確認してください。接続できたら自動で読み込みます。</p>
          ) : !posters || !decks ? (
            <p className="lib-empty">読み込み中…</p>
          ) : recent.length === 0 ? (
            <div className="lib-empty">
              <p>まだ{info.item}はありません。</p>
            </div>
          ) : (
            <ul className="home-recent">
              {recent.slice(0, RECENT_MAX).map((r) => (
                <li key={r.kind + r.id}>
                  <button className="home-card" onClick={() => openRecent(r)} title="エディタで開く" disabled={r.kind === "deck" && !r.cover}>
                    {thumb(r.kind === "poster" ? r.poster : r.cover, r.kind === "deck" ? <span className="badge muted">{r.deck.slides.length} 枚</span> : undefined)}
                    <strong className="lib-title">{r.kind === "deck" && <Ico name="slides" size={13} />}{r.title}</strong>
                    <small>{fmtAgo(r.updatedAt)}{r.pending > 0 && <> ・ <span className="warn">画像 {r.pending} 点未生成</span></>}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {error && <p className="lib-error" role="alert">{error} <button className="small" onClick={() => setError(null)}>閉じる</button></p>}

      </main>

      {busy && (
        <div className="home-busy" role="status" aria-live="polite">
          <span className="spinner" aria-hidden />
          {busy.label}{busy.progress ? `（${busy.progress[0]} / ${busy.progress[1]} 枚）` : "…"}
        </div>
      )}
    </div>
  );
}
