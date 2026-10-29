import { useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import { TRANS_EFFECT_LABEL } from "../transition";
import { importPptx } from "../import/pptx";
import { buildDeckPptx, download, renderSpecPng } from "../render/export";
import { IG_MAX_IMAGES, IG_RATIOS, resizeCanvas, type IgRatio } from "../instagram";
import { preloadImages } from "../render/useRenderReady";
import { applyFonts, specTexts } from "../fonts";
import { slideContent } from "../notes";
import { PosterSpecSchema, type PosterSpec } from "../schema";
import type { resolveTheme } from "../themes";
import { deckSubject, watchWork, WORK_CHANGED_MESSAGE } from "./aiSubject";
import { desktopBridge } from "./desktop";
import { api, type ChatContext, type Deck, type DeckKind, type RefImage } from "./api";
import { addPageNumber, renumberPages } from "./pageNumbers";
import { diffLayers, safeFileName } from "./specOps";
import { readPref, writePref } from "./storage";
import type { Busy, Notice } from "./Toasts";
import { ask } from "./ui";
import type { useAutoSave } from "./useAutoSave";
import type { HistoryStacks } from "./useHistory";

const DECK_OPEN_KEY = "dc-designer:deck-open";
/** 台本を一度に書かせるスライドの枚数（多すぎると 1 回の応答が長くなり、途中で切れやすい） */
const NOTES_BATCH = 8;
/** 全スライドへの指示を同時に頼むスライドの枚数（多すぎると ChatGPT の利用上限に当たりやすい） */
const EDIT_PARALLEL = 3;

/** spec が描く画像の URL（レイヤー・部品の props の src） */
const imageSrcs = (spec: PosterSpec) => {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "src" && typeof x === "string" && x) out.push(x);
        else walk(x);
      }
    }
  };
  walk(spec.layers);
  return out;
};

/**
 * PPTX エディターモード（デッキ）: スライドの切り替え・追加・複製・削除・並べ替え、全スライドの書き出し、
 * フォントの一括適用、.pptx の読み込み。
 * Instagram の投稿（kind: "instagram"）も同じ仕組みで、スライドの代わりにカルーセルの画像を並べる
 */
export function useDeck({ spec, theme, save, apiUp, busy, run, notify, exported, setBusyProgress, setSpec, resetSpec, stashHistory, setSelected, fitView }: {
  spec: PosterSpec;
  theme: ReturnType<typeof resolveTheme>;
  save: ReturnType<typeof useAutoSave>;
  apiUp: boolean;
  busy: Busy | null;
  /** 時間のかかる処理を実行中として表示し、失敗を通知する */
  run: (label: string, fn: (signal: AbortSignal) => Promise<void>, opts?: { cancelable?: boolean }) => Promise<void>;
  notify: (n: Omit<Notice, "id">) => void;
  /** 書き出し完了の通知 */
  exported: (name: string) => void;
  setBusyProgress: (done: number, total: number) => void;
  setSpec: (s: PosterSpec) => void;
  /** 開いている文書を差し替える（stacks を渡すとその文書の Undo/Redo の続きから） */
  resetSpec: (s: PosterSpec, stacks?: HistoryStacks<PosterSpec>) => void;
  /** 開いている文書の Undo/Redo の履歴を取り出す */
  stashHistory: () => HistoryStacks<PosterSpec>;
  setSelected: (id: string | null) => void;
  fitView: () => void;
}) {
  const W = spec.meta.width, H = spec.meta.height;
  const { posterId, posterIdRef, specRef, saveBeforeSwitch } = save;

  // スライド 1 枚 = 成果物（ポスター）1 件。デッキはその並び順。開いているポスターがデッキに入っていればスライド一覧を出す。
  // プロジェクトを開いたときに全スライドの中身をまとめて読み込んで手元に持ち、切り替えはサーバーを待たずにその場で行う
  const [deck, setDeckState] = useState<Deck | null>(null);
  const deckRef = useRef<Deck | null>(null);
  const setDeck = (d: Deck | null) => { deckRef.current = d; setDeckState(d); };
  /** 開いている成果物がデッキに入っているかを調べ終えたか（入っていなければ単体のポスター。モードの判定に使う） */
  const [deckReady, setDeckReady] = useState(false);
  /**
   * スライド ID → 中身。開いているスライドの分は切り替えたときの内容で止まっているので、
   * 読むときは specOf を使う（開いているスライドは編集中の spec を返す）
   */
  const [slides, setSlidesState] = useState<ReadonlyMap<string, PosterSpec>>(new Map());
  const slidesRef = useRef<ReadonlyMap<string, PosterSpec>>(slides);
  const putSlides = (fn: (m: Map<string, PosterSpec>) => void) => {
    const m = new Map(slidesRef.current);
    fn(m);
    slidesRef.current = m;
    setSlidesState(m);
  };
  /** スライドごとの Undo/Redo の履歴（切り替えても戻れば続きから元に戻せる） */
  const histories = useRef(new Map<string, HistoryStacks<PosterSpec>>());
  const specOf = (id: string): PosterSpec | undefined => (id === posterIdRef.current ? specRef.current : slidesRef.current.get(id));

  // スライド一覧は細い帯に畳める（閉じても帯から開き直せる）
  const [deckOpen, setDeckOpen] = useState(() => readPref(DECK_OPEN_KEY) !== "0");
  const toggleDeck = (open: boolean) => { setDeckOpen(open); writePref(DECK_OPEN_KEY, open ? "1" : "0"); };

  /** サーバーから受け取ったデッキ（spec 付き）を、全スライドを手元に持った状態で開く */
  const loadDeck = (d: Deck) => {
    const m = new Map<string, PosterSpec>();
    for (const s of d.slides) {
      if (!s.spec) continue;
      m.set(s.id, s.spec);
      save.markSaved(s.id, s.spec);
    }
    slidesRef.current = m;
    setSlidesState(m);
    histories.current.clear();
    preloadImages([...m.values()].flatMap(imageSrcs));
    setDeck({ ...d, slides: d.slides.map(({ spec: _, ...s }) => s) });
  };
  useEffect(() => {
    if (!posterId || !apiUp) { setDeck(null); setDeckReady(false); return; }
    // 同じデッキの中での切り替えでは読み直さない
    if (deckRef.current?.slides.some((s) => s.id === posterId)) return;
    let alive = true;
    setDeckReady(false);
    (async () => {
      const { deck: d } = await api.deckOf(posterId);
      // spec を付けない古い API サーバーでも、全スライドをまとめて読み込んでから開く
      const full = d && { ...d, slides: await Promise.all(d.slides.map(async (s) => (s.spec ? s : { ...s, spec: (await api.poster(s.id)).spec }))) };
      if (!alive) return;
      if (full) loadDeck(full);
      else setDeck(null);
      setDeckReady(true);
    })().catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posterId, apiUp]);

  /**
   * 別のスライド（成果物）に切り替える。手元にあるスライドならサーバーを待たずにその場で切り替え、
   * 今のスライドの未保存の編集は裏で保存する。デッキの外の成果物（PPTX を読み込む前のポスターなど）はサーバーから読む
   */
  const openSlide = async (id: string): Promise<PosterSpec> => {
    const cur = posterIdRef.current;
    if (id === cur) return specRef.current;
    let next = slidesRef.current.get(id);
    if (!next) {
      await saveBeforeSwitch();
      next = (await api.poster(id)).spec;
      save.markSaved(id, next);
    }
    if (cur && slidesRef.current.has(cur)) {
      const leaving = specRef.current;
      histories.current.set(cur, stashHistory());
      putSlides((m) => m.set(cur, leaving));
    }
    save.switchTo(id, next);
    resetSpec(next, histories.current.get(id));
    setSelected(null);
    fitView();
    return next;
  };
  /** 別のスライドの中身を書き換える（開いているスライドなら編集として、ほかは手元を書き換えて裏で保存） */
  const updateSlide = (id: string, next: PosterSpec) => {
    if (id === posterIdRef.current) { setSpec(next); return; }
    putSlides((m) => m.set(id, next));
    save.saveOther(id, next);
  };
  /** 新しく作ったスライドを手元に加える（サーバーに保存済みのもの） */
  const addLocal = (id: string, s: PosterSpec) => {
    save.markSaved(id, s);
    putSlides((m) => m.set(id, s));
  };
  const dropLocal = (id: string) => {
    save.forget(id);
    histories.current.delete(id);
    putSlides((m) => m.delete(id));
  };

  const instagram = deck?.kind === "instagram";
  /** 1 枚の呼び方 */
  const unit = instagram ? "画像" : "スライド";
  /** Instagram のカルーセルは 20 枚まで */
  const full = instagram && !!deck && deck.slides.length >= IG_MAX_IMAGES;

  const deckAction = (label: string, fn: (d: Deck) => Promise<void>) => {
    if (!deck || busy) return;
    return run(label, () => fn(deck));
  };
  const checkFull = () => {
    if (!full) return false;
    notify({ kind: "info", text: `Instagram の投稿に入れられる画像は ${IG_MAX_IMAGES} 枚までです` });
    return true;
  };
  const addSlide = () => !checkFull() && deckAction(`${unit}を追加中`, async (d) => {
    const blank = PosterSpecSchema.parse({
      meta: { title: `${d.name} ${d.slides.length + 1}`, width: W, height: H },
      theme: spec.theme,
      layers: [{ id: "bg", name: "背景", type: "background", fill: "#ffffff" }],
    });
    const r = await api.addDeckSlide(d.id, { spec: blank, after: posterIdRef.current ?? undefined });
    addLocal(r.poster.id, r.poster.spec);
    setDeck(r.deck);
    await openSlide(r.poster.id);
  });
  const duplicateSlide = () => !checkFull() && deckAction(`${unit}を複製中`, async (d) => {
    // 保存を待たずに、編集中の内容をそのまま複製する
    const cur = specRef.current;
    const copy = { ...cur, meta: { ...cur.meta, title: `${cur.meta.title} のコピー` } };
    const r = await api.addDeckSlide(d.id, { spec: copy, after: posterIdRef.current! });
    addLocal(r.poster.id, r.poster.spec);
    setDeck(r.deck);
    await openSlide(r.poster.id);
  });
  const removeSlide = async () => {
    if (!deck || !posterIdRef.current) return;
    const i = deck.slides.findIndex((s) => s.id === posterIdRef.current);
    if (!await ask({ title: `${unit} ${i + 1} を削除しますか？`, message: `「${spec.meta.title}」を削除します。この操作は取り消せません。`, ok: "削除", danger: true })) return;
    deckAction(`${unit}を削除中`, async (d) => {
      const id = posterIdRef.current!;
      const next = d.slides[i + 1]?.id ?? d.slides[i - 1]?.id;
      // 削除したスライドへ自動保存が走らないよう、先に隣のスライドへ移ってから消す
      if (next) await openSlide(next);
      dropLocal(id);
      setDeck(await api.removeDeckSlide(d.id, id));
    });
  };
  /** 開いていないスライドをまとめて削除する（チャットでスライドを統合したあと。確認は呼び出し側で行う） */
  const deleteSlides = async (ids: string[]) => {
    if (!deck) return;
    let d = deck;
    for (const id of ids) {
      if (id === posterIdRef.current) continue;
      dropLocal(id);
      d = await api.removeDeckSlide(d.id, id);
    }
    setDeck(d);
  };
  /** スライドの並びを ids に変える（見た目は先に並べ替え、失敗したら元に戻す） */
  const setOrder = (label: string, ids: string[]) => {
    if (!deck || busy) return;
    const before = deck;
    const byId = new Map(deck.slides.map((s) => [s.id, s]));
    setDeck({ ...deck, slides: ids.map((id) => byId.get(id)!) });
    return run(label, async () => {
      try {
        setDeck(await api.updateDeck(before.id, { slides: ids }));
      } catch (e) {
        setDeck(before);
        throw e;
      }
    });
  };
  const moveSlide = (dir: -1 | 1) => {
    if (!deck) return;
    const ids = deck.slides.map((s) => s.id);
    const i = ids.indexOf(posterIdRef.current!);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    return setOrder("並べ替え中", ids);
  };
  /** スライド id を並びの to 番目の隙間（0 = 先頭、slides.length = 末尾）へ動かす（ドラッグ＆ドロップ） */
  const reorderSlide = (id: string, to: number) => {
    if (!deck) return;
    const ids = deck.slides.map((s) => s.id);
    const from = ids.indexOf(id);
    if (from < 0 || to === from || to === from + 1) return;
    ids.splice(from, 1);
    ids.splice(to > from ? to - 1 : to, 0, id);
    return setOrder("並べ替え中", ids);
  };
  /** デッキの全スライドの spec（開いているスライドは編集中の内容） */
  const deckSpecs = (d: Deck) => d.slides.map((s) => specOf(s.id)!).filter(Boolean);
  const exportDeck = () => deckAction("PowerPoint を書き出し中", async (d) => {
    const blob = await buildDeckPptx(deckSpecs(d), setBusyProgress);
    const name = `${safeFileName(d.name)}.pptx`;
    download(blob, name);
    exported(name);
  });

  /** Instagram: 全画像を PNG（幅 1080px）で書き出す。1 枚なら PNG、複数なら番号付きの PNG をまとめた ZIP */
  const exportImages = () => deckAction("画像を書き出し中", async (d) => {
    const specs = deckSpecs(d);
    const base = safeFileName(d.name);
    const pngs: Blob[] = [];
    for (const [i, s] of specs.entries()) {
      setBusyProgress(i, specs.length);
      pngs.push(await renderSpecPng(s, 1080 / s.meta.width));
    }
    setBusyProgress(specs.length, specs.length);
    if (pngs.length === 1) {
      download(pngs[0], `${base}.png`);
      exported(`${base}.png`);
      return;
    }
    const zip = new JSZip();
    const digits = String(pngs.length).length;
    pngs.forEach((b, i) => zip.file(`${base}_${String(i + 1).padStart(Math.max(2, digits), "0")}.png`, b));
    download(await zip.generateAsync({ type: "blob" }), `${base}.zip`);
    exported(`${base}.zip（PNG ${pngs.length} 枚）`);
  });

  /** Instagram: 全画像の比率を変える（レイヤーは新しい大きさに合わせて並べ直す。「元に戻す」は通知から） */
  const changeRatio = async (ratio: IgRatio) => {
    if (!deck || busy) return;
    const { w, h, label } = IG_RATIOS[ratio];
    if (!await ask({
      title: `${label} に変えますか？`,
      message: `${deck.slides.length} 枚すべてを ${w}×${h} にし、文字や画像の位置・大きさを新しい比率に合わせて並べ直します。はみ出しや重なりが出たら、チャットで「レイアウトを整えて」と頼むと直せます。`,
      ok: "変更する",
    })) return;
    const before = new Map<string, PosterSpec>();
    for (const s of deck.slides) {
      const old = specOf(s.id);
      if (!old) continue;
      before.set(s.id, old);
      updateSlide(s.id, resizeCanvas(old, w, h));
    }
    setSelected(null);
    requestAnimationFrame(fitView);
    notify({
      kind: "success",
      text: `${deck.slides.length} 枚を ${label}（${w}×${h}）にしました`,
      action: { label: "元に戻す", run: () => { for (const [id, old] of before) updateSlide(id, old); requestAnimationFrame(fitView); } },
    });
  };

  // フォントの提案 → 全スライドに適用
  const [fontDialog, setFontDialog] = useState<{ texts: string[]; current: { display?: string; body?: string } } | null>(null);
  const openFontDialog = () => {
    if (!deck || busy) return;
    setFontDialog({ texts: deckSpecs(deck).flatMap(specTexts), current: { display: theme.fonts.display, body: theme.fonts.body } });
  };
  const applyDeckFonts = async (fonts: { display: string; body: string }) => {
    if (!deck) return;
    const before = new Map<string, PosterSpec>();
    for (const s of deck.slides) {
      const old = specOf(s.id);
      if (!old) continue;
      before.set(s.id, old);
      updateSlide(s.id, applyFonts(old, fonts));
    }
    notify({
      kind: "success",
      text: `${deck.slides.length} 枚のスライドに「${fonts.display}」（見出し）と「${fonts.body}」（本文）を適用しました`,
      action: {
        label: "元に戻す",
        run: () => { for (const [id, old] of before) updateSlide(id, old); },
      },
    });
  };

  /** 開いているスライドの画面切り替えを、ほかの全スライドにも付ける（「元に戻す」は通知から） */
  const applyTransitionToAll = () => {
    if (!deck) return;
    const t = spec.transition;
    const before = new Map<string, PosterSpec>();
    for (const s of deck.slides) {
      const old = specOf(s.id);
      if (!old || s.id === posterIdRef.current) continue;
      before.set(s.id, old);
      const { transition: _, ...rest } = old;
      updateSlide(s.id, t ? { ...rest, transition: t } : rest);
    }
    notify({
      kind: "success",
      text: t ? `${deck.slides.length} 枚すべてのスライドを「${TRANS_EFFECT_LABEL[t.effect]}」で切り替えるようにしました` : "すべてのスライドの画面切り替えを外しました",
      action: { label: "元に戻す", run: () => { for (const [id, old] of before) updateSlide(id, old); } },
    });
  };

  /**
   * 「右下のスライド番号の並びを直して」: 全スライドのページ番号をデッキの並び順に振り直す。
   * 番号の無いスライドがあれば、確認してから見本の番号を複製して足す（表紙＝1 枚目には足さない）。
   * 結果の要約を返す（チャットの返答に使う）。「元に戻す」は通知から
   */
  const renumberDeckPages = async (): Promise<{ text: string; changes?: string }> => {
    if (!deck) throw new Error("スライドのデッキを開いていません");
    const d = deck;
    const olds = deckSpecs(d);
    const r = renumberPages(olds, d.name);
    if (!r.template) return { text: "どのスライドにも、隅にページ番号のテキストが見つかりませんでした。番号が画像に含まれている場合は、テキストで番号を入れ直してから試してください" };
    const total = olds.length;
    const addable = r.missing.filter((n) => n !== 1);
    const add = addable.length > 0 && await ask({
      title: `スライド ${addable.join("・")} にも番号を付けますか？`,
      message: `これらのスライドには隅のページ番号がありません。ほかのスライドと同じ位置・書式で番号を追加します（表紙のスライド 1 には付けません）。「キャンセル」なら番号の無いスライドはそのままにします。`,
      ok: "追加する",
    });
    const nexts = r.specs.map((s, i) => (add && addable.includes(i + 1) ? addPageNumber(s, r.template!, i + 1, total) : s));
    const touched = d.slides.map((s, i) => ({ id: s.id, old: olds[i], next: nexts[i] })).filter((t) => t.next !== t.old);
    if (!touched.length) {
      const skip = r.missing.length ? `（番号が無いスライド: ${r.missing.join("・")}）` : "";
      return { text: `ページ番号はすでに 1〜${total} の順に並んでいました${skip}` };
    }
    for (const t of touched) updateSlide(t.id, t.next);
    notify({
      kind: "success",
      text: "ページ番号を振り直しました",
      action: {
        label: "元に戻す",
        run: () => { for (const t of touched) updateSlide(t.id, t.old); },
      },
    });
    const lines = r.changed.map((c) => `スライド ${c.slide}: ${c.from} → ${c.to}`);
    if (add) lines.push(`スライド ${addable.join("・")} に番号を追加`);
    const left = r.missing.filter((n) => !add || !addable.includes(n));
    if (left.length) lines.push(`スライド ${left.join("・")} は番号が無いのでそのままです`);
    return {
      text: `右下のページ番号を、今のスライドの並び（1〜${total}）に合わせて振り直しました。\n${lines.join("\n")}`,
      changes: [r.changed.length && `${r.changed.length} 枚の番号を修正`, add && `${addable.length} 枚に番号を追加`].filter(Boolean).join("・"),
    };
  };

  /**
   * AI でスライドに台本を書く。全スライドの文字・画像の説明と既存の台本（口調・長さのお手本）を渡し、一度に NOTES_BATCH 枚ずつ書かせる。
   * targets を省くと台本が空のスライドすべて、渡すとその番号のスライド（台本があれば書き直す）。request はユーザーの指示文（「短めに」など）。
   * 結果の要約を返す（チャットの返答に使う）。「元に戻す」は通知から
   */
  const writeNotes = async (signal: AbortSignal, opts: { targets?: number[]; request?: string } = {}): Promise<{ text: string; changes?: string }> => {
    if (!deck) throw new Error("スライドのデッキを開いていません");
    const d = deck;
    const specs = d.slides.map((s) => specOf(s.id));
    const missing = opts.targets ?? specs.flatMap((s, i) => (s && !s.notes?.trim() ? [i + 1] : []));
    if (!missing.length) return { text: "すべてのスライドに台本が書かれています" };
    const slides = specs.flatMap((s, i) => (s ? [{ number: i + 1, title: s.meta.title, ...slideContent(s), notes: s.notes }] : []));
    const written: { id: string; old: PosterSpec; n: number }[] = [];
    let stopped = "";
    setBusyProgress(0, missing.length);
    for (let i = 0; i < missing.length; i += NOTES_BATCH) {
      const targets = missing.slice(i, i + NOTES_BATCH);
      let res: Awaited<ReturnType<typeof api.writeNotes>>;
      try {
        const changed = watchWork(!!desktopBridge(), () => d.slides.map((s) => specOf(s.id)));
        res = await api.writeNotes({ title: d.name, slides, targets, request: opts.request, subject: deckSubject(d) }, signal);
        if (changed()) throw new Error(WORK_CHANGED_MESSAGE);
      } catch (e) {
        // 途中まで書けていれば、書けた分は残して（元に戻せるようにして）止める
        if (!written.length) throw e;
        stopped = signal.aborted ? "キャンセルしたため" : `エラーのため（${(e as Error)?.message ?? e}）`;
        break;
      }
      for (const r of res.notes) {
        const slide = d.slides[r.number - 1];
        // 待っている間に手で台本を書き換えたスライドは上書きしない
        const cur = slide && specOf(slide.id);
        if (!cur || (cur.notes ?? "") !== (specs[r.number - 1]?.notes ?? "") || !targets.includes(r.number)) continue;
        updateSlide(slide.id, { ...cur, notes: r.notes });
        written.push({ id: slide.id, old: cur, n: r.number });
        // 後の回で前後のつながり・口調を踏まえられるよう、書いた台本も文脈に入れる
        const ctx = slides.find((s) => s.number === r.number);
        if (ctx) ctx.notes = r.notes;
      }
      setBusyProgress(Math.min(i + NOTES_BATCH, missing.length), missing.length);
    }
    if (!written.length) return { text: "台本を書けませんでした。もう一度試してください" };
    notify({
      kind: "success",
      text: `${written.length} 枚のスライドに台本を書きました`,
      action: { label: "元に戻す", run: () => { for (const w of written) updateSlide(w.id, w.old); } },
    });
    const nums = written.map((w) => w.n).sort((a, b) => a - b);
    const left = missing.filter((n) => !nums.includes(n));
    return {
      text: `${opts.targets ? "" : "台本が無かった"}スライド ${nums.join("・")} に台本を書きました。${left.length ? `\nスライド ${left.join("・")} は${stopped ? `${stopped}途中で止めた` : "書けなかった"}のでそのままです（もう一度実行すると続きを書きます）` : ""}`,
      changes: `${nums.length} 枚に台本を${opts.targets ? "書く" : "追加"}`,
    };
  };

  /**
   * 「授業スライド全体の差し色を #F08C00 にして」: ふつうの修正は今のスライドしか書き換えないので、同じ指示を全スライドに 1 枚ずつ当てる。
   * 今のスライドを先に直し、その返答を方針としてほかのスライドに渡して直し方をそろえる（ほかは EDIT_PARALLEL 枚ずつ並べて頼む）。
   * 待っている間に手で直したスライドは上書きしない。途中で止まっても直せた分は残す。結果の要約と、直したスライドの id を返す。「元に戻す」は通知から
   */
  const editAcrossDeck = async (signal: AbortSignal, instruction: string, chat?: ChatContext, references?: RefImage[]): Promise<{ text: string; changes?: string; ids: string[] }> => {
    if (!deck) throw new Error("スライドのデッキを開いていません");
    const d = deck;
    const total = d.slides.length;
    const cur = Math.max(d.slides.findIndex((s) => s.id === posterIdRef.current), 0);
    const order = [cur, ...d.slides.keys()].filter((i, k, a) => a.indexOf(i) === k);
    const done: { id: string; old: PosterSpec; n: number }[] = [];
    const replies: string[] = [];
    let guide: string | undefined;
    let failed = 0, finished = 0;
    let stopped = "";
    setBusyProgress(0, total);
    const editOne = async (i: number) => {
      const slide = d.slides[i];
      const old = specOf(slide.id);
      if (!old) return;
      try {
        const res = await api.edit(old, instruction, undefined, signal, undefined, chat, instagram || undefined, { number: i + 1, total, guide }, references, deckSubject(d));
        if (signal.aborted) return;
        if (i === cur && res.reply) guide = res.reply;
        if (!res.spec || !diffLayers(old, res.spec).hasChanges || specOf(slide.id) !== old) return;
        updateSlide(slide.id, res.spec);
        done.push({ id: slide.id, old, n: i + 1 });
        if (res.reply) replies.push(res.reply);
      } catch (e) {
        if (signal.aborted) { stopped = "キャンセルしたため"; return; }
        failed++;
        stopped ||= `エラーのため（${(e as Error)?.message ?? e}）`;
      } finally {
        setBusyProgress(++finished, total);
      }
    };
    await editOne(order[0]);
    const rest = order.slice(1);
    for (let k = 0; k < rest.length && !signal.aborted; k += EDIT_PARALLEL) await Promise.all(rest.slice(k, k + EDIT_PARALLEL).map(editOne));
    if (signal.aborted && !done.length) throw new Error("aborted");
    if (!done.length) {
      if (failed) throw new Error(`どのスライドも直せませんでした${stopped ? `（${stopped.replace(/のため$/, "")}）` : ""}`);
      return { text: guide ? `${guide}\n（どのスライドにも変更はありませんでした）` : "どのスライドにも変更はありませんでした", ids: [] };
    }
    notify({
      kind: "success",
      text: `${done.length} 枚の${unit}を修正しました`,
      action: { label: "元に戻す", run: () => { for (const w of done) updateSlide(w.id, w.old); } },
    });
    const nums = done.map((w) => w.n).sort((a, b) => a - b);
    const untouched = d.slides.map((_, i) => i + 1).filter((n) => !nums.includes(n));
    const note = signal.aborted || failed
      ? `\n${unit} ${untouched.join("・")} は${stopped || "途中で止まったため"}そのままです（もう一度送ると続きを直します）`
      : untouched.length ? `\n${unit} ${untouched.join("・")} は当てはまる箇所が無かったのでそのままです` : "";
    return { text: `${guide ?? replies[0] ?? "修正しました"}\n${unit} ${nums.join("・")} に反映しました。${note}`, changes: `${nums.length} 枚の${unit}を変更`, ids: done.map((w) => w.id) };
  };

  /**
   * チャットの「最後にクロージングのスライドを 1 枚追加して」: デッキ全体の文字と前後のスライド（見た目のお手本）を渡して AI に 1 枚作らせ、
   * 追加後のスライド番号が position になるように入れて開く。既存のスライドは変えない。結果の要約を返す（チャットの返答に使う）。「元に戻す」は通知から
   */
  const addSlideByAI = async (signal: AbortSignal, instruction: string, position: number, chat?: ChatContext, references?: RefImage[]): Promise<{ text: string; changes?: string; spec?: PosterSpec }> => {
    if (!deck) throw new Error("スライドのデッキを開いていません");
    if (full) return { text: `Instagram の投稿に入れられる画像は ${IG_MAX_IMAGES} 枚までです` };
    const d = deck;
    const total = d.slides.length;
    const specs = d.slides.map((s) => specOf(s.id));
    const outline = specs.flatMap((s, i) => (s ? [{ number: i + 1, title: s.meta.title, texts: slideContent(s).texts }] : []));
    // 見た目のお手本: 入れる位置の前後のスライドと、表紙（クロージングのような見出しだけのスライドのお手本になる）
    const samples = [...new Set([position - 1, position, 1])].flatMap((n) => {
      const sp = specs[n - 1];
      return sp ? [{ number: n, title: sp.meta.title, spec: sp }] : [];
    });
    const changed = watchWork(!!desktopBridge(), () => [deckRef.current, ...d.slides.map((s) => specOf(s.id))]);
    const res = await api.planSlide({ instruction, position, total, title: d.name, outline, samples, references, subject: deckSubject(d), ...(instagram ? { instagram } : {}) }, chat, signal);
    if (changed()) throw new Error(WORK_CHANGED_MESSAGE);
    if (signal.aborted) throw new Error("aborted");
    const r = await api.addDeckSlide(d.id, { spec: res.spec, after: d.slides[Math.max(position - 2, 0)].id });
    let nd = r.deck;
    // 先頭に入れるときは、1 枚目の後ろに入れてから先頭へ動かす
    if (position === 1) nd = await api.updateDeck(d.id, { slides: [r.poster.id, ...nd.slides.map((s) => s.id).filter((id) => id !== r.poster.id)] });
    addLocal(r.poster.id, r.poster.spec);
    setDeck(nd);
    await openSlide(r.poster.id);
    const added = r.poster.id;
    notify({
      kind: "success",
      text: `${unit} ${position} を追加しました`,
      action: {
        label: "元に戻す",
        run: () => run(`${unit}を削除中`, async () => {
          const cur = deckRef.current;
          const i = cur?.slides.findIndex((s) => s.id === added) ?? -1;
          if (!cur || i < 0) return;
          // 削除したスライドへ自動保存が走らないよう、先に隣のスライドへ移ってから消す
          if (posterIdRef.current === added) {
            const next = cur.slides[i - 1]?.id ?? cur.slides[i + 1]?.id;
            if (next) await openSlide(next);
          }
          dropLocal(added);
          setDeck(await api.removeDeckSlide(cur.id, added));
        }),
      },
    });
    return { text: res.reply || `${unit} ${position} を追加しました`, changes: `${unit} ${position} を追加`, spec: r.poster.spec };
  };

  /**
   * spec の並びから新しいデッキ（成果物）を作って 1 枚目を開く。開いていた成果物はそのまま残り、通知から戻れる。
   * 作ったデッキの全スライドの中身を返す（開いたあとの画像生成などに使う）
   */
  const openNewDeck = async (name: string, specs: PosterSpec[], kind: DeckKind | undefined, notice: Omit<Notice, "id" | "action">) => {
    const before = spec;
    const prevId = posterIdRef.current;
    await saveBeforeSwitch();
    const created = await api.createDeck(name, specs, kind);
    // 作ったスライドの中身は渡した spec そのもの（サーバーに問い合わせ直さない）
    const parsed = specs.map((s) => PosterSpecSchema.parse(s));
    loadDeck({ ...created, slides: created.slides.map((s, i) => ({ ...s, spec: parsed[i] })) });
    toggleDeck(true);
    await openSlide(created.slides[0].id);
    notify({
      ...notice,
      action: prevId ? { label: "元の成果物に戻る", run: () => { openSlide(prevId).catch(() => { resetSpec(before); }); } } : undefined,
    });
    return created.slides.map((s, i) => ({ id: s.id, spec: parsed[i] }));
  };

  /** .pptx を読み込み、スライドごとの成果物とデッキを作って 1 枚目を開く */
  const importPptxFile = (file: File) => run("PowerPoint を読み込み中", async (signal) => {
    const res = await importPptx(file, file.name, {
      signal,
      onImage: async (blob, mediaType) => (await api.uploadBlob(blob, mediaType)).src,
      onProgress: setBusyProgress,
    });
    if (signal.aborted) return;
    const warn = res.warnings.length ? `（読み込めなかった要素: ${res.warnings.join("、")}）` : "";
    await openNewDeck(res.name, res.slides, undefined, {
      kind: res.warnings.length ? "info" : "success",
      text: `${file.name} の ${res.slides.length} 枚のスライドを読み込みました${warn}`,
    });
  }, { cancelable: true });

  return {
    deck, slides, specOf, deckOpen, toggleDeck, openSlide, updateSlide, addSlide, duplicateSlide, removeSlide, deleteSlides, moveSlide, reorderSlide, exportDeck,
    fontDialog, setFontDialog, openFontDialog, applyDeckFonts, applyTransitionToAll, renumberDeckPages, writeNotes, addSlideByAI, editAcrossDeck, importPptxFile,
    instagram, full, exportImages, changeRatio, openNewDeck, deckReady,
  };
}
