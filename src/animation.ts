import type { Layer, LayerAnimation, PosterSpec, SoundRef } from "./schema";

/**
 * PPTX エディターモードのアニメーション（PowerPoint の「開始」効果）。
 * - 順番は animation.order（無ければレイヤーの重ね順）で決まる
 * - 書き出しでは PowerPoint の <p:timing> を組み立てて slide.xml に差し込む（pptxgenjs はアニメーションを書けない）
 */

export type AnimEffect = LayerAnimation["effect"];
export type AnimDirection = NonNullable<LayerAnimation["direction"]>;

export const ANIM_EFFECTS: { value: AnimEffect; label: string; directional?: boolean }[] = [
  { value: "appear", label: "表示" },
  { value: "fade", label: "フェード" },
  { value: "float", label: "浮き上がり" },
  { value: "fly", label: "スライドイン", directional: true },
  { value: "wipe", label: "ワイプ", directional: true },
  { value: "zoom", label: "ズーム" },
];
export const ANIM_EFFECT_LABEL = Object.fromEntries(ANIM_EFFECTS.map((e) => [e.value, e.label])) as Record<AnimEffect, string>;
export const isDirectional = (e: AnimEffect) => !!ANIM_EFFECTS.find((x) => x.value === e)?.directional;

export const ANIM_DIRECTIONS: { value: AnimDirection; label: string }[] = [
  { value: "bottom", label: "下から" }, { value: "left", label: "左から" }, { value: "right", label: "右から" }, { value: "top", label: "上から" },
];
export const ANIM_STARTS: { value: LayerAnimation["start"]; label: string }[] = [
  { value: "click", label: "クリック時" }, { value: "with", label: "直前と同時" }, { value: "after", label: "直前の動作の後" },
];

/** 新しく付けるときの既定値 */
export const defaultAnimation = (effect: AnimEffect = "fade"): LayerAnimation => ({
  effect, start: "click", duration: 500, delay: 0, ...(isDirectional(effect) ? { direction: "bottom" as const } : {}),
});

/** 再生される（表示中でアニメーション付きの）トップレベルのレイヤーを、再生順に並べる */
export function animationSequence(spec: PosterSpec): { layer: Layer; anim: LayerAnimation }[] {
  return spec.layers
    .map((layer, i) => ({ layer, i }))
    .filter(({ layer }) => layer.animation && layer.type !== "background" && layer.visible !== false && (!layer.themes || layer.themes.includes(spec.theme)))
    .sort((a, b) => (a.layer.animation!.order ?? Infinity) - (b.layer.animation!.order ?? Infinity) || a.i - b.i)
    .map(({ layer }) => ({ layer, anim: layer.animation! }));
}

/**
 * 再生順を 1, 2, 3… に振り直す（ids を dir だけ前後に動かすこともできる）。
 * 複数のときは並びを保ったまま、それぞれのまとまりを 1 つずつずらす（端に着いたら動かさない）
 */
export function renumberAnimations(spec: PosterSpec, move?: { ids: string[]; dir: -1 | 1 }): PosterSpec {
  const ids = animationSequence(spec).map((s) => s.layer.id);
  // 非表示などで再生されないものも順番は保つ
  for (const l of spec.layers) if (l.animation && !ids.includes(l.id)) ids.push(l.id);
  if (move) {
    const moving = new Set(move.ids.filter((id) => ids.includes(id)));
    const pos = ids.flatMap((id, i) => (moving.has(id) ? [i] : []));
    const edge = move.dir < 0 ? 0 : ids.length - 1;
    if (pos.length && !pos.includes(edge)) {
      // 動かす向きの先頭から順に、隣の（動かさない）ものと入れ替える
      for (const i of move.dir < 0 ? pos : pos.reverse()) {
        const j = i + move.dir;
        if (!moving.has(ids[j])) [ids[i], ids[j]] = [ids[j], ids[i]];
      }
    }
  }
  const order = new Map(ids.map((id, i) => [id, i + 1]));
  return {
    ...spec,
    layers: spec.layers.map((l) => (l.animation && l.animation.order !== order.get(l.id) ? { ...l, animation: { ...l.animation, order: order.get(l.id) } } : l)),
  };
}

/**
 * 再生のまとまり。PowerPoint と同じく「クリック」ごとに区切り、その中で「直前の後」ごとに時間をずらす。
 * 先頭が「同時」「後」のときは、スライドが表示されたら自動で始まる（click グループ扱いにしない）
 */
export type AnimStep = { offset: number; items: { id: string; anim: LayerAnimation; offset: number }[] };
export type AnimGroup = { auto: boolean; steps: AnimStep[] };

export function animationGroups(seq: { layer: Layer; anim: LayerAnimation }[]): AnimGroup[] {
  const groups: AnimGroup[] = [];
  let step: AnimStep | null = null;
  let stepEnd = 0; // 今のステップで最後に終わる時刻（グループ先頭からの ms）
  for (const { layer, anim } of seq) {
    const g = groups.at(-1);
    if (!g || anim.start === "click") {
      groups.push({ auto: anim.start !== "click", steps: [] });
      step = null;
      stepEnd = 0;
    }
    const group = groups.at(-1)!;
    if (!step || anim.start === "after") {
      step = { offset: step ? stepEnd : 0, items: [] };
      group.steps.push(step);
    }
    // ステップ内の各効果は、ステップ開始からの遅延で並ぶ
    step.items.push({ id: layer.id, anim, offset: anim.delay });
    stepEnd = Math.max(stepEnd, step.offset + anim.delay + anim.duration);
  }
  return groups;
}

// ---------- PowerPoint の <p:timing> ----------

/** 方向 → PowerPoint の presetSubtype（スライドイン・ワイプ共通） */
const SUBTYPE: Record<AnimDirection, number> = { top: 1, right: 2, bottom: 4, left: 8 };
const PRESET: Record<AnimEffect, number> = { appear: 1, fly: 2, fade: 10, wipe: 22, float: 42, zoom: 53 };
/** ワイプは「どちらへ広がるか」で書く（下から = 上へ広がる） */
const WIPE_FILTER: Record<AnimDirection, string> = { bottom: "wipe(up)", top: "wipe(down)", left: "wipe(right)", right: "wipe(left)" };

type Ids = { next: () => number };

function anim(ids: Ids, spid: number, dur: number, attr: string, from: string, to: string) {
  return `<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="${ids.next()}" dur="${dur}" fill="hold"/><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl><p:attrNameLst><p:attrName>${attr}</p:attrName></p:attrNameLst></p:cBhvr>`
    + `<p:tavLst><p:tav tm="0"><p:val><p:strVal val="${from}"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="${to}"/></p:val></p:tav></p:tavLst></p:anim>`;
}
const animEffect = (ids: Ids, spid: number, dur: number, filter: string) =>
  `<p:animEffect transition="in" filter="${filter}"><p:cBhvr><p:cTn id="${ids.next()}" dur="${dur}"/><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cBhvr></p:animEffect>`;

/** 効果の中身（表示に切り替える set ＋ 効果ごとの動き） */
function behaviors(ids: Ids, spid: number, a: LayerAnimation): string {
  const dur = Math.max(1, Math.round(a.duration));
  const set = `<p:set><p:cBhvr><p:cTn id="${ids.next()}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>`;
  const dir = a.direction ?? "bottom";
  switch (a.effect) {
    case "appear": return set;
    case "fade": return set + animEffect(ids, spid, dur, "fade");
    case "fly": {
      const x = dir === "left" ? "0-#ppt_w/2" : dir === "right" ? "1+#ppt_w/2" : "#ppt_x";
      const y = dir === "top" ? "0-#ppt_h/2" : dir === "bottom" ? "1+#ppt_h/2" : "#ppt_y";
      return set + anim(ids, spid, dur, "ppt_x", x, "#ppt_x") + anim(ids, spid, dur, "ppt_y", y, "#ppt_y");
    }
    case "wipe": return set + animEffect(ids, spid, dur, WIPE_FILTER[dir]);
    case "float":
      return set + animEffect(ids, spid, dur, "fade") + anim(ids, spid, dur, "ppt_x", "#ppt_x", "#ppt_x") + anim(ids, spid, dur, "ppt_y", "#ppt_y+.1", "#ppt_y");
    case "zoom":
      return set + anim(ids, spid, dur, "ppt_w", "0", "#ppt_w") + anim(ids, spid, dur, "ppt_h", "0", "#ppt_h") + animEffect(ids, spid, dur, "fade");
  }
}

const NODE_TYPE = { click: "clickEffect", with: "withEffect", after: "afterEffect" } as const;

/** 効果音を書き出しで見分ける名前（内蔵音はその名前、ファイルは保存先のファイル名から。英数字と _ だけ） */
export const soundKey = (s: SoundRef) =>
  typeof s === "string" ? s : "file_" + (s.src.split("/").pop() ?? "").replace(/\.[^.]*$/, "").replace(/\W/g, "_");
/** 効果音の関係 ID（書き出しでスライドの .rels に同じ ID で WAV を足す） */
export const soundRelId = (s: SoundRef) => `rIdSfx_${soundKey(s)}`;
export const SOUND_REL_RE = /r:embed="rIdSfx_(\w+)"/g;
/** PowerPoint のアニメーション・画面切り替えの音は WAV しか使えないので、ファイルの音も WAV にして入れる */
export const soundTag = (tag: string, s: SoundRef) => `<${tag} r:embed="${soundRelId(s)}" name="${soundKey(s)}.wav"/>`;

/** 効果と同時に鳴らす音（PowerPoint の「効果のオプション → サウンド」と同じ書き方） */
const soundXml = (ids: Ids, sound: SoundRef) =>
  `<p:subTnLst><p:audio><p:cMediaNode showWhenStopped="0"><p:cTn id="${ids.next()}" display="0" masterRel="sameClick"><p:stCondLst><p:cond delay="0"/></p:stCondLst>`
  + `<p:endCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:endCondLst></p:cTn>`
  + `<p:tgtEl>${soundTag("p:sndTgt", sound)}</p:tgtEl></p:cMediaNode></p:audio></p:subTnLst>`;

/**
 * スライドの <p:timing> を作る。spids はレイヤー id → スライド内の図形 id（cNvPr id）。
 * textIds はテキストボックスとして書き出したレイヤー（bldP が要る）
 */
export function buildTimingXml(groups: AnimGroup[], spids: Map<string, number>, textIds: Set<string> = new Set()): string {
  let n = 2; // 1 = tmRoot, 2 = mainSeq
  const ids: Ids = { next: () => ++n };
  const used: { spid: number; grpId: number; text: boolean }[] = [];
  const pars = groups.map((g) => {
    const steps = g.steps.map((st) => {
      const items = st.items.flatMap((it) => {
        const spid = spids.get(it.id);
        if (spid == null) return [];
        used.push({ spid, grpId: 0, text: textIds.has(it.id) });
        const effId = ids.next();
        const sub = isDirectional(it.anim.effect) ? SUBTYPE[it.anim.direction ?? "bottom"] : it.anim.effect === "zoom" ? 16 : 0;
        return [`<p:par><p:cTn id="${effId}" presetID="${PRESET[it.anim.effect]}" presetClass="entr" presetSubtype="${sub}" fill="hold" grpId="0" nodeType="${NODE_TYPE[it.anim.start]}">`
          + `<p:stCondLst><p:cond delay="${Math.round(it.offset)}"/></p:stCondLst><p:childTnLst>${behaviors(ids, spid, it.anim)}</p:childTnLst>${it.anim.sound ? soundXml(ids, it.anim.sound) : ""}</p:cTn></p:par>`];
      });
      return items.length ? { offset: st.offset, xml: items.join("") } : null;
    }).filter((s) => s !== null);
    if (!steps.length) return "";
    const outerId = ids.next();
    // 自動で始まるグループは、メインシーケンスの開始（スライド表示）を合図にする
    const start = g.auto ? `<p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>` : `<p:cond delay="indefinite"/>`;
    return `<p:par><p:cTn id="${outerId}" fill="hold"><p:stCondLst>${start}</p:stCondLst><p:childTnLst>`
      + steps.map((s) => `<p:par><p:cTn id="${ids.next()}" fill="hold"><p:stCondLst><p:cond delay="${Math.round(s.offset)}"/></p:stCondLst><p:childTnLst>${s.xml}</p:childTnLst></p:cTn></p:par>`).join("")
      + `</p:childTnLst></p:cTn></p:par>`;
  }).join("");
  if (!pars) return "";
  // 同じ図形を 2 回登録しない
  const bld = [...new Map(used.filter((u) => u.text).map((u) => [u.spid, u])).values()]
    .map((u) => `<p:bldP spid="${u.spid}" grpId="${u.grpId}" animBg="1"/>`).join("");
  return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>`
    + `<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${pars}</p:childTnLst></p:cTn>`
    + `<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>`
    + `<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>`
    + `</p:childTnLst></p:cTn></p:par></p:tnLst>${bld ? `<p:bldLst>${bld}</p:bldLst>` : ""}</p:timing>`;
}

/**
 * slide.xml に <p:timing> を入れる（スキーマ上 clrMapOvr・transition の後、extLst の前）。
 * 画面切り替え（<p:transition>）を前に付けて渡せば一緒に入る
 */
export function insertTiming(slideXml: string, timing: string): string {
  if (!timing) return slideXml;
  const cleaned = slideXml.replace(/<p:timing>[\s\S]*?<\/p:timing>/, "");
  const ext = cleaned.lastIndexOf("<p:extLst>", cleaned.lastIndexOf("</p:sld>"));
  const cSldEnd = cleaned.indexOf("</p:cSld>");
  // スライド直下の extLst（cSld の後ろにあるもの）だけを対象にする
  const at = ext > cSldEnd && cSldEnd >= 0 ? ext : cleaned.lastIndexOf("</p:sld>");
  return cleaned.slice(0, at) + timing + cleaned.slice(at);
}
