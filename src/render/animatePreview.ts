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

/** スライドショーで 1 クリックずつ進めるまとまり（先頭が auto なら表示と同時に始まる） */
export const slideGroups = (spec: PosterSpec): AnimGroup[] => {
  // スクロールの画像は、最初のクリックまでに読み込んでおく
  void loadScrollRatios(spec);
  return animationGroups(animationSequence(spec));
};

/** まだ出していないまとまりの要素を隠す（hidden = false で元に戻す） */
export function hideGroup(svg: SVGSVGElement, g: AnimGroup, hidden: boolean) {
  for (const st of g.steps) for (const it of st.items) {
    const el = layerEl(svg, it.id);
    if (el) hidden ? el.style.setProperty("visibility", "hidden") : el.style.removeProperty("visibility");
  }
}

/** まとまりを 1 つ、今すぐ再生する（finish で最後の状態まで飛ばせる） */
export function playGroup(svg: SVGSVGElement, spec: PosterSpec, g: AnimGroup): Running {
  const running: Playing = { anims: [], sounds: [] };
  startGroup(svg, spec, g, 0, running, true);
  return settle(running);
}
