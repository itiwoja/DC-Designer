/**
 * コンポーネントカタログ（React 非依存）。
 * エディタのUIと、ChatGPT へのプロンプト（使えるパーツ一覧）の両方で使う単一の定義元。
 * props の色は "$token"（テーマ色）か CSS カラー。
 */
export interface CatalogEntry {
  name: string;
  label: string;
  description: string;
  props: string; // LLM 向けの props 説明
  defaultSize: [number, number];
  defaults: Record<string, unknown>;
  /** 中にある文字列。位置調整は `${prefix}Dx` / `${prefix}Dy`(px) / `${prefix}Align` で行う */
  textSlots?: TextSlot[];
}

export interface TextSlot {
  prefix: string;
  label: string;
}

/** 文字列を持つコンポーネント共通の位置調整 props（LLM 向け説明） */
const TEXT_POS_PROPS = `textDx?: number=0, textDy?: number=0（文字の位置を px でずらす）, textAlign?: "left"|"center"|"right"`;

export const ICON_NAMES = [
  "calendar", "pin", "clock", "beginner", "heart", "star", "camera", "plane", "check", "sparkle", "laptop", "chat",
] as const;

export const CATALOG: CatalogEntry[] = [
  {
    name: "pill",
    label: "ピル型ラベル",
    description: "角丸のラベル/バッジ。アイコン付き可。『プログラミング未経験者向け』『参加申込はこちら』など。",
    props: `{ text: string, icon?: IconName, fill?: Paint="$pill", color?: color="$pillInk", fontSize?: number(自動=h*0.45), font?: "body"|"display"|"hand", stroke?: color, glow?: boolean, ${TEXT_POS_PROPS} }`,
    defaultSize: [380, 64],
    defaults: { text: "ラベル", icon: "beginner" },
    textSlots: [{ prefix: "text", label: "テキスト" }],
  },
  {
    name: "qr",
    label: "QRコード＋見出し",
    description: "見出しピルの下に白い角丸枠付きQRコード。URLから実際に読み取れるQRを生成する。url が空文字なら「URL を入れてください」という点線の空枠になる（URL が未定のとき）。",
    props: `{ url: string, label?: string, labelFill?: Paint="$label1", labelColor?: color="$labelInk", frame?: color="#ffffff", border?: color="$ink", labelDx?: number=0, labelDy?: number=0（見出し文字を px でずらす）, labelAlign?: "left"|"center"|"right" }`,
    defaultSize: [200, 240],
    defaults: { url: "https://example.com", label: "参加申込はこちら" },
    textSlots: [{ prefix: "label", label: "見出し" }],
  },
  {
    name: "iconText",
    label: "アイコン＋テキスト",
    description: "日時・場所などの情報行。左にアイコン、右にテキスト（1行）。",
    props: `{ icon: IconName, text: string, color?: color="$ink", iconColor?: color, fontSize?: number(自動=h*0.62), weight?: number=700, ${TEXT_POS_PROPS} }`,
    defaultSize: [600, 48],
    defaults: { icon: "calendar", text: "2026年11月11日（水）11:00〜12:30" },
    textSlots: [{ prefix: "text", label: "テキスト" }],
  },
  {
    name: "speechBubble",
    label: "吹き出し",
    description: "手書き風テキスト入りの吹き出し。cloud=もこもこ雲型, round=楕円, rect=角丸。",
    props: `{ text: string(\\n改行), shape?: "cloud"|"round"|"rect"="cloud", tail?: "bottom-right"|"bottom-left"|"none", fill?: Paint="$bubble", stroke?: color="$primary", strokeWidth?: number=4, color?: color="$bubbleInk", font?: string="hand", fontSize?: number, textRotate?: number, ${TEXT_POS_PROPS} }`,
    defaultSize: [300, 220],
    defaults: { text: "ここに\n吹き出し", shape: "cloud", tail: "bottom-right" },
    textSlots: [{ prefix: "text", label: "テキスト" }],
  },
  {
    name: "stickyNote",
    label: "付箋メモ",
    description: "マスキングテープ付きの紙メモ。手書き風テキスト。",
    props: `{ text: string, paper?: color="$paper", tape?: boolean=true, tapeColor?: color, color?: color="$noteInk", font?: string="hand", fontSize?: number, scribble?: boolean=true, ${TEXT_POS_PROPS} }`,
    defaultSize: [220, 200],
    defaults: { text: "好きな\nアイデアを\nカタチにしてみよう。" },
    textSlots: [{ prefix: "text", label: "テキスト" }],
  },
  {
    name: "sparkle",
    label: "キラキラ",
    description: "4方向の星形キラキラ。装飾用。",
    props: `{ color?: color="$accent", outline?: boolean=false, glow?: boolean=false }`,
    defaultSize: [48, 48],
    defaults: {},
  },
  {
    name: "stars",
    label: "星くず（散布）",
    description: "枠内に小さな星・点をランダム散布。夜空背景向け。",
    props: `{ count?: number=60, color?: color="#ffffff", seed?: number=1, sparkleRatio?: number=0.15 }`,
    defaultSize: [1000, 1414],
    defaults: { count: 60 },
  },
  {
    name: "burst",
    label: "強調線（集中線）",
    description: "タイトル脇の『\\ /』のような3本の強調線。side=left なら右上向き、right なら左上向き。",
    props: `{ color?: color="$primary", side?: "left"|"right"="left", count?: number=3, thickness?: number=8 }`,
    defaultSize: [80, 90],
    defaults: { side: "left" },
  },
  {
    name: "brush",
    label: "ブラシストローク",
    description: "蛍光ペン/筆のような横長ストローク。文字の下に敷いて強調。",
    props: `{ color?: color="$highlight", opacity?: number=0.85, seed?: number=1 }`,
    defaultSize: [700, 50],
    defaults: {},
  },
  {
    name: "underline",
    label: "手書きアンダーライン",
    description: "手書き風の下線。",
    props: `{ color?: color="$primary", style?: "wavy"|"straight"|"double"="straight", thickness?: number=5 }`,
    defaultSize: [300, 20],
    defaults: {},
  },
  {
    name: "arrow",
    label: "手書き矢印",
    description: "くるっとループする手書き矢印。左下→右上方向。",
    props: `{ color?: color="$primary", thickness?: number=4, flip?: boolean }`,
    defaultSize: [140, 70],
    defaults: {},
  },
  {
    name: "icon",
    label: "アイコン",
    description: "単体のラインアイコン。",
    props: `{ name: IconName, color?: color="$ink", filled?: boolean }`,
    defaultSize: [64, 64],
    defaults: { name: "camera" },
  },
  {
    name: "polaroid",
    label: "ポラロイド写真",
    description: "白フチ付き写真＋マスキングテープ。画像は src または asset（生成依頼）で指定。",
    props: `{ src?: string, asset?: AssetRequest, caption?: string, tape?: boolean=true, ${TEXT_POS_PROPS} }`,
    defaultSize: [260, 300],
    defaults: { asset: { prompt: "tropical beach with palm trees, blue sky", aspect: "square" } },
    textSlots: [{ prefix: "text", label: "キャプション" }],
  },
  {
    name: "circlePhoto",
    label: "丸型写真",
    description: "円形（楕円）に切り抜いた写真。人物のアイコン写真・スポット写真など。縁取りリング付き可。",
    props: `{ src?: string, asset?: AssetRequest(aspect="square"推奨), crop?: { scale: number, x: number, y: number }（枠内の拡大・位置）, ring?: color="$primary", ringWidth?: number=0（縁取りの太さ px。0 で無し） }`,
    defaultSize: [240, 240],
    defaults: { asset: { prompt: "", transparent: false, aspect: "square" } },
  },
  {
    name: "roundPhoto",
    label: "角丸写真",
    description: "角を丸くした四角（正方形）に切り抜いた写真。スポット写真・作品のサムネイル・アプリのアイコン風の画像など。縁取り付き可。",
    props: `{ src?: string, asset?: AssetRequest(aspect="square"推奨), crop?: { scale: number, x: number, y: number }（枠内の拡大・位置）, radius?: number=0.2（角の丸みを短い辺に対する割合で。0〜0.5）, ring?: color="$primary", ringWidth?: number=0（縁取りの太さ px。0 で無し） }`,
    defaultSize: [240, 240],
    defaults: { asset: { prompt: "", transparent: false, aspect: "square" } },
  },
  {
    name: "laptop",
    label: "ノートPCモック",
    description: "ノートPCのフレーム。画面に画像（Webアプリのスクリーンショット風）を表示。",
    props: `{ src?: string, asset?: AssetRequest(aspect="landscape"推奨), frame?: color="#e9e9f2" }`,
    defaultSize: [620, 400],
    defaults: { asset: { prompt: "clean web app dashboard UI screenshot", aspect: "landscape" } },
  },
  {
    name: "phone",
    label: "スマホモック",
    description: "スマートフォンのフレーム。画面に画像を表示。",
    props: `{ src?: string, asset?: AssetRequest(aspect="portrait"推奨), frame?: color="#1b1b24" }`,
    defaultSize: [230, 440],
    defaults: { asset: { prompt: "mobile app home screen UI with card tiles", aspect: "portrait" } },
  },
  {
    name: "checklist",
    label: "手書きチェックリスト",
    description: "✓付きの手書き風リスト。",
    props: `{ items: string[], color?: color="$inkSoft", checkColor?: color="$primary", font?: string="hand", fontSize?: number=28, lineGap?: number=1.5, ${TEXT_POS_PROPS} }`,
    defaultSize: [380, 220],
    defaults: { items: ["こんなWebアプリをつくってみたい！", "好きをもっと楽しむアプリ！"] },
    textSlots: [{ prefix: "text", label: "項目テキスト" }],
  },
  {
    name: "moon",
    label: "三日月",
    description: "光る三日月。夜テーマ向け。",
    props: `{ color?: color="$accent", glow?: boolean=true }`,
    defaultSize: [120, 120],
    defaults: {},
  },
  {
    name: "tape",
    label: "マスキングテープ",
    description: "半透明のマスキングテープ片。",
    props: `{ color?: color="#f3e3b5" }`,
    defaultSize: [110, 34],
    defaults: {},
  },
  {
    name: "dots",
    label: "ドットパターン",
    description: "ハーフトーン風のドット群（装飾）。",
    props: `{ color?: color="$primary", gap?: number=16, r?: number=2.5, fade?: boolean=true }`,
    defaultSize: [160, 120],
    defaults: {},
  },
];

export const CATALOG_BY_NAME = Object.fromEntries(CATALOG.map((c) => [c.name, c]));
