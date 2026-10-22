import { useEffect, useMemo, useRef, useState } from "react";
import type { Layer, LayerAnimation, PosterSpec, SlideBgm, SlideTransition, SoundRef } from "../schema";
import { BGM_FILE_MAX_BYTES, createBgmPlayer } from "../bgm";
import { LayerSchema } from "../schema";
import { CATALOG_BY_NAME } from "../components/catalog";
import { THEMES, resolveTheme } from "../themes";
import { FONT_BY_FAMILY, FONT_CATALOG, FONT_ROLE_LABELS, FONT_SCRIPT_LABELS, type FontScript } from "../fonts";
import { TYPE_LABEL } from "./LayersPanel";
import { CROP_MAX_SCALE, clampCrop, cropLimits, cropTarget, roundPhotoRadius, withCrop } from "../render/ImageBox";
import { Ico } from "./uiIcons";
import { withText } from "../textRuns";
import { ANIM_DIRECTIONS, ANIM_EFFECTS, ANIM_STARTS, defaultAnimation, isDirectional, soundKey } from "../animation";
import { decodeSound, playSound, SOUND_FILE_MAX_BYTES, SOUND_FILE_MAX_SEC, SOUND_FILE_TYPES, SOUNDS, type SoundId } from "../sounds";
import { api } from "./api";
import { defaultTransition, isTransDirectional, TRANS_EFFECTS } from "../transition";

type Align = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
type Arrange = "front" | "forward" | "backward" | "back";

interface Props {
  layer: Layer | null;
  /** 複数選択中の件数（2 以上のとき layer は null） */
  multiCount: number;
  spec: PosterSpec;
  onChange: (patch: Partial<Layer>, coalesce?: string) => void;
  onReplace: (layer: Layer) => void;
  onRegenerate: () => void;
  onPickImage: (files: FileList | null) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onAlign: (where: Align) => void;
  onArrange: (dir: Arrange) => void;
  busy: boolean;
  generating: boolean;
  /** 画像のトリミング（枠内での拡大・位置調整）モード中か */
  cropping: boolean;
  /** 選択中の画像本来の幅/高さ（読み込めていれば） */
  cropRatio?: number;
  onToggleCrop: () => void;
  /** PPTX エディターモードのときだけ: スライドで表示されるときの動き（複数選択ならまとめて編集） */
  animation?: AnimationProps;
  mod: string;
}

const ALIGN_BUTTONS: [Align, string, string][] = [
  ["left", "⇤", "左揃え"], ["hcenter", "↔", "左右中央"], ["right", "⇥", "右揃え"],
  ["top", "⤒", "上揃え"], ["vcenter", "↕", "上下中央"], ["bottom", "⤓", "下揃え"],
];
const TEXT_ALIGN_BUTTONS: [string | undefined, string][] = [[undefined, "既定"], ["left", "左"], ["center", "中央"], ["right", "右"]];

const ARRANGE_BUTTONS: [Arrange, string, string][] = [
  ["front", "最前面へ", "Shift+]"], ["forward", "前面へ", "]"], ["backward", "背面へ", "["], ["back", "最背面へ", "Shift+["],
];

function Num({ label, value, onChange, step = 1 }: { label: string; value: number | undefined; onChange: (v: number) => void; step?: number }) {
  return (
    <label className="num">
      <span>{label}</span>
      <input type="number" step={step} value={value ?? ""} onChange={(e) => e.target.value !== "" && onChange(Number(e.target.value))} />
    </label>
  );
}

/** 候補の中で最も近い値（render/export.ts の snap と同じ考え方） */
function nearestWeight(want: number, have: number[]): number {
  return have.reduce((best, w) => (Math.abs(w - want) < Math.abs(best - want) ? w : best), have[0]);
}

/** レイヤーの font（トークン or フォント名）から、このフォントで使える太さの一覧を返す。1 種類だけなら疑似太字を含む 2 択 */
function weightChoices(spec: PosterSpec, font: string): { options: number[]; single: boolean } {
  const family = resolveTheme(spec.theme, spec.themeOverride).fonts[font] ?? font;
  const have = FONT_BY_FAMILY.get(family)?.weights;
  if (!have) return { options: [100, 200, 300, 400, 500, 600, 700, 800, 900], single: false };
  if (have.length <= 1) return { options: [400, 700], single: true };
  return { options: have, single: false };
}

/** フォントを替えたとき、今の太さが無ければ近い太さに寄せる（変えなくてよければ undefined） */
function weightForFont(spec: PosterSpec, font: string, weight: number): number | undefined {
  const { options, single } = weightChoices(spec, font);
  if (single) return weight >= 600 ? 700 : 400;
  return options.includes(weight) ? undefined : nearestWeight(weight, options);
}

/**
 * 太さの数値入力。打った値は Enter かフォーカスを外したときに確定する（打ちかけの「7」「70」を反映しない）。
 * ▲▼・矢印キーはフォントが持つ次の太さへ進む（持っていない太さは見た目が変わらないため）
 */
function WeightInput({ spec, layer, onChange }: { spec: PosterSpec; layer: Extract<Layer, { type: "text" }>; onChange: (v: number) => void }) {
  const { options } = weightChoices(spec, layer.font);
  const [text, setText] = useState(String(layer.weight));
  useEffect(() => setText(String(layer.weight)), [layer.weight]);
  const commit = () => {
    const v = Number(text);
    if (text.trim() === "" || !Number.isFinite(v)) return setText(String(layer.weight));
    const w = Math.round(Math.min(1000, Math.max(1, v)));
    setText(String(w));
    if (w !== layer.weight) onChange(w);
  };
  const stepTo = (dir: 1 | -1) => {
    const next = dir > 0 ? options.find((w) => w > layer.weight) : [...options].reverse().find((w) => w < layer.weight);
    if (next !== undefined) onChange(next);
  };
  return (
    <label className="num">
      <span>太さ</span>
      <input
        type="number" min={1} max={1000} step={100} value={text}
        onChange={(e) => {
          const v = Number(e.target.value);
          // ▲▼のクリックは inputType が空で届く。打鍵・貼り付けは打っている途中とみなす
          const typed = !!(e.nativeEvent as InputEvent).inputType;
          if (!typed && e.target.value !== "" && v !== layer.weight) stepTo(v > layer.weight ? 1 : -1);
          else setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); stepTo(e.key === "ArrowUp" ? 1 : -1); }
          else if (e.key === "Enter") commit();
        }}
        onBlur={commit}
      />
    </label>
  );
}

/** "$primary" などのトークン or 色 or グラデーションJSON を編集する小さな入力 */
function PaintInput({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const tokens = [...Object.keys(THEMES.ocean.colors), ...Object.keys(THEMES.ocean.gradients)].map((k) => `$${k}`);
  const isStr = typeof value === "string";
  const [text, setText] = useState(isStr ? (value as string) : JSON.stringify(value));
  useEffect(() => setText(isStr ? (value as string) : JSON.stringify(value)), [value]);
  return (
    <div className="paint">
      <input
        list="paint-tokens"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const t = text.trim();
          if (t.startsWith("{")) { try { onChange(JSON.parse(t)); } catch { /* 無効 */ } }
          else onChange(t);
        }}
      />
      {isStr && !(value as string).startsWith("$") && (
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value as string) ? (value as string) : "#000000"} onChange={(e) => onChange(e.target.value)} />
      )}
      <datalist id="paint-tokens">{tokens.map((t) => <option key={t} value={t} />)}</datalist>
    </div>
  );
}

type AnimationProps = {
  /** 対象のレイヤー（背景は除いたもの） */
  layers: Layer[];
  /** 再生順（1 から。再生されないものは入っていない）と、このスライドの動きの数 */
  order: Map<string, number>;
  total: number;
  /** 対象ごとに新しい動きを決める（i は layers での位置） */
  onSet: (update: (prev: LayerAnimation | undefined, i: number) => LayerAnimation | undefined, coalesce?: string) => void;
  onMove: (dir: -1 | 1) => void;
  onPreview: () => void;
};

/** 全部同じならその値、ばらばらなら undefined */
const common = <T,>(xs: T[]): T | undefined => (xs.length && xs.every((x) => x === xs[0]) ? xs[0] : undefined);

function AnimationBox({ layers, order, total, onSet, onMove, onPreview }: AnimationProps) {
  const multi = layers.length > 1;
  const anims = layers.map((l) => l.animation).filter((a) => !!a);
  const effect = anims.length === layers.length ? common(anims.map((a) => a.effect)) : anims.length ? undefined : "";
  const start = common(anims.map((a) => a.start));
  const dirAnims = anims.filter((a) => isDirectional(a.effect));
  const direction = common(dirAnims.map((a) => a.direction ?? "bottom"));
  // 同じ音かはファイルなら保存先で比べる
  const soundKeys = common(anims.map((a) => (a.sound ? soundKey(a.sound) : "")));
  const sound = soundKeys === undefined ? undefined : anims[0]?.sound ?? "";
  const key = layers.map((l) => l.id).join(",");
  // 動きが付いているものだけに当てる（付いていない要素は効果を選んだときに付く）
  const patch = (p: Partial<LayerAnimation>, co?: string) => onSet((a) => a && { ...a, ...p }, co);
  const nums = layers.flatMap((l) => (order.has(l.id) ? [order.get(l.id)!] : [])).sort((a, b) => a - b);
  const label = !nums.length ? null
    : nums.length === 1 ? `${nums[0]} / ${total} 番目`
    : nums.at(-1)! - nums[0] === nums.length - 1 ? `${nums[0]}〜${nums.at(-1)} / ${total} 番目`
    : `${nums.join("・")} / ${total} 番目`;
  return (
    <div className="field anim-box">
      <span>{multi ? `アニメーション（${layers.length} 件まとめて）` : "アニメーション"}{label && <em>{label}</em>}</span>
      <div className="row">
        <select
          value={effect ?? "mixed"} aria-label="効果"
          onChange={(e) => {
            const v = e.target.value as LayerAnimation["effect"] | "" | "mixed";
            if (v === "mixed") return;
            if (!v) return onSet(() => undefined);
            // まだ動きの無い要素に付けるときは、最初の 1 つをクリック時・残りを同時にして一緒に動かす
            const fresh = layers.filter((l) => !l.animation).map((l) => l.id);
            onSet((a, i) => {
              const next = a ? { ...a, effect: v } : { ...defaultAnimation(v), start: fresh.indexOf(layers[i].id) > 0 ? "with" as const : "click" as const };
              // 向きのある効果に変えたら向きを補い、無い効果では外す
              return isDirectional(v) ? { ...next, direction: next.direction ?? "bottom" } : { ...next, direction: undefined };
            });
          }}
        >
          {effect === undefined && <option value="mixed" disabled>{anims.length < layers.length ? "一部だけ付いている" : "混在"}</option>}
          <option value="">なし</option>
          {ANIM_EFFECTS.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
        </select>
        {anims.length > 0 && (
          <select value={start ?? "mixed"} aria-label="開始" title="いつ動き始めるか" onChange={(e) => e.target.value !== "mixed" && patch({ start: e.target.value as LayerAnimation["start"] })}>
            {start === undefined && <option value="mixed" disabled>混在</option>}
            {ANIM_STARTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        )}
      </div>
      {dirAnims.length > 0 && (
        <div className="seg">
          {ANIM_DIRECTIONS.map((d) => (
            <button
              key={d.value} className={direction === d.value ? "on" : ""} aria-pressed={direction === d.value}
              onClick={() => onSet((a) => a && (isDirectional(a.effect) ? { ...a, direction: d.value } : a))}
            >{d.label}</button>
          ))}
        </div>
      )}
      {anims.length > 0 && (
        <>
          <div className="grid4">
            <Num label="長さ 秒" step={0.1} value={common(anims.map((a) => a.duration / 1000))} onChange={(v) => patch({ duration: Math.round(Math.max(0, Math.min(20, v)) * 1000) }, `ad-${key}`)} />
            <Num label="遅延 秒" step={0.1} value={common(anims.map((a) => a.delay / 1000))} onChange={(v) => patch({ delay: Math.round(Math.max(0, Math.min(60, v)) * 1000) }, `ay-${key}`)} />
          </div>
          <SoundPicker value={sound} onChange={(v) => patch({ sound: v })} title="動き始めと同時に鳴らす音（スライドショーと PowerPoint でも鳴ります）" />
          {multi && <p className="hint">「同時」なら一緒に、「直前の動作の後」なら再生順に 1 つずつ動きます。</p>}
          <div className="row">
            <button className="small" onClick={onPreview} title={multi ? "選んだ要素の動きをキャンバスで再生" : "この動きをキャンバスで再生"}><Ico name="play" size={14} /> 再生</button>
            <span className="spacer" />
            <span className="hint">順番</span>
            <button className="small" disabled={!nums.length || nums[0] <= 1} onClick={() => onMove(-1)} title="先に動かす" aria-label="順番を前へ"><Ico name="chevronUp" size={14} /></button>
            <button className="small" disabled={!nums.length || nums.at(-1)! >= total} onClick={() => onMove(1)} title="後に動かす" aria-label="順番を後ろへ"><Ico name="chevronDown" size={14} /></button>
          </div>
        </>
      )}
    </div>
  );
}

/** 音声ファイルを確かめて（読めるか・大きさ）サーバーに取り込む */
async function importSoundFile(f: File): Promise<SoundRef> {
  if (!SOUND_FILE_TYPES.test(f.type)) throw new Error("MP3 / WAV / M4A / OGG の音声ファイルを選んでください");
  if (f.size > SOUND_FILE_MAX_BYTES) throw new Error("音声ファイルが大きすぎます（5MB まで）");
  const { seconds } = await decodeSound(await f.arrayBuffer()).catch(() => { throw new Error("この音声ファイルは読み込めませんでした"); });
  const { src } = await api.uploadBlob(f, f.type);
  const name = f.name.replace(/\.[^.]+$/, "").slice(0, 40) || "音声";
  return seconds > SOUND_FILE_MAX_SEC ? { src, name: `${name}（最初の ${SOUND_FILE_MAX_SEC} 秒）` } : { src, name };
}

/** 効果音の選択（なし・内蔵音・手持ちの音声ファイル）と試聴ボタン */
function SoundPicker({ value, onChange, title }: { value: SoundRef | "" | undefined; onChange: (v: SoundRef | undefined) => void; title: string }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const file = value && typeof value !== "string" ? value : null;
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    setLoading(true);
    try {
      const s = await importSoundFile(f);
      onChange(s);
      playSound(s);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      <div className="row">
        <select
          value={value === undefined ? "mixed" : typeof value === "string" ? value : "file"} aria-label="効果音" title={title} disabled={loading}
          onChange={(e) => {
            const v = e.target.value as SoundId | "" | "mixed" | "file" | "pick";
            if (v === "mixed" || v === "file") return;
            if (v === "pick") return fileRef.current?.click();
            setErr(null);
            onChange(v || undefined);
            if (v) playSound(v);
          }}
        >
          {value === undefined && <option value="mixed" disabled>効果音: 混在</option>}
          <option value="">効果音なし</option>
          {SOUNDS.map((s) => <option key={s.value} value={s.value}>効果音: {s.label}</option>)}
          {file && <option value="file">ファイル: {file.name}</option>}
          <option value="pick">{loading ? "読み込み中…" : "ファイルから選ぶ…"}</option>
        </select>
        <button className="small" disabled={!value} onClick={() => value && playSound(value)} title="効果音だけを鳴らす" aria-label="効果音を試聴"><Ico name="play" size={14} /></button>
        <input
          ref={fileRef} type="file" accept="audio/*" hidden
          onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }}
        />
      </div>
      {err && <p className="err-text">{err}</p>}
    </>
  );
}

/** BGM にする音声ファイルを確かめて（形式・大きさ・読めるか）サーバーに取り込む */
async function importBgmFile(f: File): Promise<Pick<SlideBgm, "src" | "name">> {
  if (!SOUND_FILE_TYPES.test(f.type)) throw new Error("MP3 / WAV / M4A / OGG の音声ファイルを選んでください");
  if (f.size > BGM_FILE_MAX_BYTES) throw new Error("音声ファイルが大きすぎます（15MB まで）");
  const url = URL.createObjectURL(f);
  try {
    await new Promise<void>((ok, ng) => {
      const a = new Audio();
      a.preload = "metadata";
      a.onloadedmetadata = () => ok();
      a.onerror = () => ng(new Error("この音声ファイルは読み込めませんでした"));
      a.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
  const { src } = await api.uploadBlob(f, f.type);
  return { src, name: f.name.replace(/\.[^.]+$/, "").slice(0, 40) || "BGM" };
}

/** スライドの BGM の一覧（並べた順に流す）。曲ごとに流し始め・繰り返し・次のスライドでも流すかを選び、試聴できる */
function BgmPicker({ bgm: list, onChange }: { bgm: SlideBgm[]; onChange: (b: SlideBgm[]) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  /** ファイルを選んだら差し替える曲の番号（null なら末尾に足す） */
  const replacing = useRef<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const player = useMemo(createBgmPlayer, []);
  /** 試聴している曲の番号 */
  const [trying, setTrying] = useState<number | null>(null);
  const stopTry = () => { player.stop(); setTrying(null); };
  // パネルを閉じる・スライドを替えたら試聴を止める
  useEffect(() => () => player.stop(), [player]);
  const patch = (i: number, b: Partial<SlideBgm>) => onChange(list.map((x, k) => (k === i ? { ...x, ...b } : x)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...list];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    stopTry();
    onChange(next);
  };
  const choose = (i: number | null) => { replacing.current = i; fileRef.current?.click(); };
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    setLoading(true);
    try {
      const file = await importBgmFile(f);
      stopTry();
      const i = replacing.current;
      onChange(i === null ? [...list, { start: "click", loop: true, across: false, ...file }] : list.map((x, k) => (k === i ? { ...x, ...file } : x)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="field anim-box">
      <span>BGM{list.length > 1 ? `（${list.length} 曲を上から順に流す）` : ""}</span>
      {list.map((b, i) => (
        <div key={i} className="bgm-item">
          <div className="row">
            <span className="bgm-name" title={b.name}>{i + 1}. {b.name}</span>
            <button className="small" onClick={() => (trying === i ? stopTry() : (player.play({ ...b, loop: false }, () => setTrying(null)), setTrying(i)))} title={trying === i ? "試聴を止める" : "この曲を試聴"} aria-label={trying === i ? "試聴を止める" : "BGM を試聴"}>
              <Ico name={trying === i ? "x" : "play"} size={14} />
            </button>
            {list.length > 1 && (
              <>
                <button className="small" disabled={i === 0} onClick={() => move(i, -1)} title="先に流す" aria-label="順番を前へ"><Ico name="chevronUp" size={14} /></button>
                <button className="small" disabled={i === list.length - 1} onClick={() => move(i, 1)} title="後に流す" aria-label="順番を後ろへ"><Ico name="chevronDown" size={14} /></button>
              </>
            )}
          </div>
          <select value={b.start} aria-label="BGM を流し始めるとき" onChange={(e) => patch(i, { start: e.target.value as SlideBgm["start"] })}>
            <option value="click">クリック時（次へで流す）</option>
            <option value="auto">{i === 0 ? "スライドに入ったら" : "前の曲が終わったら"}</option>
          </select>
          <label className="check"><input type="checkbox" checked={b.loop} onChange={(e) => patch(i, { loop: e.target.checked })} /> 繰り返す</label>
          <label className="check"><input type="checkbox" checked={b.across} onChange={(e) => patch(i, { across: e.target.checked })} /> 次のスライドに進んでも流し続ける</label>
          <div className="row">
            <button className="small" disabled={loading} onClick={() => choose(i)} title="この曲のファイルを替える">ファイルを替える…</button>
            <span className="spacer" />
            <button className="small" onClick={() => { stopTry(); onChange(list.filter((_, k) => k !== i)); }} title="この曲を外す">外す</button>
          </div>
        </div>
      ))}
      <div className="row">
        <button className="small" disabled={loading} onClick={() => choose(null)} title="MP3 / WAV / M4A / OGG（15MB まで）">
          {loading ? "読み込み中…" : list.length ? "＋ BGM を追加…" : "ファイルから選ぶ…"}
        </button>
        <input ref={fileRef} type="file" accept="audio/*" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
      {err && <p className="err-text">{err}</p>}
      <p className="hint">スライドショーで流れます。「クリック時」の曲は次へで 1 曲ずつ切り替わり、流し終えてから次のスライドへ進みます（PowerPoint には書き出しません）。</p>
    </div>
  );
}

/**
 * スライドの画面切り替えと BGM（要素を選んでいないときに出す）。画面切り替えは前のスライドからこのスライドに替わるときの動き
 */
export function TransitionBox({ transition: t, bgm, slideCount, onChange, onBgmChange, onPreview, onApplyAll }: {
  transition: SlideTransition | undefined;
  bgm: SlideBgm[];
  slideCount: number;
  onChange: (t: SlideTransition | undefined, coalesce?: string) => void;
  onBgmChange: (b: SlideBgm[]) => void;
  onPreview: () => void;
  onApplyAll: () => void;
}) {
  return (
    <div className="panel inspector">
      <h3>スライド</h3>
      <div className="field anim-box">
        <span>画面切り替え</span>
        <select
          value={t?.effect ?? ""} aria-label="画面切り替えの効果" title="前のスライドからこのスライドに替わるときの動き"
          onChange={(e) => {
            const v = e.target.value as SlideTransition["effect"] | "";
            if (!v) return onChange(undefined);
            const next = t ? { ...t, effect: v } : defaultTransition(v);
            onChange(isTransDirectional(v) ? { ...next, direction: next.direction ?? "right" } : { ...next, direction: undefined });
          }}
        >
          <option value="">なし</option>
          {TRANS_EFFECTS.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
        </select>
        {t && isTransDirectional(t.effect) && (
          <div className="seg">
            {ANIM_DIRECTIONS.map((d) => (
              <button key={d.value} className={(t.direction ?? "right") === d.value ? "on" : ""} aria-pressed={(t.direction ?? "right") === d.value} onClick={() => onChange({ ...t, direction: d.value })}>{d.label}</button>
            ))}
          </div>
        )}
        {t && (
          <>
            <div className="grid4">
              <Num label="長さ 秒" step={0.1} value={t.duration / 1000} onChange={(v) => onChange({ ...t, duration: Math.round(Math.max(0, Math.min(10, v)) * 1000) }, "trans-dur")} />
            </div>
            <SoundPicker value={t.sound ?? ""} onChange={(sound) => onChange({ ...t, sound })} title="切り替えと同時に鳴らす音（スライドショーと PowerPoint でも鳴ります）" />
            <div className="row">
              <button className="small" onClick={onPreview} title="この切り替えをキャンバスで再生"><Ico name="play" size={14} /> 再生</button>
              <span className="spacer" />
              {slideCount > 1 && <button className="small" onClick={onApplyAll} title="同じ画面切り替えを、ほかのスライドにも付ける">すべてのスライドに適用</button>}
            </div>
          </>
        )}
        <p className="hint">スライドショーで次へ進んだときと、書き出した PowerPoint で動きます。要素の動きは、要素を選ぶと付けられます。</p>
      </div>
      <BgmPicker bgm={bgm} onChange={onBgmChange} />
    </div>
  );
}

export function Inspector({ layer, multiCount, spec, onChange, onReplace, onRegenerate, onPickImage, onDuplicate, onDelete, onAlign, onArrange, busy, generating, cropping, cropRatio, onToggleCrop, animation, mod }: Props) {
  const [json, setJson] = useState("");
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  useEffect(() => { setJson(layer ? JSON.stringify(layer, null, 2) : ""); setJsonErr(null); }, [layer]);

  if (multiCount > 1) {
    return (
      <div className="panel inspector">
        <h3>インスペクター</h3>
        <div className="empty">
          <p><strong>{multiCount} 件</strong>を選択中です。ドラッグや矢印キーでまとめて移動できます。</p>
          <p className="hint">1 つだけ編集するときは、その要素をクリックしてください。</p>
        </div>
        <div className="row">
          <button onClick={onDuplicate}>複製 <kbd>{mod}+D</kbd></button>
          <button className="danger" onClick={onDelete}>削除 <kbd>Delete</kbd></button>
        </div>
        {animation && animation.layers.length > 0 && <AnimationBox {...animation} />}
      </div>
    );
  }

  if (!layer) return null;

  const asset = layer.type === "image" ? layer.asset : layer.type === "component" ? (layer.props as any)?.asset : undefined;
  const src = layer.type === "image" ? layer.src : layer.type === "component" ? (layer.props as any)?.src : undefined;
  // 画像ファイルで差し替えられるか（image レイヤー / 写真・モックの画面）
  const hasImageSlot = layer.type === "image" || (layer.type === "component" && !!layer.props && ("asset" in layer.props || "src" in layer.props));
  // 枠内トリミングできる画像（ロック中も数値では調整できる）
  const crop = cropTarget({ ...layer, locked: false } as Layer);
  const setProp = (k: string, v: unknown, co?: string) => layer.type === "component" && onChange({ props: { ...layer.props, [k]: v } } as any, co);

  return (
    <div className="panel inspector">
      <div className="insp-head">
        <h3>{layer.type === "component" ? CATALOG_BY_NAME[layer.component]?.label ?? layer.component : TYPE_LABEL[layer.type]}</h3>
        <button
          className={"small" + (layer.locked ? " on" : "")}
          aria-pressed={!!layer.locked}
          title={layer.locked ? "ロック中：キャンバスで動かせません" : "キャンバスで誤って動かさないようにロック"}
          onClick={() => onChange({ locked: !layer.locked })}
        ><Ico name={layer.locked ? "lock" : "unlock"} size={14} /> {layer.locked ? "ロック中" : "ロック"}</button>
      </div>
      <label className="field">
        <span>レイヤー名</span>
        <input value={layer.name ?? ""} onChange={(e) => onChange({ name: e.target.value }, `name-${layer.id}`)} />
      </label>
      {layer.type !== "background" && (
        <div className="grid4">
          <Num label="X" value={layer.x} onChange={(v) => onChange({ x: v }, `x-${layer.id}`)} />
          <Num label="Y" value={layer.y} onChange={(v) => onChange({ y: v }, `y-${layer.id}`)} />
          <Num label="W" value={layer.w} onChange={(v) => onChange({ w: v }, `w-${layer.id}`)} />
          <Num label="H" value={layer.h} onChange={(v) => onChange({ h: v }, `h-${layer.id}`)} />
          <Num label="回転" value={layer.rotation ?? 0} onChange={(v) => onChange({ rotation: v }, `r-${layer.id}`)} />
        </div>
      )}
      <label className="field">
        <span>不透明度 <em>{Math.round((layer.opacity ?? 1) * 100)}%</em></span>
        <input type="range" min={0} max={1} step={0.01} value={layer.opacity ?? 1} onChange={(e) => onChange({ opacity: Number(e.target.value) }, `o-${layer.id}`)} />
      </label>
      {layer.type !== "background" && (
        <>
          <div className="field">
            <span>ポスターに揃える</span>
            <div className="seg icons">
              {ALIGN_BUTTONS.map(([k, icon, label]) => (
                <button key={k} title={label} aria-label={label} disabled={layer.locked} onClick={() => onAlign(k)}>{icon}</button>
              ))}
            </div>
          </div>
          <div className="field">
            <span>重ね順</span>
            <div className="seg">
              {ARRANGE_BUTTONS.map(([k, label, key]) => (
                <button key={k} title={`${label}（${mod}+${key}）`} onClick={() => onArrange(k)}>{label}</button>
              ))}
            </div>
          </div>
        </>
      )}

      {layer.type === "text" && (
        <>
          <label className="field">
            <span>テキスト</span>
            <textarea rows={3} value={layer.text} onChange={(e) => onChange(withText(layer, e.target.value) as any, `t-${layer.id}`)} />
          </label>
          <div className="grid4">
            <Num label="サイズ" value={layer.size} onChange={(v) => onChange({ size: v } as any, `s-${layer.id}`)} />
            <WeightInput spec={spec} layer={layer} onChange={(v) => onChange({ weight: v } as any, `wt-${layer.id}`)} />
            <Num label="行間" step={0.05} value={layer.lineHeight} onChange={(v) => onChange({ lineHeight: v } as any, `lh-${layer.id}`)} />
            <Num label="字間em" step={0.01} value={layer.letterSpacing ?? 0} onChange={(v) => onChange({ letterSpacing: v } as any, `ls-${layer.id}`)} />
          </div>
          {(() => {
            const { options, single } = weightChoices(spec, layer.font);
            if (single) return <p className="hint small">このフォントは太さが 1 種類だけです（600 以上は疑似太字）。もっと細く/太くするにはフォントを変えてください</p>;
            if (!options.includes(layer.weight)) return <p className="hint small">このフォントに {layer.weight} は無いため {nearestWeight(layer.weight, options)} で表示されます（使える太さ: {options.join(" / ")}）</p>;
            return null;
          })()}
          <div className="row">
            <select value={layer.font} onChange={(e) => {
              const weight = weightForFont(spec, e.target.value, layer.weight);
              onChange((weight === undefined ? { font: e.target.value } : { font: e.target.value, weight }) as any);
            }}>
              <option value="display">display（見出し）</option>
              <option value="body">body（本文）</option>
              <option value="hand">hand（手書き）</option>
              <option value="heavy">heavy（極太）</option>
              {!["display", "body", "hand", "heavy"].includes(layer.font) && !FONT_BY_FAMILY.has(layer.font) && <option value={layer.font}>{layer.font}</option>}
              {(Object.keys(FONT_SCRIPT_LABELS) as FontScript[]).map((sc) => (
                <optgroup key={sc} label={FONT_SCRIPT_LABELS[sc]}>
                  {FONT_CATALOG.filter((f) => f.script === sc).map((f) => <option key={f.id} value={f.family}>{f.family}（{FONT_ROLE_LABELS[f.role]}）</option>)}
                </optgroup>
              ))}
            </select>
            <select value={layer.align} onChange={(e) => onChange({ align: e.target.value } as any)}>
              <option value="left">左揃え</option>
              <option value="center">中央</option>
              <option value="right">右揃え</option>
            </select>
            <select value={layer.fit ?? "none"} onChange={(e) => onChange({ fit: e.target.value } as any)}>
              <option value="none">はみ出し可</option>
              <option value="shrink">枠に縮小</option>
            </select>
          </div>
          <label className="field"><span>塗り</span><PaintInput value={layer.fill} onChange={(v) => onChange({ fill: v } as any)} /></label>
          {!!layer.colorRuns?.length && (
            <div className="row">
              <span className="hint">一部の文字に別の色（{layer.colorRuns.length} か所）</span>
              <button onClick={() => onChange({ colorRuns: undefined } as any)}>部分色を外す</button>
            </div>
          )}
        </>
      )}

      {(layer.type === "shape" || layer.type === "background") && (
        <label className="field"><span>塗り</span><PaintInput value={layer.fill} onChange={(v) => onChange({ fill: v } as any)} /></label>
      )}

      {layer.type === "component" && typeof (layer.props as any)?.text === "string" && (
        <label className="field">
          <span>テキスト</span>
          <textarea rows={3} value={(layer.props as any).text} onChange={(e) => setProp("text", e.target.value, `pt-${layer.id}`)} />
        </label>
      )}
      {layer.type === "component" && typeof (layer.props as any)?.url === "string" && (
        <label className="field"><span>QR の URL</span><input value={(layer.props as any).url} onChange={(e) => setProp("url", e.target.value, `pu-${layer.id}`)} /></label>
      )}
      {layer.type === "component" && typeof (layer.props as any)?.label === "string" && (
        <label className="field"><span>見出し</span><input value={(layer.props as any).label} onChange={(e) => setProp("label", e.target.value, `pl-${layer.id}`)} /></label>
      )}

      {layer.type === "component" && CATALOG_BY_NAME[layer.component]?.textSlots?.map(({ prefix, label }) => {
        const props = layer.props as Record<string, any>;
        const dx = props[`${prefix}Dx`], dy = props[`${prefix}Dy`], align = props[`${prefix}Align`];
        const moved = !!dx || !!dy || align !== undefined;
        return (
          <div className="field" key={prefix}>
            <span>{label}の位置</span>
            <div className="grid4">
              <Num label="横ずらし" value={dx ?? 0} onChange={(v) => setProp(`${prefix}Dx`, v, `${prefix}dx-${layer.id}`)} />
              <Num label="縦ずらし" value={dy ?? 0} onChange={(v) => setProp(`${prefix}Dy`, v, `${prefix}dy-${layer.id}`)} />
            </div>
            <div className="row">
              <div className="seg">
                {TEXT_ALIGN_BUTTONS.map(([v, l]) => (
                  <button key={l} className={align === v ? "on" : ""} aria-pressed={align === v} onClick={() => setProp(`${prefix}Align`, v)}>{l}</button>
                ))}
              </div>
              <span className="spacer" />
              <button
                className="small"
                disabled={!moved}
                title="ずらし量と揃えを既定に戻す"
                onClick={() => {
                  const next = { ...props };
                  delete next[`${prefix}Dx`]; delete next[`${prefix}Dy`]; delete next[`${prefix}Align`];
                  onChange({ props: next } as any);
                }}
              >リセット</button>
            </div>
          </div>
        );
      })}

      {layer.type === "component" && layer.component === "roundPhoto" && (() => {
        const k = Math.round(roundPhotoRadius(layer.props, 1, 1) * 100);
        return (
          <div className="field">
            <span>角の丸み</span>
            <div className="row">
              <input type="range" min={0} max={50} step={1} value={k} aria-label="角の丸み" onChange={(e) => setProp("radius", Number(e.target.value) / 100, `radius-${layer.id}`)} />
              <span className="hint">{k}%</span>
            </div>
          </div>
        );
      })()}

      {layer.type === "component" && (layer.component === "circlePhoto" || layer.component === "roundPhoto") && (() => {
        const props = layer.props as Record<string, any>;
        const rw = Number(props.ringWidth) || 0;
        return (
          <div className="field">
            <span>縁取り</span>
            <div className="row">
              <Num label="太さ" value={rw} onChange={(v) => setProp("ringWidth", Math.max(0, v), `rw-${layer.id}`)} />
              {rw > 0 && <PaintInput value={props.ring ?? "$primary"} onChange={(v) => setProp("ring", v)} />}
            </div>
          </div>
        );
      })()}

      {crop && (() => {
        const c = crop.crop ?? { scale: 1, x: 0, y: 0 };
        const setCrop = (next: typeof c | undefined, co?: string) => {
          const n = withCrop(layer, next && clampCrop(next, layer.w, layer.h, cropRatio ?? next.ratio));
          onChange((n.type === "component" ? { props: n.props } : { crop: (n as any).crop }) as any, co);
        };
        return (
          <div className="field">
            <span>枠内の画像（トリミング）</span>
            <div className="row">
              {layer.type === "image" && (
                <select value={layer.fit ?? "contain"} onChange={(e) => onChange({ fit: e.target.value } as any)} title="枠への収め方">
                  <option value="cover">枠いっぱい</option>
                  <option value="contain">全体を表示</option>
                </select>
              )}
              <input
                type="range" min={1} max={CROP_MAX_SCALE} step={0.01} value={c.scale} aria-label="拡大率"
                onChange={(e) => { const scale = Number(e.target.value), r = scale / c.scale; setCrop({ scale, x: c.x * r, y: c.y * r }, `crop-zoom-${layer.id}`); }}
              />
              <span className="hint">{Math.round(c.scale * 100)}%</span>
            </div>
            {(() => {
              const lim = cropLimits(layer.w, layer.h, c.scale, cropRatio ?? c.ratio);
              // スライダーは枠の幅・高さに対する割合。動かせる範囲が無い向きは無効
              const axis = (k: "x" | "y", label: string) => (
                <label className="row" key={k}>
                  <span className="hint">{label}</span>
                  <input
                    type="range" min={-lim[k]} max={lim[k]} step={0.001} value={Math.max(-lim[k], Math.min(lim[k], c[k]))} disabled={!lim[k]} aria-label={`${label}の位置`}
                    title={lim[k] ? undefined : "この向きにははみ出しが無いので動かせません（拡大すると動かせます）"}
                    onChange={(e) => setCrop({ ...c, [k]: Number(e.target.value) }, `crop-${k}-${layer.id}`)}
                  />
                </label>
              );
              return <>{axis("x", "左右")}{axis("y", "上下")}</>;
            })()}
            <div className="row">
              <button className={"small" + (cropping ? " primary" : "")} aria-pressed={cropping} onClick={onToggleCrop}
                title="キャンバス上でドラッグして位置、ホイールで拡大（画像のダブルクリックでも開始）">
                <Ico name={cropping ? "check" : "crop"} size={14} /> {cropping ? "調整を終える" : "キャンバスで調整"}
              </button>
              <span className="spacer" />
              <button className="small" disabled={!crop.crop} onClick={() => setCrop(undefined)}>リセット</button>
            </div>
          </div>
        );
      })()}

      {asset && (
        <div className="asset-box">
          <label className="field">
            <span>画像生成プロンプト</span>
            <textarea
              rows={4}
              placeholder="どんな画像？（例: 夕焼けの沖縄の海、水彩風）"
              value={asset.prompt}
              onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && asset.prompt?.trim() && !busy && !generating) { e.preventDefault(); onRegenerate(); } }}
              onChange={(e) => {
                const next = { ...asset, prompt: e.target.value };
                if (layer.type === "image") onChange({ asset: next } as any, `ap-${layer.id}`);
                else setProp("asset", next, `ap-${layer.id}`);
              }}
            />
          </label>
          <div className="row">
            <span className="hint">{generating ? "⏳ 生成中…" : src ? "✅ 生成済み" : "未生成"}</span>
            <span className="spacer" />
            <button className={src ? "" : "primary"} disabled={busy || generating || !asset.prompt?.trim()} title={asset.prompt?.trim() ? `${mod}+Enter` : "先にプロンプトを入力してください"} onClick={onRegenerate}>{src ? "再生成" : "画像を生成"}</button>
          </div>
        </div>
      )}

      {hasImageSlot && (
        <div className="row">
          <span className="hint">{!asset && (src ? "画像ファイル" : "画像未設定")}</span>
          <span className="spacer" />
          <label className={"as-button small" + (busy || generating ? " disabled" : "")} title="手持ちの画像ファイルに差し替え（キャンバスの画像へドロップでも可）">
            <Ico name="folder" size={14} /> {src ? "ファイルで差し替え" : "ファイルを選ぶ"}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden disabled={busy || generating} onChange={(e) => { onPickImage(e.target.files); e.target.value = ""; }} />
          </label>
        </div>
      )}

      {animation && animation.layers.length > 0 && <AnimationBox {...animation} />}

      <details className="json-edit">
        <summary>JSON で編集</summary>
        <textarea rows={14} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
        {jsonErr && <p className="err-text">{jsonErr}</p>}
        <button
          onClick={() => {
            try { onReplace(LayerSchema.parse(JSON.parse(json))); setJsonErr(null); }
            catch (e: any) { setJsonErr(e?.message?.slice(0, 300) ?? "JSON が不正です"); }
          }}
        >適用</button>
      </details>

      <div className="row end">
        <button onClick={onDuplicate} title={`${mod}+D`}>複製</button>
        <button className="danger" onClick={onDelete} title="Delete">削除</button>
      </div>
    </div>
  );
}

/** キャンバス操作・ショートカットの一覧（上部バーの「?」メニューに表示） */
export function ShortcutList({ mod }: { mod: string }) {
  const keys: [string, string][] = [
    ["ドラッグ", `移動（${mod} で吸着なし）`],
    ["Alt+ドラッグ", "表示位置を移動（「全体」で戻す）"],
    ["空白をドラッグ", "範囲選択（Shift で追加）"],
    ["Shift+クリック", "複数選択に追加 / 解除"],
    [`${mod}+A`, "すべて選択"],
    ["ハンドル", "リサイズ（Shift で比率固定）"],
    ["上の丸", "回転（Shift で 15° 刻み）"],
    ["画像をダブルクリック", "枠内で拡大・位置調整"],
    ["テキストをダブルクリック / Enter", "キャンバス上で文字を直接編集（Esc で終了）"],
    ["矢印", "1px 移動（Shift で 10px）"],
    ["矢印（未選択時） / PageUp・PageDown", "前 / 次のスライドへ"],
    ["F5 / Shift+F5", "最初から / 今のスライドから投影（クリック・→ で進む、Esc で終了）"],
    ["Alt+F5", "今のスライドから、発表者ビュー（台本・次のスライド・経過時間）付きで投影"],
    [`${mod}+C / V`, "コピー / 貼り付け"],
    [`${mod}+D`, "複製"],
    [`${mod}+] / [`, "前面へ / 背面へ"],
    ["Delete", "削除"],
    [`${mod}+Z`, "元に戻す"],
    [`${mod}+ホイール`, "ズーム（" + mod + "+0 で全体）"],
  ];
  return (
    <dl className="shortcuts">
      {keys.map(([k, v]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}
    </dl>
  );
}
