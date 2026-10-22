import { useCallback, useEffect, useMemo, useState } from "react";
import { findPendingAssets, PosterSpecSchema, type PosterSpec } from "../schema";
import { THEMES } from "../themes";
import { download } from "../render/export";
import { api, deckBySlide, type Deck, type GeneratedFile, type SavedPoster } from "./api";
import { modeEditorUrl, modeHomeUrl, modeOfDeck, MODES, readLastId, readModeParam } from "./mode";
import { BLANK_SLIDE_SPEC, BLANK_SPEC, openDeckInEditor, openInEditor } from "./nav";
import { readCurrentId, STORAGE_KEY, writeCurrentId, writeSynced } from "./storage";
import { safeFileName } from "./specOps";
import { ask, PosterFrame } from "./ui";
import { Ico } from "./uiIcons";

/** items = そのモードの成果物（ポスター・プレゼンテーション・投稿） */
type Tab = "items" | "images";
type Sort = "updated" | "created" | "title";
type ImageFilter = "all" | "used" | "unused";

const fmtDate = (iso: string) => new Date(iso).toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** ブラウザに控えている編集中の spec（サーバー保存前の変更で使っている画像を消さないため） */
function editingSpec(): PosterSpec[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? [PosterSpecSchema.parse(JSON.parse(raw))] : [];
  } catch { return []; }
}

const initialTab = (): Tab => {
  const t = new URLSearchParams(location.search).get("tab");
  return t === "images" ? t : "items";
};

/** 名前の変更欄。Enter / フォーカスを外すと確定、Esc で取り消し */
function RenameInput({ value, label, onDone, onCancel }: { value: string; label: string; onDone: (name: string) => void; onCancel: () => void }) {
  return (
    <input
      autoFocus
      defaultValue={value}
      aria-label={label}
      onBlur={(e) => onDone(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") onCancel(); }}
    />
  );
}

export function Library() {
  /** この一覧が扱うモード。別モードの成果物は出さない */
  const mode = useMemo(() => readModeParam() ?? "poster", []);
  const { label: modeLabel, item: itemLabel } = MODES[mode];
  const [tab, setTab] = useState<Tab>(initialTab);
  const [posters, setPosters] = useState<SavedPoster[] | null>(null);
  const [decks, setDecks] = useState<Deck[] | null>(null);
  const [files, setFiles] = useState<GeneratedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("updated");
  const [imageFilter, setImageFilter] = useState<ImageFilter>("all");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [preview, setPreview] = useState<GeneratedFile | null>(null);
  const [busy, setBusy] = useState(false);
  const currentId = readCurrentId();

  const reload = useCallback(async () => {
    try {
      const [p, d, g] = await Promise.all([api.posters(), api.decks(), api.generated(editingSpec())]);
      setPosters(p.posters);
      setDecks(d.decks);
      // 取り込んだ効果音（音声ファイル）は画像の一覧に出さない
      setFiles(g.files.filter((f) => !/\.(mp3|wav|ogg|m4a|aac|webm)$/i.test(f.name)));
      setError(null);
    } catch (e) {
      setError(`成果物を読み込めませんでした（API サーバーは起動していますか？）: ${(e as Error).message}`);
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { document.title = `${modeLabel} の成果物 - DC-Designer`; }, [modeLabel]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await reload(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  /** このモードのデッキ（slides は Instagram 以外、instagram は Instagram のみ。poster は無し） */
  const modeDecks = useMemo(() => (mode === "poster" ? [] : (decks ?? []).filter((d) => modeOfDeck(d) === mode)), [decks, mode]);
  const posterById = useMemo(() => new Map((posters ?? []).map((p) => [p.id, p])), [posters]);
  /** スライド ID → それが入っているプロジェクト（デッキ） */
  const deckOfSlide = useMemo(() => deckBySlide(decks), [decks]);
  /** 画像の「使用中」などに出す名前。スライドなら「デッキ名 / スライド名」 */
  const titleOf = useMemo(() => new Map((posters ?? []).map((p) => {
    const title = p.spec.meta.title || "無題のポスター";
    const d = deckOfSlide.get(p.id);
    return [p.id, d ? `${d.name} / ${title}` : title];
  })), [posters, deckOfSlide]);

  const q = query.trim().toLowerCase();
  const matchesSpec = (p: SavedPoster) => !q || p.spec.meta.title.toLowerCase().includes(q) || JSON.stringify(p.spec.layers).toLowerCase().includes(q);

  /** プロジェクトに属さない単体のポスター */
  const standalone = useMemo(() => (posters ?? []).filter((p) => !deckOfSlide.has(p.id)), [posters, deckOfSlide]);
  const shownPosters = useMemo(() => {
    const list = standalone.filter(matchesSpec);
    if (sort === "created") list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    else if (sort === "title") list.sort((a, b) => a.spec.meta.title.localeCompare(b.spec.meta.title, "ja"));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standalone, q, sort]);

  /** デッキ自体の更新（名前・並び）とスライドの更新のうち新しい方 */
  const lastUpdated = (d: Deck) => d.slides.reduce((a, s) => (s.updatedAt > a ? s.updatedAt : a), d.updatedAt);
  const shownDecks = useMemo(() => {
    const list = modeDecks.filter((d) => !q || d.name.toLowerCase().includes(q) || d.slides.some((s) => { const p = posterById.get(s.id); return p ? matchesSpec(p) : s.title.toLowerCase().includes(q); }));
    if (sort === "created") list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    else if (sort === "title") list.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    else list.sort((a, b) => lastUpdated(b).localeCompare(lastUpdated(a)));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeDecks, posterById, q, sort]);

  /** このモードの成果物の ID（画像の絞り込み用） */
  const modeIds = useMemo(() => new Set(mode === "poster" ? standalone.map((p) => p.id) : modeDecks.flatMap((d) => d.slides.map((s) => s.id))), [mode, standalone, modeDecks]);
  /** このモードの成果物が使っている画像と、どれにも使われていない画像 */
  const modeFiles = useMemo(() => (files ?? []).filter((f) => !f.usedBy.length || f.usedBy.some((id) => modeIds.has(id))), [files, modeIds]);
  const unused = modeFiles.filter((f) => !f.usedBy.length);
  const shownFiles = modeFiles.filter((f) => {
    if (imageFilter === "used" && !f.usedBy.length) return false;
    if (imageFilter === "unused" && f.usedBy.length) return false;
    return !q || f.name.toLowerCase().includes(q) || f.usedBy.some((id) => titleOf.get(id)?.toLowerCase().includes(q));
  });
  /** 「エディタに戻る」は、最後に開いた成果物がこのモードの一覧にあるときだけ出す */
  const lastId = readLastId(mode);
  const canReturn = !!lastId && (posters ?? []).some((p) => p.id === lastId && modeIds.has(p.id));

  const clearEditing = () => { writeCurrentId(null); writeSynced(false); try { localStorage.removeItem(STORAGE_KEY); } catch { /* 無視 */ } };

  const createNew = () => act(async () => {
    if (mode === "instagram") { location.href = modeHomeUrl("instagram"); return; } // 比率はモードのホームで選ぶ
    if (mode === "slides") {
      const deck = await api.createDeck("無題のプレゼンテーション", [BLANK_SLIDE_SPEC]);
      openInEditor(await api.poster(deck.slides[0].id), "slides");
      return;
    }
    openInEditor(await api.createPoster(BLANK_SPEC), "poster");
  });
  const newLabel = mode === "poster" ? "＋ 新規ポスター" : mode === "slides" ? "＋ 新規プレゼンテーション" : "＋ 新規投稿";
  const rename = (p: SavedPoster, title: string) => {
    setRenaming(null);
    if (title.trim() === p.spec.meta.title) return;
    const spec = { ...p.spec, meta: { ...p.spec.meta, title: title.trim() || "無題のポスター" } };
    act(() => api.savePoster(p.id, spec));
    // 編集中のポスターならブラウザの控えも合わせる（エディタに戻ったとき古いタイトルで上書きしないように）
    if (p.id === currentId) try { localStorage.setItem(STORAGE_KEY, JSON.stringify(spec)); } catch { /* 無視 */ }
  };
  const remove = async (p: SavedPoster) => {
    if (!await ask({ title: "ポスターを削除しますか？", message: `「${p.spec.meta.title || "無題のポスター"}」を削除します。この操作は取り消せません（使っていた画像は残ります）。`, ok: "削除", danger: true })) return;
    act(async () => {
      await api.deletePoster(p.id);
      // 編集中のものを消したら、エディタが同じ内容で作り直さないように控えも消す
      if (p.id === currentId) clearEditing();
    });
  };
  const removeFiles = async (names: string[]) => {
    if (!names.length) return;
    const size = (files ?? []).filter((f) => names.includes(f.name)).reduce((a, f) => a + f.size, 0);
    if (!await ask({ title: `未使用の画像 ${names.length} 件を削除しますか？`, message: `合計 ${fmtSize(size)}。この操作は取り消せません。`, ok: "削除", danger: true })) return;
    act(() => api.deleteGenerated(names, editingSpec()));
  };

  // ---------- プロジェクト（デッキ） ----------
  const openDeck = (d: Deck) => openDeckInEditor(d, posterById);
  const renameDeck = (d: Deck, name: string) => {
    setRenaming(null);
    if (!name.trim() || name.trim() === d.name) return;
    act(() => api.updateDeck(d.id, { name: name.trim() }));
  };
  const removeDeck = async (d: Deck) => {
    if (!await ask({ title: `${itemLabel}を削除しますか？`, message: `「${d.name}」と中のスライド ${d.slides.length} 枚をまとめて削除します。この操作は取り消せません（使っていた画像は残ります）。`, ok: "削除", danger: true })) return;
    act(async () => {
      await api.deleteDeck(d.id);
      if (d.slides.some((s) => s.id === currentId)) clearEditing();
    });
  };
  const exportDeckJson = (d: Deck) => {
    const slides = d.slides.map((s) => posterById.get(s.id)?.spec).filter(Boolean);
    download(new Blob([JSON.stringify({ name: d.name, slides }, null, 2)], { type: "application/json" }), `${safeFileName(d.name)}.json`);
  };

  const itemCount = posters && decks ? (mode === "poster" ? standalone.length : modeDecks.length) : undefined;

  return (
    <div className="library">
      <header className="topbar lib-topbar">
        <button onClick={() => (location.href = modeHomeUrl(mode))}><Ico name="home" /> ホーム</button>
        {canReturn && <button onClick={() => (location.href = modeEditorUrl(mode))}><Ico name="arrowLeft" /> エディタに戻る</button>}
        <div className="tabs lib-tabs" role="tablist" aria-label="成果物の種類">
          <button role="tab" aria-selected={tab === "items"} className={tab === "items" ? "active" : ""} onClick={() => setTab("items")}>
            {itemLabel}{itemCount !== undefined && <span className="count">{itemCount}</span>}
          </button>
          <button role="tab" aria-selected={tab === "images"} className={tab === "images" ? "active" : ""} onClick={() => setTab("images")}>
            画像{files && <span className="count">{modeFiles.length}</span>}
          </button>
        </div>
        <span className="spacer" />
        <input className="lib-search" type="search" placeholder={tab === "images" ? `ファイル名・${mode === "poster" ? "ポスター" : itemLabel}名で検索` : mode === "poster" ? "タイトル・本文で検索" : `${itemLabel}名・本文で検索`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="検索" />
        {tab !== "images" ? (
          <>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="並び順">
              <option value="updated">更新が新しい順</option>
              <option value="created">作成が新しい順</option>
              <option value="title">{mode === "poster" ? "タイトル順" : "名前順"}</option>
            </select>
            <button className="primary" disabled={busy} onClick={createNew}>{newLabel}</button>
          </>
        ) : (
          <>
            <select value={imageFilter} onChange={(e) => setImageFilter(e.target.value as ImageFilter)} aria-label="絞り込み">
              <option value="all">すべて</option>
              <option value="used">使用中</option>
              <option value="unused">未使用</option>
            </select>
            <button className="danger" disabled={busy || !unused.length} onClick={() => removeFiles(unused.map((f) => f.name))}>
              未使用を削除{unused.length ? `（${unused.length}件・${fmtSize(unused.reduce((a, f) => a + f.size, 0))}）` : ""}
            </button>
          </>
        )}
      </header>

      <main className="lib-main">
        {error && <p className="lib-error" role="alert">{error} <button className="small" onClick={reload}>再読み込み</button></p>}

        {tab === "items" && mode === "poster" && posters && decks && (
          shownPosters.length ? (
            <ul className="lib-grid">
              {shownPosters.map((p) => {
                const pending = findPendingAssets(p.spec).length;
                return (
                  <li key={p.id} className={"lib-card" + (p.id === currentId ? " current" : "")}>
                    <button className="lib-thumb" style={{ aspectRatio: `${p.spec.meta.width} / ${p.spec.meta.height}` }} onClick={() => openInEditor(p, "poster")} title="エディタで開く">
                      <PosterFrame poster={p} />
                      {p.id === currentId && <span className="badge">編集中</span>}
                    </button>
                    <div className="lib-info">
                      {renaming === p.id
                        ? <RenameInput value={p.spec.meta.title} label="タイトル" onDone={(name) => rename(p, name)} onCancel={() => setRenaming(null)} />
                        : <strong className="lib-title" title="ダブルクリックで名前を変更" onDoubleClick={() => setRenaming(p.id)}>{p.spec.meta.title || "無題のポスター"}</strong>}
                      <small>更新 {fmtDate(p.updatedAt)}</small>
                      <small>
                        {THEMES[p.spec.theme]?.label ?? p.spec.theme} ・ {p.spec.layers.length} レイヤー
                        {pending > 0 && <> ・ <span className="warn">画像 {pending} 点未生成</span></>}
                      </small>
                    </div>
                    <div className="lib-actions">
                      <button className="small primary" onClick={() => openInEditor(p, "poster")}>開く</button>
                      <button className="small" disabled={busy} onClick={() => setRenaming(p.id)}>名前変更</button>
                      <button className="small" disabled={busy} onClick={() => act(() => api.duplicatePoster(p.id))}>複製</button>
                      <button className="small" onClick={() => download(new Blob([JSON.stringify(p.spec, null, 2)], { type: "application/json" }), `${safeFileName(p.spec.meta.title)}.json`)}>JSON</button>
                      <button className="small danger" disabled={busy} onClick={() => remove(p)}>削除</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="lib-empty">
              {query ? <p>「{query}」に一致するポスターはありません。</p> : <>
                <p>まだ保存されたポスターはありません。エディタで作ったポスターは自動でここに保存されます。</p>
                <button className="primary" disabled={busy} onClick={createNew}>{newLabel}</button>
              </>}
            </div>
          )
        )}

        {tab === "items" && mode !== "poster" && posters && decks && (
          shownDecks.length ? (
            <ul className="lib-grid projects">
              {shownDecks.map((d) => {
                const slides = d.slides.map((s) => posterById.get(s.id)).filter((p): p is SavedPoster => !!p);
                const cover = slides[0];
                const editing = d.slides.some((s) => s.id === currentId);
                const pending = slides.reduce((a, p) => a + findPendingAssets(p.spec).length, 0);
                const open = expanded === d.id;
                return (
                  <li key={d.id} className={"lib-card project" + (editing ? " current" : "") + (open ? " expanded" : "")}>
                    <div className="lib-project-head">
                      <button className="lib-thumb" style={{ aspectRatio: cover ? `${cover.spec.meta.width} / ${cover.spec.meta.height}` : "16 / 9" }} onClick={() => openDeck(d)} title="エディタで開く" disabled={!cover}>
                        {cover && <PosterFrame poster={cover} />}
                        <span className={"badge" + (editing ? "" : " muted")}>{editing ? "編集中" : `${d.slides.length} 枚`}</span>
                        {d.slides.length > 1 && <span className="stack" aria-hidden />}
                      </button>
                      <div className="lib-info">
                        {renaming === d.id
                          ? <RenameInput value={d.name} label={`${itemLabel}名`} onDone={(name) => renameDeck(d, name)} onCancel={() => setRenaming(null)} />
                          : <strong className="lib-title" title="ダブルクリックで名前を変更" onDoubleClick={() => setRenaming(d.id)}><Ico name={d.kind === "instagram" ? "carousel" : "slides"} size={13} /> {d.name}</strong>}
                        <small>更新 {fmtDate(lastUpdated(d))}</small>
                        <small>
                          {mode === "instagram" ? "投稿画像" : "スライド"} {d.slides.length} 枚
                          {pending > 0 && <> ・ <span className="warn">画像 {pending} 点未生成</span></>}
                        </small>
                      </div>
                      <div className="lib-actions">
                        <button className="small primary" onClick={() => openDeck(d)} disabled={!cover}>開く</button>
                        <button className="small" disabled={busy} onClick={() => setRenaming(d.id)}>名前変更</button>
                        <button className="small" disabled={busy} onClick={() => act(() => api.duplicateDeck(d.id))}>複製</button>
                        <button className="small" onClick={() => exportDeckJson(d)} disabled={!cover}>JSON</button>
                        <button className="small" aria-expanded={open} onClick={() => setExpanded(open ? null : d.id)}>{mode === "instagram" ? (open ? "画像を閉じる" : "画像一覧") : open ? "スライドを閉じる" : "スライド一覧"}</button>
                        <button className="small danger" disabled={busy} onClick={() => removeDeck(d)}>削除</button>
                      </div>
                    </div>
                    {open && (
                      <ol className="lib-slides" aria-label={`${d.name} のスライド`}>
                        {d.slides.map((s, i) => {
                          const p = posterById.get(s.id);
                          return (
                            <li key={s.id} className={s.id === currentId ? "current" : ""}>
                              <button className="lib-thumb" style={{ aspectRatio: p ? `${p.spec.meta.width} / ${p.spec.meta.height}` : "16 / 9" }} onClick={() => p && openInEditor(p, mode)} title="このスライドを開く" disabled={!p}>
                                {p && <PosterFrame poster={p} />}
                                <span className="num">{i + 1}</span>
                              </button>
                              <small title={s.title}>{s.title || "無題"}</small>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="lib-empty">
              {query ? <p>「{query}」に一致する{itemLabel}はありません。</p> : <>
                <p>まだ{itemLabel}はありません。</p>
                {mode === "slides"
                  ? <p>PowerPoint（.pptx）を開くか新規に作ると、スライドが 1 つのプレゼンテーションとしてここにまとまります。</p>
                  : <p>新規に作ると、投稿画像が 1 つの投稿としてここにまとまります。</p>}
                <button className="primary" disabled={busy} onClick={createNew}>{newLabel}</button>
              </>}
            </div>
          )
        )}

        {tab === "images" && files && (
          shownFiles.length ? (
            <ul className="lib-grid images">
              {shownFiles.map((f) => (
                <li key={f.name} className="lib-card">
                  <button className="lib-thumb img" onClick={() => setPreview(f)} title="拡大して表示">
                    <img src={f.src} alt={f.name} loading="lazy" />
                    <span className={"badge " + (f.usedBy.length ? "" : "muted")}>{f.usedBy.length ? "使用中" : "未使用"}</span>
                  </button>
                  <div className="lib-info">
                    <strong className="lib-title mono" title={f.name}>{f.name}</strong>
                    <small>{f.uploaded ? "取り込み" : "AI 生成"} ・ {fmtSize(f.size)} ・ {fmtDate(f.mtime)}</small>
                    {f.usedBy.length > 0 && (
                      <small className="used-by">
                        {f.usedBy.map((id) => {
                          const p = posterById.get(id);
                          return p ? <button key={id} className="link" onClick={() => openInEditor(p, deckOfSlide.has(id) ? modeOfDeck(deckOfSlide.get(id)) : "poster")}>{titleOf.get(id)}</button> : <span key={id}>編集中の{itemLabel}</span>;
                        })}
                      </small>
                    )}
                  </div>
                  <div className="lib-actions">
                    <a className="as-button small" href={f.src} download={f.name}>ダウンロード</a>
                    {!f.usedBy.length && <button className="small danger" disabled={busy} onClick={() => removeFiles([f.name])}>削除</button>}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="lib-empty"><p>{query || imageFilter !== "all" ? "条件に一致する画像はありません。" : "まだ画像はありません。"}</p></div>
          )
        )}

        {!error && (!posters || !decks || !files) && <p className="lib-empty">読み込み中…</p>}
      </main>

      {preview && (
        <div className="lib-preview" role="dialog" aria-label={preview.name} onClick={() => setPreview(null)} onKeyDown={(e) => e.key === "Escape" && setPreview(null)}>
          <img src={preview.src} alt={preview.name} />
          <button autoFocus onClick={() => setPreview(null)} aria-label="閉じる">✕</button>
        </div>
      )}
    </div>
  );
}
