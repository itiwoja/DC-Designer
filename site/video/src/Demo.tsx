import { AbsoluteFill, Audio, Img, interpolate, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Camera, Note, PopText, prog, Ring, Shape, Stage, type Rect } from "./parts";
import { C, FONT_BODY, FONT_DISPLAY } from "./theme";
import VO_SECONDS from "../public/vo/durations.json";

// アプリの画面のスクショは 1600x1000 の画面を 3 倍（入力は 4 倍）で撮ったもの。配置はすべて 2 倍の大きさ（3200x2000）の座標で書く
const APP = { w: 3200, h: 2000 };
const FULL: Rect = { x: 0, y: 0, w: 3200, h: 2000 };
// アプリ画面を置く窓（字幕の下）
const WIN: Rect = { x: 120, y: 150, w: 1040, h: 528 };

/** 場面の切り替え：最初の数フレームで浮かび上がる */
function Fade({ children, len }: { children: React.ReactNode; len: number }) {
  const f = useCurrentFrame();
  const o = interpolate(f, [0, 8, len - 6, len], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
}

function Caption({ text, sub }: { text: string; sub?: string }) {
  return (
    <div style={{ position: "absolute", left: WIN.x, top: 36, display: "flex", alignItems: "baseline", gap: 24 }}>
      <PopText text={text} start={2} size={56} stagger={1} />
      {sub && (
        <div style={{ fontFamily: FONT_BODY, fontWeight: 700, fontSize: 24, color: C.yellow, opacity: 0.95 }}>{sub}</div>
      )}
    </div>
  );
}

/** 効果音：場面の中のフレーム at から鳴らす（1 つの瞬間に 1 音） */
function Sfx({ name, at, volume = 1 }: { name: string; at: number; volume?: number }) {
  return (
    <Sequence from={at} layout="none">
      <Audio src={staticFile(`sfx/${name}.ogg`)} volume={volume} />
    </Sequence>
  );
}

const EXAMPLE = <Note style={{ right: 120, bottom: 2 }}>作例（架空のイベント）・写真の AI 生成は Windows 版 v1.0.6 では未対応</Note>;

/** 1. ● ▲ ■ が落ちて弾み、「AIに頼んで、」 */
function Intro() {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const shapes = [
    { kind: "circle" as const, color: C.red, x: 470 },
    { kind: "triangle" as const, color: C.yellow, x: 600 },
    { kind: "square" as const, color: C.blue, x: 730 },
  ];
  return (
    <Stage>
      {shapes.map((s, i) => {
        const p = spring({ frame: f - i * 5, fps, config: { damping: 9, stiffness: 120, mass: 0.7 } });
        const spin = interpolate(f, [0, 75], [0, i === 1 ? 0 : 20 * (i - 1)]);
        return (
          <div key={s.kind} style={{ position: "absolute", left: s.x, top: interpolate(p, [0, 1], [-160, 200]), transform: `rotate(${spin}deg)` }}>
            <Shape kind={s.kind} size={90} color={s.color} />
          </div>
        );
      })}
      <div style={{ position: "absolute", left: 0, right: 0, top: 360, display: "flex", justifyContent: "center" }}>
        <PopText text="AIに頼んで、" start={16} size={96} stagger={3} />
      </div>
      {/* ● ▲ ■ が着地するたびにポップ */}
      <Sfx name="pop" at={9} volume={0.6} />
      <Sfx name="pop" at={14} volume={0.6} />
      <Sfx name="pop" at={19} volume={0.6} />
      {[...Array(6)].map((_, k) => (
        <Sfx key={k} name="tick" at={18 + k * 3} volume={0.4} />
      ))}
    </Stage>
  );
}

/** 2. 作りたいものを文章で書いて「レイアウトを生成」 */
// 本物の入力欄に 1 文字ずつ入れ、2 文字ごとに撮ったコマ（shots/typing/type-000〜079）。入力欄が自動で下へ送られるのも実際の動き
const TYPE_FRAMES = 80;
const TYPE_START = 18;
const CLICK_AT = TYPE_START + TYPE_FRAMES + 8;
// 打っている間は入力欄に寄る（窓と同じ縦横比）
const TIGHT: Rect = { x: 20, y: 300, w: 760, h: 395 };
function Brief() {
  const f = useCurrentFrame();
  const n = Math.max(0, Math.min(TYPE_FRAMES - 1, f - TYPE_START));
  // 入力欄（スクショの座標。撮影の範囲は CSS px で x18 y164 w288 h174 を 2 倍）
  const area = { x: 36, y: 328, w: 576, h: 348 };
  return (
    <Stage>
      <Caption text="作りたいものを、文章で。" />
      <Camera src="shots/brief.jpg" natural={APP} box={WIN} rects={[FULL, TIGHT, TIGHT, { x: 0, y: 320, w: 1300, h: 675 }]} at={[0, 16, TYPE_START + TYPE_FRAMES - 4, CLICK_AT - 4]}>
        <Img src={staticFile(`shots/typing/type-${String(n).padStart(3, "0")}.jpg`)} style={{ position: "absolute", left: area.x, top: area.y, width: area.w, height: area.h }} />
        <Ring x={324} y={892} start={CLICK_AT - 2} size={150} />
      </Camera>
      <Sfx name="typing" at={TYPE_START} volume={0.5} />
      <Sfx name="click" at={CLICK_AT} />
      {EXAMPLE}
    </Stage>
  );
}

/** 3. ChatGPT がレイアウトを設計中 */
function Generating() {
  return (
    <Stage>
      <Caption text="AIが、下書きを組み立てる。" />
      <Sfx name="whoosh" at={0} volume={0.5} />
      {/* AI が考えている間、少しずつ高まる */}
      <Sfx name="riser" at={12} volume={0.6} />
      <Camera src="shots/generating.jpg" natural={APP} box={WIN} rects={[FULL, { x: 900, y: 1480, w: 1400, h: 727 }, { x: 1040, y: 1560, w: 1120, h: 582 }]} at={[6, 55, 90]} />
      {EXAMPLE}
    </Stage>
  );
}

/** 4. 本物の 22 枚のレイヤーが下から順に重なる */
function Layers() {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const n = Math.max(1, Math.min(22, Math.floor((f - 4) / 3.4) + 1));
  const h = 600;
  const w = (h * 1000) / 1414;
  const zoom = interpolate(f, [0, 120], [1, 1.04]);
  const pop = spring({ frame: f - 82, fps, config: { damping: 10, stiffness: 140 } });
  return (
    <Stage>
      <div style={{ position: "absolute", left: 120, top: 210, width: 560 }}>
        <PopText text={"文字も、図形も、\n写真も。"} start={2} size={60} stagger={1} />
        <div style={{ marginTop: 34, display: "flex", alignItems: "baseline", gap: 16, fontFamily: FONT_DISPLAY, color: C.yellow }}>
          <span style={{ fontSize: 34 }}>レイヤー</span>
          <span style={{ fontSize: 110, color: C.white, transform: `scale(${1 + 0.15 * pop * (n === 22 ? 1 : 0)})`, display: "inline-block" }}>{n}</span>
          <span style={{ fontSize: 34 }}>枚</span>
        </div>
        <div style={{ marginTop: 6, fontFamily: FONT_BODY, fontWeight: 700, fontSize: 24, color: "rgba(255,255,255,.8)" }}>
          1 枚ずつ、あとから直せる。
        </div>
      </div>
      <div
        style={{
          position: "absolute", left: 1160 - w, top: (720 - h) / 2 + 20, width: w, height: h, borderRadius: 10, overflow: "hidden",
          transform: `scale(${zoom}) rotate(${interpolate(f, [0, 120], [-1.5, 0.5])}deg)`, boxShadow: "0 30px 80px rgba(0,0,0,.6)",
        }}
      >
        <Img src={staticFile(`shots/layers/layer-${String(n).padStart(2, "0")}.jpg`)} style={{ width: "100%", height: "100%" }} />
      </div>
      {/* レイヤーが 1 枚重なるたびに小さく刻み、22 枚そろったらチャイム */}
      {Array.from({ length: 21 }, (_, k) => (
        <Sfx key={k} name="tick" at={Math.ceil(4 + (k + 1) * 3.4)} volume={0.35} />
      ))}
      <Sfx name="ding" at={80} volume={0.7} />
      <Note style={{ right: 120, bottom: 2 }}>AI が実際に作った 22 枚のレイヤーを、下から順に表示</Note>
    </Stage>
  );
}

/** 5. 気になる所だけ、ドラッグで直す（実際の操作） */
function Edit() {
  const f = useCurrentFrame();
  const drag = ["poster-select", "poster-drag-1", "poster-drag-2", "poster-drag-3", "poster-drag-4", "poster-drag-5", "poster-drag-6", "poster-dropped"];
  const i = f < 22 ? 0 : Math.min(drag.length - 1, 1 + Math.floor((f - 22) / 6));
  // ドラッグ中のコマは、寄った範囲（スクショの座標 {860,540,1500,780}）だけを 3 倍で撮ったもの
  const zoomArea = { x: 860, y: 540, w: 1500, h: 780 };
  return (
    <Stage>
      <Caption text="気になる所だけ、自分で直す。" />
      <Camera src="shots/poster-select.jpg" natural={APP} box={WIN} rects={[FULL, { x: 860, y: 540, w: 1500, h: 779 }]} at={[0, 18]}>
        {i > 0 && (
          <Img src={staticFile(`shots/${drag[i]}.jpg`)} style={{ position: "absolute", left: zoomArea.x, top: zoomArea.y, width: zoomArea.w, height: zoomArea.h }} />
        )}
        {/* 望遠鏡に重なった吹き出しをつかむ所 */}
        <Ring x={1709} y={867} start={10} size={140} />
      </Camera>
      <Sfx name="click" at={12} />
      <Sfx name="tick" at={64} volume={0.7} />
      {EXAMPLE}
    </Stage>
  );
}

/** 6. スライドも */
function Slides() {
  return (
    <Stage>
      <Caption text="スライドも。" sub="PowerPoint（PPTX）で書き出せる" />
      <Sfx name="whoosh" at={0} volume={0.5} />
      <Sfx name="confirm" at={30} volume={0.7} />
      <Camera src="shots/slides-open.jpg" natural={APP} box={WIN} rects={[FULL, { x: 690, y: 240, w: 1820, h: 945 }, { x: 860, y: 330, w: 1480, h: 768 }]} at={[0, 30, 115]} />
      {EXAMPLE}
    </Stage>
  );
}

/** 7. 書き出しの形式とロゴ */
function End() {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const chips = [
    { t: "PDF", bg: C.red, fg: C.white },
    { t: "PNG", bg: C.yellow, fg: C.ink },
    { t: "PPTX", bg: C.blue, fg: C.white },
  ];
  return (
    <Stage>
      {/* ロゴが出たあとも止まって見えないよう、全体をゆっくり寄せ続ける */}
      <AbsoluteFill style={{ transform: `scale(${interpolate(f, [0, 145], [1, 1.07])})` }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 150, display: "flex", justifyContent: "center", gap: 28 }}>
        {chips.map((c, i) => {
          const p = spring({ frame: f - i * 4, fps, config: { damping: 9, stiffness: 150, mass: 0.6 } });
          return (
            <div key={c.t} style={{
              fontFamily: FONT_DISPLAY, fontSize: 44, color: c.fg, background: c.bg, padding: "10px 34px", borderRadius: 999,
              transform: `translateY(${(1 - p) * 80}px) scale(${p})`,
            }}>{c.t}</div>
          );
        })}
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 290, display: "flex", justifyContent: "center" }}>
        <PopText text="DC-Designer" start={18} size={110} stagger={2} />
      </div>
      <div style={{
        position: "absolute", left: 0, right: 0, top: 460, textAlign: "center", fontFamily: FONT_BODY, fontWeight: 700, fontSize: 30,
        color: "rgba(255,255,255,.85)", letterSpacing: "0.08em", opacity: prog(f, 36, 50),
      }}>
        無料 ・ Windows 版 ・ MIT ライセンス
      </div>
      </AbsoluteFill>
      <Sfx name="pop" at={6} volume={0.55} />
      <Sfx name="pop" at={10} volume={0.55} />
      <Sfx name="pop" at={14} volume={0.55} />
      {/* 効果音は声（40 フレーム目から）より前に済ませる。重なると名前が聞き取りにくくなった */}
      <Sfx name="ding" at={24} volume={0.8} />
      {/* 声の利用規約で必要なクレジット */}
      <Note style={{ left: 120, bottom: 14 }}>ナレーション：VOICEVOX:春日部つむぎ</Note>
    </Stage>
  );
}

// vo：ナレーション（public/vo/<id>.ogg、VOICEVOX:春日部つむぎ）を場面の voAt フレームから流す。
// 場面の長さは、声が終わってから次の場面へ移るように決めた（長さは public/vo/durations.json）
export const SCENES = [
  { C: Intro, len: 95, vo: "intro", voAt: 6 },
  { C: Brief, len: 135, vo: "brief", voAt: 10 },
  { C: Generating, len: 90, vo: "generating", voAt: 5 },
  { C: Layers, len: 120, vo: "layers", voAt: 6 },
  { C: Edit, len: 105, vo: "edit", voAt: 6 },
  { C: Slides, len: 115, vo: "slides", voAt: 5 },
  { C: End, len: 145, vo: "end", voAt: 40 },
];
export const DEMO_FRAMES = SCENES.reduce((a, s) => a + s.len, 0);

// BGM：軽く後ろで流す（声より十分小さく。最初と最後はフェード）
const BGM_VOLUME = 0.14;
// 声が出ている間は BGM を半分に下げる（声が聞き取りやすいように）。前後 6 フレームでなめらかに上げ下げ
const BGM_DUCKED = 0.07;
const VO_WINDOWS = (() => {
  let from = 0;
  return SCENES.map(({ len, vo, voAt }) => {
    const start = from + voAt;
    from += len;
    return [start, start + Math.ceil((VO_SECONDS as Record<string, number>)[vo] * 30)] as const;
  });
})();
const bgmVolume = (f: number) => {
  const duck = Math.max(0, ...VO_WINDOWS.map(([s, e]) => Math.min(interpolate(f, [s - 6, s], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }), interpolate(f, [e, e + 6], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }))));
  const edge = interpolate(f, [0, 12, DEMO_FRAMES - 45, DEMO_FRAMES - 1], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return edge * (BGM_VOLUME - (BGM_VOLUME - BGM_DUCKED) * duck);
};
export function Demo() {
  let from = 0;
  return (
    <AbsoluteFill style={{ background: C.ink }}>
      <Audio
        src={staticFile("sfx/bgm.ogg")}
        volume={bgmVolume}
      />
      {SCENES.map(({ C: Scene, len, vo, voAt }, i) => {
        const el = (
          <Sequence key={i} from={from} durationInFrames={len}>
            <Fade len={len}>
              <Scene />
            </Fade>
            <Sequence from={voAt} layout="none">
              <Audio src={staticFile(`vo/${vo}.ogg`)} />
            </Sequence>
          </Sequence>
        );
        from += len;
        return el;
      })}
    </AbsoluteFill>
  );
}
