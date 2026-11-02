import { useEffect, useMemo, useRef, type RefObject } from "react";
import { animationSequence, renumberAnimations } from "../animation";
import { playAnimations } from "../render/animatePreview";
import type { LayerAnimation, PosterSpec, SlideBgm, SlideTransition } from "../schema";
import { playSound } from "../sounds";
import { TRANSITION_EASING, transitionKeyframes } from "../transition";

type SetSpec = (next: PosterSpec | ((prev: PosterSpec) => PosterSpec), coalesceKey?: string) => void;

/** アニメーション・画面切り替え・BGM（PPTX エディターモード）の編集と、キャンバスでの試し再生 */
export function useAnimationOps({ spec, setSpec, svgRef, posterId }: {
  spec: PosterSpec;
  setSpec: SetSpec;
  svgRef: RefObject<SVGSVGElement | null>;
  posterId: string | null;
}) {
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
  /** 試し再生中のもの。スライドショーを始めるときにも止める */
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
  return { animOrder, setAnimations, moveAnimations, previewRef, previewAnimations, previewTransition, setTransition, setBgm };
}
