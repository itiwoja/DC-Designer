import type { Layer, LayerAnimation, PosterSpec, SoundRef } from "./schema";

/**
 * PPTX エディターモードのアニメーション（PowerPoint の「開始」効果）。
 * - 順番は animation.order（無ければレイヤーの重ね順）で決まる
 * - 書き出しでは PowerPoint の <p:timing> を組み立てて slide.xml に差し込む（pptxgenjs はアニメーションを書けない）
 */

export type AnimEffect = LayerAnimation["effect"];
export type AnimDirection = NonNullable<LayerAnimation["direction"]>;
/** 上下左右の 4 方向（ワイプ・画面切り替え・スクロールで使える向き） */
export type CardinalDirection = "bottom" | "top" | "left" | "right";

export const ANIM_EFFECTS: { value: AnimEffect; label: string; directional?: boolean; diagonal?: boolean; imageOnly?: boolean }[] = [
  { value: "appear", label: "表示" },
  { value: "fade", label: "フェード" },
  { value: "float", label: "浮き上がり" },
  { value: "fly", label: "画面外から（スライドイン）", directional: true, diagonal: true },
  { value: "wipe", label: "ワイプ", directional: true },
  { value: "zoom", label: "ズーム" },
  { value: "scroll", label: "スクロール", directional: true, imageOnly: true },
];
export const isDirectional = (e: AnimEffect) => !!ANIM_EFFECTS.find((x) => x.value === e)?.directional;
/** 斜めの向きも選べる効果か */
export const isDiagonalOk = (e: AnimEffect) => !!ANIM_EFFECTS.find((x) => x.value === e)?.diagonal;
/** 画像にしか付けられない効果か */
export const isImageOnly = (e: AnimEffect) => !!ANIM_EFFECTS.find((x) => x.value === e)?.imageOnly;

export const ANIM_DIRECTIONS: { value: CardinalDirection; label: string }[] = [
  { value: "bottom", label: "下から" }, { value: "left", label: "左から" }, { value: "right", label: "右から" }, { value: "top", label: "上から" },
];
/** スライドインの斜めの向き */
export const ANIM_DIAGONALS: { value: AnimDirection; label: string }[] = [
  { value: "topleft", label: "左上から" }, { value: "topright", label: "右上から" }, { value: "bottomleft", label: "左下から" }, { value: "bottomright", label: "右下から" },
];
/** スクロールの向き（画像のどちらからどちらへ流すか） */
export const SCROLL_DIRECTIONS: { value: CardinalDirection; label: string }[] = [
  { value: "bottom", label: "上→下" }, { value: "top", label: "下→上" }, { value: "right", label: "左→右" }, { value: "left", label: "右→左" },
];
export const ANIM_STARTS: { value: LayerAnimation["start"]; label: string }[] = [
  { value: "click", label: "クリック時" }, { value: "with", label: "直前と同時" }, { value: "after", label: "直前の動作の後" },
];

/** 向きの横・縦の成分（-1 = 左／上から、1 = 右／下から） */
export function dirParts(d: AnimDirection): { h: -1 | 0 | 1; v: -1 | 0 | 1 } {
  return { h: d.endsWith("left") ? -1 : d.endsWith("right") ? 1 : 0, v: d.startsWith("top") ? -1 : d.startsWith("bottom") ? 1 : 0 };
}
/** 斜めを上下左右のどれかにする（縦の成分を優先） */
export function toCardinal(d: AnimDirection): CardinalDirection {
  const { h, v } = dirParts(d);
  return v < 0 ? "top" : v > 0 ? "bottom" : h < 0 ? "left" : "right";
}
/** 効果に合う向きにそろえる。向きの無い効果は undefined、斜めを選べない効果の斜めは上下左右にする */
export function normalizeDirection(effect: AnimEffect, d: AnimDirection | undefined): AnimDirection | undefined {
  if (!isDirectional(effect)) return undefined;
  const dir = d ?? "bottom";
  return isDiagonalOk(effect) ? dir : toCardinal(dir);
}

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

// ---------- スクロール（画像を枠の中で流す） ----------

/**
 * スクロールの配置。枠 (0,0,w,h) の左上を基準に、画像全体の矩形（img）と、動かす量（move）。
 * 縦（bottom / top）は画像の幅を枠に合わせ、横（right / left）は高さを枠に合わせて、はみ出した分を流す。
 * travel が 0 なら、その向きにははみ出していない（流せない）
 */
export function scrollLayout(frame: { w: number; h: number }, ratio: number, direction: AnimDirection | undefined, to = 1) {
  const dir = toCardinal(direction ?? "bottom");
  const vertical = dir === "bottom" || dir === "top";
  const iw = vertical ? frame.w : frame.h * ratio;
  const ih = vertical ? frame.w / ratio : frame.h;
  const travel = Math.max(0, vertical ? ih - frame.h : iw - frame.w);
  const amount = travel * Math.max(0, Math.min(1, to));
  // bottom / right は端から始めて逆の端へ、top / left は逆の端から始める
  const reverse = dir === "top" || dir === "left";
  const start = reverse ? -travel : 0;
  const sign = reverse ? 1 : -1;
  return {
    vertical, travel,
    img: { x: vertical ? 0 : start, y: vertical ? start : 0, w: iw, h: ih },
    move: { dx: vertical ? 0 : sign * amount, dy: vertical ? sign * amount : 0 },
  };
}

type Rect = { x: number; y: number; w: number; h: number };

/**
 * PPTX 書き出しでのスクロールの置き方。
 * - picture: 画像全体の矩形（スライド座標。枠からはみ出す）
 * - move: 動かす量（スライドの幅・高さに対する比。animMotion の path に使う）
 * - bands: はみ出した部分を隠す帯（スライド内に入る部分だけ。このレイヤーより下のものを画像にして置く）
 * 回転している・はみ出していない（流せない）ときは null
 */
export function planScroll(
  l: { x: number; y: number; w: number; h: number; rotation?: number }, ratio: number, a: LayerAnimation, slide: { width: number; height: number },
): { picture: Rect; move: { x: number; y: number }; bands: Rect[] } | null {
  if (l.rotation || !(ratio > 0) || !(l.w > 0) || !(l.h > 0)) return null;
  const lay = scrollLayout(l, ratio, a.direction, a.scrollTo ?? 1);
  if (lay.travel < 1) return null;
  const picture = { x: l.x + lay.img.x, y: l.y + lay.img.y, w: lay.img.w, h: lay.img.h };
  const end = { x: picture.x + lay.move.dx, y: picture.y + lay.move.dy };
  const bands: Rect[] = [];
  if (lay.vertical) {
    const x0 = Math.max(0, l.x), x1 = Math.min(slide.width, l.x + l.w);
    const top = Math.max(0, Math.min(picture.y, end.y)), bottom = Math.min(slide.height, Math.max(picture.y, end.y) + picture.h);
    if (x1 - x0 >= 1 && l.y - top >= 1) bands.push({ x: x0, y: top, w: x1 - x0, h: l.y - top });
    if (x1 - x0 >= 1 && bottom - (l.y + l.h) >= 1) bands.push({ x: x0, y: l.y + l.h, w: x1 - x0, h: bottom - (l.y + l.h) });
  } else {
    const y0 = Math.max(0, l.y), y1 = Math.min(slide.height, l.y + l.h);
    const left = Math.max(0, Math.min(picture.x, end.x)), right = Math.min(slide.width, Math.max(picture.x, end.x) + picture.w);
    if (y1 - y0 >= 1 && l.x - left >= 1) bands.push({ x: left, y: y0, w: l.x - left, h: y1 - y0 });
    if (y1 - y0 >= 1 && right - (l.x + l.w) >= 1) bands.push({ x: l.x + l.w, y: y0, w: right - (l.x + l.w), h: y1 - y0 });
  }
  return { picture, move: { x: lay.move.dx / slide.width, y: lay.move.dy / slide.height }, bands };
}

// ---------- PowerPoint の <p:timing> ----------

/** 方向 → PowerPoint の presetSubtype（スライドイン・ワイプ共通。上 1・右 2・下 4・左 8 の足し算で、斜めは 3・6・12・9） */
const subtype = (d: AnimDirection) => {
  const { h, v } = dirParts(d);
  return (v < 0 ? 1 : 0) + (h > 0 ? 2 : 0) + (v > 0 ? 4 : 0) + (h < 0 ? 8 : 0);
};
/** scroll は移動のパス（presetClass="path"）で、ID は 0（ユーザー設定のパス） */
const PRESET: Record<AnimEffect, number> = { appear: 1, fly: 2, fade: 10, wipe: 22, float: 42, zoom: 53, scroll: 0 };
/** ワイプは「どちらへ広がるか」で書く（下から = 上へ広がる） */
const WIPE_FILTER: Record<CardinalDirection, string> = { bottom: "wipe(up)", top: "wipe(down)", left: "wipe(right)", right: "wipe(left)" };

type Ids = { next: () => number };
/** スクロールの動き（スライドの幅・高さに対する比） */
export type ScrollMove = { x: number; y: number };

function anim(ids: Ids, spid: number, dur: number, attr: string, from: string, to: string) {
  return `<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="${ids.next()}" dur="${dur}" fill="hold"/><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl><p:attrNameLst><p:attrName>${attr}</p:attrName></p:attrNameLst></p:cBhvr>`
    + `<p:tavLst><p:tav tm="0"><p:val><p:strVal val="${from}"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="${to}"/></p:val></p:tav></p:tavLst></p:anim>`;
}
const animEffect = (ids: Ids, spid: number, dur: number, filter: string) =>
  `<p:animEffect transition="in" filter="${filter}"><p:cBhvr><p:cTn id="${ids.next()}" dur="${dur}"/><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cBhvr></p:animEffect>`;

/** 効果の中身（表示に切り替える set ＋ 効果ごとの動き） */
function behaviors(ids: Ids, spid: number, a: LayerAnimation, motion?: ScrollMove): string {
  const dur = Math.max(1, Math.round(a.duration));
  const set = `<p:set><p:cBhvr><p:cTn id="${ids.next()}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>`;
  const dir = normalizeDirection(a.effect, a.direction) ?? "bottom";
  switch (a.effect) {
    case "appear": return set;
    case "fade": return set + animEffect(ids, spid, dur, "fade");
    case "fly": {
      const { h, v } = dirParts(dir);
      const x = h < 0 ? "0-#ppt_w/2" : h > 0 ? "1+#ppt_w/2" : "#ppt_x";
      const y = v < 0 ? "0-#ppt_h/2" : v > 0 ? "1+#ppt_h/2" : "#ppt_y";
      return set + anim(ids, spid, dur, "ppt_x", x, "#ppt_x") + anim(ids, spid, dur, "ppt_y", y, "#ppt_y");
    }
    case "wipe": return set + animEffect(ids, spid, dur, WIPE_FILTER[toCardinal(dir)]);
    case "scroll": {
      // 表示のまま、今の位置から path の終点へ動かす。値はスライドの幅・高さに対する比（rCtr は 1/100000）
      const m = motion ?? { x: 0, y: 0 };
      const f = (v: number) => String(Math.round(v * 1e5) / 1e5);
      return `<p:animMotion origin="layout" path="M 0 0 L ${f(m.x)} ${f(m.y)} E" pathEditMode="relative" rAng="0" ptsTypes="AA"><p:cBhvr><p:cTn id="${ids.next()}" dur="${dur}" fill="hold"/><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl><p:attrNameLst><p:attrName>ppt_x</p:attrName><p:attrName>ppt_y</p:attrName></p:attrNameLst></p:cBhvr><p:rCtr x="${Math.round(m.x * 5e4)}" y="${Math.round(m.y * 5e4)}"/></p:animMotion>`;
    }
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
 * textIds はテキストボックスとして書き出したレイヤー（bldP が要る）。scrolls はスクロールのレイヤー id → 動き（無いスクロールは書かない）
 */
export function buildTimingXml(groups: AnimGroup[], spids: Map<string, number>, textIds: Set<string> = new Set(), scrolls: Map<string, ScrollMove> = new Map()): string {
  let n = 2; // 1 = tmRoot, 2 = mainSeq
  const ids: Ids = { next: () => ++n };
  const used: { spid: number; grpId: number; text: boolean }[] = [];
  const pars = groups.map((g) => {
    const steps = g.steps.map((st) => {
      const items = st.items.flatMap((it) => {
        const spid = spids.get(it.id);
        if (spid == null || (it.anim.effect === "scroll" && !scrolls.has(it.id))) return [];
        used.push({ spid, grpId: 0, text: textIds.has(it.id) });
        const effId = ids.next();
        const scroll = it.anim.effect === "scroll";
        const sub = scroll ? 0 : isDirectional(it.anim.effect) ? subtype(normalizeDirection(it.anim.effect, it.anim.direction) ?? "bottom") : it.anim.effect === "zoom" ? 16 : 0;
        return [`<p:par><p:cTn id="${effId}" presetID="${PRESET[it.anim.effect]}" presetClass="${scroll ? "path" : "entr"}" presetSubtype="${sub}"${scroll ? ' accel="50000" decel="50000"' : ""} fill="hold" grpId="0" nodeType="${NODE_TYPE[it.anim.start]}">`
          + `<p:stCondLst><p:cond delay="${Math.round(it.offset)}"/></p:stCondLst><p:childTnLst>${behaviors(ids, spid, it.anim, scrolls.get(it.id))}</p:childTnLst>${it.anim.sound ? soundXml(ids, it.anim.sound) : ""}</p:cTn></p:par>`];
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

// ---------- 取り込み（buildTimingXml の逆） ----------

/** 取り込んだ 1 つの効果。spid は図形の id（cNvPr id）。order は再生順（1 から） */
export type TimingEffect = { spid: number; anim: LayerAnimation };

/** PowerPoint の入場効果（presetClass="entr"）→ このアプリの効果。書き出しの PRESET の逆に、よくある効果を近いものへ寄せる */
const PRESET_TO_EFFECT: Record<number, AnimEffect> = {
  1: "appear", 2: "fly", 7: "fly", 10: "fade", 12: "wipe", 22: "wipe", 42: "float", 53: "zoom",
  // ズーム系（ベーシックズーム・拡大して回転）
  23: "zoom", 31: "zoom",
};
const SUBTYPE_TO_DIR: [number, AnimDirection][] = [[4, "bottom"], [1, "top"], [8, "left"], [2, "right"]];
const START_OF: Record<string, LayerAnimation["start"]> = { clickEffect: "click", withEffect: "with", afterEffect: "after" };

const els = (el: Element): Element[] => Array.from(el.getElementsByTagNameNS("*", "*"));
const child = (el: Element, name: string) => Array.from(el.childNodes as unknown as Element[]).find((c) => c.nodeType === 1 && c.localName === name) ?? null;

/**
 * slide.xml の <p:timing> から、メインシーケンスの入場効果を再生順に読む。
 * - 退場・強調・軌跡と、クリックで始まる別系統（interactiveSeq）は読まない
 * - 知らないプリセットは appear 以外ならフェードに寄せる。同じ図形に複数あれば最初の 1 つだけ
 * - 効果音は読まない（スライドの .rels の WAV を取り込む仕組みが無いため）
 */
export function readTiming(timing: Element | null | undefined): TimingEffect[] {
  if (!timing) return [];
  const main = els(timing).find((e) => e.localName === "cTn" && e.getAttribute("nodeType") === "mainSeq");
  if (!main) return [];
  const out: TimingEffect[] = [];
  const seen = new Set<number>();
  for (const ctn of els(main)) {
    if (ctn.localName !== "cTn" || ctn.getAttribute("presetClass") !== "entr") continue;
    const start = START_OF[ctn.getAttribute("nodeType") ?? ""];
    const target = els(ctn).find((e) => e.localName === "spTgt");
    const spid = Number(target?.getAttribute("spid"));
    if (!start || !Number.isFinite(spid) || seen.has(spid)) continue;
    seen.add(spid);
    const preset = Number(ctn.getAttribute("presetID"));
    const effect = PRESET_TO_EFFECT[preset] ?? "fade";
    const sub = Number(ctn.getAttribute("presetSubtype")) || 0;
    // 効果の長さ = 中の動き（表示に切り替える set の 1ms は除く）のうち最も長いもの
    const durs = els(ctn).filter((e) => e.localName === "cTn" && e !== ctn).map((e) => Number(e.getAttribute("dur"))).filter((d) => d > 1 && Number.isFinite(d));
    const duration = Math.min(20000, durs.length ? Math.max(...durs) : 500);
    const cond = child(child(ctn, "stCondLst") ?? ctn, "cond");
    const delay = Math.min(60000, Math.max(0, Number(cond?.getAttribute("delay")) || 0));
    const dir = SUBTYPE_TO_DIR.find(([bit]) => sub & bit)?.[1] ?? "bottom";
    out.push({
      spid,
      anim: { effect, start, duration, delay, order: out.length + 1, ...(isDirectional(effect) ? { direction: dir } : {}) },
    });
  }
  return out;
}
