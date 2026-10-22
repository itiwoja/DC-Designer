import type { SlideTransition } from "./schema";
import { soundTag } from "./animation";

/**
 * PPTX エディターモードの画面切り替え（PowerPoint の「画面切り替え」）。
 * - スライドショーでは前のスライドの上で次のスライドを動かして入れる
 * - 書き出しでは slide.xml に <p:transition> を書く（pptxgenjs は書けない）
 */

export type TransEffect = SlideTransition["effect"];
export type TransDirection = NonNullable<SlideTransition["direction"]>;

export const TRANS_EFFECTS: { value: TransEffect; label: string; directional?: boolean }[] = [
  { value: "fade", label: "フェード" },
  { value: "push", label: "プッシュ", directional: true },
  { value: "wipe", label: "ワイプ", directional: true },
  { value: "cover", label: "カバー", directional: true },
  { value: "zoom", label: "ズーム" },
];
export const TRANS_EFFECT_LABEL = Object.fromEntries(TRANS_EFFECTS.map((e) => [e.value, e.label])) as Record<TransEffect, string>;
export const isTransDirectional = (e: TransEffect) => !!TRANS_EFFECTS.find((x) => x.value === e)?.directional;

/** 新しく付けるときの既定値 */
export const defaultTransition = (effect: TransEffect = "fade"): SlideTransition => ({
  effect, duration: 700, ...(isTransDirectional(effect) ? { direction: "right" as const } : {}),
});

// ---------- PowerPoint の <p:transition> ----------

/** 入ってくる向き → PowerPoint の dir（動いていく向きで書く。右から = 左へ） */
const DIR: Record<TransDirection, string> = { bottom: "u", top: "d", right: "l", left: "r" };
const FROM_DIR: Record<string, TransDirection> = { u: "bottom", d: "top", l: "right", r: "left" };

const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main";

/** 長さを PowerPoint 2007 の 3 段階の速さにする（p14:dur を読めないときの代わり） */
const speed = (ms: number) => (ms < 600 ? "fast" : ms < 900 ? "med" : "slow");

/** スライドの <p:transition>。無ければ空。長さは p14:dur で書き、古い PowerPoint 向けに速さだけの版も添える */
export function buildTransitionXml(t: SlideTransition | undefined): string {
  if (!t) return "";
  const dir = isTransDirectional(t.effect) ? ` dir="${DIR[t.direction ?? "right"]}"` : "";
  const body = `<p:${t.effect}${dir}/>`
    + (t.sound ? `<p:sndAc><p:stSnd>${soundTag("p:snd", t.sound)}</p:stSnd></p:sndAc>` : "");
  const dur = Math.max(1, Math.round(t.duration));
  return `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">`
    + `<mc:Choice xmlns:p14="${P14}" Requires="p14"><p:transition spd="${speed(dur)}" p14:dur="${dur}">${body}</p:transition></mc:Choice>`
    + `<mc:Fallback><p:transition spd="${speed(dur)}">${body}</p:transition></mc:Fallback></mc:AlternateContent>`;
}

/** 読み込んだ <p:transition> → 画面切り替え。知らない効果はフェードにする（何か動くほうが元に近い） */
export function readTransition(el: Element | null | undefined): SlideTransition | undefined {
  if (!el) return undefined;
  const kids = Array.from(el.children);
  const fx = kids.find((k) => k.localName !== "sndAc" && k.localName !== "extLst");
  if (!fx) return undefined;
  const durAttr = Array.from(el.attributes).find((a) => a.localName === "dur")?.value;
  const spd = el.getAttribute("spd");
  const duration = durAttr ? Math.min(10000, Number(durAttr)) : spd === "fast" ? 500 : spd === "med" ? 750 : 1000;
  const effect = (TRANS_EFFECTS.some((e) => e.value === fx.localName) ? fx.localName : "fade") as TransEffect;
  const t: SlideTransition = { effect, duration: Number.isFinite(duration) ? duration : 700 };
  // cover は斜め（"lu" など）もあるので、先頭の向きで受ける
  if (isTransDirectional(effect)) t.direction = FROM_DIR[(fx.getAttribute("dir") ?? "l")[0]] ?? "right";
  return t;
}

// ---------- 再生（スライドショー・プレビュー） ----------

/** 入ってくるスライドと出ていくスライドのキーフレーム（どちらも枠いっぱいの箱に当てる） */
export function transitionKeyframes(t: SlideTransition): { incoming: Keyframe[]; outgoing?: Keyframe[] } {
  const dir = t.direction ?? "right";
  const off = { bottom: "0 100%", top: "0 -100%", right: "100% 0", left: "-100% 0" }[dir];
  const away = { bottom: "0 -100%", top: "0 100%", right: "-100% 0", left: "100% 0" }[dir];
  switch (t.effect) {
    case "fade": return { incoming: [{ opacity: 0 }, { opacity: 1 }] };
    case "push": return { incoming: [{ translate: off }, { translate: "0 0" }], outgoing: [{ translate: "0 0" }, { translate: away }] };
    case "cover": return { incoming: [{ translate: off }, { translate: "0 0" }] };
    case "wipe": {
      const from = { bottom: "inset(100% 0 0 0)", top: "inset(0 0 100% 0)", right: "inset(0 0 0 100%)", left: "inset(0 100% 0 0)" }[dir];
      return { incoming: [{ clipPath: from }, { clipPath: "inset(0 0 0 0)" }] };
    }
    case "zoom": return { incoming: [{ scale: "0.3", opacity: 0 }, { scale: "1", opacity: 1 }], outgoing: [{ opacity: 1 }, { opacity: 0 }] };
  }
}

export const TRANSITION_EASING = "cubic-bezier(.4,0,.2,1)";
