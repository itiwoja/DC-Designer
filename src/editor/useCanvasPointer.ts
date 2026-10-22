import { useRef, useState, type PointerEvent as RPointerEvent, type RefObject } from "react";
import { clampCrop, cropTarget, withCrop } from "../render/ImageBox";
import type { ImageCrop, Layer, PosterSpec } from "../schema";
import { aabb, angleFrom, intersects, resizeBox, snapMove, unionBox, type Guide, type Handle } from "./canvas";
import { DEFAULT_CROP, type CropState } from "./CanvasOverlay";
import { isVisibleOnCanvas, resizeSelection } from "./specOps";

/** イベントの対象を含むトップレベルのレイヤー ID（ネストしたコンポーネントの子ではなく、いちばん外側） */
export function topLayerAt(target: EventTarget, topIds: Set<string>) {
  let el = (target as Element).closest?.("[data-layer-id]");
  let id: string | null = null;
  while (el) {
    const cand = el.getAttribute("data-layer-id")!;
    if (topIds.has(cand)) id = cand;
    el = el.parentElement?.closest("[data-layer-id]") ?? null;
  }
  return id;
}

type Selection = {
  selLayers: Layer[];
  selectedLayer: Layer | null;
  selectedIds: string[];
  multi: boolean;
  setSelected: (id: string | null) => void;
  setSelectedIds: (ids: string[]) => void;
  /** Shift / Ctrl+クリックで選択に足す・外す */
  toggleSelect: (id: string) => void;
  /** 範囲選択の対象にできるか */
  selectable: (l: Layer) => boolean;
  /** 一括移動の対象にできるもの */
  movable: (ls: Layer[]) => Layer[];
};

/**
 * キャンバス上のポインタ操作: レイヤーのクリック選択・ドラッグ移動（吸着）・範囲選択・リサイズ・回転・トリミング・ホバー。
 * cropWheel にはトリミング中のホイール操作（useZoom から呼ばれる）を入れる
 */
export function useCanvasPointer({ svgRef, spec, topIds, cropWheel, crop, cropRatio, setCropping, startTextEdit, updateLayer, replaceLayers, moveLayers, selection, setHovered }: {
  svgRef: RefObject<SVGSVGElement | null>;
  spec: PosterSpec;
  topIds: Set<string>;
  cropWheel: RefObject<((deltaY: number) => boolean) | null>;
  crop: CropState | null;
  cropRatio: number | undefined;
  setCropping: (id: string | null) => void;
  startTextEdit: (id: string, at?: { x: number; y: number }) => void;
  updateLayer: (id: string, patch: Partial<Layer> | ((l: Layer) => Layer), coalesce?: string) => void;
  replaceLayers: (layers: Layer[], coalesce: string) => void;
  moveLayers: (group: Layer[], dx: number, dy: number, coalesce?: string) => void;
  selection: Selection;
  setHovered: (id: string | null) => void;
}) {
  const W = spec.meta.width, H = spec.meta.height;
  const { selLayers, selectedLayer, selectedIds, multi, setSelected, setSelectedIds, toggleSelect, selectable, movable } = selection;
  const lastDown = useRef<{ id: string; t: number } | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [interacting, setInteracting] = useState(false);

  const k = () => (svgRef.current ? W / svgRef.current.getBoundingClientRect().width : 1); // 画面px → ポスター座標
  const toPoster = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) };
  };
  /** ポインタを離すまで onMove を呼ぶ */
  const trackPointer = (onMove: (ev: PointerEvent) => void, onEnd?: () => void) => {
    setInteracting(true);
    const up = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", up);
      setInteracting(false);
      setGuides([]);
      onEnd?.();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", up);
  };

  // トリミング（枠内での画像の拡大・位置）
  const setCrop = (l: Layer, next: ImageCrop, key: string) => {
    const c = clampCrop(next, l.w, l.h, cropRatio ?? next.ratio);
    updateLayer(l.id, (cur) => withCrop(cur, c), key);
  };
  cropWheel.current = crop ? (deltaY) => {
    const c = crop.info.crop ?? DEFAULT_CROP;
    const scale = c.scale * Math.exp(-deltaY * 0.0015);
    // 中心を保ったまま拡大縮小（ずらし量も比例させる）
    const r = scale / c.scale;
    setCrop(crop.layer, { scale, x: c.x * r, y: c.y * r }, `crop-zoom-${crop.layer.id}`);
    return true;
  } : null;
  const startCropPan = (e: RPointerEvent, l: Layer) => {
    const start = { x: e.clientX, y: e.clientY };
    const s = k();
    const c0 = cropTarget(l)?.crop ?? DEFAULT_CROP;
    const rot = ((l.rotation ?? 0) * Math.PI) / 180, cos = Math.cos(rot), sin = Math.sin(rot);
    const key = `crop-pan-${l.id}-${Date.now()}`;
    trackPointer((ev) => {
      const dx = (ev.clientX - start.x) * s, dy = (ev.clientY - start.y) * s;
      // 回転したレイヤーでも見た目どおりの方向に動かす
      const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
      setCrop(l, { ...c0, x: c0.x + lx / l.w, y: c0.y + ly / l.h }, key);
    });
  };

  /** 背景などから空白をドラッグして範囲選択する。動かさずに離したら onClick（未指定なら選択解除） */
  const startMarquee = (e: RPointerEvent, onClick?: () => void) => {
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = additive ? selLayers.filter((l) => l.type !== "background").map((l) => l.id) : [];
    const start = { x: e.clientX, y: e.clientY };
    const p0 = toPoster(e);
    const candidates = spec.layers.filter(selectable);
    let moved = false;
    trackPointer((ev) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return;
      moved = true;
      const p = toPoster(ev);
      const r = { x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) };
      setMarquee(r);
      // 枠に少しでも掛かったレイヤーを選ぶ
      const hit = candidates.filter((l) => intersects(aabb(l), r)).map((l) => l.id);
      setSelectedIds([...new Set([...base, ...hit])]);
    }, () => {
      setMarquee(null);
      // Shift 等を押したままのクリックは今の選択を保つ
      if (!moved && !additive) onClick ? onClick() : setSelected(null);
    });
  };

  /** group をまとめてドラッグ移動する（全体の外接矩形で吸着）。動かさずに離したら onClick */
  const startDrag = (e: RPointerEvent, group: Layer[], onClick?: () => void) => {
    const start = { x: e.clientX, y: e.clientY };
    const s = k();
    const key = `drag-${group.map((l) => l.id).join(",")}-${Date.now()}`;
    const ids = new Set(group.map((l) => l.id));
    const others = spec.layers.filter((l) => !ids.has(l.id) && isVisibleOnCanvas(l, spec.theme));
    const bounds = unionBox(group);
    let moved = false;
    trackPointer((ev) => {
      let dx = (ev.clientX - start.x) * s, dy = (ev.clientY - start.y) * s;
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return; // クリックでの誤移動を防ぐ
      moved = true;
      // Ctrl / ⌘ 押下中はスナップしない（Alt はキャンバスの表示移動に使う）
      if (!ev.ctrlKey && !ev.metaKey) {
        const snap = snapMove({ ...bounds, x: bounds.x + dx, y: bounds.y + dy }, others, { w: W, h: H }, 6 * s);
        dx += snap.dx; dy += snap.dy;
        setGuides(snap.guides);
      } else setGuides([]);
      moveLayers(group, dx, dy, key);
    }, () => { if (!moved) onClick?.(); });
  };

  const onLayerPointerDown = (e: RPointerEvent, layer: Layer) => {
    if (!topIds.has(layer.id)) return; // ネストした子は親（トップレベル）に任せる
    if (e.button !== 0) return;
    e.stopPropagation();
    if (crop && layer.id === crop.layer.id) { startCropPan(e, crop.layer); return; }
    const now = Date.now(), prev = lastDown.current;
    lastDown.current = { id: layer.id, t: now };
    const doubleClick = prev?.id === layer.id && now - prev.t < 350 && !e.shiftKey;
    // 画像のダブルクリックでトリミングモードへ
    if (doubleClick && cropTarget(layer)) {
      lastDown.current = null;
      setSelected(layer.id);
      setCropping(layer.id);
      return;
    }
    // テキストのダブルクリックでその場で文字を編集
    if (doubleClick && layer.type === "text" && !layer.locked) {
      e.preventDefault(); // 既定のフォーカス移動で編集欄がすぐ閉じないように
      lastDown.current = null;
      setSelected(layer.id);
      startTextEdit(layer.id, { x: e.clientX, y: e.clientY });
      return;
    }
    // 背景・ロック中の要素の上からは範囲選択（クリックだけならその要素を選ぶ）
    if (layer.locked || layer.type === "background") { startMarquee(e, () => setSelected(layer.id)); return; }
    if (e.shiftKey || e.ctrlKey || e.metaKey) { toggleSelect(layer.id); return; }
    // 複数選択中のどれかを掴んだら全体を動かす。クリックだけならそれ 1 つを選び直す
    if (multi && selectedIds.includes(layer.id)) {
      startDrag(e, movable(selLayers), () => setSelected(layer.id));
      return;
    }
    setSelected(layer.id);
    startDrag(e, [layer]);
  };

  const onResizeDown = (e: RPointerEvent, handle: Handle) => {
    if (e.button !== 0) return;
    if (multi) {
      e.stopPropagation();
      e.preventDefault();
      const group = movable(selLayers);
      if (!group.length) return;
      const start = { x: e.clientX, y: e.clientY }, s = k();
      const key = `resize-selection-${Date.now()}`;
      trackPointer((ev) => replaceLayers(resizeSelection(group, handle, { x: (ev.clientX - start.x) * s, y: (ev.clientY - start.y) * s }), key));
      return;
    }
    if (!selectedLayer) return;
    e.stopPropagation();
    const l = selectedLayer;
    const start = { x: e.clientX, y: e.clientY };
    const s = k();
    const key = `resize-${l.id}-${Date.now()}`;
    trackPointer((ev) => {
      const box = resizeBox(l, handle, { x: (ev.clientX - start.x) * s, y: (ev.clientY - start.y) * s }, ev.shiftKey);
      updateLayer(l.id, (cur) => {
        const next = { ...cur, ...box } as Layer;
        // テキストは枠に合わせて文字サイズも比例させる（Shift 押下時）
        if (ev.shiftKey && cur.type === "text" && l.type === "text") (next as any).size = Math.round(l.size * (box.w / l.w));
        return next;
      }, key);
    });
  };

  const onRotateDown = (e: RPointerEvent) => {
    if (!selectedLayer) return;
    e.stopPropagation();
    const l = selectedLayer;
    const center = { x: l.x + l.w / 2, y: l.y + l.h / 2 };
    const key = `rotate-${l.id}-${Date.now()}`;
    trackPointer((ev) => updateLayer(l.id, { rotation: angleFrom(center, toPoster(ev), ev.shiftKey) }, key));
  };

  const onStageHover = (e: RPointerEvent) => {
    if (interacting) return;
    const id = topLayerAt(e.target, topIds);
    const l = id ? spec.layers.find((x) => x.id === id) : null;
    setHovered(l && l.type !== "background" ? l.id : null);
  };

  return { guides, marquee, interacting, toPoster, startMarquee, onLayerPointerDown, onResizeDown, onRotateDown, onStageHover };
}
