import { z } from "zod";

/**
 * ポスターの設計図（PosterSpec）。
 * - レイヤーは配列の先頭が最背面、末尾が最前面。
 * - 色は "#rrggbb" などの CSS カラー、またはテーマトークン "$primary" のような参照。
 * - グラデーションは { type: "linear", angle, stops } か、テーマのグラデーショントークン "$title" など。
 */

const GradientStop = z.object({
  offset: z.number().min(0).max(1),
  color: z.string(),
});

const LinearGradient = z.object({
  type: z.literal("linear"),
  angle: z.number().default(90), // 0 = 左→右, 90 = 上→下
  stops: z.array(GradientStop).min(2),
});

const RadialGradient = z.object({
  type: z.literal("radial"),
  cx: z.number().default(0.5),
  cy: z.number().default(0.5),
  r: z.number().default(0.7),
  stops: z.array(GradientStop).min(2),
});

export const Paint = z.union([z.string(), LinearGradient, RadialGradient]);
export type Paint = z.infer<typeof Paint>;

/** 画像生成モデルへの依頼内容。src が空なら生成対象になる */
export const AssetRequest = z.object({
  prompt: z.string(),
  transparent: z.boolean().default(false),
  aspect: z.enum(["square", "portrait", "landscape"]).default("square"),
  style: z.string().optional(),
});
export type AssetRequest = z.infer<typeof AssetRequest>;

/** 画像をポスターになじませるための文脈。サーバー側でプロンプトに足す */
export const AssetContext = z.object({
  /** ポスター全体で共通の画風 */
  style: z.string().optional(),
  /** ポスターの主要色（CSS カラー） */
  palette: z.array(z.string()).max(8).optional(),
  /** 置かれる場所: hero（主役ビジュアル）/ supporting（添え）/ small（小さな挿絵） */
  role: z.enum(["hero", "supporting", "small"]).optional(),
  /** 入れ物のコンポーネント名（laptop / phone / polaroid など） */
  component: z.string().optional(),
});
export type AssetContext = z.infer<typeof AssetContext>;

const Outline = z.object({ color: z.string(), width: z.number() });
const Shadow = z.object({
  color: z.string().default("rgba(0,0,0,0.35)"),
  dx: z.number().default(0),
  dy: z.number().default(4),
  blur: z.number().default(6),
});

/** 内蔵の効果音（src/sounds.ts で合成する） */
export const BuiltinSound = z.enum(["pop", "click", "whoosh", "chime", "sparkle", "drum", "fanfare", "pico"]);
/** 効果音。内蔵音の名前か、取り込んだ音声ファイル（src はアップロード先、name は元のファイル名） */
export const SoundRef = z.union([BuiltinSound, z.object({ src: z.string(), name: z.string() })]);
export type SoundRef = z.infer<typeof SoundRef>;

/** PPTX の「開始」アニメーション（スライドで表示されるときの動き） */
export const LayerAnimation = z.object({
  effect: z.enum(["appear", "fade", "float", "fly", "wipe", "zoom"]),
  /** fly / wipe の入ってくる向き */
  direction: z.enum(["bottom", "top", "left", "right"]).optional(),
  /** click: クリック時 / with: 直前と同時 / after: 直前の動作の後 */
  start: z.enum(["click", "with", "after"]).default("click"),
  duration: z.number().min(0).max(20000).default(500), // ms
  delay: z.number().min(0).max(60000).default(0), // ms
  /** 再生順（1 から）。無ければレイヤーの重ね順 */
  order: z.number().int().min(1).optional(),
  /** 動き始めと同時に鳴らす効果音 */
  sound: SoundRef.optional(),
});
export type LayerAnimation = z.infer<typeof LayerAnimation>;

/** PPTX の画面切り替え（前のスライドからこのスライドに替わるときの動き） */
export const SlideTransition = z.object({
  effect: z.enum(["fade", "push", "wipe", "cover", "zoom"]),
  /** push / wipe / cover の入ってくる向き */
  direction: z.enum(["bottom", "top", "left", "right"]).optional(),
  duration: z.number().min(0).max(10000).default(700), // ms
  /** 切り替えと同時に鳴らす効果音 */
  sound: SoundRef.optional(),
});
export type SlideTransition = z.infer<typeof SlideTransition>;

/** スライドの BGM（取り込んだ音声ファイル）。スライドショーで流す */
export const SlideBgm = z.object({
  src: z.string(),
  name: z.string(),
  /** click: 次へ（クリック・→）で流し始める / auto: 1 曲目はスライドに入ったら、2 曲目からは前の曲が終わったら流す */
  start: z.enum(["click", "auto"]).default("click"),
  /** 最後まで流れたら頭から繰り返す */
  loop: z.boolean().default(true),
  /** 次のスライドへ進んでも止めない（別の BGM が始まるか、スライドショーを終えるまで） */
  across: z.boolean().default(false),
});
export type SlideBgm = z.infer<typeof SlideBgm>;

const LayerBase = z.object({
  id: z.string(),
  name: z.string().optional(),
  visible: z.boolean().optional(),
  locked: z.boolean().optional(),
  x: z.number().default(0),
  y: z.number().default(0),
  w: z.number().default(100),
  h: z.number().default(100),
  rotation: z.number().optional(),
  opacity: z.number().min(0).max(1).optional(),
  blend: z.string().optional(), // CSS mix-blend-mode
  shadow: Shadow.optional(),
  /** 指定したテーマのときだけ表示（例: ["night"]） */
  themes: z.array(z.string()).optional(),
  animation: LayerAnimation.optional(),
});

const BackgroundLayer = LayerBase.extend({
  type: z.literal("background"),
  fill: Paint,
});

const ShapeLayer = LayerBase.extend({
  type: z.literal("shape"),
  shape: z.enum(["rect", "ellipse", "blob", "path"]),
  fill: Paint.optional(),
  stroke: z.string().optional(),
  strokeWidth: z.number().optional(),
  radius: z.number().optional(),
  /** shape=path の場合: 0..1 正規化座標の SVG path（w,h でスケール） */
  d: z.string().optional(),
  fillRule: z.enum(["nonzero", "evenodd"]).optional(),
  /** shape=blob の形状シード */
  seed: z.number().optional(),
  blur: z.number().optional(),
});

const TextLayer = LayerBase.extend({
  type: z.literal("text"),
  text: z.string(), // 改行 "\n" で改行
  font: z.string().default("body"), // "display" | "body" | "hand" | 任意のフォント名
  size: z.number().default(32),
  weight: z.number().default(700),
  lineHeight: z.number().default(1.25),
  letterSpacing: z.number().optional(), // em 単位
  align: z.enum(["left", "center", "right"]).default("left"),
  fill: Paint.default("$ink"),
  /** 一部の文字だけの色。text の文字位置 [start, end) をその色にする（範囲外は fill） */
  colorRuns: z.array(z.object({ start: z.number().int().min(0), end: z.number().int().min(0), color: z.string() })).optional(),
  outlines: z.array(Outline).optional(), // 外側から順に
  skewX: z.number().optional(),
  /** "shrink": はみ出したら枠に収まるよう縮小 */
  fit: z.enum(["none", "shrink"]).optional(),
});

export const ImageCrop = z.object({
  scale: z.number().min(1).max(10).default(1),
  x: z.number().default(0),
  y: z.number().default(0),
  /** 画像本来の幅/高さ。あれば枠からはみ出した分も上下左右に動かせる */
  ratio: z.number().positive().optional(),
});
export type ImageCrop = z.infer<typeof ImageCrop>;

const ImageLayer = LayerBase.extend({
  type: z.literal("image"),
  src: z.string().optional(),
  asset: AssetRequest.optional(),
  fit: z.enum(["cover", "contain"]).default("contain"),
  /** 枠内での拡大と位置（トリミング）。scale=1 で枠いっぱい、x/y は枠の幅・高さに対するずらし量 */
  crop: ImageCrop.optional(),
  radius: z.number().optional(),
  blur: z.number().optional(),
});

const ComponentLayer = LayerBase.extend({
  type: z.literal("component"),
  component: z.string(),
  props: z.record(z.string(), z.any()).default({}),
});

export type Layer =
  | z.infer<typeof BackgroundLayer>
  | z.infer<typeof ShapeLayer>
  | z.infer<typeof TextLayer>
  | z.infer<typeof ImageLayer>
  | z.infer<typeof ComponentLayer>
  | (z.infer<typeof LayerBase> & { type: "group"; children: Layer[] });

export const LayerSchema: z.ZodType<Layer> = z.lazy(() =>
  z.discriminatedUnion("type", [
    BackgroundLayer,
    ShapeLayer,
    TextLayer,
    ImageLayer,
    ComponentLayer,
    LayerBase.extend({ type: z.literal("group"), children: z.array(LayerSchema) }),
  ]),
) as any;

const ThemeOverride = z.object({
  colors: z.record(z.string(), z.string()).optional(),
  gradients: z.record(z.string(), Paint).optional(),
  fonts: z.record(z.string(), z.string()).optional(),
});

export const PosterSpecSchema = z.object({
  version: z.literal(1).default(1),
  meta: z.object({
    title: z.string().default("Untitled"),
    width: z.number().default(1000),
    height: z.number().default(1414),
    /** 全画像で共通の画風（アートディレクション）。未指定ならテーマの imageStyle */
    imageStyle: z.string().optional(),
  }),
  theme: z.string().default("ocean"),
  themeOverride: ThemeOverride.optional(),
  layers: z.array(LayerSchema),
  /** 台本（発表者のノート）。PPTX エディターモードのスライドで話す内容。PPTX ではノートとして読み書きする */
  notes: z.string().optional(),
  /** 画面切り替え（PPTX エディターモードのスライド）。前のスライドからこのスライドに替わるときの動き */
  transition: SlideTransition.optional(),
  /** BGM（PPTX エディターモードのスライド）。並べた順に 1 曲ずつ流す（前は 1 曲だけをオブジェクトで持っていた） */
  bgm: z.preprocess((v) => (v && !Array.isArray(v) ? [v] : v), z.array(SlideBgm)).optional(),
});

export type PosterSpec = z.infer<typeof PosterSpecSchema>;
export type TextLayerT = z.infer<typeof TextLayer>;

type PendingAsset = { path: (string | number)[]; asset: AssetRequest };

/** spec 内のすべての「生成待ちアセット」(asset あり & src なし) を列挙する */
export function findPendingAssets(spec: PosterSpec): PendingAsset[] {
  const out: PendingAsset[] = [];
  const walk = (node: any, path: (string | number)[]) => {
    if (!node || typeof node !== "object") return;
    if (node.asset && typeof node.asset === "object" && node.asset.prompt && !node.src) {
      out.push({ path, asset: AssetRequest.parse(node.asset) });
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "asset") continue;
      if (Array.isArray(v)) v.forEach((c, i) => walk(c, [...path, k, i]));
      else if (v && typeof v === "object") walk(v, [...path, k]);
    }
  };
  walk(spec, []);
  return out;
}
