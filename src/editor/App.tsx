import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type DragEvent as RDragEvent } from "react";
import { slideContent } from "../notes";
import { Poster } from "../render/Poster";
import { buildExportSvg, download, renderSpecPng, svgToPngSized } from "../render/export";
import { A4Check } from "./A4Check";
import { a4Fit, a4Instruction, a4Issues, a4Size, exportPixels, fitToA4, pngA4Report, PRINT_DPI, readPngInfo, SAFE_MARGIN_MM, setPngDpi } from "./a4";
import { cropTarget } from "../render/ImageBox";
import { useRenderReady } from "../render/useRenderReady";
import { playAnimations } from "../render/animatePreview";
import { animationSequence, renumberAnimations } from "../animation";
import { findPendingAssets, PosterSpecSchema, type AssetRequest, type Layer, type LayerAnimation, type PosterSpec, type SlideBgm, type SlideTransition } from "../schema";
import { resolveTheme } from "../themes";
import { applyFonts, specTexts } from "../fonts";
import { blankInstagramSpec, IG_DEFAULT_RATIO, IG_MAX_IMAGES, IG_RATIO_KEYS, IG_RATIOS, nearestRatio, ratioOf, type IgRatio } from "../instagram";
import { CATALOG_BY_NAME } from "../components/catalog";
import sample from "../../samples/ai-workshop.json";
import { api, readDataUrl, type AIProgress, type AIProvider, type DeckEditContext, type RefImage, type Status } from "./api";
import { AccountBar, ModelSelect, WelcomeModal } from "./AccountBar";
import { unionBox } from "./canvas";
import { CanvasOverlay, MeasureLabel, type CropState } from "./CanvasOverlay";
import { ChatLog, useChat, type ChatMsg } from "./ChatLog";
import { DeckStrip } from "./DeckStrip";
import { Resizer, usePanelSize } from "./usePanelSize";
import { FontDialog } from "./FontDialog";
import { Inspector, ShortcutList, TransitionBox } from "./Inspector";
import { TRANSITION_EASING, transitionKeyframes } from "../transition";
import { playSound } from "../sounds";
import { LayersPanel } from "./LayersPanel";
import { blockPageFileDrop } from "./fileDrop";
import { useFileDrop } from "./useFileDrop";
import { NotesPanel } from "./NotesPanel";
import { Presenter } from "./Presenter";
import { openPresenterWindow } from "./PresenterView";
import { HOME_URL, IMPORT_NOTICE_KEY, PENDING_BRIEF_KEY } from "./nav";
import { modeHomeUrl, modeLibraryUrl, modeOfDeck, MODES, readModeParam, writeLastId, type AppMode } from "./mode";
import { isMissingNotesRequest, isWriteNotesRequest } from "./notes";
import { isRenumberRequest } from "./pageNumbers";
import { addSlidePosition } from "./addSlide";
import { isWholeDeckRequest, slideRefs } from "./slideRefs";
import { parseSlash, slashSuggestions, SlashMenu, type SlashCommand } from "./slashCommands";
import {
  alignedPosition, aspectOf, assetHolder, diffLayers, IMAGE_FILE_ACCEPT, IMAGE_FILE_TYPES, imageSlot, insertAfter, isVisibleOnCanvas,
  naturalSize, patchAsset, PPTX_ACCEPT, prepareAsset, reorderLayer, moveLayerTo, safeFileName, toLayerRef, uid, type AlignTo, type LayerRef,
} from "./specOps";
import { blobToRef, fitToRatio, loadImage, overlayOf, REF_OVERLAY_ID, referenceSize, resolveRefCrops, scaledReference, withOverlay, withoutOverlay } from "./reproduce";
import { readPref, STORAGE_KEY, writePref } from "./storage";
import { TextEditor } from "./TextEditor";
import { Toasts, useNotices, type Busy, type Notice } from "./Toasts";
import { ask, Menu, RenderLoading, ThemeMenu, useLoadWithRetry } from "./ui";
import { Ico } from "./uiIcons";
import { useAutoSave } from "./useAutoSave";
import { topLayerAt, useCanvasPointer } from "./useCanvasPointer";
import { useDeck } from "./useDeck";
import { useChatGPTAuth } from "./useChatGPTAuth";
import { useHistory } from "./useHistory";
import { useZoom } from "./useZoom";
import { MAX_REFERENCES, MAX_REFERENCE_DATA_BYTES } from "../referenceLimits";
import { REFERENCE_FILE_ACCEPT, readReferenceFile, type ReferencePage } from "./referenceFiles";
import { ImageAttach } from "./ImageAttach";

const IMAGE_PROVIDER_KEY = "dc-designer:image-provider";
const AUTO_IMAGES_KEY = "dc-designer:auto-images";
const LEFT_OPEN_KEY = "dc-designer:left-open";
const RIGHT_OPEN_KEY = "dc-designer:right-open";
const LEFT_WIDTH_KEY = "dc-designer:left-width";
const RIGHT_WIDTH_KEY = "dc-designer:right-width";
const DECK_HEIGHT_KEY = "dc-designer:deck-height";
const NOTES_OPEN_KEY = "dc-designer:notes-open";
const NOTES_HEIGHT_KEY = "dc-designer:notes-height";
const IG_REPRODUCE_KEY = "dc-designer:ig-reproduce";
/** Instagram の再現で同時に写し取る画像の数（1 枚でも中で 6 本の帯を同時に書かせている） */
const IG_REPRODUCE_CONCURRENCY = 2;
/** スライド一覧の既定の高さ（styles.css の --dh と合わせる）と、サムネイル以外の見出し・余白の分 */
const DECK_H = 127, DECK_CHROME_H = 63;
/** 台本欄の既定の高さ（styles.css の --nh と合わせる）と、畳んだときの高さ */
const NOTES_H = 132, NOTES_CHROME_H = 38;
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

function loadInitial(): PosterSpec {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return PosterSpecSchema.parse(JSON.parse(raw));
  } catch { /* 破損時はサンプル */ }
  return PosterSpecSchema.parse(sample);
}

const layerName = (l: Layer) => l.name ?? l.id;

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
  const { state: spec, set: setSpec, reset: resetSpec, stash: stashHistory, undo, redo, canUndo, canRedo } = useHistory<PosterSpec>(loadInitial());
  const W = spec.meta.width, H = spec.meta.height;
  const theme = resolveTheme(spec.theme, spec.themeOverride);
  const pending = useMemo(() => findPendingAssets(spec), [spec]);

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
  const [status, setStatus] = useState<Status | null>(null);
  const refreshStatus = useLoadWithRetry(useCallback(() => api.status().then(setStatus), []));
  const apiUp = !!status;
  const gpt = status?.chatgpt;
  // レイアウト生成・AI 修正に使う AI（ChatGPT プランか OpenRouter）。どちらも使えなければ undefined。
  // ai を返さない古い API サーバー（再起動前）のあいだは、従来どおり ChatGPT プランが使えれば ChatGPT
  const aiProvider = status?.ai ? status.ai.provider : gpt?.signedIn && gpt.planEnabled ? "chatgpt" : undefined;
  const openrouter = status?.ai?.openrouter;
  const aiReady = !status || !!aiProvider;
  /** 進み具合の表示での AI の呼び名 */
  const aiName = aiProvider === "openrouter" ? "AI" : "ChatGPT";
  const [imageProvider, setImageProvider] = useState(() => readPref(IMAGE_PROVIDER_KEY) ?? "");
  const [autoImages, setAutoImages] = useState(() => readPref(AUTO_IMAGES_KEY) !== "0");
  // ダミー画像（placeholder）は選択肢に出さない
  const imageChoices = status?.imageProviders.filter((p) => p !== "placeholder") ?? [];
  // 選んだプロバイダが使えなくなっていたら（キー削除など）サーバーの既定 → 先頭の選択肢に戻す
  const activeImageProvider = imageChoices.includes(imageProvider) ? imageProvider
    : status && imageChoices.includes(status.imageProvider) ? status.imageProvider : imageChoices[0];
  const chooseImageProvider = (p: string) => { setImageProvider(p); writePref(IMAGE_PROVIDER_KEY, p); };
  const changeModel = (set: (model: string) => Promise<unknown>) => (model: string) =>
    set(model).then(refreshStatus, (e) => notify({ kind: "error", text: `モデルを変更できませんでした: ${e instanceof Error ? e.message : String(e)}` }));
  const chooseChatGPTModel = changeModel(api.setChatGPTModel);
  const chooseOpenRouterModel = changeModel(api.setOpenRouterModel);
  const chooseAIProvider = (provider: AIProvider | "") =>
    api.setAIProvider(provider).then(refreshStatus, (e) => notify({ kind: "error", text: `AI を切り替えられませんでした: ${e instanceof Error ? e.message : String(e)}` }));
  const toggleAutoImages = (on: boolean) => { setAutoImages(on); writePref(AUTO_IMAGES_KEY, on ? "1" : "0"); };
  // 左のパネル（新規作成・チャット）は細いバーに畳める
  const [leftOpen, setLeftOpen] = useState(() => readPref(LEFT_OPEN_KEY) !== "0");
  const toggleLeft = (open: boolean) => { setLeftOpen(open); writePref(LEFT_OPEN_KEY, open ? "1" : "0"); };
  const [rightOpen, setRightOpen] = useState(() => readPref(RIGHT_OPEN_KEY) !== "0");
  const toggleRight = (open: boolean) => { setRightOpen(open); writePref(RIGHT_OPEN_KEY, open ? "1" : "0"); };
  // 左右パネルの幅とスライド一覧の高さは縁のつまみをドラッグして変えられる（画面が狭いときは画面に対する割合で頭打ち）
  const [leftW, setLeftW] = usePanelSize(LEFT_WIDTH_KEY);
  const [rightW, setRightW] = usePanelSize(RIGHT_WIDTH_KEY);
  const [deckH, setDeckH] = usePanelSize(DECK_HEIGHT_KEY);
  const [resizing, setResizing] = useState(false);
  const leftRef = useRef<HTMLElement>(null);
  const rightRef = useRef<HTMLElement>(null);
  const deckHeight = Math.max(DECK_CHROME_H + 24, Math.min(deckH ?? DECK_H, Math.round(window.innerHeight * 0.5)));
  // 台本欄（PPTX エディターモード）も畳めて、高さを変えられる
  const [notesOpen, setNotesOpen] = useState(() => readPref(NOTES_OPEN_KEY) !== "0");
  const toggleNotes = (open: boolean) => { setNotesOpen(open); writePref(NOTES_OPEN_KEY, open ? "1" : "0"); };
  const [notesH, setNotesH] = usePanelSize(NOTES_HEIGHT_KEY);
  const notesMax = Math.round(window.innerHeight * 0.4);
  const notesHeight = Math.max(NOTES_CHROME_H + 40, Math.min(notesH ?? NOTES_H, notesMax));

  // ---------- 保存 ----------
  const save = useAutoSave(spec, setSpec, apiUp, resetSpec);
  const { posterId, posterIdRef } = save;
  const saveNow = async () => {
    if (save.savingNow) return;
    if (await save.saveNow()) notify({ kind: "success", text: "保存しました" });
    else notify({ kind: "error", text: "保存できませんでした。API サーバーが起動しているか確認してください（ブラウザには保存済みで、復帰後に自動で保存します）" });
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
  /** Instagram: 参考画像を 1 枚ずつ、投稿の 1 枚ずつとしてそのまま再現する（ChatGPT で作った画像を取り込む使い方が多いので既定で入） */
  const [igReproduce, setIgReproduce] = useState(() => readPref(IG_REPRODUCE_KEY) !== "0");
  const toggleIgReproduce = (on: boolean) => { setIgReproduce(on); writePref(IG_REPRODUCE_KEY, on ? "1" : "0"); };
  const [instruction, setInstruction] = useState("");
  const [chatMode, setChatMode] = useState<"chat" | "image">("chat");
  /** / コマンドの候補: 選択中の位置と、Esc で閉じたか（入力を変えると開き直す） */
  const [slashActive, setSlashActive] = useState(0);
  const [slashClosed, setSlashClosed] = useState(false);
  /** Instagram の比率・枚数（0 はおまかせ） */
  const [igRatioPick, setIgRatioPick] = useState<IgRatio | null>(null);
  const [igCount, setIgCount] = useState(0);
  const [imgPrompt, setImgPrompt] = useState("");
  const [imgTransparent, setImgTransparent] = useState(false);
  const chat = useChat({ ready: !!aiProvider, posterId, posterTitle: spec.meta.title });

  // ---------- キャンバス ----------
  const svgRef = useRef<SVGSVGElement>(null);
  const renderReady = useRenderReady(svgRef);
  const stageRef = useRef<HTMLDivElement>(null);
  const clipboard = useRef<Layer[]>([]);
  /** AI の変更箇所を一瞬ハイライトする */
  const [flash, setFlash] = useState<string[]>([]);
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
  // 画像レイヤーを選んだら、そのプロンプトをチャットの画像生成欄に読み込む
  useEffect(() => {
    if (selHolder) { setImgPrompt(selHolder.asset.prompt ?? ""); setImgTransparent(!!selHolder.asset.transparent); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

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
  const planWithAI = () => mode === "slides" ? undefined : igReproduceOn ? reproduceInstagram() : mode === "instagram" ? planInstagram() : reproduceOn ? reproduceWithAI() : run(`${aiName} がレイアウトを設計中`, async (signal) => {
    const { spec: next } = await api.plan(brief + referenceCaption, undefined, refs.map((r) => ({ ...r.img, name: r.name })), signal);
    const n = findPendingAssets(next).length;
    const images = n ? autoImages ? `・画像 ${n} 点を生成します` : `・画像 ${n} 点が未生成` : "";
    await openAsNewPoster(next, `新しいポスターを作成しました（${next.layers.length} レイヤー${images}）。前のポスターは成果物に保存されています`);
    if (n && autoImages) await generatePending(next, signal);
  }, { cancelable: true });

  // ---------- AI: Instagram の投稿（カルーセル） ----------
  /** ブリーフから画像 1〜20 枚の投稿を作り、新しい Instagram の成果物として開く（画像も続けて生成） */
  const planInstagram = () => run(`${aiName} が投稿を設計中`, async (signal) => {
    const { w, h } = IG_RATIOS[igRatio];
    const { title, posts } = await api.planInstagram(
      { brief, width: w, height: h, count: igCount || undefined, references: refs.slice(0, 4).map((r) => r.img) }, showAIProgress("レイヤー目"), signal,
    );
    if (signal.aborted) throw new Error("aborted");
    const n = posts.reduce((a, p) => a + findPendingAssets(p).length, 0);
    const images = n ? autoImages ? `・画像素材 ${n} 点を生成します` : `・画像素材 ${n} 点が未生成` : "";
    const created = await openNewDeck(title, posts, "instagram", {
      kind: "success", text: `Instagram の投稿を作成しました（${posts.length} 枚${images}）。前の成果物は保存されています`,
    });
    if (n && autoImages) await generateAcross(created.map((c) => c.id), signal);
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
  const refineSpec = async (target: PosterSpec, img: HTMLImageElement, reference: RefImage, signal: AbortSignal, hooks: { onProgress?: (p: AIProgress) => void; onCrop?: () => void } = {}) => {
    const overlay = overlayOf(target);
    const base = withoutOverlay(target);
    const render = await blobToRef(await renderSpecPng(base));
    const res = await api.refineReproduction(reference, render, base, hooks.onProgress, signal);
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
  const refineOnce = async (target: PosterSpec, img: HTMLImageElement, reference: RefImage, signal: AbortSignal, step?: [number, number]) => {
    setBusyLabel("描画結果を参考画像と見比べて修正中", step);
    const res = await refineSpec(target, img, reference, signal, {
      onProgress: showAIProgress("件目の修正"), onCrop: () => setBusyLabel("参考画像から画像を切り抜き中"),
    });
    if (res.spec === target) return res;
    const next = res.spec;
    const d = diffLayers(target, next);
    setSpec(next);
    setFlash([...d.added, ...d.changed]);
    setTimeout(() => setFlash([]), 1800);
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

  // ---------- AI: 画像を 1 枚ずつ再現（Instagram） ----------
  /**
   * 参考画像の 1 枚ずつを、投稿の 1 枚ずつとして写し取り（＋描画結果と見比べて 1 回仕上げ）、新しい Instagram の投稿にする。
   * 画像は投稿の比率に中央で切り抜いてから渡す。写し取れなかった画像は、参考画像だけを持った白紙にして順番は崩さない
   */
  const reproduceInstagram = () => run(`${aiName} が画像を写し取り中`, async (signal) => {
    const { w: width, h: height } = IG_RATIOS[igRatio];
    const items = refs.slice(0, IG_MAX_IMAGES);
    const total = items.length;
    let done = 0;
    const tick = () => setBusy((b) => b && { ...b, progress: [done, total] });
    tick();
    const reproduceOne = async (r: (typeof items)[number], i: number): Promise<{ spec: PosterSpec; ok: boolean }> => {
      const img = await fitToRatio(await loadImage(r.url), width, height);
      const scaled = await scaledReference(img, width, height);
      const overlaySrc = await uploadCrop(scaled.blob);
      const title = `画像 ${i + 1}`;
      try {
        const { spec: raw } = await api.reproduce(scaled.ref, width, height, brief, undefined, signal);
        const cropped = await resolveRefCrops({ ...raw, meta: { ...raw.meta, title } }, img, uploadCrop);
        const first = withOverlay(cropped, overlaySrc);
        // 仕上げに失敗しても、写し取ったものは使う
        const refined = await refineSpec(first, img, scaled.ref, signal).catch((e) => { if (signal.aborted) throw e; return { spec: first }; });
        return { spec: refined.spec, ok: true };
      } catch (e) {
        if (signal.aborted) throw e;
        console.error(`画像 ${i + 1} の再現に失敗`, e);
        return { spec: withOverlay(blankInstagramSpec(igRatio, title), overlaySrc), ok: false };
      } finally {
        done++;
        tick();
      }
    };
    // 同時に写し取る数を絞って、順番どおりに並べる
    const results: { spec: PosterSpec; ok: boolean }[] = new Array(total);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(IG_REPRODUCE_CONCURRENCY, total) }, async () => {
      while (next < total) {
        const i = next++;
        results[i] = await reproduceOne(items[i], i);
      }
    }));
    if (signal.aborted) throw new Error("aborted");
    const posts = results.map((r) => r.spec);
    const failed = results.filter((r) => !r.ok).length;
    const n = posts.reduce((a, p) => a + findPendingAssets(p).length, 0);
    const images = n ? autoImages ? `・画像素材 ${n} 点を生成します` : `・画像素材 ${n} 点が未生成` : "";
    const name = brief.trim().split("\n")[0].slice(0, 40) || "再現した投稿";
    const created = await openNewDeck(name, posts, "instagram", failed
      ? { kind: "error", text: `${total} 枚中 ${failed} 枚は写し取れませんでした（参考画像を重ねた白紙にしています。その画像を開いて「見比べて直す」で作り直せます）${images}` }
      : { kind: "success", text: `${total} 枚の画像を再現しました${images}。左パネルの「参考画像を重ねる」で見比べられます` });
    if (n && autoImages) await generateAcross(created.map((c) => c.id), signal);
  }, { cancelable: true });

  /** 比較用レイヤーの参考画像と見比べて、もう 1 回直す */
  const refineWithAI = () => run("描画結果を参考画像と見比べて修正中", async (signal) => {
    const overlay = overlayOf(spec);
    if (!overlay?.src) throw new Error("このポスターには参考画像（比較用レイヤー）がありません");
    const img = await loadImage(overlay.src);
    const reference = await blobToRef(await (await fetch(overlay.src)).blob());
    const before = spec;
    const { spec: next, reply } = await refineOnce(spec, img, reference, signal);
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
        const remaining = refLimit - refs.length - next.length;
        if (remaining < 1) { skipped.push(`参考資料は画像・PDFのページを合わせて ${refLimit} 枚までです（${file.name} 以降は追加していません）`); break; }
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
  /** 参考画像の並びを入れ替える（Instagram の再現では、この順が投稿の画像の順になる） */
  const moveRef = (i: number, to: number) => setRefs((r) => {
    if (to < 0 || to >= r.length) return r;
    const next = [...r];
    next.splice(to, 0, ...next.splice(i, 1));
    return next;
  });

  const referencePreviews = refs.length > 0 && (
    <div className="refs" aria-label="添付した参考資料">
      {refs.map((r, i) => (
        <div key={i} className="ref" title={r.name}>
          <img src={r.url} alt={r.name} />
          <button className="ref-x" aria-label={`${r.name} を外す`} disabled={readingRefs || !!busy} onClick={() => setRefs((x) => x.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
    </div>
  );

  // ---------- AI: チャット ----------
  /**
   * 資料全体を把握できるよう、PPTX の全スライドを渡す。現在のスライドは api.edit の spec に含まれる。
   * 言及したスライドは spec 全体（書き換えや統合の対象になる）、それ以外は文字だけ（参考）にして、枚数が多くても AI の入力を抑える
   */
  const deckEditContext = async (text: string): Promise<DeckEditContext | undefined> => {
    if (!deck) return undefined;
    const current = deck.slides.findIndex((s) => s.id === posterIdRef.current) + 1;
    if (!current) return undefined;
    await save.flushSave();
    const full = new Set(slideRefs(text, current, deck.slides.length));
    const slides = await Promise.all(deck.slides.flatMap((s, i) => i + 1 === current ? [] : [{ slide: s, number: i + 1 }]).map(async ({ slide, number }) => {
      const spec = (await api.poster(slide.id)).spec;
      return full.has(number) ? { number, title: slide.title, spec } : { number, title: slide.title, texts: slideContent(spec).texts.map((t) => t.slice(0, 120)) };
    }));
    return { current, total: deck.slides.length, slides, ...(instagram ? { instagram } : {}) };
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
   * 入力欄の文を送る（送ったら空にし、失敗したら戻す）。
   * regen: 履歴の発言への返答の作り直し。入力欄には触らず、base（AI が変更する前の spec）から考え直させる
   */
  const sendChat = (text = instruction.trim(), regen?: { msg: ChatMsg; base: PosterSpec }) => {
    if (readingRefsLock.current || busy) return;
    const cur = regen?.base ?? spec;
    const ids = selLayers.length ? selLayers.map((l) => l.id) : undefined;
    const context = chat.context(regen?.msg.id);
    const slash = parseSlash(text, isSlides, mode === "poster");
    if (slash && "error" in slash) { notify({ kind: "error", text: slash.error }); return; }
    const restore = regen ? () => {} : () => setInstruction(text);
    if (!regen) setInstruction("");
    if (slash) return runSlash(slash.cmd, slash.arg, restore, regen?.msg);
    // 「右下のスライド番号の並びを直して」: AI には 1 枚ずつしか見えないので、全スライドの番号を手元で振り直す
    if (isSlides && isRenumberRequest(text)) {
      return chatTurn(regen?.msg ?? { text, mode: "chat" }, "ページ番号を確認中", restore, () => renumberDeckPages());
    }
    // 「台本が無いスライドに台本を書いて」: AI には 1 枚ずつしか見えないので、デッキ全体の文字を渡して空の台本をまとめて書く
    if (isSlides && isMissingNotesRequest(text)) return writeNotesTurn(regen?.msg ?? { text, mode: "chat" }, restore, { request: text });
    // 「このスライドの台本を書いて」: ふつうの修正だとほかのスライドの台本が見えないので、同じ書き方（口調・長さをお手本に合わせる）で書く
    if (isSlides && deck && isWriteNotesRequest(text)) {
      const current = deck.slides.findIndex((s) => s.id === posterIdRef.current) + 1;
      // 「全スライドの台本を書き直して」は全スライドを書き直す
      const targets = isWholeDeckRequest(text) ? deck.slides.map((_, i) => i + 1) : slideRefs(text, current, deck.slides.length);
      if (targets.length || current) return writeNotesTurn(regen?.msg ?? { text, mode: "chat" }, restore, { targets: targets.length ? targets : [current], request: text });
    }
    // 「最後にクロージングのスライドを追加して」: ふつうの修正は今のスライドを書き換えるだけなので、新しいスライドを作ってデッキに入れる
    const current = deck ? deck.slides.findIndex((s) => s.id === posterIdRef.current) + 1 : 0;
    const position = deck && current ? addSlidePosition(text, current, deck.slides.length) : null;
    if (position) {
      return chatTurn(regen?.msg ?? { text, mode: "chat" }, `${aiName} が${instagram ? "画像" : "スライド"}を作成中`, restore, async (signal) => {
        const r = await addSlideByAI(signal, text, position, context);
        if (autoImages && r.spec && findPendingAssets(r.spec).length) {
          chat.push({ role: "assistant", text: r.text, changes: r.changes });
          await generatePending(r.spec, signal);
          return { text: "画像も生成しました" };
        }
        return { text: r.text, changes: r.changes };
      });
    }
    // 「授業スライド全体の差し色を変えて」: ふつうの修正は今のスライドしか書き換えないので、同じ指示を全スライドに当てる
    if (deck && deck.slides.length > 1 && isWholeDeckRequest(text)) {
      return chatTurn(regen?.msg ?? { text, mode: "chat" }, `${aiName} が全${instagram ? "画像" : "スライド"}を修正中`, restore, async (signal) => {
        const r = await editAcrossDeck(signal, text, context);
        if (autoImages && r.ids.some((id) => { const sp = specOf(id); return sp && findPendingAssets(sp).length; })) {
          chat.push({ role: "assistant", text: r.text, changes: r.changes });
          await generateAcross(r.ids, signal);
          return { text: "画像も生成しました" };
        }
        return { text: r.text, changes: r.changes };
      });
    }
    const requestText = regen ? text : text + referenceCaption;
    const references = regen ? regen.msg.references ?? [] : refs.map((r) => ({ ...r.img, name: r.name }));
    return chatTurn(regen?.msg ?? { text: requestText, scope: chatScope ?? (slideNo ? chatFallback : undefined), mode: "chat", ...(references.length ? { references, hasReferences: true } : {}) }, `${aiName} が考え中`, restore, async (signal) => {
      const ctx = await deckEditContext(text);
      const res = await api.edit(cur, requestText, ids, signal, ctx, context, instagram || undefined, undefined, references);
      const next = res.spec;
      if (!next) return { text: res.reply || "変更はありませんでした" };
      // 別のスライドを書き換える指示なら、そのスライドを開いてから適用する（履歴に積まれるので Ctrl+Z / 元に戻す が効く）
      const target = ctx && res.target && res.target !== ctx.current ? deck?.slides[res.target - 1] : undefined;
      let before = cur;
      if (target) {
        if (signal.aborted) throw new Error("aborted");
        before = await openSlide(target.id);
      }
      const d = diffLayers(before, next);
      if (!d.hasChanges) {
        return { text: res.reply ? `${res.reply}\n（ポスターに変更はありませんでした。もう少し具体的に指示してみてください）` : "変更はありませんでした。指示をもう少し具体的にしてみてください" };
      }
      setSpec(next);
      setFlash([...d.added, ...d.changed]);
      setTimeout(() => setFlash([]), 1800);
      const parts = [d.changed.length && `${d.changed.length} 件変更`, d.added.length && `${d.added.length} 件追加`, d.removed && `${d.removed} 件削除`, d.themeChanged && "テーマ変更", d.metaChanged && "ポスター設定変更", d.reordered && "重ね順変更", d.notesChanged && "台本変更", d.transitionChanged && "画面切り替え変更"].filter(Boolean);
      if (d.notesChanged && isSlides) toggleNotes(true);
      const reply = { text: res.reply || "修正しました", changes: `${target ? `スライド ${res.target}: ` : ""}${parts.join("・") || "変更"}`, before, posterId: posterIdRef.current };
      // 「スライド18,19を1枚にまとめて」: まとめ元のスライドを、確認してから削除する
      const merged = (res.remove ?? []).map((n) => ({ n, slide: deck?.slides[n - 1] })).filter((r) => r.slide && r.slide.id !== posterIdRef.current);
      if (merged.length) {
        const nums = merged.map((r) => r.n).join("・");
        const ok = await ask({
          title: `スライド ${nums} を削除しますか？`,
          message: `内容をスライド ${res.target ?? ctx?.current} にまとめました。まとめ元の${merged.map((r) => `「${r.slide!.title}」`).join("")}を削除します。この操作は取り消せません（残しておく場合は「キャンセル」）。`,
          ok: "削除", danger: true,
        });
        if (ok) {
          await deleteSlides(merged.map((r) => r.slide!.id));
          reply.changes += `・スライド ${nums} を削除`;
        }
      }
      if (autoImages && findPendingAssets(next).length) {
        chat.push({ role: "assistant", ...reply });
        await generatePending(next, signal);
        return { text: "画像も生成しました" };
      }
      return reply;
    });
  };
  /** / コマンドの実行（restore は失敗したときに入力欄へ元の文を戻す。regen は作り直す発言） */
  const runSlash = (cmd: SlashCommand, arg: string, restore: () => void, regen?: ChatMsg) => {
    switch (cmd.name) {
      case "image":
        return generateImageHere(arg, restore, regen);
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
      const res = await api.edit(next, a4Instruction(next, issues, extra), undefined, signal, undefined, chat.context());
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
    setFlash([...d.added, ...d.changed]);
    setTimeout(() => setFlash([]), 1800);
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
    setBusy((b) => b && { ...b, label: opts.label ?? "画像を生成中", progress: [0, total], step: undefined, detail: undefined, stepStartedAt: undefined });
    // 同時 2 並列で 1 点ずつ依頼する。1 点の失敗で全体を止めない
    const worker = async () => {
      for (let j = queue.shift(); j && !signal.aborted; j = queue.shift()) {
        try { await generateOne(j.ref, j.asset, signal, target); } catch (e) { if (signal.aborted) throw e; failed++; }
        setBusyProgress(++done, total);
      }
    };
    await Promise.all([worker(), worker()]);
    if (signal.aborted) throw new Error("aborted");
    if (opts.quiet) return { total, failed };
    if (failed) notify({ kind: "error", text: `${failed} 点の画像生成に失敗しました。レイヤーを選んで「再生成」できます` });
    else notify({ kind: "success", text: `画像を ${total} 点生成しました` });
    return { total, failed };
  };
  /**
   * Instagram の投稿: ids の各画像を順に開いて、未生成の画像素材を生成する（画像は開いているものにしか当てられないため）。
   * 終わったら、始めに開いていた画像に戻る
   */
  const generateAcross = async (ids: string[], signal: AbortSignal) => {
    const start = posterIdRef.current;
    const targets = ids.filter((id) => { const sp = specOf(id); return sp && findPendingAssets(sp).length; });
    let total = 0, failed = 0;
    for (const [i, id] of targets.entries()) {
      const opened = await openSlide(id);
      // ids はデッキの並び順（作った直後は deck の state がまだ古いので、ids から数える）
      const label = targets.length > 1 ? `画像を生成中（${ids.indexOf(id) + 1} 枚目・${i + 1} / ${targets.length}）` : "画像を生成中";
      const r = await generatePending(opened, signal, { quiet: true, label });
      total += r.total;
      failed += r.failed;
    }
    if (start && start !== posterIdRef.current && ids.includes(start)) await openSlide(start);
    if (failed) notify({ kind: "error", text: `${failed} 点の画像生成に失敗しました。その画像を開き、レイヤーを選んで「再生成」できます` });
    else if (total) notify({ kind: "success", text: `${targets.length} 枚の画像に、画像素材を ${total} 点生成しました` });
  };
  /** 未生成の画像をまとめて生成（Instagram の投稿なら全画像の分） */
  const generateAll = () => run("画像を生成中", (signal) => (
    instagram && deck ? generateAcross(deck.slides.map((s) => s.id), signal) : generatePending(spec, signal).then(() => {})
  ), { cancelable: true });

  const regenerateLayer = (layerId: string) => run("画像を生成中", async (signal) => {
    const holder = assetHolder(spec.layers.find((l) => l.id === layerId) ?? null);
    if (!holder) throw new Error("このレイヤーには asset（生成プロンプト）がありません");
    await generateOne({ layerId, rest: holder.rest }, holder.asset, signal);
  }, { cancelable: true });

  /** チャットの画像生成の対象: 選択中の画像を作り直す／選択中の要素の位置に追加。null なら中央に新しい画像 */
  const imageScope = selectedLayer && selHolder ? `「${layerName(selectedLayer)}」を作り直す`
    : selectedLayer && selectedLayer.type !== "background" ? `「${layerName(selectedLayer)}」の位置に追加` : null;
  const generateImageHere = (prompt: string, restoreInput: () => void, regen?: ChatMsg) =>
    chatTurn(regen ?? { text: prompt, scope: imageScope ?? "新しい画像", mode: "image" }, "画像を生成中", restoreInput, async (signal) => {
      const before = spec;
      if (selectedLayer && selHolder) {
        const asset = { ...selHolder.asset, prompt, transparent: imgTransparent };
        const patch = selHolder.rest.length ? { props: { ...(selectedLayer as any).props, asset } } : { asset };
        updateLayer(selectedLayer.id, patch as Partial<Layer>);
        const src = await generateOne({ layerId: selectedLayer.id, rest: selHolder.rest }, asset, signal);
        return { text: "画像を作り直しました", image: src, before, posterId: posterIdRef.current };
      }
      const at = selectedLayer && selectedLayer.type !== "background"
        ? { x: selectedLayer.x, y: selectedLayer.y, w: selectedLayer.w, h: selectedLayer.h, rotation: selectedLayer.rotation }
        : { x: Math.round((W - 400) / 2), y: Math.round((H - 400) / 2), w: 400, h: 400 };
      const asset = { prompt, transparent: imgTransparent, aspect: aspectOf(at.w, at.h) };
      const layer = { id: uid("image"), name: prompt.slice(0, 20) || "画像", type: "image", fit: "contain", asset, ...at } as Layer;
      // 選択中の要素の 1 つ上に重ねる
      setSpec((s) => ({ ...s, layers: insertAfter(s.layers, selectedLayer?.id, [layer]) }));
      setSelected(layer.id);
      const src = await generateOne({ layerId: layer.id, rest: [] }, asset, signal, { ...spec, layers: [...spec.layers, layer] });
      return { text: "画像を生成して配置しました", image: src, before, posterId: posterIdRef.current };
    });
  /** 画像生成の入力欄から生成する */
  const generateImageFromInput = () => {
    const prompt = imgPrompt.trim();
    setImgPrompt("");
    return generateImageHere(prompt, () => setImgPrompt(prompt));
  };
  /**
   * 最後の自分の発言の下の「再送信」: 発言は増やさず、その返答を作り直す（入力欄の書きかけはそのまま）。
   * チャットは、前の返答で AI が変えたポスターを変更前に戻してから考え直させる（同じ指示が重ねがけされないように）。
   * 画像生成は今の選択に対してもう一度生成する（前の返答で置いた画像が選ばれていれば、それを作り直す）
   */
  const resendChat = async (m: ChatMsg) => {
    if (busy || readingRefs || (m.hasReferences && !m.references)) return;
    if (m.mode === "image") return generateImageHere(m.text, () => {}, m);
    const i = chat.messages.findIndex((x) => x.id === m.id);
    const prev = chat.messages.slice(i + 1).find((x) => x.role === "assistant" && x.before && !x.undone);
    let base = spec;
    if (prev?.before) {
      if (prev.posterId && prev.posterId !== posterIdRef.current) {
        try { await openSlide(prev.posterId); } catch (e) { notifyAIError(e); return; }
      }
      base = prev.before;
      setSpec(base);
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
        let at: { x: number; y: number; w: number; h: number; rotation?: number };
        if (b && b.type !== "background") at = { x: b.x + i * 20, y: b.y + i * 20, w: b.w, h: b.h, rotation: b.rotation };
        else {
          // 元の縦横比のまま、ポスターの半分に収まる大きさで置く
          const n = await naturalSize(src);
          const k = Math.min(1, (W * 0.5) / n.w, (H * 0.5) / n.h);
          const w = Math.round(n.w * k), h = Math.round(n.h * k);
          const c = opts.at ?? { x: W / 2, y: H / 2 };
          at = { x: Math.round(c.x - w / 2) + i * 20, y: Math.round(c.y - h / 2) + i * 20, w, h };
        }
        added.push({ id: uid("image"), name, type: "image", fit: "contain", src, ...at } as Layer);
      }
      setSpec((s) => ({ ...s, layers: insertAfter(s.layers, opts.box?.id, added) }));
      setSelected(added[added.length - 1].id);
      notify({ kind: "success", text: `画像を ${added.length} 点追加しました` });
    });
  };
  /** チャットの 📎（画像ファイル）: 選択中の画像は差し替え、ほかの要素を選んでいればその位置に、未選択なら中央に置く */
  const insertImageFilesHere = (files: FileList | null) =>
    selectedLayer && imageSlot(selectedLayer) ? insertImageFiles(files, { replaceId: selectedLayer.id })
      : insertImageFiles(files, { box: selectedLayer ?? undefined });

  /** キャンバスへのドロップ: PowerPoint なら（PPTX モードだけ）読み込み、画像の上なら差し替え、それ以外はドロップした位置に置く */
  const onStageDrop = (files: File[], e: RDragEvent) => {
    const pptx = mode === "slides" ? files.find((f) => /\.pptx$/i.test(f.name)) : undefined;
    if (pptx) { importPptxFile(pptx); return; }
    const id = topLayerAt(e.target, topIds);
    const l = id ? spec.layers.find((x) => x.id === id) ?? null : null;
    if (l && imageSlot(l) && !l.locked) { setSelected(l.id); insertImageFiles(files, { replaceId: l.id }); return; }
    insertImageFiles(files, { at: svgRef.current ? toPoster(e) : undefined });
  };
  const stageDrop = useFileDrop(onStageDrop, { disabled: !!busy });
  /** AI パネル（新規作成・チャット）へのドロップは参考資料として添付 */
  const refDrop = useFileDrop((files) => void onRefFiles(files), { disabled: readingRefs || !!busy });
  // ドロップ先の外（インスペクタなど）にファイルを落としても、ブラウザがそのファイルを開いてしまわないようにする
  useEffect(blockPageFileDrop, []);

  // クリップボードの画像を貼り付け（スクリーンショットなど）
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTextInput(e.target)) return;
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => IMAGE_FILE_TYPES.test(f.type));
      if (!files.length) return;
      e.preventDefault();
      insertImageFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  // ---------- 書き出し ----------
  const exported = (name: string) => notify({ kind: "success", text: `${name} を書き出しました` });
  // ---------- A4（ポスター） ----------
  const [a4Guide, setA4Guide] = useState(false);
  /** A4 300dpi ちょうど（2480×3508px）に描き、解像度（pHYs）を書き込んだ PNG */
  const buildA4Png = async () => {
    const blob = await svgToPngSized(await buildExportSvg(svgRef.current!, spec), W, H, exportPixels(W, H));
    return new Blob([setPngDpi(new Uint8Array(await blob.arrayBuffer()), PRINT_DPI) as Uint8Array<ArrayBuffer>], { type: "image/png" });
  };
  // 書き出した PNG を読み直し、画素数と解像度から実寸が A4 になっているかを知らせる
  const exportPng = () => run("PNG を書き出し中", async () => {
    const name = `${safeFileName(spec.meta.title)}.png`;
    const blob = await buildA4Png();
    download(blob, name);
    const info = readPngInfo(new Uint8Array(await blob.arrayBuffer()));
    const r = info && pngA4Report(info);
    if (!info || !r) return exported(name);
    const size = `${info.w}×${info.h}px・${r.dpi ?? "?"}dpi → ${r.wMm.toFixed(1)}×${r.hMm.toFixed(1)}mm`;
    notify(r.ok
      ? { kind: "success", text: `${name} を A4 で書き出しました（${size}）` }
      : { kind: "error", text: `${name} を書き出しましたが、A4 の大きさではありません（${size}）。A4 チェックからそろえられます` });
  });
  /** A4 の大きさで印刷プレビューを開く（ブラウザの印刷画面で用紙 A4・余白なしで確かめられる） */
  const printA4 = () => {
    // ポップアップを止められないよう、クリックのうちに窓だけ開いておく
    const w = window.open("", "_blank");
    if (!w) return notify({ kind: "error", text: "印刷プレビューの窓を開けませんでした（ポップアップを許可してください）" });
    const fit = a4Fit(W, H);
    w.document.title = `${spec.meta.title || "無題のポスター"} - A4 印刷プレビュー`;
    w.document.body.textContent = "印刷用の画像を作っています…";
    run("印刷プレビューを準備中", async () => {
      const url = URL.createObjectURL(await buildA4Png());
      const { page } = fit;
      w.document.head.innerHTML = `<style>
        @page { size: A4 ${fit.orientation}; margin: 0; }
        html, body { margin: 0; background: #888; }
        img { display: block; width: ${page.w}mm; height: ${page.h}mm; margin: 0 auto; background: #fff; }
        @media screen { img { margin: 16px auto; box-shadow: 0 2px 12px rgba(0,0,0,.4); } }
        @media print { html, body { background: none; } }
      </style>`;
      w.document.body.innerHTML = "";
      const img = w.document.createElement("img");
      img.alt = spec.meta.title;
      img.onload = () => { w.focus(); w.print(); };
      img.src = url;
      w.document.body.append(img);
      w.addEventListener("beforeunload", () => URL.revokeObjectURL(url));
    });
  };
  const fixA4 = () => {
    const before = spec;
    setSpec((s) => ({ ...s, meta: { ...s.meta, ...a4Size(s.meta.width, s.meta.height) } }));
    notifyRestorable("用紙を A4 の大きさにそろえました", before, "info");
  };
  const resetToSample = () => {
    const before = spec;
    setSpec(PosterSpecSchema.parse(sample));
    setSelected(null);
    notifyRestorable("サンプルに戻しました", before, "info");
  };

  // ---------- PPTX エディターモード ----------
  const {
    deck, slides, specOf, deckOpen, toggleDeck, openSlide, addSlide, duplicateSlide, removeSlide, deleteSlides, moveSlide, reorderSlide, exportDeck,
    fontDialog, setFontDialog, openFontDialog, applyDeckFonts, applyTransitionToAll, renumberDeckPages, writeNotes, addSlideByAI, editAcrossDeck, importPptxFile,
    instagram, exportImages, changeRatio, openNewDeck, deckReady,
  } = useDeck({ spec, theme, save, apiUp, busy, run, notify, exported, setBusyProgress, setSpec, resetSpec, stashHistory, setSelected, fitView });
  /** PPTX のスライド（Instagram の投稿でない普通のデッキ）を開いているか。投影・台本・アニメーションはこのときだけ */
  const isSlides = !!deck && !instagram;
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
  /** 新規作成タブ（ポスター・Instagram の生成）。PPTX モードでは出さずチャットだけにする */
  const canMake = mode !== "slides";
  const tab = canMake ? aiTab : "chat";
  // Instagram の比率（未選択なら開いている投稿の比率）
  /** Instagram で、参考画像を 1 枚ずつそのまま再現する（参考画像があれば「投稿を生成」の代わりにこれを行う） */
  const igReproduceMode = mode === "instagram" && igReproduce;
  const igReproduceOn = igReproduceMode && refs.length > 0;
  const refLimit = igReproduceMode ? IG_MAX_IMAGES : MAX_REFERENCES;
  // 再現するときは、選んでいなければ 1 枚目の画像に一番近い比率にする
  const igRatio: IgRatio = igRatioPick ?? (igReproduceOn ? nearestRatio(refs[0].w, refs[0].h) : undefined) ?? (instagram ? ratioOf(W, H) : undefined) ?? IG_DEFAULT_RATIO;
  /** Instagram の投稿で、未生成の画像素材がある画像の数と素材の数（開いている画像は編集中の内容） */
  const deckPending = useMemo(() => {
    if (!instagram || !deck) return null;
    let images = 0, assets = 0;
    for (const s of deck.slides) {
      const n = findPendingAssets(s.id === posterId ? spec : slides.get(s.id) ?? spec).length;
      if (n) { images++; assets += n; }
    }
    return { images, assets };
  }, [instagram, deck, slides, spec, posterId]);
  const pendingCount = deckPending ? deckPending.assets : pending.length;

  const confirmExport = async () => {
    const ok = await ask(instagram && deck
      ? { title: "PNG で書き出しますか？", message: deck.slides.length > 1 ? `「${deck.name}」の ${deck.slides.length} 枚を、幅 1080px の PNG（番号付き）にして ZIP にまとめて保存します。投稿するときはこの順に選んでください。` : `「${deck.name}」を幅 1080px の PNG として保存します。`, ok: "書き出す" }
      : deck
      ? { title: "PowerPoint で書き出しますか？", message: `「${deck.name}」を .pptx ファイルとして保存します。`, ok: "書き出す" }
      : { title: "PNG で書き出しますか？", message: `「${spec.meta.title || "無題のポスター"}」を A4 300dpi（2480×3508px）の PNG として保存します。書き出したあと、実寸が A4 になったかをお知らせします。`, ok: "書き出す" });
    if (ok) (instagram ? exportImages : deck ? exportDeck : exportPng)();
  };

  // ---------- レイヤー操作 ----------
  const reorder = (id: string, to: (layers: Layer[], i: number) => number) => setSpec((s) => {
    const layers = reorderLayer(s.layers, id, to);
    return layers === s.layers ? s : { ...s, layers };
  });
  const moveTo = (id: string, targetId: string, above: boolean) => setSpec((s) => {
    const layers = moveLayerTo(s.layers, id, targetId, above);
    return layers === s.layers ? s : { ...s, layers };
  });
  const removeLayers = (ids: string[]) => {
    if (!ids.length) return;
    const before = spec;
    const name = ids.length > 1 ? `${ids.length} 件のレイヤー` : `「${spec.layers.find((l) => l.id === ids[0])?.name ?? ids[0]}」`;
    setSpec((s) => ({ ...s, layers: s.layers.filter((l) => !ids.includes(l.id)) }));
    setSelected(null);
    notifyRestorable(`${name}を削除しました`, before, "info");
  };
  /** srcs のコピーを afterId の 1 つ上（未指定なら最前面）にまとめて重ね、コピーを選択する */
  const insertCopies = (srcs: Layer[], afterId?: string) => {
    if (!srcs.length) return;
    const copies = srcs.map((src) => ({ ...structuredClone(src), id: uid(src.type), name: `${layerName(src)} のコピー`, x: src.x + 20, y: src.y + 20, locked: false }) as Layer);
    setSpec((s) => ({ ...s, layers: insertAfter(s.layers, afterId, copies) }));
    setSelectedIds(copies.map((c) => c.id));
  };
  const duplicateLayers = (ls: Layer[]) => insertCopies(ls.filter((l) => l.type !== "background"), ls[ls.length - 1]?.id);
  const copyLayers = (ls: Layer[]) => { clipboard.current = structuredClone(ls); };
  /** group の各レイヤーを、開始位置から (dx, dy) だけずらす */
  const moveLayers = (group: Layer[], dx: number, dy: number, coalesce?: string) => {
    const starts = new Map(group.map((l) => [l.id, l]));
    setSpec((s) => ({
      ...s,
      layers: s.layers.map((l) => { const o = starts.get(l.id); return o ? ({ ...l, x: Math.round(o.x + dx), y: Math.round(o.y + dy) } as Layer) : l; }),
    }), coalesce);
  };
  /** 範囲選択・一括移動の対象にできるレイヤー（背景・ロック・非表示は除く） */
  const selectable = (l: Layer) => isVisibleOnCanvas(l, spec.theme) && !l.locked;
  const movable = (ls: Layer[]) => ls.filter((l) => !l.locked && l.type !== "background");
  /** Shift / Ctrl+クリックで選択に足す・外す */
  const toggleSelect = (id: string) => setSelectedIds((ids) => {
    const keep = ids.filter((i) => spec.layers.some((l) => l.id === i && l.type !== "background"));
    return keep.includes(id) ? keep.filter((i) => i !== id) : [...keep, id];
  });
  // ---------- アニメーション（PPTX エディターモード） ----------
  const animOrder = useMemo(() => new Map(animationSequence(spec).map((s, i) => [s.layer.id, i + 1])), [spec]);
  /** ids の各レイヤーの動きを update で決め直す（i は ids での位置） */
  const setAnimations = (ids: string[], update: (prev: LayerAnimation | undefined, i: number) => LayerAnimation | undefined, coalesce?: string) => setSpec((s) => renumberAnimations({
    ...s,
    layers: s.layers.map((l) => {
      const i = ids.indexOf(l.id);
      if (i < 0) return l;
      const anim = update(l.animation, i);
      // 新しく付けたものは最後に動かす（同じ順なら重ね順で並ぶ）
      return { ...l, animation: anim && { ...anim, order: anim.order ?? Number.MAX_SAFE_INTEGER } };
    }),
  }), coalesce);
  const moveAnimations = (ids: string[], dir: -1 | 1) => setSpec((s) => renumberAnimations(s, { ids, dir }));
  const previewRef = useRef<{ cancel: () => void } | null>(null);
  const previewAnimations = (only?: string[]) => {
    previewRef.current?.cancel();
    if (!svgRef.current) return;
    const p = playAnimations(svgRef.current, spec, only);
    previewRef.current = p;
    p.done.then(() => { if (previewRef.current === p) previewRef.current = null; });
  };
  /** 画面切り替えをキャンバスで再生する（前のスライドは無いので、入ってくる動きだけ） */
  const previewTransition = () => {
    previewRef.current?.cancel();
    const t = spec.transition, svg = svgRef.current;
    if (!t || !svg) return;
    const a = svg.animate(transitionKeyframes(t).incoming, { duration: Math.max(1, t.duration), easing: TRANSITION_EASING });
    const sound = t.sound ? playSound(t.sound) : null;
    const p = { cancel: () => { a.cancel(); sound?.stop(); } };
    previewRef.current = p;
    a.finished.then(() => { if (previewRef.current === p) previewRef.current = null; }, () => undefined);
  };
  const setTransition = (t: SlideTransition | undefined, coalesce?: string) => setSpec((s) => {
    const { transition: _, ...rest } = s;
    return t ? { ...rest, transition: t } : rest;
  }, coalesce);
  const setBgm = (b: SlideBgm[]) => setSpec((s) => {
    const { bgm: _, ...rest } = s;
    return b.length ? { ...rest, bgm: b } : rest;
  });
  // スライドを切り替えたら再生を止める
  useEffect(() => () => previewRef.current?.cancel(), [posterId]);

  // ---------- スライドショー（PPTX エディターモード） ----------
  /** 投影中のスライド（開始時点の中身）と、始めるスライドの番号 */
  const [show, setShow] = useState<{ slides: PosterSpec[]; start: number; view: Window | null } | null>(null);
  /**
   * fromCurrent なら開いているスライドから、そうでなければ 1 枚目から投影する。
   * withView なら発表者ビューを別ウィンドウで開く（ポップアップを止められないよう、クリック・キーの処理の中で同期的に開く）
   */
  const startShow = (fromCurrent: boolean, withView = false) => {
    if (!deck || instagram) return;
    previewRef.current?.cancel();
    setTextEdit(null);
    setCropping(null);
    const specs = deck.slides.map((s) => specOf(s.id)).filter((s): s is PosterSpec => !!s);
    if (!specs.length) return;
    const cur = deck.slides.findIndex((s) => s.id === posterIdRef.current);
    const view = withView ? openPresenterWindow() : null;
    if (withView && !view) notify({ kind: "error", text: "発表者ビューのウィンドウを開けませんでした。ブラウザのポップアップのブロックを解除してください" });
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

  const addLayer = (layer: Layer) => { setSpec((s) => ({ ...s, layers: [...s.layers, layer] })); setSelected(layer.id); };
  /** ポスター中央に置く位置 */
  const centered = (w: number, h: number) => ({ x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h });
  const addComponent = (name: string) => {
    const c = CATALOG_BY_NAME[name];
    addLayer({ id: uid(name), name: c.label, type: "component", component: name, props: structuredClone(c.defaults), ...centered(...c.defaultSize) });
  };
  const addText = () => addLayer({ id: uid("text"), name: "テキスト", type: "text", text: "テキスト", font: "display", size: 64, weight: 900, lineHeight: 1.25, align: "left", fill: "$ink", ...centered(600, 90) });
  /** 空の画像枠を置き、チャットの画像生成欄でプロンプトを入れてもらう */
  const addImage = () => {
    addLayer({ id: uid("image"), name: "画像", type: "image", fit: "contain", asset: { prompt: "", transparent: false, aspect: "square" }, ...centered(300, 300) });
    setImgPrompt("");
    setChatMode("image");
    setAiTab("chat");
  };
  const alignLayer = (id: string, where: AlignTo) => {
    const l = spec.layers.find((x) => x.id === id);
    if (l) updateLayer(id, alignedPosition(l, where, W, H) as Partial<Layer>);
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
      // PowerPoint と同じく F5 で最初から、Shift+F5 で今のスライドから投影する。Alt+F5 は今のスライドから発表者ビュー付きで
      if (e.key === "F5" && isSlides && !mod) { e.preventDefault(); startShow(e.shiftKey || e.altKey, e.altKey); return; }
      const key = e.key.toLowerCase();
      // 保存は入力欄にフォーカスがあっても効かせる（ブラウザの「ページを保存」を出さない）
      if (mod && !e.shiftKey && key === "s") { e.preventDefault(); saveNow(); return; }
      if (isTextInput(e.target)) return;
      const shortcut = (fn: () => void) => { e.preventDefault(); fn(); };
      if (mod && key === "z") return shortcut(e.shiftKey ? redo : undo);
      if (mod && key === "y") return shortcut(redo);
      if (mod && (key === "=" || key === "+")) return shortcut(() => zoomBy(1));
      if (mod && key === "-") return shortcut(() => zoomBy(-1));
      if (mod && key === "0") return shortcut(fitView);
      if (mod && key === "1") return shortcut(() => setZoom(1));
      if (mod && key === "v" && clipboard.current.length) return shortcut(() => insertCopies(clipboard.current, selLayers[selLayers.length - 1]?.id));
      if (mod && key === "a") return shortcut(() => setSelectedIds(spec.layers.filter(selectable).map((l) => l.id)));
      if (cropping && (e.key === "Escape" || e.key === "Enter")) return shortcut(() => setCropping(null));
      if (e.key === "Escape") { setSelected(null); return; }
      // スライド一覧の前後へ: PageUp / PageDown はいつでも、矢印キーはレイヤーを選んでいないとき（選択中はレイヤーの移動に使う）
      const slideDir = { PageUp: -1, PageDown: 1, ...(selLayers.length ? {} : { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }) }[e.key];
      if (slideDir && deck && !mod && !e.altKey) return shortcut(() => stepSlide(slideDir as -1 | 1));
      if (!selLayers.length) return;

      // 選択中のレイヤー（1 件でも複数でも）
      const ids = selLayers.map((l) => l.id);
      if (mod && key === "c") { copyLayers(selLayers); notify({ kind: "info", text: multi ? `${selLayers.length} 件コピーしました` : "コピーしました" }); return; }
      if (mod && key === "x") { copyLayers(selLayers); removeLayers(ids); return; }
      if (mod && key === "d") return shortcut(() => duplicateLayers(selLayers));
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
  const canPlan = canMake && !busy && !readingRefs && (!!brief.trim() || reproduceOn || igReproduceOn) && aiReady;
  // / コマンドは AI を使わないので、サインインしていなくても送れる
  const canChat = !busy && !readingRefs && !!instruction.trim() && (aiReady || /^[/／]/.test(instruction.trim()));
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
  const canGenImage = !busy && !!imgPrompt.trim();
  // 未サインインで AI ボタンが押せない理由をボタンのそばに出す
  // OpenRouter のキーがあるのに使えない = AI の設定で ChatGPT を選んでいる
  const orHint = openrouter ? "（AI の設定で OpenRouter に切り替えられます）" : "（または .env に OPENROUTER_API_KEY を設定）";
  const signinNote = !aiReady && (
    <p className="notice-inline">
      {status?.ai?.explicit === "openrouter"
        ? "OpenRouter の API キー（.env の OPENROUTER_API_KEY）が無いため、この機能は使えません（AI の設定で切り替えられます）。"
        : gpt?.signedIn ? `このアカウントでは ChatGPT プランを利用できないため、この機能は使えません${orHint}。` : `この機能は ChatGPT へのサインインが必要です${orHint}。`}
      {status?.ai?.explicit !== "openrouter" && !gpt?.signedIn && <button className="small" onClick={api.chatgptLogin}>サインイン</button>}
    </p>
  );
  /** 送信の対象を示すチップ（× で選択解除） */
  /** レイヤーを選んでいないときの対象。デッキでは開いているスライド（ふつうの修正はそのスライドだけを書き換える） */
  const slideNo = deck ? deck.slides.findIndex((s) => s.id === posterId) + 1 : 0;
  const chatFallback = slideNo ? `${instagram ? "画像" : "スライド"} ${slideNo}` : "ポスター全体";
  const targetChip = (label: string | null, fallback: string) => label
    ? <span className="chip">{label}<button aria-label="対象を解除" onClick={() => setSelected(null)}>×</button></span>
    : <span className="chip muted">{fallback}</span>;
  const canReplaceImage = !!(selectedLayer && imageSlot(selectedLayer));
  const hasImage = !!(selHolder && selectedLayer && ((selectedLayer as any).src || (selectedLayer as any).props?.src));
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
                  <button role="menuitem" onClick={() => leaveTo(HOME_URL)}><Ico name="layers" /> モードを選ぶ<small>ポスター・PPTX・Instagram</small></button>
                  {mode === "slides" && <>
                    <div className="menu-sep" />
                    <label className="as-button" role="menuitem"><Ico name="slides" /> PowerPoint を開く…<small>スライドごとに編集</small><input type="file" accept={PPTX_ACCEPT} hidden onChange={(e) => { e.target.files?.[0] && importPptxFile(e.target.files[0]); e.target.value = ""; close(); }} /></label>
                  </>}
                  <div className="menu-sep" />
                  <button role="menuitem" onClick={saveNow} disabled={save.savingNow}><Ico name="save" /> 今すぐ保存<small><kbd>{MOD}+S</kbd></small></button>
                  {mode === "poster" && <button role="menuitem" onClick={resetToSample}><Ico name="undo" /> サンプルに戻す</button>}
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
            placeholder={mode === "instagram" ? "無題の投稿" : mode === "slides" ? "無題のプレゼンテーション" : "無題のポスター"}
            value={spec.meta.title}
            onChange={(e) => setSpec((s) => ({ ...s, meta: { ...s.meta, title: e.target.value } }), "title")}
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
            {mode === "instagram" && (
              <div className="row ig-options">
                <label className="field">
                  <span>比率</span>
                  <select value={igRatio} onChange={(e) => setIgRatioPick(e.target.value as IgRatio)} title={IG_RATIOS[igRatio].note}>
                    {IG_RATIO_KEYS.map((k) => <option key={k} value={k}>{IG_RATIOS[k].label}</option>)}
                  </select>
                </label>
                {igReproduceOn ? (
                  <div className="field">
                    <span>枚数</span>
                    <span className="field-value">{Math.min(refs.length, IG_MAX_IMAGES)} 枚（画像の数）</span>
                  </div>
                ) : (
                  <label className="field">
                    <span>枚数</span>
                    <select value={igCount} onChange={(e) => setIgCount(Number(e.target.value))} title="カルーセル（スワイプで見る複数枚の投稿）の画像の枚数">
                      <option value={0}>おまかせ</option>
                      {Array.from({ length: 10 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} 枚</option>)}
                    </select>
                  </label>
                )}
              </div>
            )}
            {mode === "instagram" && (
              <label className="check small" title="ChatGPT などで作った画像を、1 枚ずつ投稿の 1 枚ずつとして、文字・位置・色までそのまま写し取ります（写真やイラストは画像から切り抜きます）">
                <input type="checkbox" checked={igReproduce} onChange={(e) => toggleIgReproduce(e.target.checked)} /> 画像を 1 枚ずつそのまま再現
              </label>
            )}
            <textarea
              rows={igReproduceMode ? 3 : 7}
              aria-label={igReproduceMode ? "補足（文言の差し替えなど）" : mode === "instagram" ? "投稿の内容（ブリーフ）" : "ポスターの内容（ブリーフ）"}
              placeholder={igReproduceMode ? "補足（空で構いません。文言を差し替えたいときだけ書いてください。全部の画像に効きます）" : mode === "instagram" ? "投稿の内容（伝えたいこと・告知なら日時・場所・対象など）。カルーセルなら「1 枚目に…、2 枚目に…」のように書いても構いません" : "ポスターの内容（タイトル・日時・場所・対象など）"}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              onKeyDown={submitOnModEnter(planWithAI, canPlan)}
            />
            {!igReproduceMode && (
              <ImageAttach
                images={refs}
                max={refLimit}
                label="参考画像・PDFを添付（1ファイル20MB）"
                caption="画像・PDF"
                accept={REFERENCE_FILE_ACCEPT}
                disabled={readingRefs || !!busy}
                onAdd={onRefFiles}
                onRemove={(i) => setRefs((x) => x.filter((_, j) => j !== i))}
              />
            )}
            <div className="row">
              {igReproduceMode && (
                <label className="as-button small" title={`投稿にする画像（${IG_MAX_IMAGES} 枚まで・ドロップでも追加可）。並んだ順に 1 枚目・2 枚目…になります`}>
                  <Ico name="plus" size={14} /> 画像を追加<input type="file" accept={REFERENCE_FILE_ACCEPT} multiple hidden disabled={readingRefs || !!busy} onChange={(e) => { onRefFiles(e.target.files); e.target.value = ""; }} />
                </label>
              )}
              {refs.length > 0 && !deck && mode === "poster" && (
                <label className="check small" title="参考画像の 1 枚目を、文字・位置・色までそのまま写し取ります（写真やイラストは参考画像から切り抜きます）">
                  <input type="checkbox" checked={reproduce} onChange={(e) => setReproduce(e.target.checked)} /> 1 枚目をそのまま再現
                </label>
              )}
            </div>
            {refs.length > 0 && igReproduceMode && (
              <ol className="ig-slots" aria-label="再現する画像（並びが投稿の順）">
                {refs.slice(0, IG_MAX_IMAGES).map((r, i) => (
                  <li key={r.url + i} className="ig-slot">
                    <img src={r.url} alt={r.name} style={{ aspectRatio: `${IG_RATIOS[igRatio].w} / ${IG_RATIOS[igRatio].h}` }} title={`${r.name}（${r.w}×${r.h}）`} />
                    <span className="ig-slot-no">{i + 1}</span>
                    <span className="ig-slot-tools">
                      <button aria-label={`${i + 1} 枚目を前へ`} title="前へ" disabled={i === 0} onClick={() => moveRef(i, i - 1)}><Ico name="chevronLeft" size={12} /></button>
                      <button aria-label={`${r.name} を外す`} title="外す" onClick={() => setRefs((x) => x.filter((_, j) => j !== i))}>×</button>
                      <button aria-label={`${i + 1} 枚目を後ろへ`} title="後ろへ" disabled={i === refs.length - 1} onClick={() => moveRef(i, i + 1)}><Ico name="chevronRight" size={12} /></button>
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {refs.length > 0 && igReproduceMode && refs.some((r) => !ratioOf(r.w, r.h) || ratioOf(r.w, r.h) !== igRatio) && (
              <p className="hint small">比率が {IG_RATIOS[igRatio].label} と違う画像は、中央で切り抜いてから再現します（サムネイルは切り抜いた後の見え方です）</p>
            )}
            {readingRefs && <p className="hint small" role="status">参考資料を読み込み中…</p>}
            {signinNote}
            <button className="primary block" disabled={!canPlan} onClick={planWithAI}>
              <Ico name="sparkles" /> {igReproduceOn ? `${Math.min(refs.length, IG_MAX_IMAGES)} 枚の画像を再現` : reproduceOn ? "参考画像を再現" : mode === "instagram" ? "投稿を生成" : "レイアウトを生成"} <kbd>{MOD}+Enter</kbd>
            </button>
            {mode === "instagram" && <p className="hint small">{IG_RATIOS[igRatio].w}×{IG_RATIOS[igRatio].h}px・{IG_RATIOS[igRatio].note}。新しい投稿として作ります（今の成果物は残ります）。最大 {IG_MAX_IMAGES} 枚</p>}
            {reproduceOn && <p className="hint small">ブリーフは空でも構いません。文言を差し替えたいときだけ書いてください</p>}
            {igReproduceMode && !refs.length && <p className="hint small">投稿にする画像を 1 枚目から順に追加してください（まとめて選ぶとファイル名の順に並びます）。1 枚あたり 2〜4 分ほどかかります</p>}
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
              onExample={(t) => { setChatMode("chat"); setInstruction(t); }}
              onUndo={undoChat}
              onResend={resendChat}
              canResend={(m) => !busy && !readingRefs && (!m.hasReferences || !!m.references) && (aiReady || m.mode === "image" || /^[/／]/.test(m.text))}
            />
            <div className="composer">
              <div className="composer-top">
                <div className="seg" role="radiogroup" aria-label="送信モード">
                  <button role="radio" aria-checked={chatMode === "chat"} className={chatMode === "chat" ? "on" : ""} onClick={() => setChatMode("chat")}><Ico name="message" size={14} /> チャット</button>
                  <button role="radio" aria-checked={chatMode === "image"} className={chatMode === "image" ? "on" : ""} onClick={() => setChatMode("image")}><Ico name="image" size={14} /> 画像生成</button>
                </div>
                {chatMode === "chat" ? targetChip(chatScope, chatFallback) : targetChip(imageScope, "新しい画像（中央）")}
              </div>
              {chatMode === "chat" && slashItems.length > 0 && (
                <SlashMenu items={slashItems} active={slashSel} onPick={pickSlash} onHover={setSlashActive} />
              )}
              {chatMode === "chat"
                ? <textarea
                    rows={3}
                    aria-label="AI へのメッセージ"
                    placeholder={multi ? `選んだ ${selLayers.length} 件をどう変えますか？` : selectedLayer ? `「${layerName(selectedLayer)}」をどう変えますか？` : "メッセージを入力（/ でコマンド）"}
                    value={instruction}
                    onChange={(e) => { setInstruction(e.target.value); setSlashClosed(false); setSlashActive(0); }}
                    onKeyDown={onChatKey}
                  />
                : <textarea
                    rows={3}
                    aria-label="画像生成プロンプト"
                    placeholder="どんな画像？（例: 夕焼けの沖縄の海、水彩風）"
                    value={imgPrompt}
                    onChange={(e) => setImgPrompt(e.target.value)}
                    onKeyDown={submitOnEnter(generateImageFromInput, canGenImage)}
                  />}
              {chatMode === "chat" && referencePreviews}
              {chatMode === "chat" && readingRefs && <p className="hint small" role="status">参考資料を読み込み中…</p>}
              <div className="composer-bar">
                {chatMode === "chat" && <label className="as-button small" title="参考資料として画像・PDFを添付（合計20ページまで、1ファイル20MB）">
                  <Ico name="file" /> 画像・PDF
                  <input type="file" accept={REFERENCE_FILE_ACCEPT} multiple hidden disabled={readingRefs || !!busy} onChange={(e) => { onRefFiles(e.target.files); e.target.value = ""; }} />
                </label>}
                <label className={"as-button small icon" + (busy ? " disabled" : "")} title={canReplaceImage ? "画像ファイルで差し替え" : "画像ファイルから挿入（キャンバスへのドロップ・貼り付けでも可）"} aria-label="画像ファイルを入れる">
                  <Ico name="paperclip" />
                  <input type="file" accept={IMAGE_FILE_ACCEPT} multiple={!canReplaceImage} hidden disabled={!!busy} onChange={(e) => { insertImageFilesHere(e.target.files); e.target.value = ""; }} />
                </label>
                {chatMode === "image" && <label className="check"><input type="checkbox" checked={imgTransparent} onChange={(e) => setImgTransparent(e.target.checked)} /> 透過</label>}
                {chatMode === "chat" && aiProvider === "chatgpt" && gpt?.signedIn && gpt.models?.length ? (
                  <ModelSelect className="composer-model" label="ChatGPT のモデル" models={gpt.models} choice={gpt.modelChoice ?? ""} autoModel={gpt.autoModel} disabled={!!busy} onChange={chooseChatGPTModel} />
                ) : chatMode === "chat" && aiProvider === "openrouter" && openrouter?.models?.length ? (
                  <ModelSelect className="composer-model" label="OpenRouter のモデル" models={openrouter.models} choice={openrouter.modelChoice} autoModel={openrouter.autoModel} disabled={!!busy} onChange={chooseOpenRouterModel} />
                ) : null}
                {chatMode === "chat"
                  ? <button className="primary send" disabled={!canChat} onClick={() => sendChat()} aria-label="送信">送信</button>
                  : <button className="primary send" disabled={!canGenImage} onClick={generateImageFromInput}>{hasImage ? "再生成" : "生成"}</button>}
              </div>
              {chatMode === "chat" && signinNote}
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
            onOpen={goToSlide}
            onAdd={addSlide} onDuplicate={duplicateSlide} onRemove={removeSlide} onMove={moveSlide} onReorder={reorderSlide}
            onExport={instagram ? confirmExport : exportDeck} onFonts={openFontDialog} onToggle={toggleDeck} onPresent={() => startShow(false)} onPresentView={() => startShow(true, true)}
            instagram={instagram ? { ratio: ratioOf(W, H), onRatio: changeRatio } : undefined}
          />
        )}
        {deck && deckOpen && (
          <Resizer
            className="deck" edge="top" label="スライド一覧の高さを変える" min={DECK_CHROME_H + 24} max={Math.round(window.innerHeight * 0.5)}
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
              title={deckPending && deckPending.images > 1 ? `${deckPending.images} 枚の画像にある未生成の画像素材をまとめて生成します` : "未生成の画像をまとめて生成します"}
            >
              <Ico name="image" /> 画像を生成<span className="pill-count">{pendingCount}</span>
            </button>
          </div>
        )}
        <div className="zoombar float-bar" role="group" aria-label="ズーム">
          <button onClick={() => zoomBy(-1)} title={`縮小（${MOD}+-）`} aria-label="縮小"><Ico name="minus" /></button>
          <button className="zoom-val" onClick={() => (zoom === "fit" ? setZoom(1) : fitView())} title={`クリックで 100% / 全体表示を切替（${MOD}+0 で全体）`}>
            {Math.round(scale * 100)}%
          </button>
          <button onClick={() => zoomBy(1)} title={`拡大（${MOD}++）`} aria-label="拡大"><Ico name="plus" /></button>
          <button onClick={fitView} disabled={zoom === "fit" && !pan.x && !pan.y} title={`全体を表示（${MOD}+0）`} aria-label="全体を表示"><Ico name="fit" /></button>
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
          {isSlides && <button className="icon-btn" onClick={() => startShow(true)} title="このスライドから投影（Shift+F5。F5 で最初から）" aria-label="スライドショー"><Ico name="monitor" /></button>}
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
          <button className="primary" onClick={confirmExport} title={instagram ? "全画像を PNG（幅 1080px）で書き出し" : deck ? "全スライドを PowerPoint で書き出し" : "PNG で書き出し（A4 300dpi・2480×3508px）"}><Ico name="download" /> 書き出し</button>
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

        <div className="right-card right-layers">
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
        />
        </div>
        </div>
      </aside>

      {fontDialog && deck && (
        <FontDialog
          kind={instagram ? "instagram" : "slides"} deckName={deck.name} texts={fontDialog.texts} current={fontDialog.current}
          onApply={applyDeckFonts} onError={notifyAIError} onClose={() => setFontDialog(null)}
        />
      )}

      {posterFontDialog && !deck && (
        <FontDialog
          kind="poster" deckName={spec.meta.title} texts={specTexts(spec)} current={{ display: theme.fonts.display, body: theme.fonts.body }}
          onApply={applyPosterFonts} onError={notifyAIError} onClose={() => setPosterFontDialog(false)}
        />
      )}

      {show && <Presenter slides={show.slides} start={show.start} view={show.view} onExit={endShow} />}

      {welcome && <WelcomeModal status={status} onClose={closeWelcome} />}
    </div>
  );
}
