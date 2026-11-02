import type { RefObject } from "react";
import { CATALOG_BY_NAME } from "../components/catalog";
import type { Layer, PosterSpec } from "../schema";
import { alignedPosition, insertAfter, isVisibleOnCanvas, moveLayerTo, reorderLayer, uid, type AlignTo } from "./specOps";

export const layerName = (l: Layer) => l.name ?? l.id;

type SetSpec = (next: PosterSpec | ((prev: PosterSpec) => PosterSpec), coalesceKey?: string) => void;

/**
 * エディタでのレイヤーの並べ替え・削除・複製・移動・選択・追加・整列。
 * spec は App が useHistory で持ち、ここでは setSpec で書き換えるだけ（描画のたびに作り直す）
 */
export function createLayerOps({ spec, setSpec, setSelected, setSelectedIds, clipboard, updateLayer, notifyRestorable }: {
  spec: PosterSpec;
  setSpec: SetSpec;
  setSelected: (id: string | null) => void;
  setSelectedIds: (update: string[] | ((ids: string[]) => string[])) => void;
  clipboard: RefObject<Layer[]>;
  updateLayer: (id: string, patch: Partial<Layer>) => void;
  notifyRestorable: (text: string, before: PosterSpec, kind: "info") => void;
}) {
  const W = spec.meta.width, H = spec.meta.height;
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
  const addLayer = (layer: Layer) => { setSpec((s) => ({ ...s, layers: [...s.layers, layer] })); setSelected(layer.id); };
  /** ポスター中央に置く位置 */
  const centered = (w: number, h: number) => ({ x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h });
  const addComponent = (name: string) => {
    const c = CATALOG_BY_NAME[name];
    addLayer({ id: uid(name), name: c.label, type: "component", component: name, props: structuredClone(c.defaults), ...centered(...c.defaultSize) });
  };
  const addText = () => addLayer({ id: uid("text"), name: "テキスト", type: "text", text: "テキスト", font: "display", size: 64, weight: 900, lineHeight: 1.25, align: "left", fill: "$ink", ...centered(600, 90) });
  const alignLayer = (id: string, where: AlignTo) => {
    const l = spec.layers.find((x) => x.id === id);
    if (l) updateLayer(id, alignedPosition(l, where, W, H) as Partial<Layer>);
  };
  return {
    reorder, moveTo, removeLayers, insertCopies, duplicateLayers, copyLayers, moveLayers, selectable, movable, toggleSelect,
    addLayer, centered, addComponent, addText, alignLayer,
  };
}
