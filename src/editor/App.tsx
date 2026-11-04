import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type DragEvent as RDragEvent } from "react";
import { slideContent } from "../notes";
import { Poster } from "../render/Poster";
import { renderSpecPng } from "../render/svg";
import { A4Check } from "./A4Check";
import { a4Fit, a4Instruction, a4Issues, fitToA4, SAFE_MARGIN_MM } from "./a4";
import { cropTarget } from "../render/ImageBox";
import { useRenderReady } from "../render/useRenderReady";
import { findPendingAssets, type AssetRequest, type Layer, type PosterSpec, type TextLayerT } from "../schema";
import { textStyleKey, toggleTextStyle } from "./textStyle";
import { summarizeDeckDesign, type DeckDesign } from "../deckDesign";
import { resolveTheme } from "../themes";
import { applyFonts, specTexts } from "../fonts";
import { workSubject, watchWork, WORK_CHANGED_MESSAGE, type AiSubject } from "./aiSubject";
import { desktopBridge, useDesktopVersion } from "./desktop";
import { api, type AIProgress, type DeckEditContext, type RefImage } from "./api";
import { planDeckSequence } from "./deckSequence";
import { AccountBar, ModelSelect, WelcomeModal } from "./AccountBar";
import { unionBox } from "./canvas";
import { CanvasOverlay, MeasureLabel, type CropState } from "./CanvasOverlay";
import { ChatLog, useChat, type ChatMsg } from "./ChatLog";
import { DeckStrip } from "./DeckStrip";
import { Resizer } from "./usePanelSize";
import { DECK_CHROME_H, NOTES_CHROME_H, usePanelLayout } from "./usePanelLayout";
import { useProviders } from "./useProviders";
import { createLayerOps, layerName } from "./layerOps";
import { useAnimationOps } from "./useAnimationOps";
import { useA4Export } from "./useA4Export";
import { FontDialog } from "./FontDialog";
import { Inspector, ShortcutList, TransitionBox } from "./Inspector";
import { LayersPanel } from "./LayersPanel";
import { blockPageFileDrop } from "./fileDrop";
import { useFileDrop } from "./useFileDrop";
import { NotesPanel } from "./NotesPanel";
import { Presenter } from "./Presenter";
import { openPresenterWindow } from "./PresenterView";
import { HOME_URL, IMPORT_NOTICE_KEY, loadInitialSpec, PENDING_BRIEF_KEY } from "./nav";
import { modeHomeUrl, modeLibraryUrl, modeOfDeck, MODES, readModeParam, writeLastId, type AppMode } from "./mode";
import { slideRefs } from "./slideRefs";
import { slidePalette } from "./slidePalette";
import { imagePromptOf, isImageRedoRequest, isImageRequest, isTransparentRequest, routeChatRequest } from "./chatRoute";
import { slashSuggestions, SlashMenu, type SlashCommand } from "./slashCommands";
import {
  aspectOf, assetHolder, diffLayers, IMAGE_FILE_ACCEPT, IMAGE_FILE_TYPES, imageSlot, insertAfter, placeImage, replaceableByImage,
  naturalSize, patchAsset, PPTX_ACCEPT, prepareAsset, toLayerRef, uid, type LayerRef,
} from "./specOps";
import { blobToRef, loadImage, overlayOf, REF_OVERLAY_ID, referenceSize, resolveRefCrops, scaledReference, withOverlay, withoutOverlay } from "./reproduce";
import { readPref, STORAGE_KEY } from "./storage";
import { TextEditor } from "./TextEditor";
import { Toasts, useNotices, type Busy, type Notice } from "./Toasts";
import { ask, askChoice, Menu, RenderLoading, ThemeMenu } from "./ui";
import { Ico } from "./uiIcons";
import { useAutoSave } from "./useAutoSave";
import { topLayerAt, useCanvasPointer } from "./useCanvasPointer";
import { useDeck } from "./useDeck";
import { useChatGPTAuth } from "./useChatGPTAuth";
import { useHistory } from "./useHistory";
import { useZoom } from "./useZoom";
import { MAX_REFERENCES, MAX_REFERENCE_DATA_BYTES } from "../referenceLimits";
import { REFERENCE_FILE_ACCEPT, readReferenceFile, toReferenceImages, type ReferencePage } from "./referenceFiles";
import { ImageAttach } from "./ImageAttach";
import { failureReason } from "./imageErrors";
import { ReferenceAttachments } from "./ReferenceAttachments";

const CHAT_EXAMPLES = ["タイトルをもっと大きく目立たせて", "全体を落ち着いた配色にして", "日時と場所を見やすく整理して"];
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
/** 矢印キーでの移動量（Shift で 10px） */
const arrowDelta = (e: KeyboardEvent): [number, number] | undefined => {
  const step = e.shiftKey ? 10 : 1;
  return ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, [number, number]>)[e.key];
};
const isTextInput = (t: EventTarget | null) => {
  const el = t as HTMLElement;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
};


/** ホームで入力されたブリーフ（あればエディタを開いてすぐ AI に作らせる）。一度読んだら消す */
const takePendingBrief = () => {
  try {
    const v = sessionStorage.getItem(PENDING_BRIEF_KEY);
    if (v) sessionStorage.removeItem(PENDING_BRIEF_KEY);
    return v?.trim() ? v : null;
  } catch { return null; }
};


/** 画像の縦横比（幅/高さ）。読み込むまでは undefined */
function useImageRatio(src?: string) {
  const [r, setR] = useState<{ src: string; ratio: number } | null>(null);
  useEffect(() => {
    if (!src) return;
    let alive = true;
    const img = new Image();
    img.onload = () => { if (alive && img.naturalWidth && img.naturalHeight) setR({ src, ratio: img.naturalWidth / img.naturalHeight }); };
    img.src = src;
    return () => { alive = false; };
  }, [src]);
  return r && r.src === src ? r.ratio : undefined;
}

export function App() {
  const { state: spec, set: setSpec, reset: resetSpec, stash: stashHistory, undo, redo, canUndo, canRedo } = useHistory<PosterSpec>(loadInitialSpec());
  const W = spec.meta.width, H = spec.meta.height;
  const theme = resolveTheme(spec.theme, spec.themeOverride);
  const pending = useMemo(() => findPendingAssets(spec), [spec]);
  const appVersion = useDesktopVersion();

  // ---------- 選択 ----------
  // 範囲選択・Shift+クリックで複数選べる。1 件だけのときはインスペクター等で編集できる
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const setSelected = useCallback((id: string | null) => setSelectedIds(id ? [id] : []), []);
  const [hovered, setHovered] = useState<string | null>(null);
  // Undo などで消えたレイヤーは選択から外れたものとして扱う（重ね順どおり）
  const selLayers = spec.layers.filter((l) => selectedIds.includes(l.id));
  const selectedLayer = selLayers.length === 1 ? selLayers[0] : null;
  const selected = selectedLayer?.id ?? null;
  const multi = selLayers.length > 1;
  const hoveredLayer = spec.layers.find((l) => l.id === hovered) ?? null;
  const topIds = useMemo(() => new Set(spec.layers.map((l) => l.id)), [spec.layers]);

  // ---------- 状態表示 ----------
  const [busy, setBusy] = useState<Busy | null>(null);
  const setBusyProgress = (done: number, total: number) => setBusy((b) => b && { ...b, progress: [done, total] });
  const { notices, notify, dismiss } = useNotices();
  useEffect(() => {
    try {
      const text = sessionStorage.getItem(IMPORT_NOTICE_KEY);
      if (text) { sessionStorage.removeItem(IMPORT_NOTICE_KEY); notify({ kind: "info", text }); }
    } catch { /* ストレージが使えなければ案内を省く */ }
  }, []);

  // ---------- サーバーの状態（ChatGPT・画像生成） ----------
  const {
    status, setStatus, refreshStatus, apiUp, gpt, aiProvider, openrouter, aiReady, aiName,
    autoImages, toggleAutoImages, imageChoices, activeImageProvider, chooseImageProvider,
    chooseChatGPTModel, chooseOpenRouterModel, chooseAIProvider,
  } = useProviders(notify);
  const {
    leftOpen, toggleLeft, rightOpen, toggleRight, leftW, setLeftW, rightW, setRightW, resizing, setResizing, leftRef, rightRef,
    deckH, setDeckH, deckHeight, deckMax, notesOpen, toggleNotes, notesH, setNotesH, notesHeight, notesMax,
    layersOpen, toggleLayers,
  } = usePanelLayout();

  // ---------- 保存 ----------
  const save = useAutoSave(spec, setSpec, apiUp, resetSpec);
  const { posterId, posterIdRef } = save;
  const saveNow = async () => {
    if (save.savingNow) return;
    if (await save.saveNow()) notify({ kind: "success", text: "保存しました" });
    else notify({ kind: "error", text: "保存できませんでした。API サーバーが起動しているか確認してください（ブラウザには保存済みで、復帰後に自動で保存します）" });
  };
  /** 今の内容をテンプレートとして保存する（ポスターは 1 枚、スライドはデッキ丸ごと）。サーバーの保存済みの中身から作るので、先に未保存の編集を確定する */
  const saveAsTemplate = async () => {
    if (save.savingNow) return;
    const target = deck ? { deckId: deck.id } : posterIdRef.current ? { posterId: posterIdRef.current } : null;
    if (!target || !await save.saveNow()) {
      notify({ kind: "error", text: "テンプレートを保存できませんでした。先に成果物を保存できるか（API サーバーが起動しているか）確認してください" });
      return;
    }
    try {
      const t = await api.createTemplate(target);
      notify({ kind: "success", text: `テンプレート『${t.name}』を保存しました。ホームの『テンプレートから作る』から使えます` });
    } catch (e) {
      notify({ kind: "error", text: `テンプレートを保存できませんでした${e instanceof Error && e.message ? `（${e.message}）` : ""}` });
    }
  };
  const leaveTo = async (url: string) => {
    // 保存できないまま移ると、別の成果物を開いたときにブラウザの控えも置き換わって編集内容を失う（裏で保存中のスライドも待つ）
    if (!await save.flushAll() && !await ask({
      title: "保存できていません",
      message: "編集内容を成果物に保存できませんでした（API サーバーが起動しているか確認してください）。このまま移動して別の成果物を開くと、保存していない編集内容は失われます。",
      ok: "移動する",
      danger: true,
    })) return;
    location.href = url;
  };

  // ---------- AI 入力欄・チャット ----------
  const pendingBrief = useRef<string | null>(takePendingBrief());
  const [aiTab, setAiTab] = useState<"plan" | "chat">(() => (pendingBrief.current || !readPref(STORAGE_KEY) ? "plan" : "chat"));
  const [brief, setBrief] = useState(pendingBrief.current ?? "");
  const [refs, setRefs] = useState<(ReferencePage & { w: number; h: number })[]>([]);
  const [readingRefs, setReadingRefs] = useState(false);
  const readingRefsLock = useRef(false);
  const referenceCaption = refs.length ? `\n\n添付資料（画像の順番）:\n${refs.map((r, i) => `${i + 1}. ${r.name}`).join("\n")}` : "";
  /** 参考画像（1 枚目）を雰囲気の参考ではなく、見た目そのままに再現する */
  const [reproduce, setReproduce] = useState(false);
  const [instruction, setInstruction] = useState("");
  /** / コマンドの候補: 選択中の位置と、Esc で閉じたか（入力を変えると開き直す） */
  const [slashActive, setSlashActive] = useState(0);
  const [slashClosed, setSlashClosed] = useState(false);
  /** チャットの区切りに出す名前。デッキのスライドは名前ではなく番号（useDeck の後で差し替える） */
  const chatTitle = useRef(() => spec.meta.title);
  const chat = useChat({ ready: !!aiProvider, posterId, posterTitle: () => chatTitle.current() });

  // ---------- キャンバス ----------
  const svgRef = useRef<SVGSVGElement>(null);
  const renderReady = useRenderReady(svgRef);
  const stageRef = useRef<HTMLDivElement>(null);
  const clipboard = useRef<Layer[]>([]);
  /** AI の変更箇所を一瞬ハイライトする */
  const [flash, setFlash] = useState<string[]>([]);
  /** AI が変えた・足したレイヤーを少しの間だけ光らせる */
  const flashLayers = (ids: string[]) => { setFlash(ids); setTimeout(() => setFlash([]), 1800); };
  /** 画像生成中の "レイヤーID|パス" */
  const [generating, setGenerating] = useState<Set<string>>(new Set());
  const generatingIds = useMemo(() => new Set([...generating].map((k) => k.split("|")[0])), [generating]);
  /** トリミング中（ホイールで画像を拡大縮小する）なら true を返す */
  const cropWheel = useRef<((deltaY: number) => boolean) | null>(null);
  const { zoom, setZoom, scale, pan, panning, zoomBy, fitView, startPanView } = useZoom(stageRef, W, H, cropWheel);
  const px = 1 / scale; // 画面 1px をポスター座標に換算

  // 枠内で画像を拡大・移動する「トリミング」モード中のレイヤー
  const [cropping, setCropping] = useState<string | null>(null);
  // 選択中の画像の縦横比（枠からはみ出した分まで上下左右に動かせるように）。contain では使わない
  const selCrop = selectedLayer ? cropTarget({ ...selectedLayer, locked: false } as Layer) : null;
  const imageRatio = useImageRatio(selCrop?.src);
  const cropRatio = selCrop?.fit === "cover" ? imageRatio : undefined;
  const cropInfo = selectedLayer?.id === cropping ? cropTarget(selectedLayer) : null;
  const crop: CropState | null = selectedLayer && cropInfo ? { layer: selectedLayer, info: cropInfo, ratio: cropRatio } : null;
  // 選択が変わったらトリミングモードは終える
  useEffect(() => { if (cropping && cropping !== selected) setCropping(null); }, [cropping, selected]);

  /** キャンバス上で直接編集中のテキスト（at はダブルクリック位置） */
  const [textEdit, setTextEdit] = useState<{ id: string; at?: { x: number; y: number }; key: string } | null>(null);
  const editLayer = textEdit && selectedLayer?.id === textEdit.id && selectedLayer.type === "text" && !selectedLayer.locked ? selectedLayer : null;
  useEffect(() => { if (textEdit && !editLayer) setTextEdit(null); }, [textEdit, editLayer]);
  const startTextEdit = (id: string, at?: { x: number; y: number }) => setTextEdit({ id, at, key: `text-${id}-${Date.now()}` });

  const selHolder = assetHolder(selectedLayer);
  // ---------- Sign in with ChatGPT ----------
  const { welcome, closeWelcome, signOut } = useChatGPTAuth({ status, setStatus, refreshStatus, notify });

  /** AI エラーの表示。ChatGPT の利用上限なら使用状況ページへの導線を付ける */
  const notifyAIError = (e: any) => {
    if (e?.code === "subscription_sharing_usage_limit_exceeded" && status) {
      notify({ kind: "error", text: "ChatGPT の利用上限に達しました。プランまたはこのアプリの上限を ChatGPT の設定で確認してください", action: { label: "使用状況を管理", run: () => window.open(status.chatgpt.usageUrl, "_blank", "noopener") } });
    } else if (e?.code === "chatgpt_auth" || e?.code === "subscription_sharing_invalid_user") {
      notify({ kind: "error", text: e.message, action: { label: "サインインし直す", run: api.chatgptLogin } });
      refreshStatus();
    } else notify({ kind: "error", text: e?.message ?? String(e) });
  };

  /** 直前の状態へ戻せる通知（破壊的な操作のあとに出す） */
  const notifyRestorable = (text: string, before: PosterSpec, kind: Notice["kind"] = "success") =>
    notify({ kind, text, action: { label: "元に戻す", run: () => { setSpec(before); setSelected(null); } } });

  // ポスター（デッキでないとき）のフォント提案 → このポスターに適用。デッキのときは useDeck の全スライド版を使う
  const [posterFontDialog, setPosterFontDialog] = useState(false);
  const applyPosterFonts = async (fonts: { display: string; body: string }) => {
    const before = spec;
    setSpec(applyFonts(before, fonts));
    notifyRestorable(`「${fonts.display}」（見出し）と「${fonts.body}」（本文）を適用しました`, before);
  };

  /** 時間のかかる処理を実行中として表示し、失敗を通知する */
  const run = async (label: string, fn: (signal: AbortSignal) => Promise<void>, opts: { cancelable?: boolean } = {}) => {
    const abort = new AbortController();
    setBusy({ label, startedAt: Date.now(), abort: opts.cancelable ? abort : undefined });
    try { await fn(abort.signal); }
    catch (e: any) {
      if (abort.signal.aborted) notify({ kind: "info", text: "キャンセルしました" });
      else notifyAIError(e);
    } finally { setBusy(null); }
  };

  const updateLayer = useCallback((id: string, patch: Partial<Layer> | ((l: Layer) => Layer), coalesce?: string) => {
    setSpec((s) => ({
      ...s,
      layers: s.layers.map((l) => (l.id === id ? (typeof patch === "function" ? patch(l) : ({ ...l, ...patch } as Layer)) : l)),
    }), coalesce);
  }, [setSpec]);

  /** AI などで作った spec を新しい成果物として開く（元に戻すと前の成果物に戻る） */
  const openAsNewPoster = async (next: PosterSpec, text: string) => {
    const before = spec;
    const restore = await save.startNewPoster();
    setSpec(next);
    setSelected(null);
    notify({ kind: "success", text, action: { label: "元に戻す", run: () => { restore(before); setSelected(null); } } });
  };

  // ---------- AI: 新規作成 ----------
  const planWithAI = () => mode === "slides" ? undefined : reproduceOn ? reproduceWithAI() : run(`${aiName} がレイアウトを設計中`, async (signal) => {
    const { spec: next } = await api.plan(brief + referenceCaption, undefined, toReferenceImages(refs), signal);
    const n = findPendingAssets(next).length;
    const images = n ? autoImages ? `・画像 ${n} 点を生成します` : `・画像 ${n} 点が未生成` : "";
    await openAsNewPoster(next, `新しいポスターを作成しました（${next.layers.length} レイヤー${images}）。前のポスターは成果物に保存されています`);
    if (n && autoImages) await generatePending(next, signal);
  }, { cancelable: true });

  // ---------- AI: 参考画像の再現（A4 モード） ----------
  /** 再現の段階を切り替える（step を渡すと「1/2」のように何段階目かも出し、その段階の経過秒数を数え直す） */
  const setBusyLabel = (label: string, step?: [number, number]) =>
    setBusy((b) => b && { ...b, label, progress: undefined, detail: undefined, ...(step ? { step, stepStartedAt: Date.now() } : {}) });
  /** ChatGPT の応答の進み具合を、今の段階の中の様子として出す（unit は書き出し済みの数の単位） */
  const showAIProgress = (unit: string) => (p: AIProgress) => {
    const retry = p.attempt > 1 ? "出力の誤りを直させています・" : "";
    const detail = p.phase === "thinking" ? `${retry}考え中（応答の書き出し前）` : `${retry}書き出し中・${p.items ?? 0} ${unit}`;
    setBusy((b) => b && { ...b, detail });
  };
  const uploadCrop = async (blob: Blob) => (await api.uploadBlob(blob, blob.type)).src;

  /**
   * 再現の仕上げを 1 回（エディタには反映しない）: spec を描画して参考画像と見比べさせ、直した spec を返す。
   * 直すところが無ければ spec は target のまま
   */
  const refineSpec = async (target: PosterSpec, img: HTMLImageElement, reference: RefImage, signal: AbortSignal, hooks: { onProgress?: (p: AIProgress) => void; onCrop?: () => void; subject?: AiSubject } = {}) => {
    const overlay = overlayOf(target);
    const base = withoutOverlay(target);
    const render = await blobToRef(await renderSpecPng(base));
    const res = await api.refineReproduction(reference, render, base, hooks.onProgress, signal, hooks.subject);
    if (!res.spec) return { spec: target, reply: res.reply || "参考画像との違いは見つかりませんでした" };
    hooks.onCrop?.();
    let next = await resolveRefCrops(res.spec, img, uploadCrop);
    if (overlay) next = withOverlay(next, overlay);
    if (signal.aborted) throw new Error("aborted");
    return { spec: next, reply: res.reply || "参考画像に合わせて修正しました" };
  };

  /**
   * 再現の仕上げを 1 回: 今の spec を描画して参考画像と見比べさせ、直した spec を反映する。
   * 返り値は反映後の spec（直すところが無ければ target のまま）
   */
  const refineOnce = async (target: PosterSpec, img: HTMLImageElement, reference: RefImage, signal: AbortSignal, step?: [number, number], subject?: AiSubject) => {
    setBusyLabel("描画結果を参考画像と見比べて修正中", step);
    const changed = watchWork(!!desktopBridge() && !!subject, workRefs);
    const res = await refineSpec(target, img, reference, signal, {
      subject, onProgress: showAIProgress("件目の修正"), onCrop: () => setBusyLabel("参考画像から画像を切り抜き中"),
    });
    if (changed()) throw new Error(WORK_CHANGED_MESSAGE);
    if (res.spec === target) return res;
    const next = res.spec;
    const d = diffLayers(target, next);
    setSpec(next);
    flashLayers([...d.added, ...d.changed]);
    return res;
  };

  /** 参考画像の 1 枚目を写し取って新しいポスターにし、描画結果と見比べて 1 回仕上げる */
  const reproduceWithAI = () => run(`${aiName} が参考画像を写し取り中`, async (signal) => {
    setBusyLabel(`${aiName} が参考画像を写し取り中`, [1, 2]);
    const img = await loadImage(refs[0].url);
    const { width, height } = referenceSize(img);
    const scaled = await scaledReference(img, width, height);
    const { spec: raw } = await api.reproduce(scaled.ref, width, height, brief, showAIProgress("レイヤー目"), signal);
    setBusyLabel("参考画像から画像を切り抜き中");
    const [cropped, overlaySrc] = await Promise.all([resolveRefCrops(raw, img, uploadCrop), uploadCrop(scaled.blob)]);
    let next = withOverlay(cropped, overlaySrc);
    if (signal.aborted) throw new Error("aborted");
    await openAsNewPoster(next, `参考画像を再現しました（${next.layers.length - 1} レイヤー）。続けて描画結果と見比べて仕上げます`);
    const refined = await refineOnce(next, img, scaled.ref, signal, [2, 2]);
    next = refined.spec;
    notify({ kind: "success", text: `${refined.reply}。左パネルの「参考画像を重ねる」で見比べられます` });
    if (findPendingAssets(next).length && autoImages) await generatePending(next, signal);
  }, { cancelable: true });

  /** 比較用レイヤーの参考画像と見比べて、もう 1 回直す */
  const refineWithAI = () => run("描画結果を参考画像と見比べて修正中", async (signal) => {
    const overlay = overlayOf(spec);
    if (!overlay?.src) throw new Error("このポスターには参考画像（比較用レイヤー）がありません");
    const img = await loadImage(overlay.src);
    const reference = await blobToRef(await (await fetch(overlay.src)).blob());
    const before = spec;
    const { spec: next, reply } = await refineOnce(spec, img, reference, signal, undefined, workSubject(deck, posterIdRef.current, spec.meta.title));
    if (next === before) { notify({ kind: "info", text: reply }); return; }
    notifyRestorable(reply, before);
    if (findPendingAssets(next).length && autoImages) await generatePending(next, signal);
  }, { cancelable: true });

  const refOverlay = overlayOf(spec);
  const toggleRefOverlay = () => refOverlay && updateLayer(REF_OVERLAY_ID, { visible: refOverlay.visible === false });

  // ホームから「AI で作る」で来たとき: サーバーの状態が取れたらすぐ生成を始める（未サインインならブリーフを入れたまま案内だけ出す）
  useEffect(() => {
    if (!status || !pendingBrief.current) return;
    pendingBrief.current = null;
    if (aiProvider) planWithAI();
    else notify({ kind: "info", text: "ブリーフを受け取りました。ChatGPT にサインインする（または .env に OPENROUTER_API_KEY を設定する）と「レイアウトを生成」で作成できます" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const onRefFiles = async (files: FileList | File[] | null) => {
    if (!files?.length || readingRefsLock.current || busy) return;
    readingRefsLock.current = true;
    setReadingRefs(true);
    try {
      // 読めたファイルは上限まで追加し、読めなかったもの（上限超え・形式違い・大きすぎ）は理由をまとめて知らせる
      const next: (ReferencePage & { w: number; h: number })[] = [];
      const skipped: string[] = [];
      let bytes = refs.reduce((sum, r) => sum + r.img.data.length, 0);
      for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }))) {
        const remaining = MAX_REFERENCES - refs.length - next.length;
        if (remaining < 1) { skipped.push(`参考資料は画像・PDFのページを合わせて ${MAX_REFERENCES} 枚までです（${file.name} 以降は追加していません）`); break; }
        try {
          const pages = await readReferenceFile(file, remaining);
          const size = pages.reduce((sum, p) => sum + p.img.data.length, 0);
          if (bytes + size > MAX_REFERENCE_DATA_BYTES) { skipped.push(`${file.name}: 参考資料の合計サイズが大きすぎるため追加していません。枚数やファイルサイズを減らしてください`); continue; }
          for (const page of pages) {
            const image = await loadImage(page.url);
            next.push({ ...page, w: image.naturalWidth, h: image.naturalHeight });
          }
          bytes += size;
        } catch (e) {
          skipped.push(e instanceof Error ? e.message : String(e));
        }
      }
      if (next.length) setRefs((r) => [...r, ...next]);
      if (skipped.length) notify({ kind: next.length ? "info" : "error", text: [...new Set(skipped)].join("\n") });
    } finally {
      readingRefsLock.current = false;
      setReadingRefs(false);
    }
  };
  // ---------- AI: チャット ----------
  /** 製品版で「確認を待つ間に作品が編集されたか」を見張る対象（開いている作品の id と、デッキなら全スライド・ポスターなら編集中の spec の参照） */
  const workRefs = () => [posterIdRef.current, ...(deck ? deck.slides.map((s) => specOf(s.id)) : [specOf(posterIdRef.current ?? "")])];
  /**
   * 資料全体を把握できるよう、PPTX の全スライドを渡す。現在のスライドは api.edit の spec に含まれる。
   * 言及したスライドは spec 全体（書き換えや統合の対象になる）、それ以外は文字・台本・配色だけ（参考）にして、枚数が多くても AI の入力を抑える
   */
  const deckEditContext = async (text: string): Promise<{ ctx: DeckEditContext; design?: DeckDesign } | undefined> => {
    if (!deck) return undefined;
    const current = deck.slides.findIndex((s) => s.id === posterIdRef.current) + 1;
    if (!current) return undefined;
    await save.flushSave();
    // スライド一覧で選んだスライドも、言及したものと同じく spec ごと渡す（構成変更や統合の対象になる）
    const selected = selectedSlideIds.map((id) => deck.slides.findIndex((s) => s.id === id) + 1).filter((n) => n > 0).sort((a, b) => a - b);
    const full = new Set([...slideRefs(text, current, deck.slides.length), ...selected]);
    const fetched = await Promise.all(deck.slides.flatMap((s, i) => i + 1 === current ? [] : [{ slide: s, number: i + 1 }]).map(async ({ slide, number }) => {
      const spec = (await api.poster(slide.id)).spec;
      const notes = spec.notes?.trim().slice(0, 300);
      return { number, spec, entry: full.has(number) ? { number, title: slide.title, spec } : { number, title: slide.title, theme: spec.theme, colors: slidePalette(spec), texts: slideContent(spec).texts.map((t) => t.slice(0, 120)), ...(notes ? { notes } : {}) } };
    }));
    const slides = fetched.map((f) => f.entry);
    // デザインの要約: 全スライドの spec を番号順に（今のスライドは編集中のもの）。作れなくても編集は止めない
    let design: DeckDesign | undefined;
    try {
      const curSpec = specOf(posterIdRef.current ?? "");
      design = summarizeDeckDesign([...fetched.map((f) => ({ number: f.number, spec: f.spec })), ...(curSpec ? [{ number: current, spec: curSpec }] : [])].sort((x, y) => x.number - y.number).map((x) => x.spec));
    } catch { design = undefined; }
    return { ctx: { current, total: deck.slides.length, slides, ...(selected.length ? { selected } : {}) }, design };
  };

  /** 番号の並びを「4・5」の形に */
  const nums = (ns: number[]) => ns.join("・");
  /**
   * AI の構成変更（res.sequence）をデッキに当てる。消すスライドがあれば、当てる前に確認する（キャンセルなら何も当てない）。
   * 書き換え・新規に画像の生成待ちがあれば、そのまま生成する
   */
  const applySequenceResult = async (res: Awaited<ReturnType<typeof api.edit>>, ctx: DeckEditContext | undefined, signal: AbortSignal): Promise<Omit<ChatMsg, "id" | "role">> => {
    const d = deck!;
    const oldIds = d.slides.map((s) => s.id);
    // 元のスライド番号ごとの書き換え後の spec（変化のあるものだけ）
    const edits = new Map<number, PosterSpec>();
    for (const e of [...(res.spec ? [{ target: res.target ?? ctx?.current ?? 0, spec: res.spec }] : []), ...(res.others ?? [])]) {
      const id = oldIds[e.target - 1];
      const old = id && specOf(id);
      if (old && diffLayers(old, e.spec).hasChanges) edits.set(e.target, e.spec);
    }
    const plan = planDeckSequence(oldIds, res.sequence!, edits);
    const before = oldIds.length, after = plan.slots.length;
    const removedNums = plan.removed.map((id) => oldIds.indexOf(id) + 1);
    const added = plan.slots.filter((s) => s.type !== "keep").length;
    const reordered = plan.slots.some((s, i) => s.type !== "keep" || s.id !== oldIds[i]) || before !== after;
    if (!reordered && !plan.rewrites.length) return { text: res.reply || "変更はありませんでした" };
    if (removedNums.length) {
      const ok = await ask({
        title: `スライドを ${before} 枚 → ${after} 枚に組み直しますか？`,
        message: `デッキを ${before} 枚から ${after} 枚に組み直します。${added ? `${added} 枚を追加し、` : ""}スライド ${nums(removedNums)} を削除します。削除は取り消せません。`,
        ok: "組み直す", danger: true,
      });
      if (!ok) return { text: "変更は当てませんでした" };
    }
    if (signal.aborted) throw new Error("aborted");
    const r = await applyDeckSequence(res.sequence!, edits);
    const parts = [plan.rewrites.length && `${plan.rewrites.length} 枚書き換え`, added && `${added} 枚追加`, removedNums.length && `${removedNums.length} 枚削除`, !added && !removedNums.length && reordered && "並べ替え"].filter(Boolean);
    const reply = { text: res.reply || "スライドの構成を変えました", changes: `構成: ${before} 枚 → ${after} 枚${parts.length ? `（${parts.join("・")}）` : ""}` };
    if (r.removed.length) setSelectedSlideIds([]);
    if (autoImages && r.order.some((id) => { const sp = specOf(id); return sp && (r.created.includes(id) || r.rewritten.includes(id)) && findPendingAssets(sp).length; })) {
      return generateInReply(reply, () => generateAcross(r.order.filter((id) => r.created.includes(id) || r.rewritten.includes(id)), signal));
    }
    return pendingReply(reply, r.order.filter((id) => r.created.includes(id) || r.rewritten.includes(id)).map((id) => ({ id, spec: specOf(id) })));
  };

  /**
   * チャットの 1 往復: ユーザーの発言を載せ、fn の結果（返答）を AI の発言として載せる。
   * 失敗・キャンセルもチャットに出し、入力欄に文面を戻す（利用上限・サインイン切れは通知でも導線を出す）。
   * user に既存の発言（id 付き）を渡すと再生成: 発言は増やさず、その後の返答を消して作り直す
   */
  const chatTurn = (user: Omit<ChatMsg, "id" | "role"> | ChatMsg, pendingLabel: string, restoreInput: () => void, fn: (signal: AbortSignal) => Promise<Omit<ChatMsg, "id" | "role">>) =>
    run(pendingLabel, async (signal) => {
      if ("id" in user) chat.dropRepliesAfter(user.id);
      else chat.push({ role: "user", ...user });
      chat.setPending(pendingLabel);
      try {
        chat.push({ role: "assistant", ...(await fn(signal)) });
      } catch (e: any) {
        restoreInput();
        if (signal.aborted) { chat.push({ role: "assistant", text: "キャンセルしました", error: true }); return; }
        chat.push({ role: "assistant", text: e?.message ?? String(e), error: true });
        if (e?.code) notifyAIError(e);
      } finally { chat.setPending(null); }
    }, { cancelable: true });

  /** チャットで依頼する対象（未選択ならポスター全体） */
  const chatScope = selLayers.length ? (multi ? `${selLayers.length} 件のレイヤー` : layerName(selLayers[0])) : null;
  /**
   * AI の修正（api.edit）の結果をデッキ・ポスターに当て、チャットの返答を作る。
   * 別のスライドへの指示ならそのスライドを開いてから当て、ほかのスライドは開かずに書き換える。まとめ元のスライドは確認してから消す
   */
  const applyEditResult = async (res: Awaited<ReturnType<typeof api.edit>>, cur: PosterSpec, ctx: DeckEditContext | undefined, signal: AbortSignal): Promise<Omit<ChatMsg, "id" | "role">> => {
    // 構成の変更（並べ替え・分割・統合・複製）は、並びごとまとめて当てる
    if (res.sequence && deck) return applySequenceResult(res, ctx, signal);
    const next = res.spec;
    if (!next) return { text: res.reply || "変更はありませんでした" };
    // 別のスライドを書き換える指示なら、そのスライドを開いてから適用する（履歴に積まれるので Ctrl+Z / 元に戻す が効く）
    const target = ctx && res.target && res.target !== ctx.current ? deck?.slides[res.target - 1] : undefined;
    // 「3枚目と5枚目を直して」: 開いていないほかのスライドは、開かずに書き換えて裏で保存する
    const others = (res.others ?? []).flatMap((e) => {
      const slide = deck?.slides[e.target - 1];
      const old = slide && slide.id !== (target?.id ?? posterIdRef.current) ? specOf(slide.id) : undefined;
      return slide && old && diffLayers(old, e.spec).hasChanges ? [{ n: e.target, posterId: slide.id, before: old, spec: e.spec }] : [];
    });
    let before = cur;
    if (target) {
      if (signal.aborted) throw new Error("aborted");
      before = await openSlide(target.id);
    }
    for (const o of others) updateSlide(o.posterId, o.spec);
    const d = diffLayers(before, next);
    if (!d.hasChanges && !others.length) {
      return { text: res.reply ? `${res.reply}\n（ポスターに変更はありませんでした。もう少し具体的に指示してみてください）` : "変更はありませんでした。指示をもう少し具体的にしてみてください" };
    }
    if (d.hasChanges) {
      setSpec(next);
      flashLayers([...d.added, ...d.changed]);
    }
    const parts = [d.changed.length && `${d.changed.length} 件変更`, d.added.length && `${d.added.length} 件追加`, d.removed && `${d.removed} 件削除`, d.themeChanged && "テーマ変更", d.metaChanged && "ポスター設定変更", d.reordered && "重ね順変更", d.notesChanged && "台本変更", d.transitionChanged && "画面切り替え変更"].filter(Boolean);
    if ((d.notesChanged || others.some((o) => o.before.notes !== o.spec.notes)) && isSlides) toggleNotes(true);
    const main = d.hasChanges ? `${target || others.length ? `スライド ${res.target ?? ctx?.current}: ` : ""}${parts.join("・") || "変更"}` : "";
    const changes = [main, others.length && `スライド ${others.map((o) => o.n).join("・")} も変更`].filter(Boolean).join("・");
    const reply = { text: res.reply || "修正しました", changes, before, posterId: posterIdRef.current, ...(others.length ? { others: others.map(({ posterId, before }) => ({ posterId, before })) } : {}) };
    if (autoImages && others.some((o) => findPendingAssets(o.spec).length)) {
      return generateInReply(reply, () => generateAcross([posterIdRef.current!, ...others.map((o) => o.posterId)], signal));
    }
    if (autoImages && findPendingAssets(next).length) {
      return generateInReply(reply, () => generatePending(next, signal, { quiet: true }));
    }
    return pendingReply(reply, [{ id: posterIdRef.current, spec: next }, ...others.map((o) => ({ id: o.posterId, spec: o.spec }))]);
  };
  /**
   * 入力欄の文を送る（送ったら空にし、失敗したら戻す）。
   * regen: 履歴の発言への返答の作り直し。入力欄には触らず、base（AI が変更する前の spec）から考え直させる
   */
  const sendChat = (text = instruction.trim(), regen?: { msg: ChatMsg; base: PosterSpec }) => {
    if (readingRefsLock.current || busy) return;
    const cur = regen?.base ?? spec;
    const ids = selLayers.length ? selLayers.map((l) => l.id) : undefined;
    const context = chat.context(regen?.msg.id);
    const current = deck ? deck.slides.findIndex((s) => s.id === posterIdRef.current) + 1 : 0;
    const route = routeChatRequest(text, { deck: deck ? { current, total: deck.slides.length } : undefined, poster: mode === "poster" });
    if (route.kind === "slash-error") { notify({ kind: "error", text: route.error }); return; }
    const restore = regen ? () => {} : () => setInstruction(text);
    if (!regen) setInstruction("");
    switch (route.kind) {
      case "slash":
        return runSlash(route.cmd, route.arg, restore, regen?.msg);
      case "renumber":
        return chatTurn(regen?.msg ?? { text, mode: "chat" }, "ページ番号を確認中", restore, () => renumberDeckPages());
      case "missing-notes":
        return writeNotesTurn(regen?.msg ?? { text, mode: "chat" }, restore, { request: text });
      case "write-notes":
        return writeNotesTurn(regen?.msg ?? { text, mode: "chat" }, restore, { targets: route.targets, request: text });
      case "image":
        return generateImageHere(text, route.prompt, restore, { redo: route.redo, regen: regen?.msg, transparent: route.transparent });
    }
    // 通常編集だけでなく、全スライドへの適用・スライド追加・再送信でも同じ添付を使う。
    const requestText = regen ? text : text + referenceCaption;
    const references = regen ? regen.msg.references ?? [] : toReferenceImages(refs);
    const user = regen?.msg ?? { text: requestText, scope: chatScope ?? (slideNo ? chatFallback : undefined), mode: "chat" as const, ...(references.length ? { references, hasReferences: true } : {}) };
    if (route.kind === "add-slide") {
      return chatTurn(user, `${aiName} がスライドを作成中`, restore, async (signal) => {
        const r = await addSlideByAI(signal, requestText, route.position, context, references);
        const reply = { text: r.text, changes: r.changes };
        if (autoImages && r.spec && findPendingAssets(r.spec).length) {
          const made = r.spec;
          return generateInReply(reply, () => generatePending(made, signal, { quiet: true }));
        }
        return pendingReply(reply, [{ id: posterIdRef.current, spec: r.spec }]);
      });
    }
    if (route.kind === "edit-across") {
      return chatTurn(user, `${aiName} が全スライドを修正中`, restore, async (signal) => {
        const r = await editAcrossDeck(signal, requestText, context, references);
        const reply = { text: r.text, changes: r.changes };
        if (autoImages && r.ids.some((id) => { const sp = specOf(id); return sp && findPendingAssets(sp).length; })) {
          return generateInReply(reply, () => generateAcross(r.ids, signal));
        }
        return pendingReply(reply, r.ids.map((id) => ({ id, spec: specOf(id) })));
      });
    }
    return chatTurn(user, `${aiName} が考え中`, restore, async (signal) => {
      const changed = watchWork(!!desktopBridge(), workRefs);
      const dc = await deckEditContext(text);
      const ctx = dc?.ctx;
      const res = await api.edit(cur, requestText, ids, signal, ctx, context, undefined, references, workSubject(deck, posterIdRef.current, cur.meta.title), dc?.design);
      if (changed()) throw new Error(WORK_CHANGED_MESSAGE);
      return applyEditResult(res, cur, ctx, signal);
    });
  };
  /** / コマンドの実行（restore は失敗したときに入力欄へ元の文を戻す。regen は作り直す発言） */
  const runSlash = (cmd: SlashCommand, arg: string, restore: () => void, regen?: ChatMsg) => {
    switch (cmd.name) {
      case "image":
        return generateImageHere(arg, arg, restore, { redo: true, regen });
      case "images":
        if (!findPendingAssets(spec).length) { notify({ kind: "info", text: "未生成の画像はありません" }); return; }
        return generateAll();
      case "undo": {
        const last = [...chat.messages].reverse().find((m) => m.before && !m.undone);
        if (!last) { notify({ kind: "info", text: "元に戻せる AI の変更はありません" }); return; }
        return undoChat(last);
      }
      case "renumber":
        return chatTurn(regen ?? { text: `/${cmd.name}`, mode: "chat" }, "ページ番号を確認中", restore, () => renumberDeckPages());
      case "notes":
        return writeNotesTurn(regen ?? { text: `/${cmd.name}`, mode: "chat" }, restore);
      case "a4":
        return chatTurn(regen ?? { text: arg ? `/a4 ${arg}` : "/a4", mode: "chat" }, "A4 に整え中", restore, (signal) => fitA4Turn(spec, arg, signal));
      case "clear":
        return clearChat();
    }
  };
  /**
   * /a4: ポスターを A4 に印刷できるよう整える。
   * 手元で用紙を A4 にして文字・QR を端から 5mm 内側に収め、AI（ChatGPT か OpenRouter）が使えれば重なり・文字の大きさ・余白のバランスまで直させる。
   * AI の結果も最後にもう一度手元で A4 に収め直す
   */
  const fitA4Turn = async (before: PosterSpec, extra: string, signal: AbortSignal): Promise<Omit<ChatMsg, "id" | "role">> => {
    const local = fitToA4(before);
    let next = local.spec;
    const done: string[] = [];
    if (local.resized) done.push(`用紙を A4 にしました（${before.meta.width}×${before.meta.height} → ${next.meta.width}×${next.meta.height}）。縦の配置も新しい高さに合わせています`);
    let reply = "";
    if (aiProvider) {
      setBusyLabel(`${aiName} が A4 に整え中`);
      // 解像度の低い画像は配置では直せないので、AI には伝えない
      const issues = a4Issues(next).filter((i) => i.kind !== "low-res");
      const changed = watchWork(!!desktopBridge(), workRefs);
      const res = await api.edit(next, a4Instruction(next, issues, extra), undefined, signal, undefined, chat.context(), undefined, undefined, workSubject(deck, posterIdRef.current, next.meta.title));
      if (changed()) throw new Error(WORK_CHANGED_MESSAGE);
      if (res.spec) {
        const ai = fitToA4({ ...res.spec, meta: { ...res.spec.meta, width: next.meta.width, height: next.meta.height } });
        next = ai.spec;
        reply = res.reply ?? "";
      }
    } else {
      const fixed = local.moved.length + local.shrunk.length;
      if (fixed) done.push(`文字や QR など ${fixed} 件を、端から 5mm 内側に収めました`);
      done.push("ChatGPT にサインインする（または OpenRouter の API キーを設定する）と、重なり・文字の大きさ・余白のバランスまで整えます");
    }
    if (signal.aborted) throw new Error("aborted");
    const left = a4Issues(next).filter((i) => i.kind !== "low-res");
    const rest = left.length
      ? `まだ ${left.length} 件の注意があります（右上の A4 チェックで確かめられます）:\n${left.map((i) => `・${i.name}: ${i.text}`).join("\n")}`
      : "A4 チェックの注意はなくなりました";
    const d = diffLayers(before, next);
    if (!d.hasChanges) return { text: left.length ? `変更はありませんでした。${rest}` : "すでに A4 に整っています" };
    setSpec(next);
    flashLayers([...d.added, ...d.changed]);
    const parts = [d.metaChanged && "用紙を A4 に", d.changed.length && `${d.changed.length} 件変更`, d.added.length && `${d.added.length} 件追加`, d.removed && `${d.removed} 件削除`].filter(Boolean);
    return { text: [reply, ...done, rest].filter(Boolean).join("\n"), changes: parts.join("・") || "変更", before, posterId: posterIdRef.current };
  };
  /** AI で台本を書く（チャットの 1 往復として。書いたら台本欄を開く）。opts を省くと台本が無いスライドすべて */
  const writeNotesTurn = (user: Omit<ChatMsg, "id" | "role"> | ChatMsg, restore: () => void = () => {}, opts?: { targets?: number[]; request?: string }) =>
    chatTurn(user, `${aiName} が台本を書き中`, restore, async (signal) => {
      const r = await writeNotes(signal, opts);
      if (r.changes) toggleNotes(true);
      return r;
    });
  /** チャットの「元に戻す」: 変更したポスター（デッキなら別スライドのこともある）を開いて変更前に戻す */
  const undoChat = async (m: ChatMsg) => {
    if (!m.before || busy) return;
    if (m.posterId && m.posterId !== posterIdRef.current) {
      try { await openSlide(m.posterId); } catch (e) { notifyAIError(e); return; }
    }
    setSpec(m.before);
    for (const o of m.others ?? []) updateSlide(o.posterId, o.before);
    setSelected(null);
    chat.markUndone(m.id);
  };
  const clearChat = async () => {
    if (await ask({ title: "チャットを消去しますか？", message: "チャットの履歴と、AI が覚えている会話の要約をすべて消去します。", ok: "消去", danger: true })) chat.clear();
  };

  // ---------- 画像生成 ----------
  /** target は文脈（画風・配色・レイヤーの大きさ）を取る spec。生成直後の spec をまだ state から読めない場合に渡す */
  const generateOne = async (ref: LayerRef, rawAsset: AssetRequest, signal?: AbortSignal, target: PosterSpec = spec) => {
    const key = `${ref.layerId}|${ref.rest.join(".")}`;
    setGenerating((g) => new Set(g).add(key));
    try {
      const { asset, context } = prepareAsset(target, ref, rawAsset);
      const { src } = await api.asset(asset, context, activeImageProvider, signal);
      setSpec((s) => patchAsset(s, ref, src));
      return src;
    } finally {
      setGenerating((g) => { const n = new Set(g); n.delete(key); return n; });
    }
  };

  /**
   * target 内の未生成画像をすべて生成する（AI のレイアウト生成・修正の直後にも自動で呼ぶ）。
   * quiet なら結果を通知せずに返す（何枚もの画像をまとめて生成するとき、最後にまとめて通知する）
   */
  const generatePending = async (target: PosterSpec, signal: AbortSignal, opts: { quiet?: boolean; label?: string } = {}) => {
    const queue = findPendingAssets(target).map((p) => ({ ref: toLayerRef(target, p.path), asset: p.asset }));
    const total = queue.length;
    let done = 0, failed = 0;
    /** 生成できた画像の src（チャットの返答にサムネイルで出す） */
    const srcs: string[] = [];
    /** 最初に失敗した理由（サーバーが返す、利用者が直し方の分かる文言） */
    let reason: string | undefined;
    setBusy((b) => b && { ...b, label: opts.label ?? "画像を生成中", progress: [0, total], step: undefined, detail: undefined, stepStartedAt: undefined });
    // 同時 2 並列で 1 点ずつ依頼する。1 点の失敗で全体を止めない
    const worker = async () => {
      for (let j = queue.shift(); j && !signal.aborted; j = queue.shift()) {
        try { srcs.push(await generateOne(j.ref, j.asset, signal, target)); } catch (e) { if (signal.aborted) throw e; failed++; reason ??= failureReason(e); }
        setBusyProgress(++done, total);
      }
    };
    await Promise.all([worker(), worker()]);
    if (signal.aborted) throw new Error("aborted");
    if (opts.quiet) return { total, failed, reason, srcs };
    if (failed) notify({ kind: "error", text: `${failed} 点の画像生成に失敗しました。${reason ? `${reason}。` : ""}レイヤーを選んで「再生成」できます` });
    else notify({ kind: "success", text: `画像を ${total} 点生成しました` });
    return { total, failed, reason, srcs };
  };
  /**
   * デッキの ids の各スライドを順に開いて、未生成の画像素材を生成する（画像は開いているものにしか当てられないため）。
   * 終わったら、始めに開いていたスライドに戻る
   */
  const generateAcross = async (ids: string[], signal: AbortSignal) => {
    const start = posterIdRef.current;
    const targets = ids.filter((id) => { const sp = specOf(id); return sp && findPendingAssets(sp).length; });
    let total = 0, failed = 0;
    let reason: string | undefined;
    const srcs: string[] = [];
    for (const [i, id] of targets.entries()) {
      const opened = await openSlide(id);
      // ids はデッキの並び順（作った直後は deck の state がまだ古いので、ids から数える）
      const label = targets.length > 1 ? `画像を生成中（${ids.indexOf(id) + 1} 枚目・${i + 1} / ${targets.length}）` : "画像を生成中";
      const r = await generatePending(opened, signal, { quiet: true, label });
      total += r.total;
      failed += r.failed;
      reason ??= r.reason;
      srcs.push(...r.srcs);
    }
    if (start && start !== posterIdRef.current && ids.includes(start)) await openSlide(start);
    if (failed) notify({ kind: "error", text: `${failed} 点の画像生成に失敗しました。${reason ? `${reason}。` : ""}そのスライドを開き、レイヤーを選んで「再生成」できます` });
    else if (total) notify({ kind: "success", text: `${targets.length} 枚のスライドに、画像素材を ${total} 点生成しました` });
    return { total, failed, reason, srcs };
  };
  /** 未生成の画像をまとめて生成 */
  const generateAll = () => run("画像を生成中", (signal) => generatePending(spec, signal).then(() => {}), { cancelable: true });

  /** 画像の生成結果をチャットの返答にする（できた画像はサムネイルで、失敗は失敗と分かる文言で） */
  const imagesReply = (r: { total: number; failed: number; reason?: string; srcs: string[] }): Omit<ChatMsg, "id" | "role"> => {
    if (!r.total) return { text: "未生成の画像はありませんでした" };
    if (r.failed >= r.total) return { text: `画像の生成に失敗しました。${r.reason ?? ""}`.trim(), error: true };
    return r.failed
      ? { text: `画像を ${r.srcs.length} 点生成しました（${r.failed} 点は失敗${r.reason ? `: ${r.reason}` : ""}）`, images: r.srcs }
      : { text: "画像も生成しました", images: r.srcs };
  };
  /** AI の返答を先にチャットへ出してから画像を生成し、その結果を続きの返答にする */
  const generateInReply = async (reply: Omit<ChatMsg, "id" | "role">, gen: () => Promise<{ total: number; failed: number; reason?: string; srcs: string[] }>) => {
    chat.push({ role: "assistant", ...reply });
    chat.setPending("画像を生成中…");
    return imagesReply(await gen());
  };
  /** 自動生成がオフで未生成の画像が残るなら、返答に「画像を生成する」ボタンを付ける */
  const pendingReply = (reply: Omit<ChatMsg, "id" | "role">, entries: { id: string | null; spec?: PosterSpec }[]): Omit<ChatMsg, "id" | "role"> => {
    const hit = entries.flatMap((e) => (e.spec ? [{ id: e.id, n: findPendingAssets(e.spec).length }] : [])).filter((e) => e.n);
    const count = hit.reduce((a, e) => a + e.n, 0);
    return count ? { ...reply, pendingImages: { count, posterIds: hit.flatMap((e) => (e.id ? [e.id] : [])) } } : reply;
  };
  /** 返答の「画像を生成する」: その返答で未生成だった画像をまとめて生成し、できた画像を新しい返答に出す */
  const generateFromReply = (m: ChatMsg) => {
    if (busy || !m.pendingImages) return;
    chat.markImagesStarted(m.id);
    return run("画像を生成中", async (signal) => {
      chat.setPending("画像を生成中…");
      try {
        const ids = m.pendingImages!.posterIds.filter((id) => deck?.slides.some((s) => s.id === id));
        const r = deck && ids.length ? await generateAcross(ids, signal) : await generatePending(spec, signal, { quiet: true });
        chat.push({ role: "assistant", ...imagesReply(r) });
      } catch (e: any) {
        chat.push({ role: "assistant", text: signal.aborted ? "キャンセルしました" : e?.message ?? String(e), error: true });
      } finally { chat.setPending(null); }
    }, { cancelable: true });
  };

  const regenerateLayer = (layerId: string) => run("画像を生成中", async (signal) => {
    const holder = assetHolder(spec.layers.find((l) => l.id === layerId) ?? null);
    if (!holder) throw new Error("このレイヤーには asset（生成プロンプト）がありません");
    await generateOne({ layerId, rest: holder.rest }, holder.asset, signal);
  }, { cancelable: true });

  /** チャットの画像生成の対象: 選択中の画像を作り直す／選択中の要素の位置に追加。null なら中央に新しい画像 */
  const imageScope = selectedLayer && selHolder ? `「${layerName(selectedLayer)}」を作り直す`
    : selectedLayer && selectedLayer.type !== "background" ? `「${layerName(selectedLayer)}」の位置に追加` : null;
  /**
   * チャットの画像生成（/image と「海の写真を作って」）。redo なら選択中の画像を作り直し、そうでなければ新しい画像を置く
   * （選択中の画像は消さない。選択中の別の要素があればその位置、無ければ中央）。透過は依頼文から読む
   */
  const generateImageHere = (text: string, prompt: string, restoreInput: () => void, opts: { redo: boolean; regen?: ChatMsg; transparent?: boolean }) =>
    chatTurn(opts.regen ?? { text, scope: (opts.redo ? imageScope : selHolder ? null : imageScope) ?? "新しい画像", mode: "image" }, "画像を生成中", restoreInput, async (signal) => {
      const before = spec;
      const transparent = opts.transparent ?? isTransparentRequest(text);
      if (opts.redo && selectedLayer && selHolder) {
        const asset = { ...selHolder.asset, prompt, transparent: transparent || !!selHolder.asset.transparent };
        const patch = selHolder.rest.length ? { props: { ...(selectedLayer as any).props, asset } } : { asset };
        updateLayer(selectedLayer.id, patch as Partial<Layer>);
        const src = await generateOne({ layerId: selectedLayer.id, rest: selHolder.rest }, asset, signal);
        return { text: "画像を作り直しました", images: [src], before, posterId: posterIdRef.current };
      }
      const at = selectedLayer && selectedLayer.type !== "background" && !selHolder
        ? { x: selectedLayer.x, y: selectedLayer.y, w: selectedLayer.w, h: selectedLayer.h, rotation: selectedLayer.rotation }
        : { x: Math.round((W - 400) / 2), y: Math.round((H - 400) / 2), w: 400, h: 400 };
      const asset = { prompt, transparent, aspect: aspectOf(at.w, at.h) };
      const layer = { id: uid("image"), name: prompt.slice(0, 20) || "画像", type: "image", fit: "contain", asset, ...at } as Layer;
      // 選択中の要素の 1 つ上に重ねる
      setSpec((s) => ({ ...s, layers: insertAfter(s.layers, selectedLayer?.id, [layer]) }));
      setSelected(layer.id);
      const src = await generateOne({ layerId: layer.id, rest: [] }, asset, signal, { ...spec, layers: [...spec.layers, layer] });
      return { text: "画像を生成して配置しました", images: [src], before, posterId: posterIdRef.current };
    });
  /**
   * 最後の自分の発言の下の「再送信」: 発言は増やさず、その返答を作り直す（入力欄の書きかけはそのまま）。
   * チャットは、前の返答で AI が変えたポスターを変更前に戻してから考え直させる（同じ指示が重ねがけされないように）。
   * 画像の依頼は今の選択に対してもう一度生成する（前の返答で置いた画像が選ばれていれば、それを作り直す）
   */
  const resendChat = async (m: ChatMsg) => {
    if (busy || readingRefs || (m.hasReferences && !m.references)) return;
    if (m.mode === "image") {
      const slash = /^[/／]image\s+/.exec(m.text);
      return generateImageHere(m.text, slash ? m.text.slice(slash[0].length) : imagePromptOf(m.text), () => {}, { redo: true, regen: m });
    }
    const i = chat.messages.findIndex((x) => x.id === m.id);
    const prev = chat.messages.slice(i + 1).find((x) => x.role === "assistant" && x.before && !x.undone);
    let base = spec;
    if (prev?.before) {
      if (prev.posterId && prev.posterId !== posterIdRef.current) {
        try { await openSlide(prev.posterId); } catch (e) { notifyAIError(e); return; }
      }
      base = prev.before;
      setSpec(base);
      for (const o of prev.others ?? []) updateSlide(o.posterId, o.before);
    }
    return sendChat(m.text, { msg: m, base });
  };

  // ---------- 画像ファイルの取り込み ----------
  /**
   * 手持ちの画像ファイルを入れる。
   * - replaceId: その画像（レイヤー / 写真・モックの画面）を差し替える
   * - box: その位置・大きさに新しい画像を置く（選択中の図形などの 1 つ上に重ねる）
   * - at: その点を中心に元の縦横比で置く（未指定ならポスター中央）
   */
  const insertImageFiles = (files: FileList | File[] | null, opts: { replaceId?: string; box?: Layer; at?: { x: number; y: number } } = {}) => {
    const images = [...(files ?? [])].filter((f) => IMAGE_FILE_TYPES.test(f.type));
    if (!images.length) { notify({ kind: "error", text: "PNG / JPEG / WebP / GIF の画像を選んでください" }); return; }
    return run("画像を取り込み中", async () => {
      const target = opts.replaceId ? spec.layers.find((l) => l.id === opts.replaceId) ?? null : null;
      const slot = imageSlot(target);
      if (target && slot) {
        const { src } = await api.upload(images[0]);
        setSpec((s) => patchAsset(s, { layerId: target.id, rest: slot.rest }, src));
        notify({ kind: "success", text: `「${layerName(target)}」の画像を差し替えました` });
        return;
      }
      const added: Layer[] = [];
      for (const [i, f] of images.entries()) {
        const { src } = await api.upload(f);
        const name = f.name.replace(/\.[^.]+$/, "").slice(0, 20) || "画像";
        const b = opts.box;
        const at = placeImage(await naturalSize(src), W, H, i, b && b.type !== "background" ? { box: b } : { at: opts.at });
        added.push({ id: uid("image"), name, type: "image", fit: "contain", src, ...at } as Layer);
      }
      setSpec((s) => ({ ...s, layers: insertAfter(s.layers, opts.box?.id, added) }));
      setSelected(added[added.length - 1].id);
      notify({ kind: "success", text: `画像を ${added.length} 点追加しました` });
    });
  };
  /** チャットの画像ファイルボタン: 選択中の画像は差し替え、ほかの要素を選んでいればその位置に、未選択なら中央に置く */
  const insertImageFilesHere = (files: FileList | null) =>
    selectedLayer && replaceableByImage(selectedLayer, W, H) ? insertImageFiles(files, { replaceId: selectedLayer.id })
      : insertImageFiles(files, { box: selectedLayer ?? undefined });
  /** キャンバスへのドロップ: PowerPoint なら（PPTX モードだけ）読み込み、画像の上なら差し替え、それ以外はドロップした位置に置く */
  const onStageDrop = (files: File[], e: RDragEvent) => {
    const pptx = mode === "slides" ? files.find((f) => /\.pptx$/i.test(f.name)) : undefined;
    if (pptx) { importPptxFile(pptx); return; }
    const id = topLayerAt(e.target, topIds);
    const l = id ? spec.layers.find((x) => x.id === id) ?? null : null;
    if (l && replaceableByImage(l, W, H) && !l.locked) { setSelected(l.id); insertImageFiles(files, { replaceId: l.id }); return; }
    insertImageFiles(files, { at: svgRef.current ? toPoster(e) : undefined });
  };
  const stageDrop = useFileDrop(onStageDrop, { disabled: !!busy });
  /** AI パネル（新規作成・チャット）へのドロップは参考資料として添付 */
  const refDrop = useFileDrop((files) => void onRefFiles(files), { disabled: readingRefs || !!busy });
  // ドロップ先の外（インスペクタなど）にファイルを落としても、ブラウザがそのファイルを開いてしまわないようにする
  useEffect(blockPageFileDrop, []);

  /**
   * レイヤーをコピーしたら、続いて起きる copy / cut イベントでシステムのクリップボードをアプリ専用の目印に置き換える
   * （でないと、前に外でコピーした画像が残っていて次の Ctrl+V でその画像が貼られる）。copy イベントの clipboardData は権限なしで書ける
   */
  const markCopy = useRef(false);
  const LAYER_CLIPBOARD_TYPE = "application/x-dc-designer-layers";
  // copy / cut イベントが届かなかったとき（選択が無い cut など）に目印が残らないよう、このキー操作の後で外す
  const markLayerCopy = () => { markCopy.current = true; setTimeout(() => { markCopy.current = false; }); };
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      if (!markCopy.current) return;
      markCopy.current = false;
      if (isTextInput(e.target) || !e.clipboardData) return;
      // 入力欄に貼られる text/plain は入れない（入れるとチャット欄などで Ctrl+V したときにその文字が貼られる）
      e.clipboardData.setData(LAYER_CLIPBOARD_TYPE, "1");
      e.preventDefault();
    };
    window.addEventListener("copy", onCopy);
    window.addEventListener("cut", onCopy);
    return () => { window.removeEventListener("copy", onCopy); window.removeEventListener("cut", onCopy); };
  }, []);

  // クリップボードの貼り付け: 外でコピーした画像（スクリーンショットなど）を優先し、無ければアプリ内でコピーしたレイヤー
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTextInput(e.target) || e.defaultPrevented) return;
      const d = e.clipboardData;
      // 外でコピーした画像（ファイル・スクリーンショット）。files に無くても items に入っていることがある
      const files = [...(d?.files ?? []), ...[...(d?.items ?? [])].filter((it) => it.kind === "file").map((it) => it.getAsFile())]
        .filter((f): f is File => !!f && IMAGE_FILE_TYPES.test(f.type));
      if (files.length) { e.preventDefault(); insertImageFiles([...new Map(files.map((f) => [`${f.name}:${f.size}:${f.type}`, f])).values()]); return; }
      // 画像が無ければ、アプリ内でコピーしたレイヤーを貼る
      if (clipboard.current.length) { e.preventDefault(); insertCopies(clipboard.current, selLayers[selLayers.length - 1]?.id); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  // ---------- 書き出し ----------
  const exported = (name: string) => notify({ kind: "success", text: `${name} を書き出しました` });
  // ---------- A4（ポスター） ----------
  const { a4Guide, setA4Guide, exportPng, exportPdf, printA4, fixA4 } = useA4Export({ spec, setSpec, svgRef, run, notify, exported, notifyRestorable });

  // ---------- PPTX エディターモード ----------
  const {
    deck, slides, specOf, deckOpen, toggleDeck, openSlide, updateSlide, addSlide, duplicateSlide, removeSlide, deleteSlides, applyDeckSequence, moveSlide, reorderSlide, exportDeck,
    fontDialog, setFontDialog, openFontDialog, applyDeckFonts, applyTransitionToAll, renumberDeckPages, writeNotes, addSlideByAI, editAcrossDeck, importPptxFile,
    deckReady, renameDeck,
  } = useDeck({ spec, theme, save, apiUp, busy, run, notify, exported, setBusyProgress, setSpec, resetSpec, stashHistory, setSelected, fitView });
  chatTitle.current = () => {
    const i = deck?.slides.findIndex((s) => s.id === posterId) ?? -1;
    return i >= 0 ? `スライド ${i + 1}` : spec.meta.title;
  };
  /** スライド一覧で複数選択中のスライド id（空 = 複数選択なし）。デッキが変わったら・スライドが消えたら外す */
  const [selectedSlideIds, setSelectedSlideIds] = useState<string[]>([]);
  useEffect(() => {
    setSelectedSlideIds((cur) => {
      const have = new Set(deck?.slides.map((sl) => sl.id));
      const next = cur.filter((id) => have.has(id));
      return next.length === cur.length ? cur : next.length >= 2 ? next : [];
    });
  }, [deck]);
  /** 削除ボタン: 複数選択中なら確認してまとめて削除、1 枚なら今のスライドを削除 */
  const removeSlides = async () => {
    if (selectedSlideIds.length < 2) return removeSlide();
    if (!deck || busy) return;
    const ids = selectedSlideIds;
    const nums = ids.map((id) => deck.slides.findIndex((sl) => sl.id === id) + 1).filter((n) => n > 0).sort((a, b) => a - b);
    if (!await ask({ title: `選択した ${ids.length} 枚を削除しますか？`, message: `スライド ${nums.join("・")} を削除します。この操作は取り消せません。`, ok: "削除", danger: true })) return;
    setSelectedSlideIds([]);
    return run(`${ids.length} 枚のスライドを削除中`, () => deleteSlides(ids));
  };
  /** スライド（デッキ）を開いているか。投影・台本・アニメーションはこのときだけ */
  const isSlides = !!deck;
  /** 開いているモード。デッキを調べ終えたらデッキの種類で決め、それまでは URL の mode（無ければポスター）。別モードの成果物を作る・読み込む導線は出さない */
  const mode: AppMode = deck || deckReady ? modeOfDeck(deck) : readModeParam() ?? "poster";
  // URL の mode を今のモードに合わせ（open など他のクエリは残す）、開いている成果物をモードごとの「最後に開いた ID」に覚える
  useEffect(() => {
    try {
      const u = new URL(location.href);
      if (u.searchParams.get("mode") !== mode) { u.searchParams.set("mode", mode); history.replaceState(history.state, "", u); }
    } catch { /* URL を書き換えられなくても動く */ }
  }, [mode]);
  useEffect(() => { if (posterId && (deck || deckReady)) writeLastId(mode, posterId); }, [mode, posterId, deck, deckReady]);
  /** 新規作成タブ（ポスターの生成）。スライドのモードでは出さずチャットだけにする */
  const canMake = mode !== "slides";
  const tab = canMake ? aiTab : "chat";

  const pendingCount = pending.length;

  const confirmExport = async () => {
    if (deck) {
      if (await ask({ title: "PowerPoint で書き出しますか？", message: `「${deck.name}」を .pptx ファイルとして保存します。`, ok: "書き出す" })) exportDeck();
      return;
    }
    const format = await askChoice({
      title: "書き出す形式を選んでください",
      message: `「${spec.meta.title || "無題のポスター"}」を A4 300dpi（2480×3508px）で保存します。PDF は印刷・提出用、PNG は画像として使うときに。書き出したあと、実寸が A4 になったかをお知らせします。`,
      choices: [{ value: "png", label: "PNG" }, { value: "pdf", label: "PDF" }],
    });
    if (format === "pdf") exportPdf();
    else if (format === "png") exportPng();
  };

  // ---------- レイヤー操作 ----------
  const {
    reorder, moveTo, removeLayers, insertCopies, duplicateLayers, copyLayers, moveLayers, selectable, movable, toggleSelect,
    addLayer, centered, addComponent, addText, alignLayer,
  } = createLayerOps({ spec, setSpec, setSelected, setSelectedIds, clipboard, updateLayer, notifyRestorable });
  // ---------- アニメーション（PPTX エディターモード） ----------
  const { animOrder, setAnimations, moveAnimations, previewRef, previewAnimations, previewTransition, setTransition, setBgm } =
    useAnimationOps({ spec, setSpec, svgRef, posterId });

  // ---------- スライドショー（PPTX エディターモード） ----------
  /** 投影中のスライド（開始時点の中身）と、始めるスライドの番号 */
  const [show, setShow] = useState<{ slides: PosterSpec[]; start: number; view: Window | null } | null>(null);
  /**
   * 製品版：つながっている画面の数（発表者ビューの窓はクリック・キーの中で同期的に開くので、先に数えておく）。
   * モニターの抜き差しに追いつくよう、窓に戻ってきたときにも数え直す
   */
  const displayCount = useRef(1);
  useEffect(() => {
    const p = desktopBridge()?.presenter;
    if (!p) return;
    const count = () => { p.displayCount().then((n) => { displayCount.current = n; }).catch(() => {}); };
    count();
    window.addEventListener("focus", count);
    return () => window.removeEventListener("focus", count);
  }, []);
  /**
   * 製品版で画面が 2 つ以上つながっているか（PowerPoint と同じく、そのときは発表者ビュー付きで投影する）。
   * Web 版はポップアップが止められることがあるので、発表者ビューは Alt+F5 などで明示したときだけにする
   */
  const hasExtraScreen = () => (desktopBridge()?.presenter ? displayCount.current >= 2 : false);
  /**
   * fromCurrent なら開いているスライドから、そうでなければ 1 枚目から投影する。
   * withView なら発表者ビューを別ウィンドウで開く（ポップアップを止められないよう、クリック・キーの処理の中で同期的に開く）。
   * 省くと、画面が 2 つ以上のときだけ発表者ビュー付きにする
   */
  const startShow = (fromCurrent: boolean, withView = hasExtraScreen()) => {
    if (!deck) return;
    previewRef.current?.cancel();
    setTextEdit(null);
    setCropping(null);
    const specs = deck.slides.map((s) => specOf(s.id)).filter((s): s is PosterSpec => !!s);
    if (!specs.length) return;
    const cur = deck.slides.findIndex((s) => s.id === posterIdRef.current);
    const view = withView ? openPresenterWindow() : null;
    if (withView && !view) notify({ kind: "error", text: desktopBridge() ? "発表者ビューのウィンドウを開けませんでした" : "発表者ビューのウィンドウを開けませんでした。ブラウザのポップアップのブロックを解除してください" });
    setShow({ slides: specs, start: fromCurrent ? Math.max(cur, 0) : 0, view });
  };
  /** 投影を終えたら、発表者ビューを閉じ、最後に映していたスライドを開く */
  const endShow = (at: number) => {
    if (show?.view && !show.view.closed) show.view.close();
    setShow(null);
    const id = deck?.slides[at]?.id;
    if (id && id !== posterIdRef.current) goToSlide(id);
  };

  /** 台本が空のスライドの枚数（開いているスライドは編集中の内容で数える） */
  const missingNotes = isSlides && deck ? deck.slides.filter((s) => !(s.id === posterId ? spec : slides.get(s.id))?.notes?.trim()).length : 0;
  /** 台本（スライドのノート）を書き換える。空なら項目ごと消す */
  const setNotes = (notes: string, coalesce: string) => setSpec((s) => {
    const { notes: _, ...rest } = s;
    return notes ? { ...rest, notes } : rest;
  }, coalesce);

  /** 空の画像枠を置き、チャットの /image でプロンプトを入れてもらう */
  const addImage = () => {
    addLayer({ id: uid("image"), name: "画像", type: "image", fit: "contain", asset: { prompt: "", transparent: false, aspect: "square" }, ...centered(300, 300) });
    setInstruction("/image ");
    setAiTab("chat");
  };

  // ---------- キャンバス上のポインタ操作 ----------
  const { guides, marquee, interacting, toPoster, startMarquee, onLayerPointerDown, onResizeDown, onRotateDown, onStageHover } = useCanvasPointer({
    svgRef, spec, topIds, cropWheel, crop, cropRatio, setCropping, startTextEdit, updateLayer, moveLayers,
    replaceLayers: (layers, key) => {
      const replacements = new Map(layers.map((l) => [l.id, l]));
      setSpec((s) => ({ ...s, layers: s.layers.map((l) => replacements.get(l.id) ?? l) }), key);
    },
    selection: { selLayers, selectedLayer, selectedIds, multi, setSelected, setSelectedIds, toggleSelect, selectable, movable },
    setHovered,
  });

  /** スライドを開く。全スライドは手元にあるのでその場で切り替わる（AI の処理中は、結果を別のスライドに当てないよう切り替えない） */
  const goToSlide = (id: string) => {
    if (busy) return;
    openSlide(id).catch(notifyAIError);
  };
  /** スライド一覧で 1 枚前・後ろのスライドを開く（端では止まる） */
  const stepSlide = (dir: -1 | 1) => {
    if (!deck) return;
    const next = deck.slides[deck.slides.findIndex((s) => s.id === posterIdRef.current) + dir];
    if (next) goToSlide(next.id);
  };

  // ---------- キーボード ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || show) return; // メニューを閉じた Esc など・投影中
      const mod = e.ctrlKey || e.metaKey;
      // PowerPoint と同じく F5 で最初から、Shift+F5 で今のスライドから投影する（製品版で画面が 2 つ以上なら発表者ビュー付き）。Alt+F5 は画面が 1 つでも発表者ビュー付きで
      if (e.key === "F5" && isSlides && !mod) { e.preventDefault(); startShow(e.shiftKey || e.altKey, e.altKey || undefined); return; }
      const key = e.key.toLowerCase();
      // 保存は入力欄にフォーカスがあっても効かせる（ブラウザの「ページを保存」を出さない）
      if (mod && !e.shiftKey && key === "s") { e.preventDefault(); saveNow(); return; }
      if (isTextInput(e.target)) return;
      const shortcut = (fn: () => void) => { e.preventDefault(); fn(); };
      if (mod && key === "z") return shortcut(e.shiftKey ? redo : undo);
      if (mod && key === "y") return shortcut(redo);
      // Ctrl+±/0 はアプリ全体の縮尺に使うので横取りしない（Issue #61）。スライドの拡大縮小は Ctrl+ホイールとズームバー
      if (mod && key === "1") return shortcut(() => setZoom(1));
      // Ctrl+V は preventDefault しない（貼り付けは paste イベントで、画像があれば画像、無ければコピーしたレイヤー）
      if (mod && key === "a") return shortcut(() => setSelectedIds(spec.layers.filter(selectable).map((l) => l.id)));
      if (cropping && (e.key === "Escape" || e.key === "Enter")) return shortcut(() => setCropping(null));
      if (e.key === "Escape") { setSelected(null); return; }
      // スライド一覧の前後へ: PageUp / PageDown はいつでも、矢印キーはレイヤーを選んでいないとき（選択中はレイヤーの移動に使う）
      const slideDir = { PageUp: -1, PageDown: 1, ...(selLayers.length ? {} : { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }) }[e.key];
      if (slideDir && deck && !mod && !e.altKey) return shortcut(() => stepSlide(slideDir as -1 | 1));
      if (!selLayers.length) return;

      // 選択中のレイヤー（1 件でも複数でも）
      const ids = selLayers.map((l) => l.id);
      if (mod && key === "c") { copyLayers(selLayers); markLayerCopy(); notify({ kind: "info", text: multi ? `${selLayers.length} 件コピーしました` : "コピーしました" }); return; }
      if (mod && key === "x") { copyLayers(selLayers); markLayerCopy(); removeLayers(ids); return; }
      if (mod && key === "d") return shortcut(() => duplicateLayers(selLayers));
      // Ctrl+B / Ctrl+U: 選んだテキストの太字・下線を切り替える（Ctrl+U でブラウザの「ソースを表示」を出さない）
      const style = textStyleKey(e);
      if (style) {
        e.preventDefault();
        const texts = selLayers.filter((l): l is TextLayerT => l.type === "text" && !l.locked);
        if (texts.length) {
          const patches = new Map(toggleTextStyle(texts, style).map((p) => [p.id, p.patch]));
          setSpec((s) => ({ ...s, layers: s.layers.map((l) => (patches.has(l.id) ? ({ ...l, ...patches.get(l.id) } as Layer) : l)) }));
        }
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") return shortcut(() => removeLayers(ids));
      const d = arrowDelta(e);
      const targets = movable(selLayers);
      if (d && targets.length) return shortcut(() => moveLayers(targets, d[0], d[1], `nudge-${targets.map((l) => l.id).join(",")}`));
      if (!selectedLayer) return;

      // 1 件だけ選んでいるとき
      if (mod && (e.key === "]" || e.key === "}")) return shortcut(() => reorder(selectedLayer.id, (ls, i) => (e.shiftKey ? ls.length - 1 : i + 1)));
      if (mod && (e.key === "[" || e.key === "{")) return shortcut(() => reorder(selectedLayer.id, (_, i) => (e.shiftKey ? 0 : i - 1)));
      if (e.key === "Enter" && !mod && selectedLayer.type === "text" && !selectedLayer.locked) return shortcut(() => startTextEdit(selectedLayer.id));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------- 描画 ----------
  const submitOnModEnter = (fn: () => void, enabled: boolean) => (e: RKeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && enabled) { e.preventDefault(); fn(); }
  };
  /** チャット入力: Enter で送信、Shift+Enter で改行（日本語の変換確定の Enter では送らない） */
  const submitOnEnter = (fn: () => void, enabled: boolean) => (e: RKeyboardEvent) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (enabled) fn();
  };
  // 参考画像の再現は A4 モード（単体のポスター）だけ。PPTX のスライドでは使わない
  const reproduceOn = reproduce && refs.length > 0 && mode === "poster";
  const canPlan = canMake && !busy && !readingRefs && (!!brief.trim() || reproduceOn) && aiReady;
  // / コマンドは AI を使わないので、サインインしていなくても送れる
  const canChat = !busy && !readingRefs && !!instruction.trim() && (aiReady || /^[/／]/.test(instruction.trim()) || isImageRequest(instruction) || isImageRedoRequest(instruction));
  const slashItems = slashClosed ? [] : slashSuggestions(instruction, isSlides, mode === "poster");
  const slashSel = Math.min(slashActive, Math.max(slashItems.length - 1, 0));
  /** 候補を選ぶ: 内容を書くコマンドは入力欄に入れて続きを待ち、それ以外はその場で実行する */
  const pickSlash = (c: SlashCommand) => {
    setSlashActive(0);
    if (c.arg && !c.optional) setInstruction(`/${c.name} `);
    else if (!busy) { setInstruction(""); runSlash(c, "", () => setInstruction(`/${c.name}`)); }
  };
  /** チャット入力のキー操作: 候補が出ている間は ↑↓・Tab・Enter・Esc を候補の操作に使う */
  const onChatKey = (e: RKeyboardEvent) => {
    if (slashItems.length && !e.nativeEvent.isComposing) {
      const n = slashItems.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSlashActive((slashSel + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); setSlashClosed(true); return; }
      if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); setInstruction(`/${slashItems[slashSel].name} `); return; }
      if (e.key === "Enter" && !e.shiftKey && e.keyCode !== 229) { e.preventDefault(); pickSlash(slashItems[slashSel]); return; }
    }
    submitOnEnter(() => sendChat(), canChat)(e);
  };
  // 未サインインで AI ボタンが押せない理由をボタンのそばに出す
  // OpenRouter のキーがあるのに使えない = AI の設定で ChatGPT を選んでいる
  // 製品版の AI は ChatGPT プランだけなので、OpenRouter の案内は出さない
  const orHint = desktopBridge() ? "" : openrouter ? "（AI の設定で OpenRouter に切り替えられます）" : "（または .env に OPENROUTER_API_KEY を設定）";
  const signinNote = !aiReady && (
    <p className="notice-inline">
      {status?.ai?.explicit === "openrouter"
        ? "OpenRouter の API キー（.env の OPENROUTER_API_KEY）が無いため、この機能は使えません（AI の設定で切り替えられます）。"
        : gpt?.signedIn ? `このアカウントでは ChatGPT プランを利用できないため、この機能は使えません${orHint}。` : `この機能は ChatGPT Plus / Pro などの対象プランでのサインインが必要です（無料プランは非対応）${orHint}。`}
      {status?.ai?.explicit !== "openrouter" && !gpt?.signedIn && <button className="small" onClick={api.chatgptLogin}>サインイン</button>}
    </p>
  );
  /** 送信の対象を示すチップ（× で選択解除） */
  /** レイヤーを選んでいないときの対象。デッキでは開いているスライド（ふつうの修正はそのスライドだけを書き換える） */
  const slideNo = deck ? deck.slides.findIndex((s) => s.id === posterId) + 1 : 0;
  const chatFallback = slideNo ? `スライド ${slideNo}` : "ポスター全体";
  const targetChip = (label: string | null, fallback: string) => label
    ? <span className="chip">{label}<button aria-label="対象を解除" onClick={() => setSelected(null)}>×</button></span>
    : <span className="chip muted">{fallback}</span>;
  const serverSave = save.serverSave, browserSave = save.browserSave;

  return (
    <div
      className={"app" + (leftOpen ? "" : " left-collapsed") + (rightOpen ? "" : " right-collapsed") + (resizing ? " resizing" : "")}
      style={{
        ...(leftW ? { "--lpw": `min(${leftW}px, 40vw)` } : {}),
        ...(rightW ? { "--rpw": `min(${rightW}px, 40vw)` } : {}),
      } as React.CSSProperties}
    >
      <aside className={"left float-panel" + (leftOpen ? "" : " collapsed")} ref={leftRef}>
        {/* 畳んだときのアイコンだけのバー（開閉は幅のアニメーションで切り替える） */}
        <div className="left-rail" inert={leftOpen}>
          <button className="icon-btn" onClick={() => toggleLeft(true)} title="パネルを開く" aria-label="パネルを開く"><Ico name="chevronRight" /></button>
          {canMake && <button className={"icon-btn" + (tab === "plan" ? " on" : "")} onClick={() => { setAiTab("plan"); toggleLeft(true); }} title="新規作成" aria-label="新規作成"><Ico name="sparkles" /></button>}
          <button className={"icon-btn" + (tab === "chat" ? " on" : "")} onClick={() => { setAiTab("chat"); toggleLeft(true); }} title="チャット" aria-label="チャット"><Ico name="message" /></button>
        </div>
        <div className="left-full" inert={!leftOpen}>
        <div className="panel-head">
          <div className="panel-head-row">
            <Menu className="brand-menu" fixed trigger={({ open, toggle }) => (
              <button className="brand" aria-haspopup="menu" aria-expanded={open} onClick={toggle} title="メニュー（ホーム・成果物・ファイルを開く）">
                <span className="brand-mark" aria-hidden>DC</span>
                <span className="brand-name">DC-Designer</span>
                <Ico name="chevronDown" size={14} />
              </button>
            )}>
              {(close) => (
                <div className="menu-list" role="menu" onClick={(e) => (e.target as Element).closest("button") && close()}>
                  <button role="menuitem" onClick={() => leaveTo(modeHomeUrl(mode))}><Ico name="home" /> ホーム<small>{MODES[mode].label}の新規作成・最近の成果物</small></button>
                  <button role="menuitem" onClick={() => leaveTo(modeLibraryUrl(mode))}><Ico name="folder" /> 成果物<small>{MODES[mode].label}の{MODES[mode].item}の一覧</small></button>
                  <button role="menuitem" onClick={() => leaveTo(HOME_URL)}><Ico name="layers" /> モードを選ぶ<small>ポスター・スライド</small></button>
                  {mode === "slides" && <>
                    <div className="menu-sep" />
                    <label className="as-button" role="menuitem"><Ico name="slides" /> PowerPoint を開く…<small>スライドごとに編集</small><input type="file" accept={PPTX_ACCEPT} hidden onChange={(e) => { e.target.files?.[0] && importPptxFile(e.target.files[0]); e.target.value = ""; close(); }} /></label>
                  </>}
                  <div className="menu-sep" />
                  <button role="menuitem" onClick={saveNow} disabled={save.savingNow}><Ico name="save" /> 今すぐ保存<small><kbd>{MOD}+S</kbd></small></button>
                  <button role="menuitem" onClick={saveAsTemplate} disabled={save.savingNow || !posterId}><Ico name="copy" /> テンプレートとして保存<small>{mode === "slides" ? "デッキ丸ごと" : "このポスター"}</small></button>
                  {appVersion && <><div className="menu-sep" /><p className="menu-note">DC-Designer {appVersion}</p></>}
                </div>
              )}
            </Menu>
            <span className="spacer" />
            <span
              className={"save-state " + (serverSave === "error" ? "error" : browserSave)}
              title={serverSave === "error" ? "API サーバーに保存できません。ブラウザには保存しているので、サーバーが戻ると自動で保存します" : `成果物に自動保存しています（${MOD}+S で今すぐ保存）`}
            >
              {serverSave === "saving" ? <><span className="spinner small" aria-hidden /> 保存中</>
                : serverSave === "error" ? <><Ico name="alert" size={13} /> {browserSave === "saved" ? "未保存（ブラウザには保存済み）" : "保存できません"}</>
                : browserSave === "saved" ? <><Ico name="check" size={13} /> 保存済み</>
                : <><Ico name="alert" size={13} /> ブラウザに保存できません（容量超過）</>}
            </span>
            <button className="icon-btn" onClick={() => toggleLeft(false)} title="パネルを閉じる" aria-label="パネルを閉じる"><Ico name="chevronLeft" /></button>
          </div>
          <input
            className="title-input"
            aria-label={`${MODES[mode].item}のタイトル`}
            placeholder={mode === "slides" ? "無題のプレゼンテーション" : "無題のポスター"}
            value={deck ? deck.name : spec.meta.title}
            onChange={(e) => deck ? renameDeck(e.target.value) : setSpec((s) => ({ ...s, meta: { ...s.meta, title: e.target.value } }), "title")}
          />
        </div>
        <div className="left-body">
        <section
          className={"panel" + (tab === "chat" ? " chat-panel" : "") + (refDrop.over ? " drop-over" : "")}
          {...refDrop.props}
        >
          {canMake && <div className="tabs" role="tablist" aria-label="AI">
            <button role="tab" aria-selected={tab === "plan"} className={tab === "plan" ? "active" : ""} onClick={() => setAiTab("plan")}><Ico name="sparkles" /> 新規作成</button>
            <button role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "active" : ""} onClick={() => setAiTab("chat")}><Ico name="message" /> チャット</button>
          </div>}

          {tab === "plan" && <>
            <textarea
              rows={7}
              aria-label="ポスターの内容（ブリーフ）"
              placeholder="ポスターの内容（タイトル・日時・場所・対象など）"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              onKeyDown={submitOnModEnter(planWithAI, canPlan)}
            />
            <ImageAttach
                images={refs}
                max={MAX_REFERENCES}
                label="参考画像・PDFを添付（1ファイル20MB）"
                caption="画像・PDF"
                accept={REFERENCE_FILE_ACCEPT}
                disabled={readingRefs || !!busy}
                onAdd={onRefFiles}
                onRemove={(i) => setRefs((x) => x.filter((_, j) => j !== i))}
              />
            <div className="row">
              {refs.length > 0 && !deck && mode === "poster" && (
                <label className="check small" title="参考画像の 1 枚目を、文字・位置・色までそのまま写し取ります（写真やイラストは参考画像から切り抜きます）">
                  <input type="checkbox" checked={reproduce} onChange={(e) => setReproduce(e.target.checked)} /> 1 枚目をそのまま再現
                </label>
              )}
            </div>
            {readingRefs && <p className="hint small" role="status">参考資料を読み込み中…</p>}
            {signinNote}
            <button className="primary block" disabled={!canPlan} onClick={planWithAI}>
              <Ico name="sparkles" /> {reproduceOn ? "参考画像を再現" : "レイアウトを生成"} <kbd>{MOD}+Enter</kbd>
            </button>
            {reproduceOn && <p className="hint small">ブリーフは空でも構いません。文言を差し替えたいときだけ書いてください</p>}
            {refOverlay && !isSlides && (
              <div className="row">
                <button className="small" onClick={toggleRefOverlay} title="参考画像を半透明で重ねて、ずれを確認します">
                  <Ico name="eye" size={14} /> {refOverlay.visible === false ? "参考画像を重ねる" : "重ねるのをやめる"}
                </button>
                <button className="small" disabled={!!busy || !aiReady} onClick={refineWithAI} title="今の見た目を参考画像と見比べて、ずれをもう一度直します">
                  <Ico name="sparkles" size={14} /> 見比べて直す
                </button>
              </div>
            )}
            {mode === "poster" && spec.layers.length > 1 && brief.trim() && <p className="hint small">現在のポスターは置き換わります（あとで元に戻せます）</p>}
          </>}

          {tab === "chat" && <>
            {(chat.messages.length > 0 || chat.memory) && (
              <div className="chat-head">
                {chat.memory && (
                  <details className="chat-memory">
                    <summary title="古いやりとりは要約して覚えています。AI には要約と直近の会話を渡します"><Ico name="brain" size={13} /> {chat.memory.count} 件の発言を要約して記憶中{chat.compacting ? "（更新中…）" : ""}</summary>
                    <div className="chat-memory-body">{chat.memory.summary}</div>
                  </details>
                )}
                {!chat.memory && chat.compacting && <span className="chat-memory-status"><Ico name="brain" size={13} /> 会話を要約中…</span>}
                <button className="link" disabled={!!busy} onClick={clearChat} title="チャットの履歴と記憶（要約）をすべて消去します">履歴を消去</button>
              </div>
            )}
            <ChatLog
              messages={chat.messages}
              pending={chat.pending}
              examples={CHAT_EXAMPLES}
              onExample={(t) => setInstruction(t)}
              onUndo={undoChat}
              onResend={resendChat}
              onGenerateImages={generateFromReply}
              busy={!!busy}
              canResend={(m) => !busy && !readingRefs && (!m.hasReferences || !!m.references) && (aiReady || m.mode === "image" || /^[/／]/.test(m.text))}
            />
            <div className="composer">
              <div className="composer-top">
                {targetChip(chatScope, chatFallback)}
              </div>
              {slashItems.length > 0 && (
                <SlashMenu items={slashItems} active={slashSel} onPick={pickSlash} onHover={setSlashActive} />
              )}
              <textarea
                rows={3}
                aria-label="AI へのメッセージ"
                placeholder={multi ? `選んだ ${selLayers.length} 件をどう変えますか？` : selectedLayer ? `「${layerName(selectedLayer)}」をどう変えますか？` : "メッセージを入力（/ でコマンド。「海の写真を作って」で画像も作れます）"}
                value={instruction}
                onChange={(e) => { setInstruction(e.target.value); setSlashClosed(false); setSlashActive(0); }}
                onKeyDown={onChatKey}
              />
              <ReferenceAttachments files={refs} disabled={readingRefs || !!busy} onRemove={(i) => setRefs((x) => x.filter((_, j) => j !== i))} />
              {readingRefs && <p className="hint small" role="status">参考資料を読み込み中…</p>}
              <div className="composer-bar">
                <label
                  className={"as-button small icon" + (busy || readingRefs ? " disabled" : "")}
                  title="参考資料として画像・PDFを添付（合計20ページまで、1ファイル20MB）"
                  aria-label="参考資料を添付"
                >
                  <Ico name="paperclip" />
                  <input
                    type="file"
                    accept={REFERENCE_FILE_ACCEPT}
                    multiple
                    hidden
                    disabled={!!busy || readingRefs}
                    onChange={(e) => { onRefFiles(e.target.files); e.target.value = ""; }}
                  />
                </label>
                <label
                  className={"as-button small icon" + (busy ? " disabled" : "")}
                  title={selectedLayer && replaceableByImage(selectedLayer, W, H) ? "画像ファイルで差し替え" : "画像ファイルから挿入（キャンバスへのドロップ・貼り付けでも可）"}
                  aria-label="画像ファイルを置く"
                >
                  <Ico name="image" />
                  <input
                    type="file"
                    accept={IMAGE_FILE_ACCEPT}
                    multiple={!(selectedLayer && replaceableByImage(selectedLayer, W, H))}
                    hidden
                    disabled={!!busy}
                    onChange={(e) => { insertImageFilesHere(e.target.files); e.target.value = ""; }}
                  />
                </label>
                {aiProvider === "chatgpt" && gpt?.signedIn && gpt.models?.length ? (
                  <ModelSelect className="composer-model" label="ChatGPT のモデル" models={gpt.models} choice={gpt.modelChoice ?? ""} autoModel={gpt.autoModel} disabled={!!busy} onChange={chooseChatGPTModel} />
                ) : aiProvider === "openrouter" && openrouter?.models?.length ? (
                  <ModelSelect className="composer-model" label="OpenRouter のモデル" models={openrouter.models} choice={openrouter.modelChoice} autoModel={openrouter.autoModel} disabled={!!busy} onChange={chooseOpenRouterModel} />
                ) : null}
                <button className="primary send" disabled={!canChat} onClick={() => sendChat()} aria-label="送信">送信</button>
              </div>
              {signinNote}
            </div>
          </>}
        </section>
        </div>
        <AccountBar
          status={status}
          imageChoices={imageChoices}
          imageProvider={activeImageProvider}
          onImageProvider={chooseImageProvider}
          autoImages={autoImages}
          onAutoImages={toggleAutoImages}
          onChatGPTModel={chooseChatGPTModel}
          onOpenRouterModel={chooseOpenRouterModel}
          onAIProvider={chooseAIProvider}
          onSignOut={signOut}
          onStatusChanged={refreshStatus}
        />
        </div>
      </aside>

      {leftOpen && (
        <Resizer
          className="left" edge="right" label="左パネルの幅を変える" min={240} max={Math.min(560, window.innerWidth * 0.4)}
          getSize={() => leftRef.current?.offsetWidth ?? 304} onResize={setLeftW} onDragging={setResizing}
        />
      )}

      <main
        className={"stage-wrap" + (deck ? " with-deck" + (deckOpen ? "" : " deck-collapsed") + (!isSlides ? " no-notes" : notesOpen ? "" : " notes-collapsed") : "")}
        style={{ ...(deckH ? { "--dh-open": `${deckHeight}px` } : {}), ...(notesH ? { "--nh-open": `${notesHeight}px` } : {}) } as React.CSSProperties}
      >
        <div
          className={"stage" + (panning ? " panning" : "") + (stageDrop.over ? " drop-over" : "")}
          ref={stageRef}
          onPointerDownCapture={(e) => { if (e.button === 0 && e.altKey) startPanView(e); }}
          {...stageDrop.props}
          onPointerDown={(e) => e.button === 0 && startMarquee(e)}
          onPointerMove={onStageHover}
          onPointerLeave={() => setHovered(null)}
        >
          <div className={"artboard" + (marquee ? " selecting" : interacting ? " interacting" : "")} style={{ width: W * scale, height: H * scale, transform: pan.x || pan.y ? `translate(${pan.x}px, ${pan.y}px)` : undefined }}>
            <Poster ref={svgRef} spec={spec} onLayerPointerDown={onLayerPointerDown} />
            {!renderReady && <RenderLoading />}
            <CanvasOverlay
              width={W} height={H} px={px} layers={spec.layers}
              guides={guides} generatingIds={generatingIds} flash={flash}
              hovered={hoveredLayer} selected={selectedLayer} selection={selLayers}
              marquee={marquee} interacting={interacting} editing={!!editLayer} crop={crop}
              printGuide={mode === "poster" && a4Guide ? { margin: SAFE_MARGIN_MM / a4Fit(W, H).mmPerUnit } : null}
              onRotateDown={onRotateDown} onResizeDown={onResizeDown}
            >
              {editLayer && textEdit && (
                <TextEditor
                  key={textEdit.key}
                  layer={editLayer}
                  theme={theme}
                  svg={svgRef.current}
                  at={textEdit.at}
                  px={px}
                  onChange={(patch) => updateLayer(editLayer.id, patch as Partial<Layer>, textEdit.key)}
                  onStyle={(patch) => updateLayer(editLayer.id, patch as Partial<Layer>)}
                  onDone={() => setTextEdit(null)}
                />
              )}
            </CanvasOverlay>
            {multi && interacting && !marquee && (() => {
              const b = unionBox(selLayers);
              return <MeasureLabel box={b} scale={scale}>{selLayers.length} 件　({Math.round(b.x)}, {Math.round(b.y)})</MeasureLabel>;
            })()}
            {crop && (
              <MeasureLabel box={crop.layer} scale={scale}>
                {Math.round((crop.info.crop?.scale ?? 1) * 100)}%　ドラッグで位置・ホイールで拡大・Enter で完了
              </MeasureLabel>
            )}
            {selectedLayer && interacting && !crop && (
              <MeasureLabel box={selectedLayer} scale={scale}>
                {selectedLayer.rotation ? `${selectedLayer.rotation}° · ` : ""}{selectedLayer.w} × {selectedLayer.h}　({selectedLayer.x}, {selectedLayer.y})
              </MeasureLabel>
            )}
          </div>
        </div>

        {deck && (
          <DeckStrip
            deck={deck} slides={slides} currentSpec={spec} open={deckOpen} currentId={posterId} width={W} height={H} thumbHeight={deckHeight - DECK_CHROME_H} disabled={!!busy}
            onOpen={goToSlide} selectedIds={selectedSlideIds} onSelect={setSelectedSlideIds}
            onAdd={addSlide} onDuplicate={duplicateSlide} onRemove={removeSlides} onMove={moveSlide} onReorder={reorderSlide}
            onExport={exportDeck} onFonts={openFontDialog} onToggle={toggleDeck} onPresent={() => startShow(false)} onPresentView={() => startShow(true, true)}
          />
        )}
        {deck && deckOpen && (
          <Resizer
            className="deck" edge="top" label="スライド一覧の高さを変える" min={DECK_CHROME_H + 24} max={deckMax}
            getSize={() => deckHeight} onResize={setDeckH} onDragging={setResizing}
          />
        )}
        {isSlides && (
          <NotesPanel
            key={posterId ?? ""} notes={spec.notes ?? ""} open={notesOpen} onToggle={toggleNotes} onChange={setNotes}
            missing={missingNotes} canWrite={!busy && aiReady} onWriteMissing={() => writeNotesTurn({ text: "/notes", mode: "chat" })}
          />
        )}
        {isSlides && notesOpen && (
          <Resizer
            className="notes" edge="top" label="台本欄の高さを変える" min={NOTES_CHROME_H + 40} max={notesMax}
            getSize={() => notesHeight} onResize={setNotesH} onDragging={setResizing}
          />
        )}
        {pendingCount > 0 && (
          <div className="float-bar gen-bar">
            <button
              className={"primary" + (!busy ? " attention" : "")}
              disabled={!!busy}
              onClick={generateAll}
              title="未生成の画像をまとめて生成します"
            >
              <Ico name="image" /> 画像を生成<span className="pill-count">{pendingCount}</span>
            </button>
          </div>
        )}
        <div className="zoombar float-bar" role="group" aria-label="ズーム">
          <button onClick={() => zoomBy(-1)} title={`縮小（${MOD}+ホイールでも可）`} aria-label="縮小"><Ico name="minus" /></button>
          <button className="zoom-val" onClick={() => (zoom === "fit" ? setZoom(1) : fitView())} title="クリックで 100% / 全体表示を切替">
            {Math.round(scale * 100)}%
          </button>
          <button onClick={() => zoomBy(1)} title={`拡大（${MOD}+ホイールでも可）`} aria-label="拡大"><Ico name="plus" /></button>
          <button onClick={fitView} disabled={zoom === "fit" && !pan.x && !pan.y} title="全体を表示" aria-label="全体を表示"><Ico name="fit" /></button>
        </div>

        <Toasts busy={busy} notices={notices} onDismiss={dismiss} />
      </main>

      {rightOpen && (
        <Resizer
          className="right" edge="left" label="右パネルの幅を変える" min={260} max={Math.min(560, window.innerWidth * 0.4)}
          getSize={() => rightRef.current?.offsetWidth ?? 304} onResize={setRightW} onDragging={setResizing}
        />
      )}
      <aside className={"right float-panel" + (rightOpen ? "" : " collapsed")} ref={rightRef}>
        {/* 畳んだときのアイコンだけのバー */}
        <div className="right-rail" inert={rightOpen}>
          <button className="icon-btn" onClick={() => toggleRight(true)} title="パネルを開く" aria-label="パネルを開く"><Ico name="chevronLeft" /></button>
          <button className="icon-btn" onClick={undo} disabled={!canUndo} title={`元に戻す（${MOD}+Z）`} aria-label="元に戻す"><Ico name="undo" /></button>
          <button className="icon-btn" onClick={redo} disabled={!canRedo} title={`やり直す（${MOD}+Shift+Z）`} aria-label="やり直す"><Ico name="redo" /></button>
          <button className="icon-btn" onClick={() => toggleRight(true)} title="インスペクターとレイヤー" aria-label="インスペクターとレイヤー"><Ico name="layers" /></button>
        </div>
        <div className="right-full" inert={!rightOpen}>
        {/* 選んだ要素の編集とレイヤー一覧は、別のカードに分けて境目をはっきりさせる */}
        <div className="right-card right-edit">
        <div className="panel-head panel-head-row">
          <button className="icon-btn" onClick={() => toggleRight(false)} title="パネルを閉じる" aria-label="パネルを閉じる"><Ico name="chevronRight" /></button>
          <div className="btn-group">
            <button className="icon-btn" onClick={undo} disabled={!canUndo} title={`元に戻す（${MOD}+Z）`} aria-label="元に戻す"><Ico name="undo" /></button>
            <button className="icon-btn" onClick={redo} disabled={!canRedo} title={`やり直す（${MOD}+Shift+Z）`} aria-label="やり直す"><Ico name="redo" /></button>
          </div>
          <span className="spacer" />
          {isSlides && <button className="icon-btn" onClick={() => startShow(true)} title="このスライドから投影（Shift+F5。F5 で最初から）。モニターが 2 台以上なら、もう一方に台本の出る発表者ビューを出す" aria-label="スライドショー"><Ico name="monitor" /></button>}
          {isSlides && <button className="icon-btn" onClick={() => previewAnimations()} disabled={!animOrder.size} title={animOrder.size ? `このスライドの動きを再生（${animOrder.size} 件）` : "このスライドには動き（アニメーション）がありません。要素を選んでインスペクターで付けられます"} aria-label="このスライドの動きを再生"><Ico name="play" /></button>}
          {!deck && <button className="icon-btn" onClick={() => setPosterFontDialog(true)} disabled={!!busy} title="ポスターの雰囲気に合うフォントを ChatGPT に提案してもらい、適用する（未インストールなら PC に入れる）" aria-label="フォントを提案してもらう"><Ico name="type" /></button>}
          {mode === "poster" && (
            <A4Check spec={spec} guide={a4Guide} onGuide={setA4Guide} onFix={fixA4} onSelect={(id) => setSelected(id)} onPrint={printA4} disabled={!!busy} />
          )}
          <ThemeMenu />
          <Menu trigger={({ open, toggle }) => <button className="icon-btn" aria-haspopup="dialog" aria-expanded={open} onClick={toggle} title="操作のヒント" aria-label="操作のヒント"><Ico name="help" /></button>}>
            {() => (
              <div className="menu-list help-list" role="dialog" aria-label="操作のヒント">
                <ShortcutList mod={MOD} />
              </div>
            )}
          </Menu>
          <button className="primary export-btn" onClick={confirmExport} aria-label="書き出し" title={deck ? "全スライドを PowerPoint（PPTX）で書き出し" : "PDF・PNG で書き出し（A4 300dpi・2480×3508px）"}><Ico name="download" /><span className="export-label">書き出し</span></button>
        </div>
        {(selectedLayer || multi) && <div className="inspector-wrap">
          <Inspector
            layer={selectedLayer}
            multiCount={multi ? selLayers.length : 0}
            spec={spec}
            generating={!!selectedLayer && generatingIds.has(selectedLayer.id)}
            onChange={(patch, coalesce) => selectedLayer && updateLayer(selectedLayer.id, patch, coalesce)}
            onReplace={(l) => selectedLayer && updateLayer(selectedLayer.id, () => l)}
            onRegenerate={() => selectedLayer && regenerateLayer(selectedLayer.id)}
            onPickImage={(files) => selectedLayer && insertImageFiles(files, { replaceId: selectedLayer.id })}
            onDuplicate={() => duplicateLayers(selLayers)}
            onDelete={() => removeLayers(selLayers.map((l) => l.id))}
            onAlign={(where) => selectedLayer && alignLayer(selectedLayer.id, where)}
            onArrange={(dir) => selectedLayer && reorder(selectedLayer.id, (ls, i) => ({ front: ls.length - 1, forward: i + 1, backward: i - 1, back: 0 })[dir])}
            busy={!!busy}
            cropping={!!crop}
            cropRatio={cropRatio}
            onToggleCrop={() => setCropping(crop ? null : selected)}
            animation={isSlides ? (() => {
              const layers = selLayers.filter((l) => l.type !== "background");
              const ids = layers.map((l) => l.id);
              return {
                layers,
                order: animOrder,
                total: animOrder.size,
                onSet: (update, co) => setAnimations(ids, update, co),
                onMove: (dir) => moveAnimations(ids, dir),
                onPreview: () => previewAnimations(ids),
              };
            })() : undefined}
            mod={MOD}
          />
        </div>}
        {isSlides && deck && !selectedLayer && !multi && <div className="inspector-wrap">
          <TransitionBox
            key={posterId ?? ""} transition={spec.transition} bgm={spec.bgm ?? []} slideCount={deck.slides.length}
            onChange={setTransition} onBgmChange={setBgm} onPreview={previewTransition} onApplyAll={applyTransitionToAll}
          />
        </div>}
        </div>

        <div className={"right-card right-layers" + (layersOpen ? "" : " collapsed")}>
        <LayersPanel
          spec={spec}
          selectedIds={selectedIds}
          hovered={hovered}
          generatingIds={generatingIds}
          onSelect={(id, additive) => (additive ? toggleSelect(id) : setSelected(id))}
          onHover={setHovered}
          onUpdate={(id, patch) => updateLayer(id, patch)}
          onMoveTo={moveTo}
          onAddText={addText}
          onAddImage={addImage}
          onAddComponent={addComponent}
          animOrder={isSlides ? animOrder : undefined}
          open={layersOpen}
          onToggle={toggleLayers}
        />
        </div>
        </div>
      </aside>

      {fontDialog && deck && (
        <FontDialog
          kind="slides" deckName={deck.name} texts={fontDialog.texts} current={fontDialog.current}
          subject={workSubject(deck, posterIdRef.current, deck.name)} onApply={applyDeckFonts} onError={notifyAIError} onClose={() => setFontDialog(null)}
        />
      )}

      {posterFontDialog && !deck && (
        <FontDialog
          kind="poster" deckName={spec.meta.title} texts={specTexts(spec)} current={{ display: theme.fonts.display, body: theme.fonts.body }}
          subject={workSubject(null, posterIdRef.current, spec.meta.title)} onApply={applyPosterFonts} onError={notifyAIError} onClose={() => setPosterFontDialog(false)}
        />
      )}

      {show && <Presenter slides={show.slides} start={show.start} view={show.view} onExit={endShow} />}

      {welcome && <WelcomeModal status={status} onClose={closeWelcome} />}
    </div>
  );
}
