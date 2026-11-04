import type { Layer, LayerAnimation, PosterSpec } from "../schema";
import { animationGroups, animationSequence, dirParts, normalizeDirection, scrollLayout, toCardinal, type AnimGroup } from "../animation";
import { cachedImageRatio, loadImageRatio } from "./imageRatio";
import { playSound, type PlayingSound } from "../sounds";

/** クリックで進むところは、プレビューではこの間をおいて自動で進める */
const CLICK_GAP = 700;
const LEAD_IN = 250;

/** 1 つの効果を Web Animations のキーフレームにする（PowerPoint の見た目に寄せる） */
function keyframes(l: Layer, a: LayerAnimation, spec: PosterSpec, opacity: number): Keyframe[] {
  const { width: W, height: H } = spec.meta;
  const dir = normalizeDirection(a.effect, a.direction) ?? "bottom";
  switch (a.effect) {
    case "appear": return [{ visibility: "hidden" }, { visibility: "visible" }];
    case "fade": return [{ opacity: 0 }, { opacity }];
    case "float": return [{ opacity: 0, translate: `0px ${H * 0.1}px` }, { opacity, translate: "0px 0px" }];
    case "fly": {
      // スライドの外（端のすぐ向こう）から今の位置へ
      const { h, v } = dirParts(dir);
      const dx = h < 0 ? -(l.x + l.w) : h > 0 ? W - l.x : 0;
      const dy = v < 0 ? -(l.y + l.h) : v > 0 ? H - l.y : 0;
      return [{ translate: `${dx}px ${dy}px` }, { translate: "0px 0px" }];
    }
    case "wipe": {
      const from = { bottom: "inset(100% 0 0 0)", top: "inset(0 0 100% 0)", left: "inset(0 100% 0 0)", right: "inset(0 0 0 100%)" }[toCardinal(dir)];
      return [{ clipPath: from }, { clipPath: "inset(0 0 0 0)" }];
    }
    case "scroll": return scrollKeyframes(l, a) ?? [];
    case "zoom": {
      // scale は原点 (0,0) 基準なので、中心がずれないよう translate で補う
      const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
      return [{ scale: "0", translate: `${cx}px ${cy}px`, opacity: 0 }, { scale: "1", translate: "0px 0px", opacity }];
    }
  }
}

/** 画像の読み込みが終わっていて流せるときの、スクロールのキーフレーム（image 要素の translate。枠でクリップされる） */
function scrollKeyframes(l: Layer, a: LayerAnimation): Keyframe[] | null {
  if (l.type !== "image" || !l.src) return null;
  const ratio = cachedImageRatio(l.src) ?? l.crop?.ratio;
  if (!ratio) return null;
  const { move, travel } = scrollLayout(l, ratio, a.direction, a.scrollTo ?? 1);
  return travel > 0 ? [{ translate: "0px 0px" }, { translate: `${move.dx}px ${move.dy}px` }] : null;
}

/** スクロールの画像の幅/高さを読み込んでおく（流す量に要る）。only を渡すとそのレイヤーだけ */
function loadScrollRatios(spec: PosterSpec, only?: string[]): Promise<unknown> {
  return Promise.all(spec.layers.flatMap((l) => (l.type === "image" && l.src && l.animation?.effect === "scroll" && (!only || only.includes(l.id)) ? [loadImageRatio(l.src)] : [])));
}

type Running = { done: Promise<void>; cancel: () => void; finish: () => void };

/** 再生中の動きと効果音 */
type Playing = { anims: Animation[]; sounds: PlayingSound[] };

const settle = ({ anims, sounds }: Playing): Running => ({
  done: Promise.all(anims.map((a) => a.finished.catch(() => undefined))).then(() => undefined),
  cancel: () => { anims.forEach((a) => a.cancel()); sounds.forEach((s) => s.stop()); },
  // 最後まで飛ばすときは、鳴り始めた音はそのまま鳴らし、まだの音は鳴らさない
  finish: () => { anims.forEach((a) => { try { a.finish(); } catch { /* 取り消し済み */ } }); sounds.forEach((s) => s.stop(false)); },
});

/** まとまり 1 つ（クリック 1 回分）を t ミリ秒後から再生し、終わる時刻を返す */
function startGroup(svg: SVGSVGElement, spec: PosterSpec, g: AnimGroup, t: number, running: Playing, keep: boolean): number {
  const byId = new Map(spec.layers.map((l) => [l.id, l]));
  let end = t;
  for (const st of g.steps) for (const it of st.items) {
    const l = byId.get(it.id);
    const layer = layerEl(svg, it.id);
    if (!l || !layer) continue;
    layer.style.removeProperty("visibility");
    const scroll = it.anim.effect === "scroll";
    // スクロールは枠の中の画像を動かす（枠ごと動かさない）
    const el = scroll ? layer.querySelector<SVGElement>("[data-scroll-image]") : layer;
    const start = t + st.offset + it.offset;
    const duration = Math.max(1, it.anim.duration);
    if (it.anim.sound) running.sounds.push(playSound(it.anim.sound, start));
    const kf = keyframes(l, it.anim, spec, l.opacity ?? 1);
    if (el && kf.length) {
      running.anims.push(el.animate(kf, {
        duration, delay: start,
        // スクロールはスライドショーでは動かした先で止める（試し再生では終わったら元に戻る）
        fill: scroll && keep ? "both" : "backwards",
        easing: it.anim.effect === "appear" ? "step-end" : scroll ? "ease-in-out" : "cubic-bezier(.2,.7,.3,1)",
      }));
    }
    end = Math.max(end, start + duration);
  }
  return end;
}

const layerEl = (svg: SVGSVGElement, id: string) => svg.querySelector<SVGGElement>(`[data-layer-id="${CSS.escape(id)}"]`);

/**
 * スライドのアニメーションをキャンバス上で再生する。only を渡すとそのレイヤーだけ（開始のタイミングはそのまま）。
 * 再生前は対象を隠し（fill: backwards）、終わったら元の表示に戻る。戻り値で途中で止められる
 */
export function playAnimations(svg: SVGSVGElement, spec: PosterSpec, only?: string[]): { done: Promise<void>; cancel: () => void } {
  const seq = animationSequence(spec).filter((s) => !only || only.includes(s.layer.id));
  const start = (): Running => {
    const running: Playing = { anims: [], sounds: [] };
    let t = LEAD_IN;
    for (const [gi, g] of animationGroups(seq).entries()) {
      if (gi > 0 && !g.auto) t += CLICK_GAP;
      t = startGroup(svg, spec, g, t, running, false);
    }
    return settle(running);
  };
  if (!seq.some((s) => s.anim.effect === "scroll")) return start();
  // スクロールは画像の大きさが分かってから始める
  let run: Running | null = null, cancelled = false;
  const done = loadScrollRatios(spec, only).then(() => {
    if (cancelled) return;
    run = start();
    return run.done;
  });
  return { done, cancel: () => { cancelled = true; run?.cancel(); } };
}

// ---------- スライドショー ----------

/** slideGroups が作ったまとまりと、その元のスライド（hideGroup が流し終えた位置を作るのに使う） */
const groupSpec = new WeakMap<AnimGroup, PosterSpec>();

/** スライドショーで 1 クリックずつ進めるまとまり（先頭が auto なら表示と同時に始まる） */
export const slideGroups = (spec: PosterSpec): AnimGroup[] => {
  // スクロールの画像は、最初のクリックまでに読み込んでおく
  void loadScrollRatios(spec);
  const groups = animationGroups(animationSequence(spec));
  groups.forEach((g) => groupSpec.set(g, spec));
  return groups;
};

/** スクロールの画像ごとの「最後に整えた時の印」。読み込み待ちの間に状態が変わったら古い結果を捨てるのに使う */
const scrollStamp = new WeakMap<Element, symbol>();

/** スクロールを流し終えた位置にする（終わったまとまりの表示。元の動きは取り消した上で、最後の状態だけ残す） */
function settleScroll(el: SVGElement, l: Layer, a: LayerAnimation, spec: PosterSpec) {
  el.getAnimations?.().forEach((x) => x.cancel());
  const stamp = Symbol();
  scrollStamp.set(el, stamp);
  const apply = () => {
    const kf = scrollKeyframes(l, a);
    if (!kf) return;
    const x = el.animate([kf[kf.length - 1]], { duration: 1, fill: "forwards" });
    x.finish();
  };
  if (scrollKeyframes(l, a) || l.type !== "image" || !l.src) return apply();
  // 比率がまだ無いときは、読み込んでから。その間にスライドを移った・また隠した（印が変わった）なら何もしない
  void loadImageRatio(l.src).then(() => { if (scrollStamp.get(el) === stamp && el.isConnected) apply(); });
}

/**
 * まだ出していないまとまりの要素を隠す（hidden = false で元に戻す）。
 * スクロールは入場の効果ではないので隠さない（PPTX・試し再生と同じく最初から見せる）。
 * 隠すとき（まだ流していない）は流す前の位置に戻し、出したとき（流し終えた）は流し終えた位置にする
 */
export function hideGroup(svg: SVGSVGElement, g: AnimGroup, hidden: boolean) {
  const spec = groupSpec.get(g);
  for (const st of g.steps) for (const it of st.items) {
    const el = layerEl(svg, it.id);
    if (!el) continue;
    if (it.anim.effect === "scroll") {
      const img = el.querySelector<SVGElement>("[data-scroll-image]");
      const l = spec?.layers.find((x) => x.id === it.id);
      if (hidden) { img?.getAnimations?.().forEach((a) => a.cancel()); if (img) scrollStamp.delete(img); }
      else if (img && l && spec) settleScroll(img, l, it.anim, spec);
      continue;
    }
    hidden ? el.style.setProperty("visibility", "hidden") : el.style.removeProperty("visibility");
  }
}

/** まとまりの中で、画像の比率がまだ分からず流せないスクロールのレイヤー id */
export function pendingScrolls(spec: PosterSpec, g: AnimGroup): string[] {
  const byId = new Map(spec.layers.map((l) => [l.id, l]));
  return g.steps.flatMap((st) => st.items.flatMap((it) => {
    const l = byId.get(it.id);
    return l && it.anim.effect === "scroll" && l.type === "image" && l.src && !scrollKeyframes(l, it.anim) ? [l.id] : [];
  }));
}

/** まとまりを 1 つ、今すぐ再生する（finish で最後の状態まで飛ばせる）。スクロールの画像の読み込み待ちがあれば、済んでから始める */
export function playGroup(svg: SVGSVGElement, spec: PosterSpec, g: AnimGroup): Running {
  const begin = () => {
    const running: Playing = { anims: [], sounds: [] };
    startGroup(svg, spec, g, 0, running, true);
    return settle(running);
  };
  const wait = pendingScrolls(spec, g);
  if (!wait.length) return begin();
  let inner: Running | null = null, cancelled = false, skip = false;
  const done = loadScrollRatios(spec, wait).then(() => {
    if (cancelled) return;
    inner = begin();
    if (skip) inner.finish();
    return inner.done;
  });
  return {
    done,
    // 読み込み中に取り消された・最後まで飛ばされたときは、始まった時点でそうする
    cancel: () => { cancelled = true; inner?.cancel(); },
    finish: () => { skip = true; inner?.finish(); },
  };
}
