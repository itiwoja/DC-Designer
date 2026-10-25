import { z } from "zod";
import { PosterSpecSchema, type PosterSpec } from "../src/schema";
import { CATALOG, ICON_NAMES } from "../src/components/catalog";
import { THEMES } from "../src/themes";
import { notesLength } from "../src/notes";
import { FONT_CATALOG, FONT_ROLE_LABELS, FONT_SCRIPT_LABELS } from "../src/fonts";
import { IG_MAX_IMAGES } from "../src/instagram";
import { referenceSources, resolveReferenceSources, type PosterReference } from "./references";
import { askAI } from "./ai";
import { extractJson, type ImageRef, type Turn } from "./chatgpt";
import { applyLayerPatch, isEmptyPatch, parsePatch } from "./layer-patch";

const themeTokens = (() => {
  const t = THEMES.ocean;
  return {
    colors: Object.keys(t.colors).map((k) => `$${k}`).join(", "),
    gradients: Object.keys(t.gradients).map((k) => `$${k}`).join(", "),
    fonts: Object.keys(t.fonts).join(", "),
    themes: Object.values(THEMES).map((t) => `${t.id}（${t.label}）`).join(" / "),
  };
})();

const catalogText = CATALOG.map((c) => `- ${c.name}（${c.label}）: ${c.description}\n  props: ${c.props}\n  標準サイズ: ${c.defaultSize.join("x")}`).join("\n");

const SYSTEM = `あなたは日本の学校・イベント告知ポスターを得意とするグラフィックデザイナーです。
ポスターを「1枚の画像」ではなく、Illustrator のようにレイヤーを重ねた設計図（PosterSpec JSON）として組み立てます。
文字はすべてテキストレイヤーで組み、写真やイラストだけを画像生成モデルに個別に依頼します。

# PosterSpec の形式
{
  "version": 1,
  "meta": { "title": string, "width": 1000, "height": 1414, "imageStyle": string },   // A判縦。単位はpx。imageStyle は下記「画像」参照
  "theme": テーマID,
  "themeOverride"?: { "colors"?: {...}, "gradients"?: {...} },  // 必要なときだけ
  "layers": Layer[],  // 先頭が最背面、末尾が最前面
  "notes"?: string,   // 台本（発表者のノート）。スライドで話す内容。改行は\\n
  "transition"?: { "effect": "fade"(フェード)|"push"(プッシュ)|"wipe"(ワイプ)|"cover"(カバー)|"zoom"(ズーム), "direction"?: "right"|"left"|"bottom"|"top"(push・wipe・cover の入ってくる向き), "duration": ms, "sound"?: 効果音（animation.sound と同じ値） }
}
※ notes は PowerPoint のスライド（デッキ）の台本。ユーザーが台本・ノート・話す内容を頼んだときだけ書き換え、頼まれていなければ既存の値をそのまま残す。
  書くときは、スライドの内容に沿って発表者がそのまま読み上げられる話し言葉で（1 枚 30 秒〜1 分程度。スライドの文字をそのまま読むのではなく補足・つなぎを入れる）
※ transition は PowerPoint のスライド（デッキ）の画面切り替え（前のスライドからこのスライドに替わるときの動き）。ユーザーが画面切り替え・スライドの切り替えを頼んだときだけ付け、頼まれていなければ既存の値をそのまま残す（duration は 500〜1000 程度）

共通フィールド（全レイヤー）:
  id(一意, 英数字とハイフン), name(日本語の分かりやすいレイヤー名), type,
  x, y, w, h（左上座標とサイズ）, rotation?(度, 中心回転), opacity?, blend?,
  shadow?: { color, dx, dy, blur }, themes?: string[]（特定テーマでのみ表示）, visible?,
  animation?: { effect: "appear"(表示)|"fade"(フェード)|"float"(浮き上がり)|"fly"(スライドイン)|"wipe"(ワイプ)|"zoom"(ズーム), direction?: "bottom"|"top"|"left"|"right"(fly・wipe の入ってくる向き),
               start: "click"(クリック時)|"with"(直前と同時)|"after"(直前の動作の後), duration(ms), delay(ms), order(再生順 1〜),
               sound?: "pop"(ポン)|"click"(カチッ)|"whoosh"(シュッ)|"pico"(ピコン)|"chime"(ピンポン)|"sparkle"(キラーン)|"drum"(ドン)|"fanfare"(ジャジャーン)(動き始めと同時に鳴らす効果音。{ src, name } はユーザーが取り込んだ音声ファイルなので、そのまま残す) }
    ※ PowerPoint のスライド（デッキ）のアニメーション。ユーザーが動き・アニメーションを頼んだときだけ付け、頼まれていなければ既存の値をそのまま残す。
      効果音（sound）はユーザーが効果音・音を頼んだときだけ付ける。背景には付けない。見出し → 本文 → 図のように読む順に order を振り、多用しすぎない（1 枚に 3〜5 個程度、同時に動くものは "with"）

type ごとのフィールド:
- "background": { fill: Paint }  ※キャンバス全面
- "shape": { shape: "rect"|"ellipse"|"blob"|"path", fill?: Paint, stroke?, strokeWidth?, radius?, seed?(blob形状), d?(path: 0..1正規化座標), blur? }
- "text": { text(改行は\\n), font: ${themeTokens.fonts}, size, weight(400-900), lineHeight?, letterSpacing?(em),
            align: "left"|"center"|"right", fill: Paint,
            colorRuns?: [{start, end, color}](一部の文字だけ色を変える。text の文字位置 [start,end)。改行も 1 文字。範囲外は fill), outlines?: [{color, width}](外側から。ステッカー風縁取り),
            skewX?(斜体風), fit?: "shrink"(枠からはみ出す場合に縮小。長い見出しには必ず付ける) }
- "image": { asset: { prompt(英語), transparent?(切り抜き素材ならtrue), aspect: "square"|"portrait"|"landscape", style? }, fit: "cover"|"contain", radius?, blur? }
- "component": { component: 名前, props: {...} }   ※下記カタログ
- "group": { children: Layer[] }  ※子の座標はグループ原点からの相対

Paint = CSSカラー | テーマトークン（"$primary" など）| { "type":"linear", "angle":度(0=左→右, 90=上→下), "stops":[{ "offset":0..1, "color" }] }
色はできるだけテーマトークンを使うこと。そうすればテーマ切り替えだけで配色違いを作れる。
- 色トークン: ${themeTokens.colors}
- グラデーショントークン（fill に使用可）: ${themeTokens.gradients}
- テーマ: ${themeTokens.themes}

IconName: ${ICON_NAMES.join(", ")}

# コンポーネントカタログ
${catalogText}

AssetRequest = { prompt: string(英語で具体的に), transparent?: boolean, aspect?: "square"|"portrait"|"landscape", style?: string }
画像が必要な箇所（写真、イラスト、アプリ画面など）は image レイヤーまたはコンポーネントの props.asset に AssetRequest を書く。src は書かない（後で生成される）。
画像内に文字を描かせない（文字はテキストレイヤーで載せる）。ただしアプリ画面のスクリーンショットは例外。

# 画像（ポスターになじませる）
画像はすべて自動で生成され、そのままポスターに載る。1 枚の作品として統一感が出るように設計する。
- meta.imageStyle に、ポスター全体で共通の画風を英語で 1 文書く（例: "soft flat vector illustration, rounded shapes, light grain, bright daylight"）。写真調・イラスト調などを混ぜない。配色はテーマから自動で足されるので色名は控えめでよい。
- 各 asset.prompt は「何が・どんな構図で写っているか」を具体的に書く（主題、構図、視点、余白）。画風は imageStyle に任せ、style は個別に変えたいときだけ使う。
- aspect はレイヤーの w/h に合わせる（横長 landscape / 縦長 portrait / ほぼ正方形 square）。
- 文字やパーツと重なる背景用の画像は、主題を片側に寄せる・余白を広く取るなど、上に載る文字が読みやすい構図を指示する。
- 背景の上に浮かせる人物・キャラクター・小物は transparent: true（切り抜き）、写真枠や全面を埋める画像は false。

# デザインの原則
- 視線の流れ: 学校名など発信元 → 大見出し(キャッチ) → ビジュアル → サブコピー → イベント名 → 対象/時間 → 日時・場所 → QR/申込導線。
- 大見出しは画面幅の 70〜85% を使い、行ごとに別レイヤーにしてサイズ・色でリズムを付ける。縁取り(outlines)と軽い影でポスターらしい力強さを出す。
- 余白と整列: 左右マージン 40px 以上。情報ブロックは中央揃えまたは左揃えで揃える。要素同士を不用意に重ねない（装飾の意図的な重なりは可）。
- 装飾（sparkle, burst, brush, dots, blob）でにぎやかさを出しつつ、文字の可読性を最優先。
- 日本語テキストの幅はおよそ「文字数 × size」、英数字は「文字数 × size × 0.6」で見積もり、w に収まるサイズを選ぶ。
- 画像は 2〜5 点程度に絞る（生成コストがかかるため）。
- テキストの内容（日時・場所・URL等）はユーザーの指示を正確に使う。不明な情報は作らず、ダミーであることが分かる表記にする。

# 出力
JSON のみを出力する。前置き・説明・コードフェンスは不要。形式はユーザーのメッセージの「# 出力」に従い、指定がなければ PosterSpec の JSON を出力する。`;

/**
 * 生成の進み具合（時間のかかる再現で画面に出す）。
 * thinking: 応答の書き出し前（考え中）／ writing: 書き出し中（items は書き終えたレイヤーなどの数の目安）。attempt は 1 始まり
 */
export type Progress = { phase: "thinking" | "writing"; attempt: number; chars?: number; items?: number };
export type OnProgress = (p: Progress) => void;

/** JSON を生成 → 検証 → 失敗したらエラー内容を渡して 1 回だけ修正させる */
async function generateJson<T>(first: Turn, parse: (json: unknown) => T, what = "PosterSpec の JSON 全体", onProgress?: OnProgress, signal?: AbortSignal): Promise<T> {
  const turns: Turn[] = [first];
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted(); // 中断したら検証のやり直しもしない
    onProgress?.({ phase: "thinking", attempt: attempt + 1 });
    const text = await askAI(SYSTEM, turns, onProgress && ((t) => onProgress({ phase: "writing", attempt: attempt + 1, chars: t.length, items: t.match(/"id"\s*:/g)?.length ?? 0 })), signal);
    try {
      return parse(extractJson(text));
    } catch (e: any) {
      lastError = e?.message ?? String(e);
      console.warn(`[planner] 出力の検証に失敗したのでやり直します: ${lastError.slice(0, 300)}\n  出力: ${text.slice(0, 300)}`);
      turns.push({ role: "assistant", text });
      turns.push({ role: "user", text: `出力した JSON に問題がありました。修正した ${what}だけを出力してください。\n\nエラー:\n${lastError.slice(0, 4000)}` });
    }
  }
  throw new Error(`PosterSpec の検証に失敗しました: ${lastError.slice(0, 500)}`);
}

/** ブリーフ（＋参考画像）から PosterSpec を新規に作る */
export async function planPoster(opts: { brief: string; theme?: string; references?: PosterReference[]; signal?: AbortSignal }): Promise<PosterSpec> {
  const text = [
    opts.references?.length ? "添付画像はデザインの参考です。構図・情報の階層・装飾の雰囲気を参考にし、文字はすべてテキストレイヤーで再構成してください。" : "",
    referenceSources(opts.references),
    opts.theme ? `テーマは "${opts.theme}" を使ってください。` : "内容に合うテーマを選んでください。",
    "# ポスターの依頼内容",
    opts.brief,
  ].filter(Boolean).join("\n\n");
  return generateJson({ role: "user", text, images: opts.references }, (j) => resolveReferenceSources(PosterSpecSchema.parse(j), opts.references), undefined, undefined, opts.signal);
}

// ---------- Instagram の投稿（カルーセル） ----------

/** Instagram の画像のデザインの決まりごと（新規作成とチャットでの修正で共通） */
const instagramRules = (w: number, h: number) => [
  `- キャンバスは ${w}×${h}px（Instagram の投稿画像の実寸。A判の 1000×1414 ではない）。meta.width / meta.height は変えない。`,
  "- スマホの画面で見られる前提。文字は大きく少なく: 見出しは 64px 以上、本文も 34px 以上。1 枚に詰め込まず、1 枚 1 メッセージにする。",
  "- 重要な文字・顔は縁から 64px 以上内側に置く。",
  h / w > 1.7
    ? "- 縦長 9:16（ストーリーズ）は、上 250px と下 300px にアプリの表示が重なるので、そこに文字を置かない。"
    : "- プロフィールの一覧では 3:4 に切り抜かれて表示されるので、表紙の見出しと主役ビジュアルは中央寄りに置く。",
  "- QR コードは使わない（Instagram の画像からは読み取れない）。申込先などは「詳しくはプロフィールのリンクから」のように誘導する。",
  "- notes（台本）と animation・transition は使わない。",
].join("\n");

/**
 * ブリーフ（＋参考画像）から Instagram のカルーセル投稿（同じ大きさの PosterSpec を 1〜20 枚）を作る。
 * count が無ければ枚数は内容から決めさせる
 */
export async function planCarousel(opts: { brief: string; width: number; height: number; count?: number; references?: ImageRef[]; onProgress?: OnProgress; signal?: AbortSignal }): Promise<{ title: string; posts: PosterSpec[] }> {
  const { width: w, height: h, count } = opts;
  const text = [
    "Instagram のフィードに載せる投稿を作ります。ポスターではなく SNS の投稿画像です。",
    opts.references?.length ? "添付画像はデザインの参考です。構図・情報の階層・装飾の雰囲気を参考にし、文字はすべてテキストレイヤーで再構成してください。" : "",
    "# Instagram の投稿のルール",
    count
      ? `- 画像は ${count} 枚ちょうど（1 枚 = 1 つの PosterSpec）。`
      : "- 画像の枚数は内容に合わせて 1〜8 枚で決める（1 枚 = 1 つの PosterSpec）。伝えることが少なければ 1 枚でよい。増やしすぎない。",
    instagramRules(w, h),
    "- 複数枚のときはカルーセル（スワイプで見る）: 1 枚目は表紙。フィードで流れてきても指が止まるよう、大きな見出しと主役ビジュアルで要点を一目で伝え、右下などに小さく「スワイプ →」のような続きの合図を入れる。2 枚目以降は 1 枚 1 トピックで詳しく、最後の 1 枚はまとめ・申込み・保存やフォローの呼びかけなど次の行動にする。",
    "- 全枚で theme・meta.imageStyle・配色・フォント・余白・見出しの位置をそろえ、1 つの続きものに見えるようにする。必要ならページ番号（例: 2/5）を小さく入れる。",
    "- 画像生成は全枚の合計で 2〜6 点程度に絞る（表紙の主役ビジュアルを優先）。",
    "- meta.title は各画像の短い名前（「表紙」「日時と場所」など）。",
    "# 投稿の依頼内容",
    opts.brief,
    "# 出力",
    '{"title": 投稿全体の短い名前, "posts": [PosterSpec, ...]} の JSON のみを出力してください。',
  ].filter(Boolean).join("\n\n");
  return generateJson({ role: "user", text, images: opts.references }, (j) => {
    const o = j as { title?: unknown; posts?: unknown };
    if (!Array.isArray(o?.posts) || !o.posts.length) throw new Error('"posts" に PosterSpec の配列を入れてください');
    if (o.posts.length > IG_MAX_IMAGES) throw new Error(`画像は ${IG_MAX_IMAGES} 枚までです`);
    if (count && o.posts.length !== count) throw new Error(`画像はちょうど ${count} 枚にしてください（${o.posts.length} 枚でした）`);
    const posts = o.posts.map((p) => fixSize(PosterSpecSchema.parse(p), w, h));
    return { title: typeof o.title === "string" && o.title.trim() ? o.title.trim() : posts[0].meta.title, posts };
  }, '{"title", "posts"} の JSON ', opts.onProgress, opts.signal);
}

// ---------- 参考画像の再現（A4 モード） ----------

const fontListText = FONT_CATALOG.map((f) => `- "${f.family}"（${FONT_ROLE_LABELS[f.role]}${f.script === "ja" ? "" : `・${FONT_SCRIPT_LABELS[f.script]}`}・ウェイト ${f.weights.join("/")}）: ${f.mood}`).join("\n");

/**
 * 参考画像の画像領域の切り抜き指定。src に "ref:x,y,w,h"（参考画像のピクセル座標）と書くと、
 * クライアントがその範囲を参考画像から切り抜いて取り込み、本物の画像パスに置き換える
 */
const REPRODUCE_RULES = (w: number, h: number) => `# 再現のルール（「雰囲気を参考に」ではなく、見た目をそのまま写し取る）
- 添付の参考画像は ${w}×${h}px で、ポスターの座標系（meta.width=${w}, meta.height=${h}）と 1:1 に対応する。各要素の x, y, w, h は画像上の位置をピクセル単位で測って決める。目分量で中央に寄せたり、整列させたり、余白を整えたりしない（元がずれていればずれたまま写す）。
- 文字: 画像に見えるすべての文字を、一字一句・改行位置・記号・全角半角まで正確に書き写す（ブリーフの文言より画像を優先。ブリーフで差し替えを指示された箇所だけ変える）。サイズ・色・太さ・字間・行間・回転・縁取り・影が異なるまとまりごとに別のテキストレイヤーにする。
  - size は文字の高さ（漢字・かなの字面の高さ ≒ size × 0.88）から逆算する。w は実際の文字列の幅に合わせ、行が意図せず折り返さないよう少し余裕を持たせる。fit は付けない。
  - font は下のフォント一覧から、字形が最も近いものをファミリー名で直接書く（"display" などのトークンは使わない）。weight はそのフォントにあるウェイトから選ぶ。「かな・英数のみ」「英数字のみ」のフォントは、そのレイヤーの文字がすべてその範囲に収まるとき（漢字を含まない／英数字だけ）にだけ使う。
  - 袋文字・縁取りは outlines、ドロップシャドウは shadow、斜体は skewX、傾きは rotation で再現する。
- 色: テーマトークン（$primary など）は使わず、画像からスポイトで取ったような "#rrggbb" を直接書く。グラデーションは stops と angle を画像に合わせる。theme は何でもよい（色は直接指定するので影響しない）。
- 図形: 帯・枠・角丸ボックス・円・線・吹き出し・リボン・背景の模様などは shape（rect / ellipse / path）や component で描く。複雑な輪郭は shape="path" の d（0..1 の正規化座標）でなぞる。不透明度・角丸・枠線の太さも合わせる。
- 写真・イラスト・ロゴ・キャラクター・複雑なグラフィックなど、図形や文字で描けないもの:
  - その範囲に上に載る文字が無いなら、image レイヤーにして "src": "ref:x,y,w,h"（参考画像から切り抜く範囲。レイヤーの x,y,w,h と同じ）を書く。参考画像の該当部分がそのまま使われる。asset.prompt にも内容を英語で短く（10 語程度）書いておく（あとで作り直すとき用）。
  - 切り抜きは参考画像の見えている姿そのものなので、rotation は付けない（傾いていても、傾いたまま切り抜かれる）。レイヤーの位置・大きさは切り抜き範囲に自動で合わせられる。
  - 対象が長方形でないとき（傾いたスマホ・斜めの帯の中の写真・人物や物の切り抜き・角丸や円の写真など）は、四角で切り抜くと周りの背景まで一緒に写り込んで雑に見える。"src": "ref:x,y,w,h;x1 y1,x2 y2,x3 y3,..." と、; のあとに対象の輪郭を多角形の頂点（ポスター座標・ピクセル）で書く。輪郭の外は透明になり、後ろの図形レイヤーが見える。
    - 頂点は輪郭の角や曲がり目ごとに打ち、曲線（角丸・円）は 8〜24 点で細かくなぞる。背景がはみ出さないよう、輪郭より 1〜2px 内側をなぞる。
    - スマホなどは、画面だけでなく本体の縁まで含めて 1 枚で切り抜く（縁を図形で描き直すと、写真とずれて見える）。
    - 輪郭の外側に見えていた背景（帯・三角・模様など）は、写真より下のレイヤーとして図形で描く。写真の上に重なっている飾りや吹き出しは、写真より上のレイヤーにする。
  - 切り抜く範囲に、テキストレイヤーとして再現する文字が重なっていてはいけない（文字が二重になる）。文字が上に載っている写真・背景は、src を書かずに asset.prompt で「文字の無い」画像を生成させるか、図形・グラデーションで近似する。
  - ポスター全面の背景も、模様や写真で文字が上に載るなら同じ扱い。単色・グラデーションなら background の fill で再現する。
- 重なり順（layers の並び）も画像どおりにする。要素を省略しない。小さな飾り・区切り線・アイコン・注釈も拾う。
- meta.imageStyle には参考画像の画風を英語で 1 文書く（生成する画像を元の画風にそろえるため）。

# 使えるフォント
${fontListText}`;

const toHigh = (img: ImageRef): ImageRef => ({ ...img, detail: "high" });

/**
 * 並べて書かせる帯の数。所要時間のほとんどは JSON の書き出し（1 枚で 100 レイヤー・2 万字ほどになり 4 分前後かかる）なので、
 * ポスターを横に帯へ分け、帯ごとに同時に書かせて待ち時間を縮める
 */
const REPRODUCE_BANDS = 6;

type SpecLayer = PosterSpec["layers"][number];

/**
 * 参考画像（1 枚）の見た目をそのまま PosterSpec に写し取る。
 * 帯ごとに「中心がその帯にある要素」だけを同時に書かせ、つなぎ合わせる（背景は 1 本目の帯が書く）
 */
export async function reproducePoster(opts: { reference: ImageRef; width: number; height: number; brief?: string; onProgress?: OnProgress; signal?: AbortSignal }): Promise<PosterSpec> {
  const { width: w, height: h } = opts;
  const step = Math.ceil(h / REPRODUCE_BANDS);
  const items = Array<number>(REPRODUCE_BANDS).fill(0);
  let writing = false;
  const report = (band: number) => (p: Progress) => {
    if (p.phase === "writing") { writing = true; items[band] = p.items ?? 0; }
    opts.onProgress?.({ phase: writing ? "writing" : "thinking", attempt: p.attempt, items: items.reduce((a, b) => a + b, 0) });
  };
  const bands = await Promise.all(items.map((_, band) => {
    const top = band * step, bottom = Math.min(h, top + step);
    const scope = [
      `# 今回書く範囲（y = ${top}〜${bottom}px の帯）`,
      `ポスターを上から ${REPRODUCE_BANDS} つの帯に分け、別々に書いてからつなぎ合わせます。今回は ${band + 1} 本目の帯です。`,
      `- layers には、中心の y（y + h / 2）が ${top} 以上 ${bottom} 未満の要素だけを書く。帯からはみ出す要素も、中心が帯の中ならはみ出した部分まで含めて丸ごと書く。中心が帯の外の要素は書かない（ほかの帯で書く）。`,
      band === 0
        ? "- ポスター全面の背景（background レイヤー）はこの帯で書く。"
        : "- background レイヤーは書かない（1 本目の帯で書く）。",
      `- id は "b${band + 1}-" で始める（ほかの帯と重ならないように）。`,
      "- 帯の外も見て、色・フォント・文字の大きさの決め方がポスター全体でそろうようにする。",
    ].join("\n");
    const text = [
      `添付画像（参考画像）のポスターを、できるだけ忠実に再現した PosterSpec を作ってください。meta.width は ${w}、meta.height は ${h} にします。`,
      REPRODUCE_RULES(w, h),
      scope,
      opts.brief?.trim() ? `# ユーザーからの補足（文言の差し替えなど。指示が無い部分は画像どおり）\n${opts.brief.trim()}` : "",
      "# 出力\nPosterSpec の JSON のみを出力してください（layers は今回の帯の要素だけ）。",
    ].filter(Boolean).join("\n\n");
    return generateJson({ role: "user", text, images: [toHigh(opts.reference)] }, (j) => PosterSpecSchema.parse(j), undefined, report(band), opts.signal);
  }));
  return fixSize({ ...bands[0], layers: mergeBandLayers(bands.map((b, i) => b.layers.filter((l) => i === 0 || l.type !== "background"))) }, w, h);
}

/**
 * 帯ごとのレイヤーを 1 つの重なり順にする。帯の中の順はそのまま保ち、帯どうしでは面積の大きいものを先（背面）にする
 * （大きな帯・写真の上に小さな文字や飾りが載るのがふつうなので）。背景は最背面。id がかぶれば付け直す
 */
function mergeBandLayers(bands: SpecLayer[][]): SpecLayer[] {
  const area = (l: SpecLayer) => (l.type === "background" ? Infinity : Math.abs(l.w * l.h));
  const queues = bands.map((b) => [...b]);
  const out: SpecLayer[] = [];
  while (queues.some((q) => q.length)) {
    const q = queues.filter((q) => q.length).reduce((a, b) => (area(b[0]) > area(a[0]) ? b : a));
    out.push(q.shift()!);
  }
  const seen = new Set<string>();
  const uniq = (l: SpecLayer): SpecLayer => {
    let id = l.id;
    for (let n = 2; seen.has(id); n++) id = `${l.id}-${n}`;
    seen.add(id);
    return l.type === "group" ? { ...l, id, children: l.children.map(uniq) } : { ...l, id };
  };
  return out.map(uniq);
}

/**
 * 再現の仕上げ: 参考画像と、今の PosterSpec を描画した画像を見比べて、ずれを直す。
 * 1 枚目が参考画像、2 枚目が現在の描画結果。
 * spec 全体を書き直させると出力が長く時間がかかるので、直したレイヤーだけを差分（LayerPatch）で返させてここで当てる
 */
export async function refineReproduction(opts: { reference: ImageRef; render: ImageRef; spec: PosterSpec; onProgress?: OnProgress; signal?: AbortSignal }): Promise<{ reply: string; spec?: PosterSpec }> {
  const { width: w, height: h } = opts.spec.meta;
  const text = [
    `1 枚目は参考画像、2 枚目は下の PosterSpec を描画した結果です（どちらも ${w}×${h}px で、ポスターの座標と 1:1）。2 枚目が 1 枚目と見分けがつかなくなるように PosterSpec を修正してください。`,
    "まず 2 枚を領域ごとに見比べ、ずれを洗い出してから直してください: 文字の誤字・脱字・改行位置、文字の大きさ・太さ・フォントの字形・字間・行間、要素の位置とサイズ（数 px 単位で）、色・グラデーション、縁取り・影、図形の形・角丸、重なり順、抜けている要素・余計な要素、画像の切り抜き範囲（四角く切り抜いたせいで周りの背景が写り込んでいないか、輪郭が欠けていないか）。",
    "src が \"/generated/...\" の画像は、切り抜き範囲や輪郭を変えるとき（背景が写り込んでいる・欠けているなど）だけ src を \"ref:x,y,w,h\" または \"ref:x,y,w,h;輪郭\" に書き換えてください（参考画像からもう一度切り抜かれます）。",
    REPRODUCE_RULES(w, h),
    "# 現在の PosterSpec",
    JSON.stringify(opts.spec),
    "# 出力（直したところだけを書く）",
    [
      "次の形の JSON のみを出力してください。直さないレイヤーは書かないでください（現在のまま残ります）。",
      '{"reply": 主に何を直したかを日本語 1〜3 文で, "changes": {',
      '  "update": [{"id": 既存レイヤーの id, 変えるフィールドだけ（値はそのフィールドの新しい値全体。fill・outlines・children なども丸ごと書く。フィールドを消すなら null）}],',
      '  "add": [新しいレイヤー全体（一意な id 付き）],',
      '  "remove": [消すレイヤーの id],',
      '  "order": 重なり順を変える・追加したレイヤーを最前面以外に置くときだけ、最終的な全レイヤーの id を最背面から順に並べた配列（それ以外は書かない）,',
      '  "meta": imageStyle などを変えるときだけ',
      "}}",
      'もう直すところが無ければ "changes" は null にしてください。',
    ].join("\n"),
  ].join("\n\n");
  return generateJson(
    { role: "user", text, images: [toHigh(opts.reference), toHigh(opts.render)] },
    (j) => {
      const o = j as { reply?: unknown; changes?: unknown };
      const reply = typeof o?.reply === "string" ? o.reply : "";
      if (o?.changes == null) return { reply };
      const patch = parsePatch(o.changes);
      return isEmptyPatch(patch) ? { reply } : { reply, spec: applyLayerPatch(opts.spec, patch) };
    },
    '{"reply", "changes"} の JSON ',
    opts.onProgress,
    opts.signal,
  );
}

/** 座標の基準がずれないよう、キャンバスの大きさは参考画像に合わせて固定する */
const fixSize = (spec: PosterSpec, width: number, height: number): PosterSpec => ({ ...spec, meta: { ...spec.meta, width, height } });

/** 資料全体のスライド（PPTX エディターモード。現在のスライド以外も含む）。spec が無いものは文字だけの参考 */
type SlideRef = { number: number; title?: string; spec?: PosterSpec; texts?: string[] };
export type DeckContext = { current: number; total: number; slides: SlideRef[]; instagram?: boolean };

/**
 * チャットの文脈。会話は 1 本で無限に続くので、全文は渡さない:
 * - memory: 古いやりとりの要約（ローリング要約。summarizeChat で更新）
 * - history: 要約していない直近のやりとり（原文）。note は「別のポスターを開いた」などの出来事
 * 現在の状態は毎回 PosterSpec そのものを渡すので、会話には意図・好み・決定事項だけが残っていればよい
 */
export type ChatTurn = { role: "user" | "assistant" | "note"; text: string };
type EditResult = { reply: string; spec?: PosterSpec; target?: number; remove?: number[] };
/**
 * デッキの全スライドへの指示（「授業スライド全体の差し色を変えて」）を 1 枚ずつ当てるときの、今直しているスライドの位置。
 * guide は先に直したスライドで AI が返した方針（ほかのスライドでも同じ直し方にそろえるため）
 */
export type AcrossDeck = { number: number; total: number; guide?: string };
type EditOptions = { spec: PosterSpec; instruction: string; selectedIds?: string[]; deck?: DeckContext; across?: AcrossDeck; history?: ChatTurn[]; memory?: string; instagram?: boolean; references?: PosterReference[]; signal?: AbortSignal };

/** Instagram の投稿画像を直すときの前置き */
const instagramNote = (spec: PosterSpec) => `これは Instagram の投稿画像です（ポスターではない）。次の決まりを守ってください。\n${instagramRules(spec.meta.width, spec.meta.height)}`;

const turnLine = (t: ChatTurn) => (t.role === "note" ? `（${t.text}）` : `${t.role === "user" ? "ユーザー" : "あなた"}: ${t.text}`);

const historyText = (history?: ChatTurn[], memory?: string) => [
  memory ? `# これまでの会話の要約（古い部分。ユーザーの好みや決定事項は引き続き守る）\n${memory}` : "",
  history?.length ? "# 直近の会話（古い順。「さっきの」「それ」などはここを参照）\n" + history.map(turnLine).join("\n") : "",
].filter(Boolean).join("\n\n");

const SUMMARY_MAX = 2000;
const SUMMARY_SYSTEM = `あなたはデザイン支援チャットの会話記録係です。ユーザーと AI デザイナーがポスター／スライドを修正してきた会話を、あとで会話を続けるための「記憶」として要約します。
残すもの（重要な順）:
- ユーザーの好み・こだわり・NG（色、フォント、雰囲気、文言、「〜はしないで」など）
- 決定事項と、正確に保つべき情報（日時・場所・URL・固有名詞）
- まだ終わっていない依頼や、あとで対応すると約束したこと
- 却下された案（同じ提案を繰り返さないため）
- どのポスター／スライドで何をしたかの大まかな経緯
捨てるもの: あいさつ、座標や数値の細かい変更履歴（現在の状態はポスターそのものに残っている）、エラーやキャンセル。
出力は日本語の箇条書きのみ（前置き不要）。全体で ${SUMMARY_MAX} 文字以内。古い情報と新しい情報が矛盾したら新しい方を残す。`;

/** ローリング要約: 既存の要約 ＋ 押し出された古いやりとり → 新しい要約 */
export async function summarizeChat(opts: { summary?: string; turns: ChatTurn[]; signal?: AbortSignal }): Promise<string> {
  const text = [
    opts.summary ? `# これまでの要約\n${opts.summary}` : "# これまでの要約\n（なし）",
    `# 要約に取り込むやりとり（古い順）\n${opts.turns.map(turnLine).join("\n")}`,
    "# 出力\n上の 2 つを統合した新しい要約だけを出力してください。",
  ].join("\n\n");
  const out = (await askAI(SUMMARY_SYSTEM, [{ role: "user", text }], undefined, opts.signal)).trim();
  if (!out) throw new Error("要約が空でした");
  return out.slice(0, SUMMARY_MAX + 500);
}

/** {reply, spec} を検証する。spec が null なら変更なし（質問への回答など）。古い形式（PosterSpec だけ）も受け付ける */
function parseEdit(j: unknown): { reply: string; spec?: PosterSpec } {
  const o = j as { reply?: unknown; spec?: unknown; layers?: unknown };
  if (o && Array.isArray(o.layers)) return { reply: "", spec: PosterSpecSchema.parse(o) };
  const reply = typeof o?.reply === "string" ? o.reply : "";
  if (o?.spec == null) {
    if (!reply) throw new Error('"reply" と "spec" のどちらもありません');
    return { reply };
  }
  return { reply, spec: PosterSpecSchema.parse(o.spec) };
}

const REPLY_RULE = '"reply" には、何をどう変えたか（または質問への答え）をユーザーに向けて日本語 1〜3 文で簡潔に書いてください。デザインの相談や質問だけで変更が不要なら "spec" は null にしてください。';

const acrossNote = (a: AcrossDeck) => [
  `このメッセージはデッキ（全 ${a.total} 枚）のすべてのスライドに向けた指示です。今はそのうちスライド ${a.number} を直しています。ほかのスライドも同じ指示で別に直すので、このスライドのことだけを考えてください。`,
  "直近の会話で今のスライドだけに行った変更（「そうして」「同じように」が指すもの）も、このスライドに同じように当ててください。このスライドに当てはまる箇所が無ければ \"spec\" は null にしてください。",
  a.guide ? `先に直したスライドでは次のように直しました。同じ方針（同じ色・同じ種類の要素）にそろえてください:\n${a.guide}` : "",
].filter(Boolean).join("\n");

/** 既存の PosterSpec をチャットの指示で修正する。デッキがあれば全スライドを参照するデッキ用の修正に回す */
export async function editPoster(opts: EditOptions): Promise<EditResult> {
  const r = await editSpec(opts);
  // BGM は AI に触らせない（書き戻しで落とされても、書き換えたスライドの元の BGM を残す）
  if (!r.spec || r.spec.bgm?.length) return r;
  const target = r.target ?? opts.deck?.current;
  const bgm = target === undefined || target === opts.deck?.current ? opts.spec.bgm : opts.deck?.slides.find((s) => s.number === target)?.spec?.bgm;
  return bgm?.length ? { ...r, spec: { ...r.spec, bgm } } : r;
}

async function editSpec(opts: EditOptions): Promise<EditResult> {
  if (opts.deck) return editDeckSlide({ ...opts, deck: opts.deck });
  const text = [
    "あなたはユーザーとチャットしながらポスターを仕上げています。次の PosterSpec をユーザーのメッセージに従って修正してください。指示と無関係なレイヤーは id・値ともにそのまま残してください。",
    opts.instagram ? instagramNote(opts.spec) : "",
    opts.across ? acrossNote(opts.across) : "",
    "src が設定済みの画像は、内容を変える指示がない限り src と asset をそのまま残してください（再生成させたい場合は src を削除し asset.prompt を更新）。",
    referenceSources(opts.references),
    opts.selectedIds?.length ? `ユーザーが選択中のレイヤー: ${opts.selectedIds.join(", ")}` : "",
    historyText(opts.history, opts.memory),
    "# ユーザーのメッセージ",
    opts.instruction,
    "# 現在の PosterSpec",
    JSON.stringify(opts.spec),
    "# 出力",
    `{"reply": 返答, "spec": 修正後の PosterSpec 全体 または null} の JSON のみを出力してください。${REPLY_RULE}`,
  ].filter(Boolean).join("\n\n");
  return generateJson({ role: "user", text, images: opts.references }, (j) => {
    const result = parseEdit(j);
    return result.spec ? { ...result, spec: resolveReferenceSources(result.spec, opts.references, opts.spec) } : result;
  }, '{"reply", "spec"} の JSON ', undefined, opts.signal);
}

/**
 * 「スライド8の内容をスライド5に反映」のように別のスライドを参照する指示。
 * 言及されたスライドの spec も渡し、どのスライドを書き換えるか（target）と修正後の spec を返させる。
 * 「スライド18,19を1枚にまとめて」のような統合では、不要になったスライドの番号（remove）も返させる（削除は画面側で確認してから行う）
 */
async function editDeckSlide(opts: EditOptions & { deck: DeckContext }): Promise<EditResult> {
  const { current, total } = opts.deck;
  const slides = [{ number: current, title: opts.spec.meta.title, spec: opts.spec }, ...opts.deck.slides.filter((s) => s.number !== current)]
    .sort((a, b) => a.number - b.number);
  // 書き換え・統合の対象は spec が渡されたスライドだけ。文字だけのスライドは参考として見せる
  const editable = slides.filter((s): s is typeof s & { spec: PosterSpec } => !!s.spec);
  const numbers = editable.map((s) => s.number);
  const text = [
    opts.deck.instagram
      ? `これは ${total} 枚の画像からなる Instagram のカルーセル投稿です。以下では各画像を「スライド」と呼びます。各スライドは 1 つの PosterSpec です。ユーザーは今スライド ${current} を開いています。\n${instagramNote(opts.spec)}`
      : `これは ${total} 枚のスライドからなるデッキです。各スライドは 1 つの PosterSpec です。ユーザーは今スライド ${current} を開いています。`,
    referenceSources(opts.references),
    "資料の構成や内容について相談されたら、渡された全スライドを参照して答えてください。相談や確認だけなら spec は null にし、スライドを変更しないでください。",
    "指示を読み、書き換えるべきスライドを 1 枚だけ選んで修正してください。「AをBに反映」「Aに合わせてBを直す」なら書き換えるのは B、参照元の A は変更しません。書き換え先が読み取れなければ、今開いているスライドを書き換えます。",
    "「スライドAとBを1枚にまとめて」のように複数のスライドを統合する指示なら、まとめ先（指示が無ければ番号の小さい方）を target にして、統合するスライドすべての内容（見出し・本文・図や画像）を 1 枚に収まるよう整理し直し、不要になったスライドの番号を \"remove\" に入れてください。統合でなければ \"remove\" は空配列にします。",
    "文字だけの参考スライドは内容を知るための資料です。そこに書かれた内容を取り込むときは、書き換え先のスライドに書き写してください（参考スライドを target や remove にはできません）。",
    "参照元から内容（文言・レイヤー・画像など）を持ち込むときは、書き換え先のスライドのサイズ・テーマ・既存のレイアウトになじむように配置し、id は書き換え先の中で一意にしてください。指示と無関係なレイヤーは id・値ともにそのまま残してください。",
    "src が設定済みの画像は、内容を変える指示がない限り src と asset をそのまま残してください（参照元の画像を使う場合も src ごと持ち込んでよい）。",
    opts.selectedIds?.length ? `ユーザーがスライド ${current} で選択中のレイヤー: ${opts.selectedIds.join(", ")}` : "",
    historyText(opts.history, opts.memory),
    "# ユーザーのメッセージ",
    opts.instruction,
    ...slides.map((s) => s.spec
      ? `# スライド ${s.number}${s.number === current ? "（今開いているスライド）" : ""}${s.title ? `「${s.title}」` : ""}\n${JSON.stringify(s.spec)}`
      : `# スライド ${s.number}${s.title ? `「${s.title}」` : ""}（文字だけの参考。書き換え・統合の対象にはしない）\n${(s.texts ?? []).join(" / ") || "（文字なし）"}`),
    "# 出力",
    `{"reply": 返答, "target": 書き換えるスライド番号（${numbers.join(" / ")} のいずれか）, "spec": 修正後のそのスライドの PosterSpec 全体 または null, "remove": 統合して不要になったスライド番号の配列} の JSON のみを出力してください。${REPLY_RULE}`,
  ].filter(Boolean).join("\n\n");
  return generateJson({ role: "user", text, images: opts.references }, (j) => {
    const r = parseEdit(j);
    if (!r.spec) return r;
    const raw = (j as { target?: unknown })?.target;
    const target = raw == null ? current : Number(raw);
    if (!numbers.includes(target)) throw new Error(`target は ${numbers.join(" / ")} のいずれかにしてください（受け取った値: ${String(raw)}）`);
    const remove = [...new Set(Array.isArray((j as { remove?: unknown })?.remove) ? (j as { remove: unknown[] }).remove.map(Number) : [])]
      .filter((n) => n !== target && numbers.includes(n));
    return { ...r, spec: resolveReferenceSources(r.spec, opts.references, slides.find((s) => s.number === target)?.spec), target, ...(remove.length ? { remove } : {}) };
  }, '{"reply", "target", "spec", "remove"} の JSON ', undefined, opts.signal);
}

// ---------- スライドの追加 ----------

/** デッキの並び（追加するスライドの文脈）。座標や色は要らないので、文字だけ */
export type OutlineSlide = { number: number; title?: string; texts: string[] };

/**
 * 「最後にクロージングのスライドを 1 枚追加して」: デッキに新しいスライドを 1 枚作る（既存のスライドは変えない）。
 * position は追加後のスライド番号（1〜total+1）。outline はデッキ全体の文字、samples は見た目をそろえるお手本（前後のスライドなど）
 */
export async function planSlide(opts: {
  instruction: string; position: number; total: number; deckTitle?: string; outline: OutlineSlide[]; samples: SlideRef[];
  history?: ChatTurn[]; memory?: string; instagram?: boolean; signal?: AbortSignal;
}): Promise<{ reply: string; spec: PosterSpec }> {
  const base = opts.samples[0]?.spec;
  if (!base) throw new Error("お手本のスライドがありません");
  const { width, height } = base.meta;
  const unit = opts.instagram ? "画像" : "スライド";
  const text = [
    opts.instagram
      ? `これは ${opts.total} 枚の画像からなる Instagram のカルーセル投稿です。ここに新しい画像を 1 枚追加します。\n${instagramNote(base)}`
      : `これは ${opts.total} 枚のスライドからなるデッキです。ここに新しいスライドを 1 枚追加します。既存のスライドは変更しません。`,
    `新しい${unit}は追加後の${unit} ${opts.position} になります（${opts.position > opts.total ? "末尾" : `今の${unit} ${opts.position} の前`}）。ユーザーのメッセージに沿った内容の ${unit}を 1 枚、PosterSpec として新しく作ってください。`,
    [
      `- サイズは ${width}x${height}（meta.width / meta.height はこのまま）。theme・配色・フォント・余白・見出しの位置と大きさ・ページ番号や装飾などの共通要素は、お手本のスライドと同じデザインにそろえる（デッキの一部に見えるように）。`,
      "- 文言はデッキの内容（タイトル・発表者・団体名など）に合わせる。デッキに無い事実（日時・URL・連絡先など）は作らない。",
      "- お手本の画像（src 付き）は、ロゴのように全スライド共通のものだけ src ごと持ち込んでよい。新しい画像が必要なら src を付けずに asset.prompt を書く。",
      opts.instagram ? "" : "- アンケート・申込などの QR コードを求められたら component \"qr\" を大きめ（スライドの高さの 4〜5 割）に置く。URL がメッセージにあれば props.url に入れ、無ければ props.url は空文字 \"\" にする（画面では「QR の URL を入れてください」という空の枠になり、あとでユーザーが URL を入れる）。",
      "- notes（台本）は、ほかのスライドに台本があれば同じ口調で短く書く。無ければ空でよい。",
    ].filter(Boolean).join("\n"),
    historyText(opts.history, opts.memory),
    "# ユーザーのメッセージ",
    opts.instruction,
    `# デッキの並び${opts.deckTitle ? `「${opts.deckTitle}」` : ""}（文字のみ。上から読む順）`,
    opts.outline.map((s) => `- ${unit} ${s.number}${s.title ? `「${s.title}」` : ""}: ${s.texts.join(" / ").slice(0, 300) || "（文字なし）"}`).join("\n"),
    ...opts.samples.map((s) => `# お手本: ${unit} ${s.number}${s.title ? `「${s.title}」` : ""}\n${JSON.stringify(s.spec)}`),
    "# 出力",
    `{"reply": 返答, "spec": 新しい${unit}の PosterSpec 全体} の JSON のみを出力してください。"reply" には、どんな${unit}を何枚目に追加したか（QR の URL を入れていなければ、QR の部品を選んで右のパネルの「QR の URL」に入れると読み取れる QR になること）をユーザーに向けて日本語 1〜3 文で書いてください。`,
  ].filter(Boolean).join("\n\n");
  return generateJson({ role: "user", text }, (j) => {
    const r = parseEdit(j);
    if (!r.spec) throw new Error('"spec" に新しいスライドの PosterSpec を入れてください');
    return { reply: r.reply, spec: fixSize(r.spec, width, height) };
  }, '{"reply", "spec"} の JSON ', undefined, opts.signal);
}

// ---------- 台本 ----------

/** 台本を書くときに渡すスライドの中身（読む順の文字と画像の説明。レイヤーの座標や色は台本に要らない） */
export type NotesSlide = { number: number; title?: string; texts: string[]; images?: string[]; notes?: string };

const NOTES_SYSTEM = `あなたはプレゼンテーションの台本作家です。スライドのデッキを読み、発表者がそのまま読み上げられる台本（スライドのノート）を書きます。
- 台本はそのスライドに書かれている内容（文字・箇条書き・画像）を話すもの。見出しや箇条書きの一つ一つを拾い、何を伝えるスライドなのかが聞き手に伝わるようにする
- スライドの文字をそのまま読み上げるのではなく、補足・具体例・聞き手への問いかけ・次のスライドへのつなぎを入れる。画像は「画像:」の説明を手がかりに、聞き手が見ているものとして触れる
- 前後のスライドの流れを踏まえる
- すでに台本があるスライドは発表者本人の書いたお手本。口調（です・ます／だ・である／くだけた話し方）、一人称、聞き手の呼びかけ方、語尾の癖、話し始め方、段落の分け方、1 枚あたりの長さをそこから読み取り、新しい台本も同じ人が書いたと分かるようにそろえる
- お手本が無いときは、話し言葉（です・ます調）で 1 枚 30 秒〜1 分程度（150〜300 字が目安。表紙やまとめ・区切りのスライドは短くてよい）
- スライドに無い事実（数値・日付・固有名詞）を作らない。分からないところは一般的な言い方にとどめる
- 段落の区切りは改行（\\n）。見出し・箇条書きの記号・「スライド○：」のような前置きは付けない`;

/**
 * デッキの targets の番号のスライドに台本を書く（台本があれば書き直す）。slides はデッキ全体で、流れの文脈と、targets 以外の台本を口調・長さのお手本に使う。
 * request はユーザーの指示文（「短めに」「英語で」など。あればお手本より優先）
 */
export async function writeNotes(opts: { deckTitle?: string; slides: NotesSlide[]; targets: number[]; request?: string; signal?: AbortSignal }): Promise<{ number: number; notes: string }[]> {
  const targets = opts.targets.filter((n) => opts.slides.some((s) => s.number === n));
  if (!targets.length) return [];
  const slideText = (s: NotesSlide) => [
    `## スライド ${s.number}${s.title ? `「${s.title}」` : ""}${targets.includes(s.number) ? "（台本を書く）" : ""}`,
    s.texts.length ? `文字（上から読む順）:\n${s.texts.join("\n").slice(0, 2000)}` : "文字: （なし）",
    ...(s.images ?? []).slice(0, 8).map((d) => `画像: ${d}`),
    !s.notes?.trim() ? ""
      : targets.includes(s.number) ? `今の台本（書き直す。お手本ではない）:\n${s.notes.trim().slice(0, 1500)}`
      : `既存の台本（お手本）:\n${s.notes.trim().slice(0, 1500)}`,
  ].filter(Boolean).join("\n");
  const len = notesLength(opts.slides.filter((s) => !targets.includes(s.number)).map((s) => s.notes));
  const style = len
    ? `すでに台本がある ${len.count} 枚をお手本に、口調・言い回し・段落の分け方をそろえてください。長さもお手本に合わせ、1 枚あたり ${len.median} 字前後（お手本は ${len.min}〜${len.max} 字）にしてください（スライドの中身が少ない表紙・区切りは短めでよい）。`
    : "";
  const text = [
    `# デッキ${opts.deckTitle ? `「${opts.deckTitle}」` : ""}（全 ${opts.slides.length} 枚）`,
    ...opts.slides.map(slideText),
    "# 出力",
    [style, opts.request?.trim() ? `ユーザーの指示（口調・長さなどの指定があればお手本より優先）: ${opts.request.trim()}` : "", `スライド ${targets.join("・")} の台本を書き、{"notes": [{"number": スライド番号, "text": 台本}]} の JSON のみを出力してください。対象のスライドすべてについて 1 件ずつ書いてください。`].filter(Boolean).join("\n"),
  ].join("\n\n");
  const Out = z.object({ notes: z.array(z.object({ number: z.coerce.number(), text: z.string() })) });
  const turns: Turn[] = [{ role: "user", text }];
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    opts.signal?.throwIfAborted(); // 中断したら書き直しもしない
    const out = await askAI(NOTES_SYSTEM, turns, undefined, opts.signal);
    try {
      const got = new Map(Out.parse(extractJson(out, "台本の JSON")).notes.map((n) => [n.number, n.text.trim()] as const));
      const result = targets.flatMap((n) => (got.get(n) ? [{ number: n, notes: got.get(n)! }] : []));
      if (!result.length) throw new Error("対象のスライドの台本がありません");
      return result;
    } catch (e: any) {
      lastError = e?.message ?? String(e);
      turns.push({ role: "assistant", text: out }, { role: "user", text: `出力に問題がありました。{"notes": [...]} の JSON だけを出力し直してください。\n\nエラー:\n${lastError.slice(0, 2000)}` });
    }
  }
  throw new Error(`台本の生成に失敗しました: ${lastError.slice(0, 300)}`);
}
