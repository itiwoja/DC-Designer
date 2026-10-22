import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { importPptx } from "../import/pptx";
import { importPdf } from "../import/pdf";
import { isPdf, PDF_FILE_ACCEPT } from "../import/pdfDocument";
import { findPendingAssets } from "../schema";
import { blankInstagramSpec, IG_RATIO_KEYS, IG_RATIOS, type IgRatio } from "../instagram";
import { api, AUTH_CHANNEL, deckBySlide, type Deck, type SavedPoster, type Status } from "./api";
import { BLANK_SLIDE_SPEC, BLANK_SPEC, IMPORT_NOTICE_KEY, HOME_URL, openDeckInEditor, openInEditor } from "./nav";
import { MODE_KEYS, MODES, modeHomeUrl, modeLibraryUrl, modeOfDeck, readLastId, type AppMode } from "./mode";
import { PosterFrame, ThemeMenu, useLoadWithRetry } from "./ui";
import { PPTX_ACCEPT } from "./specOps";
import { Ico } from "./uiIcons";
import { useSignInWatch } from "./useChatGPTAuth";

const RECENT_MAX = 8;

/** モードごとのアイコンの色（start-ico の修飾クラス） */
const MODE_ICO: Record<AppMode, string> = { poster: "", slides: " alt", instagram: " ig" };

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

  const gpt = status?.chatgpt;

  const posterById = useMemo(() => new Map((posters ?? []).map((p) => [p.id, p])), [posters]);
  const deckOfSlide = useMemo(() => deckBySlide(decks), [decks]);

  /** そのモードの成果物だけを更新順に並べる（poster: 単体のポスター、slides: スライドのデッキ、instagram: Instagram のデッキ） */
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
        if (modeOfDeck(d) !== mode) continue;
        const slides = d.slides.map((s) => posterById.get(s.id)).filter((p): p is SavedPoster => !!p);
        const updatedAt = slides.reduce((a, p) => (p.updatedAt > a ? p.updatedAt : a), d.updatedAt);
        items.push({ kind: "deck", id: d.id, title: d.name, updatedAt, deck: d, cover: slides[0], pending: slides.reduce((a, p) => a + findPendingAssets(p.spec).length, 0) });
      }
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [posters, decks, mode, posterById, deckOfSlide]);

  /** モード選択画面に出す、モードごとの成果物数 */
  const counts = useMemo<Record<AppMode, number> | null>(() => {
    if (!posters || !decks) return null;
    const c: Record<AppMode, number> = { poster: posters.filter((p) => !deckOfSlide.has(p.id)).length, slides: 0, instagram: 0 };
    for (const d of decks) c[modeOfDeck(d)]++;
    return c;
  }, [posters, decks, deckOfSlide]);

  /** 「続きから編集」に出す、このモードで最後に開いていたもの（別のモードの成果物なら出さない） */
  const current = useMemo(() => {
    if (!mode || !posters) return null;
    const id = readLastId(mode);
    const p = id ? posterById.get(id) : undefined;
    if (!p) return null;
    const deck = deckOfSlide.get(p.id);
    if (modeOfDeck(deck) !== mode) return null;
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
  /** 白紙の Instagram 投稿（画像 1 枚）。エディタの「新規作成」は Instagram 投稿を作る状態で開く */
  const startInstagram = (ratio: IgRatio) => act("白紙の投稿を用意中", async () => {
    const deck = await api.createDeck("無題の投稿", [blankInstagramSpec(ratio)], "instagram");
    openInEditor(await api.poster(deck.slides[0].id), "instagram");
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
  // .pptx のドロップ読み込みは PPTX のホームだけ
  const onDrop = (e: React.DragEvent) => {
    if (mode === "instagram") return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    const pdf = files.find(isPdf);
    if (pdf) { openPdf(pdf); return; }
    const pptx = files.find((f) => /\.pptx$/i.test(f.name));
    if (pptx && mode === "slides") openPptx(pptx);
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
  // OpenRouter を使う状態（キーがあり、ChatGPT を選んでもいない）ならサインインなしで使えるので、ホームを出す
  if (!gpt?.signedIn && status.ai?.provider !== "openrouter") {
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
            <p>ChatGPT アカウントでログインして始めましょう。<br />ChatGPT のプランの枠でレイアウト生成・AI 修正が使えます（無料プランでも使えます）。</p>
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
      <ThemeMenu />
      {gpt?.signedIn ? (
        <span className="home-account" title={gpt.email}>
          {gpt.picture && <img src={gpt.picture} alt="" />}
          <span>{gpt.name || gpt.email || "ChatGPT"}</span>
          {!gpt.planEnabled && <small className="warn">プラン利用不可</small>}
        </span>
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
      <div className="home" onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDrop={onDrop}>
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
            <span className="start-ico alt"><Ico name="folder" size={22} /></span><strong>PDFを開いて編集</strong><small>文字・枠・画像を部品として編集（20MB・20ページまで）</small>
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
    <div className="home" onDragOver={(e) => { if (mode !== "instagram" && e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDrop={onDrop}>
      <header className="topbar home-topbar">
        <button onClick={() => (location.href = HOME_URL)} title="作るものを選ぶ画面へ戻る"><Ico name="arrowLeft" /> モードを選ぶ</button>
        <h1 className="home-mode-title">{info.label}</h1>
        <span className="spacer" />
        <button onClick={() => (location.href = modeLibraryUrl(mode))} title={`作成した${info.item}の一覧`}><Ico name="folder" /> 成果物</button>
        {topbarRight}
      </header>

      <main className="home-main">
        <h2 className="home-hero">{info.label}を作る</h2>
        {mode === "poster" && (
          <section className="home-starts" aria-label="新しく作る">
            <button className="home-start" disabled={!!busy} onClick={startBlank}>
              <span className="start-ico"><Ico name="file" size={22} /></span><strong>A4 でスタート</strong><small>白紙の A4 縦（1000×1414）ポスター</small>
            </button>
          <button className="home-start" disabled={!!busy} onClick={() => pdfInput.current?.click()}>
            <span className="start-ico alt"><Ico name="folder" size={22} /></span><strong>PDFを開いて編集</strong><small>文字・枠・画像を部品として編集（20MB・20ページまで）</small>
          </button>
          <input ref={pdfInput} type="file" accept={PDF_FILE_ACCEPT} aria-label="編集するPDF" hidden disabled={!!busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) openPdf(f); }} />
          </section>
        )}
        {mode === "slides" && (
          <section className="home-starts" aria-label="新しく作る">
            <button className="home-start" disabled={!!busy} onClick={startBlankDeck}>
              <span className="start-ico alt"><Ico name="file" size={22} /></span><strong>0 から作る</strong><small>白紙の 16:9 スライド 1 枚から始める</small>
            </button>
            <label className={`home-start${busy ? " disabled" : ""}`}>
              <span className="start-ico alt"><Ico name="folder" size={22} /></span><strong>PowerPoint（.pptx）を開く</strong><small>既存のファイルを読み込む（ここにドロップしてもよい）</small>
              <input type="file" accept={PPTX_ACCEPT} hidden disabled={!!busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) openPptx(f); }} />
            </label>
          </section>
        )}
        {mode === "instagram" && (
          <section className="home-section" aria-label="新しく作る">
            <p className="hint small">画像の比率を選んでください。複数枚（カルーセル）の投稿は全枚が同じ比率になります。比率はあとから変えられます。</p>
            <div className="home-starts ig-ratios">
              {IG_RATIO_KEYS.map((k) => {
                const r = IG_RATIOS[k];
                return (
                  <button key={k} className="home-start" disabled={!!busy} onClick={() => startInstagram(k)}>
                    <span className="ig-ratio-box" aria-hidden><span style={{ width: 36 * Math.min(1, r.w / r.h), height: 36 * Math.min(1, r.h / r.w) }} /></span>
                    <strong>{r.label}</strong><small>{r.w}×{r.h}・{r.note}</small>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {current && (
          <section className="home-section">
            <h2>続きから編集</h2>
            <button className="home-continue" onClick={() => openInEditor(current.poster, mode)} title="エディタで開く">
              {thumb(current.poster, <span className="badge">編集中</span>)}
              <span className="home-continue-body">
                <strong>{current.deck ? current.deck.name : current.poster.spec.meta.title || "無題のポスター"}</strong>
                {current.deck && <span>{current.deck.kind === "instagram" ? "画像" : "スライド"}「{current.poster.spec.meta.title || "無題"}」（{current.deck.slides.findIndex((s) => s.id === current.poster.id) + 1} / {current.deck.slides.length} 枚目）</span>}
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
                    <strong className="lib-title">{r.kind === "deck" && <Ico name={r.deck.kind === "instagram" ? "carousel" : "slides"} size={13} />}{r.title}</strong>
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
