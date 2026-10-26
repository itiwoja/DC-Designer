import type { Layer, PosterSpec } from "./schema";

/**
 * フォントの提案・インストールで使うフォントのカタログ（すべて Google Fonts・OFL か Apache）。
 * ChatGPT への候補一覧、ブラウザでのプレビュー読み込み、OS へのインストール、SVG・PPTX 書き出しのサブセット取得で共通に使う。
 * 収録している文字（script）で 3 つに分ける。足りない文字はほかのフォント（Noto Sans JP）で表示されるので、
 * かな・英字だけのフォントは、その文字だけでできた見出しやロゴ向け
 */
export type FontRole = "gothic" | "rounded" | "mincho" | "hand" | "pop" | "display" | "mono";
export type FontScript = "ja" | "kana" | "latin";

export interface FontEntry {
  /** カタログ内で一意の ID（ファミリー名から作る。例: "noto-sans-jp"） */
  id: string;
  family: string;
  weights: number[];
  role: FontRole;
  /** 収録している文字。ja: 漢字まで / kana: かな・英数（漢字なし）/ latin: 英数字のみ */
  script: FontScript;
  /** 雰囲気の説明（ChatGPT に渡す） */
  mood: string;
}

export const FONT_ROLE_LABELS: Record<FontRole, string> = {
  gothic: "ゴシック",
  rounded: "丸ゴシック",
  mincho: "明朝・セリフ",
  hand: "手書き・筆記体",
  pop: "ポップ",
  display: "ディスプレイ",
  mono: "等幅",
};

export const FONT_SCRIPT_LABELS: Record<FontScript, string> = {
  ja: "日本語（漢字まで）",
  kana: "かな・英数のみ",
  latin: "英数字のみ",
};

type Entry = Omit<FontEntry, "id" | "script">;

/** 漢字まで入っている日本語フォント */
const JA: Entry[] = [
  { family: "Noto Sans JP", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], role: "gothic", mood: "標準的で癖のないゴシック。ビジネス・説明資料・本文全般" },
  { family: "Zen Kaku Gothic New", weights: [300, 400, 500, 700, 900], role: "gothic", mood: "すっきりした現代的なゴシック。洗練・ややデザイン寄り" },
  { family: "M PLUS 2", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], role: "gothic", mood: "モダンで幾何学的なゴシック。テック・スタートアップ" },
  { family: "M PLUS 1p", weights: [100, 300, 400, 500, 700, 800, 900], role: "gothic", mood: "軽快で明るいゴシック。IT・カジュアルな説明" },
  { family: "IBM Plex Sans JP", weights: [100, 200, 300, 400, 500, 600, 700], role: "gothic", mood: "硬質で知的なゴシック。エンジニアリング・技術発表" },
  { family: "Murecho", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], role: "gothic", mood: "やや手作り感のある柔らかいゴシック。親しみやすい説明" },
  { family: "BIZ UDPGothic", weights: [400, 700], role: "gothic", mood: "ユニバーサルデザイン。読みやすさ最優先・公的資料・学校配布" },
  { family: "Sawarabi Gothic", weights: [400], role: "gothic", mood: "素朴で軽いゴシック。シンプルな本文" },
  { family: "LINE Seed JP", weights: [100, 400, 700, 800], role: "gothic", mood: "明快で親しみやすいモダンゴシック。アプリ・サービス紹介・SNS・広告" },
  { family: "M PLUS 1", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], role: "gothic", mood: "均整の取れた現代的なゴシック。Web・UI・汎用の説明資料" },
  { family: "M PLUS U", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], role: "gothic", mood: "字面が広く濁点の大きい読みやすいゴシック。案内表示・高齢者や子ども向け" },
  { family: "Zen Kaku Gothic Antique", weights: [300, 400, 500, 700, 900], role: "gothic", mood: "古典的で端正なゴシック。落ち着いた和モダン・老舗・パンフレット" },
  { family: "Kosugi", weights: [400], role: "gothic", mood: "まっすぐで素朴なゴシック（等幅）。昭和風・実直・シンプルな告知" },
  { family: "BIZ UDGothic", weights: [400, 700], role: "gothic", mood: "UD ゴシックの等幅版。表・数字や桁をそろえたい資料・帳票" },
  { family: "M PLUS 1 Code", weights: [100, 200, 300, 400, 500, 600, 700], role: "mono", mood: "等幅のゴシック。プログラムのコード・コマンド・技術資料" },
  { family: "M PLUS Rounded 1c", weights: [100, 300, 400, 500, 700, 800, 900], role: "rounded", mood: "やさしく元気な丸ゴシック。学校・子ども向け・イベント告知" },
  { family: "Zen Maru Gothic", weights: [300, 400, 500, 700, 900], role: "rounded", mood: "上品で落ち着いた丸ゴシック。福祉・医療・やさしい案内" },
  { family: "Kosugi Maru", weights: [400], role: "rounded", mood: "素直な丸ゴシック。親しみやすい本文" },
  { family: "Kiwi Maru", weights: [300, 400, 500], role: "rounded", mood: "ふんわりレトロな丸文字。ほっこり・カフェ・絵本風" },
  { family: "Noto Serif JP", weights: [200, 300, 400, 500, 600, 700, 800, 900], role: "mincho", mood: "標準的な明朝。論文・格式・落ち着いた本文" },
  { family: "Shippori Mincho", weights: [400, 500, 600, 700, 800], role: "mincho", mood: "伝統的で美しい明朝。和風・文学・高級感" },
  { family: "Zen Old Mincho", weights: [400, 500, 600, 700, 900], role: "mincho", mood: "古風で力強い明朝。歴史・和の催し・見出し" },
  { family: "BIZ UDPMincho", weights: [400, 700], role: "mincho", mood: "読みやすい明朝。公的文書・長文" },
  { family: "Kaisei Opti", weights: [400, 500, 700], role: "mincho", mood: "端正でモダンな明朝。上品な見出し・ブランド" },
  { family: "Kaisei Decol", weights: [400, 500, 700], role: "mincho", mood: "装飾的で柔らかい明朝。ロマンチック・おしゃれ" },
  { family: "Hina Mincho", weights: [400], role: "mincho", mood: "繊細で可憐な明朝。エレガント・女性的" },
  { family: "Shippori Mincho B1", weights: [400, 500, 600, 700, 800], role: "mincho", mood: "Shippori Mincho の仮名を太く力強くした版。小説の表紙・力のある見出し" },
  { family: "Kaisei HarunoUmi", weights: [400, 500, 700], role: "mincho", mood: "波打つような柔らかい仮名の明朝。エッセイ・やさしい物語・温かい本文" },
  { family: "BIZ UDMincho", weights: [400, 700], role: "mincho", mood: "読みやすい明朝の等幅版。公的文書・表組み" },
  { family: "Sawarabi Mincho", weights: [400], role: "mincho", mood: "素朴で軽い明朝。シンプルな本文・手作りの冊子" },
  { family: "New Tegomin", weights: [400], role: "mincho", mood: "方眼に描いた手書き感のある明朝。文芸・個性的で温かい見出し" },
  { family: "Klee One", weights: [400, 600], role: "hand", mood: "教科書体風の手書き。丁寧・教育・ノート" },
  { family: "Yomogi", weights: [400], role: "hand", mood: "ペン書き風の手書き。ゆるい・メモ・吹き出し" },
  { family: "Zen Kurenaido", weights: [400], role: "hand", mood: "筆ペン風の手書き。温かみ・手紙" },
  { family: "Yusei Magic", weights: [400], role: "hand", mood: "マジックペン風。手作りポップ・黒板" },
  { family: "Hachi Maru Pop", weights: [400], role: "hand", mood: "丸っこい女子高生文字。かわいい・ギャル風" },
  { family: "Yuji Syuku", weights: [400], role: "hand", mood: "毛筆の楷書。和風・書道・伝統行事" },
  { family: "Yuji Mai", weights: [400], role: "hand", mood: "流れるような毛筆。情緒的・和風の催し・季節の挨拶" },
  { family: "Yuji Boku", weights: [400], role: "hand", mood: "素朴で楽しげな毛筆。和菓子・地域のお祭り・ほっこり和風" },
  { family: "Dela Gothic One", weights: [400], role: "display", mood: "極太のインパクトゴシック。強い見出し・スポーツ・告知" },
  { family: "RocknRoll One", weights: [400], role: "display", mood: "太く丸いロック調。元気・ライブ・ゲーム" },
  { family: "Reggae One", weights: [400], role: "display", mood: "角ばった極太。パンチ・漫画・ストリート" },
  { family: "Mochiy Pop One", weights: [400], role: "pop", mood: "もちもちのポップ体。かわいい・キッズ・お祭り" },
  { family: "Mochiy Pop P One", weights: [400], role: "pop", mood: "Mochiy Pop One のプロポーショナル版。かなが詰まって見出しが締まる" },
  { family: "Potta One", weights: [400], role: "pop", mood: "筆で描いたような太いポップ。和ポップ・屋台" },
  { family: "Rampart One", weights: [400], role: "display", mood: "立体的な袋文字。にぎやか・タイトルロゴ" },
  { family: "Train One", weights: [400], role: "display", mood: "線で描いた二重線文字。レトロ・おもしろ見出し" },
  { family: "DotGothic16", weights: [400], role: "display", mood: "ドット文字。レトロゲーム・ピクセル" },
  { family: "Zen Antique", weights: [400], role: "display", mood: "アンティーク調の明朝見出し。大正ロマン・レトロ" },
  { family: "Zen Antique Soft", weights: [400], role: "display", mood: "角を丸めたアンティーク体。やわらかいレトロ・喫茶店・昭和モダン" },
  { family: "Shippori Antique", weights: [400], role: "display", mood: "漫画のセリフで使われるアンティーク体。マンガ風・吹き出し・レトロ" },
  { family: "Shippori Antique B1", weights: [400], role: "display", mood: "Shippori Antique の仮名を太くした版。マンガのタイトル・力強いセリフ" },
  { family: "Stick", weights: [400], role: "display", mood: "直線だけで組んだかわいい文字。ゆるい・牧歌的・おしゃれな見出し" },
  { family: "WDXL Lubrifont JP N", weights: [400], role: "display", mood: "縦長で太い中華ポスター風の見出し。セール・告知・インパクト" },
  { family: "Kaisei Tokumin", weights: [400, 500, 700, 800], role: "display", mood: "太く華やかな明朝見出し。特別感・お祝い" },
];

/** かなと英数字だけで、漢字の無いフォント（漢字は Noto Sans JP で表示される） */
const KANA: Entry[] = [
  { family: "Cherry Bomb One", weights: [400], role: "pop", mood: "まるくて弾むようなかわいいかな。お菓子・キッズ・タイトルロゴ" },
  { family: "Darumadrop One", weights: [400], role: "hand", mood: "だるま落としのようにぽってりした手書き。ゆるい・食べ物・ほっこり" },
  { family: "Slackside One", weights: [400], role: "hand", mood: "力の抜けたおしゃれな手書き。カフェ・雑貨・ゆるいコピー" },
  { family: "Monomaniac One", weights: [400], role: "display", mood: "角の丸い縦長の極太ゴシック。縦書きの見出し・漫画・インパクト" },
  { family: "Chokokutai", weights: [400], role: "display", mood: "彫刻刀で彫ったようなファンキーな文字。手作り・木版風・遊び心" },
  { family: "Aoboshi One", weights: [400], role: "mincho", mood: "カッパープレート風の端正なセリフかな。上品・クラシック・ブランド名" },
  { family: "Tsukimi Rounded", weights: [300, 400, 500, 600, 700], role: "rounded", mood: "築地活版の号数活字をもとにした丸いかな。レトロでやさしい見出し" },
  { family: "Kapakana", weights: [300, 400], role: "hand", mood: "カッパープレート体（筆記体）のかな。エレガント・招待状・ロゴ" },
  { family: "Rock 3D", weights: [400], role: "display", mood: "立体的に描いた太いかな（渋谷フォント）。にぎやか・ポップな告知" },
  { family: "Palette Mosaic", weights: [400], role: "display", mood: "図形を組み合わせたモザイクのかな（渋谷フォント）。アート・展示" },
  { family: "Shizuru", weights: [400], role: "display", mood: "独特な線の手描きのかな（渋谷フォント）。個性的・アート・ワークショップ" },
  { family: "Yuji Hentaigana Akari", weights: [400], role: "hand", mood: "毛筆の変体仮名（ひらがなのみ・読みにくい）。老舗の暖簾・和の雰囲気づけ" },
  { family: "Yuji Hentaigana Akebono", weights: [400], role: "hand", mood: "やや太い毛筆の変体仮名（ひらがなのみ・読みにくい）。和菓子・伝統の雰囲気づけ" },
];

/** 英数字だけのフォント（日本語の文字は Noto Sans JP で表示される） */
const LATIN: Entry[] = [
  { family: "Inter", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], role: "gothic", mood: "癖のない標準的なサンセリフ。UI・ビジネス・英語の本文" },
  { family: "Montserrat", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], role: "gothic", mood: "幾何学的で幅の広いサンセリフ。ブランド・見出し・モダン" },
  { family: "Poppins", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], role: "gothic", mood: "丸みのある幾何学サンセリフ。スタートアップ・明るいプレゼン" },
  { family: "DM Sans", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000], role: "gothic", mood: "小さくても読みやすい低コントラストのサンセリフ。Web・資料" },
  { family: "Work Sans", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], role: "gothic", mood: "やや古風なグロテスク。落ち着いた見出し・本文" },
  { family: "Raleway", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], role: "gothic", mood: "細身でエレガントなサンセリフ。ファッション・上品な見出し" },
  { family: "Outfit", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], role: "gothic", mood: "すっきりした幾何学サンセリフ。テック・プロダクト紹介" },
  { family: "Space Grotesk", weights: [300, 400, 500, 600, 700], role: "gothic", mood: "個性のあるグロテスク。テック・クリエイティブ・未来的" },
  { family: "Lexend", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], role: "gothic", mood: "読みやすさを研究して作られたサンセリフ。教育・やさしい案内" },
  { family: "Syne", weights: [400, 500, 600, 700, 800], role: "gothic", mood: "太くなるほど横に広がるアート系サンセリフ。ギャラリー・前衛的" },
  { family: "Oswald", weights: [200, 300, 400, 500, 600, 700], role: "display", mood: "縦長の詰まったサンセリフ。ニュース・スポーツ・力強い見出し" },
  { family: "Barlow Condensed", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], role: "display", mood: "細長いサンセリフ。標識風・データ・引き締まった見出し" },
  { family: "Bebas Neue", weights: [400], role: "display", mood: "大文字だけの縦長見出し。ポスター・映画・インパクト" },
  { family: "Anton", weights: [400], role: "display", mood: "極太で縦長の見出し。セール・スポーツ・強い告知" },
  { family: "Archivo Black", weights: [400], role: "display", mood: "どっしりした極太グロテスク。ロゴ・ステートメント" },
  { family: "Unbounded", weights: [200, 300, 400, 500, 600, 700, 800, 900], role: "display", mood: "幅広で丸みのある未来的な見出し。Web3・音楽イベント" },
  { family: "Russo One", weights: [400], role: "display", mood: "角ばった太いサンセリフ。ゲーム・モータースポーツ" },
  { family: "Orbitron", weights: [400, 500, 600, 700, 800, 900], role: "display", mood: "幾何学的な SF 風の文字。宇宙・テクノロジー・近未来" },
  { family: "Rubik Mono One", weights: [400], role: "display", mood: "太く丸い大文字だけの等幅。ポップ・レトロゲーム" },
  { family: "Bungee", weights: [400], role: "display", mood: "看板のような太い大文字。ストリート・都会的・縦書きも可" },
  { family: "Righteous", weights: [400], role: "display", mood: "アールデコ風の丸い見出し。レトロ・ダイナー・音楽" },
  { family: "Monoton", weights: [400], role: "display", mood: "ネオン管のような多重線の文字。ナイトイベント・80 年代" },
  { family: "Press Start 2P", weights: [400], role: "display", mood: "8bit ゲームのドット文字。レトロゲーム・ピクセルアート" },
  { family: "Bangers", weights: [400], role: "display", mood: "アメコミの効果音風。コミック・にぎやか・ポップ" },
  { family: "Creepster", weights: [400], role: "display", mood: "したたるホラー文字。ハロウィン・お化け屋敷" },
  { family: "Nunito", weights: [200, 300, 400, 500, 600, 700, 800, 900, 1000], role: "rounded", mood: "端の丸いやさしいサンセリフ。子ども・医療・親しみやすい" },
  { family: "Quicksand", weights: [300, 400, 500, 600, 700], role: "rounded", mood: "細く丸い幾何学サンセリフ。ナチュラル・カフェ・軽やか" },
  { family: "Comfortaa", weights: [300, 400, 500, 600, 700], role: "rounded", mood: "丸い円で組んだやわらかい文字。かわいい・ベビー・ゆるい" },
  { family: "Varela Round", weights: [400], role: "rounded", mood: "素直な丸ゴシック体の英字。やさしい案内・アプリ" },
  { family: "Fredoka", weights: [300, 400, 500, 600, 700], role: "rounded", mood: "ぷっくり太い丸文字。キッズ・おもちゃ・お菓子" },
  { family: "Baloo 2", weights: [400, 500, 600, 700, 800], role: "pop", mood: "まるまる太ったポップ体。楽しい・イベント・ゲーム" },
  { family: "Shrikhand", weights: [400], role: "pop", mood: "太くうねるイタリック。レトロポップ・食べ物・ステッカー" },
  { family: "Lobster", weights: [400], role: "pop", mood: "太い続け字のレトロ看板文字。カフェ・ヴィンテージ" },
  { family: "Playfair Display", weights: [400, 500, 600, 700, 800, 900], role: "mincho", mood: "コントラストの強い高級セリフ。雑誌・ファッション・上品な見出し" },
  { family: "DM Serif Display", weights: [400], role: "mincho", mood: "太めで端正なディスプレイセリフ。エディトリアル・見出し" },
  { family: "Abril Fatface", weights: [400], role: "mincho", mood: "極太のディドーン体。雑誌の表紙・ポスター・華やか" },
  { family: "Cormorant Garamond", weights: [300, 400, 500, 600, 700], role: "mincho", mood: "繊細で優雅なガラモン。ウエディング・ラグジュアリー" },
  { family: "EB Garamond", weights: [400, 500, 600, 700, 800], role: "mincho", mood: "古典的なガラモン。文学・学術・格式ある本文" },
  { family: "Libre Baskerville", weights: [400, 500, 600, 700], role: "mincho", mood: "読みやすいバスカヴィル。英語の本文・レポート" },
  { family: "Lora", weights: [400, 500, 600, 700], role: "mincho", mood: "やわらかいモダンセリフ。ブログ・物語・温かい本文" },
  { family: "Merriweather", weights: [300, 400, 500, 600, 700, 800, 900], role: "mincho", mood: "画面で読みやすい頑丈なセリフ。長文・ニュース" },
  { family: "Cinzel", weights: [400, 500, 600, 700, 800, 900], role: "mincho", mood: "ローマの碑文風の大文字。歴史・ファンタジー・格調高い" },
  { family: "Roboto Slab", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], role: "mincho", mood: "四角いセリフのスラブ体。技術・新聞・堅実" },
  { family: "Alfa Slab One", weights: [400], role: "mincho", mood: "極太のスラブセリフ。西部劇・ヴィンテージ看板・力強い" },
  { family: "Pacifico", weights: [400], role: "hand", mood: "サーフ風の太い筆記体。夏・ビーチ・カジュアルなロゴ" },
  { family: "Dancing Script", weights: [400, 500, 600, 700], role: "hand", mood: "弾むような筆記体。お祝い・カード・かわいい" },
  { family: "Great Vibes", weights: [400], role: "hand", mood: "優雅なカリグラフィー筆記体。ウエディング・招待状" },
  { family: "Sacramento", weights: [400], role: "hand", mood: "細いモノラインの筆記体。おしゃれ・カフェ・サイン風" },
  { family: "Caveat", weights: [400, 500, 600, 700], role: "hand", mood: "ペンで書いたメモ風の手書き。注釈・ノート・ゆるい" },
  { family: "Permanent Marker", weights: [400], role: "hand", mood: "マーカーで書いた太い手書き。ストリート・手作りポップ" },
  { family: "JetBrains Mono", weights: [100, 200, 300, 400, 500, 600, 700, 800], role: "mono", mood: "コード用の読みやすい等幅。プログラム・ターミナル" },
  { family: "Fira Code", weights: [300, 400, 500, 600, 700], role: "mono", mood: "合字のあるコード用等幅。プログラム・技術資料" },
  { family: "Space Mono", weights: [400, 700], role: "mono", mood: "個性のあるレトロな等幅。テック系の見出し・エディトリアル" },
];

const toId = (family: string) => family.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const withScript = (script: FontScript) => (e: Entry): FontEntry => ({ id: toId(e.family), script, ...e });

export const FONT_CATALOG: FontEntry[] = [...JA.map(withScript("ja")), ...KANA.map(withScript("kana")), ...LATIN.map(withScript("latin"))];

/** 足りない文字を表示するフォント（themes の resolveFont のフォールバックと同じ） */
export const FALLBACK_FONT = "Noto Sans JP";

export const FONT_BY_ID = new Map(FONT_CATALOG.map((f) => [f.id, f]));

/** 漢字（CJK 統合漢字・拡張 A・互換・々〆）／かな（全角・半角）・全角記号 */
const KANJI = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff々〆〇]/;
const JAPANESE = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** そのフォントだけで text の文字を全部表示できるか（足りない文字はほかのフォントで表示される） */
export function fontCovers(f: Pick<FontEntry, "script">, text: string): boolean {
  if (f.script === "ja") return true;
  return f.script === "kana" ? !KANJI.test(text) : !JAPANESE.test(text);
}

/** text をすべて表示できる script（文面に漢字があれば ja だけ、かなまでなら kana も、英数字だけなら全部） */
export function scriptsFor(text: string): FontScript[] {
  return (["ja", "kana", "latin"] as const).filter((s) => fontCovers({ script: s }, text));
}

export const FONT_BY_FAMILY = new Map(FONT_CATALOG.map((f) => [f.family, f]));

/** PowerPoint で「標準／太字」として使えるウェイト（Google Fonts の 400 と 700 は同じファミリー名の Regular/Bold になる） */
export function installWeights(f: FontEntry): number[] {
  const near = (t: number) => f.weights.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
  return [...new Set([near(400), f.weights.includes(700) ? 700 : near(400)])];
}

export function googleCssUrl(family: string, weights?: number[]) {
  const f = FONT_BY_FAMILY.get(family);
  const ws = weights ?? f?.weights ?? [400];
  const fam = family.replace(/ /g, "+") + (ws.length > 1 || ws[0] !== 400 ? `:wght@${[...ws].sort((a, b) => a - b).join(";")}` : "");
  return `https://fonts.googleapis.com/css2?family=${fam}&display=swap`;
}

/** カタログにあるウェイトのうち、指定に最も近いもの */
export function nearestWeight(family: string, weight = 400): number {
  const ws = FONT_BY_FAMILY.get(family)?.weights ?? [400];
  return ws.reduce((a, b) => (Math.abs(b - weight) < Math.abs(a - weight) ? b : a));
}

/** 製品版（Electron）か。画面からは外部の CSS を読めないので、API のフォントキャッシュから読み込む */
const isDesktop = () => typeof window !== "undefined" && !!window.dcDesktop;

/** 取得に失敗した face を、この時間は再試行しない（描画のたびに要求が飛ぶのを防ぐ） */
const RETRY_MS = 30_000;
const failedAt = new Map<string, number>();

function base64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** 製品版：/api/fonts/files で TTF を取り、FontFace として登録する。失敗しても投げない */
async function loadDesktopFace(family: string, weight: number, key: string) {
  try {
    // server/fonts.ts がこのファイルを読むので、画面側の api は使うときだけ読み込む
    const { api } = await import("./editor/api");
    const file = (await api.fontFiles([{ family, weight }])).files.find((f) => f.family === family && f.weight === weight);
    if (!file) throw new Error("フォントを取得できませんでした");
    const face = new FontFace(family, base64ToBuffer(file.data), { weight: String(weight) });
    await face.load();
    document.fonts.add(face);
  } catch {
    loaded.delete(key);
    failedAt.set(key, Date.now());
  }
}

/**
 * ブラウザにカタログのフォントを読み込む（プレビュー・キャンバス表示用）。同じフォントは 1 度だけ。
 * 製品版は weight に最も近い face だけを取る（日本語フォントは全ウェイトだと数十MBになる）。未指定は 400
 */
const loaded = new Set<string>();
export function ensureWebFont(family: string | undefined, weight?: number) {
  if (!family || typeof document === "undefined" || !FONT_BY_FAMILY.has(family)) return;
  if (isDesktop()) {
    const w = nearestWeight(family, weight);
    const key = `${family}|${w}`;
    if (loaded.has(key) || Date.now() - (failedAt.get(key) ?? -RETRY_MS) < RETRY_MS) return;
    loaded.add(key);
    void loadDesktopFace(family, w, key);
    return;
  }
  if (loaded.has(family)) return;
  loaded.add(family);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = googleCssUrl(family);
  document.head.appendChild(link);
}

// ---------- 資料全体への適用 ----------

/** テーマのフォントトークン（themeOverride.fonts で差し替わるので、そのまま残す） */
const FONT_TOKENS = new Set(["display", "body", "hand", "heavy"]);
const isDecorative = (family: string) => ["display", "pop", "hand"].includes(FONT_BY_FAMILY.get(family)?.role ?? "");

/**
 * 見出し・本文のフォントをスライド全体に適用する。
 * - テーマのトークン（display / body / heavy）は themeOverride.fonts の差し替えで変わる（hand は手書きの意図を残すため変えない）
 * - PPTX から読み込んだテキストのように固定のフォント名を持つものは、見出し／本文に振り分けてトークンに置き換える
 *   （元が装飾系のフォント、または大きい文字なら見出し。それ以外は本文）
 */
export function applyFonts(spec: PosterSpec, fonts: { display: string; body: string }): PosterSpec {
  const titleSize = spec.meta.width * 0.03; // 16:9（1333px 幅）で約 29pt 以上を見出し扱い
  const mapLayer = (l: Layer): Layer => {
    if (l.type === "group") return { ...l, children: l.children.map(mapLayer) };
    if (l.type === "text" && !FONT_TOKENS.has(l.font)) return { ...l, font: isDecorative(l.font) || l.size >= titleSize ? "display" : "body" };
    if (l.type === "component" && typeof l.props?.font === "string" && !FONT_TOKENS.has(l.props.font)) return { ...l, props: { ...l.props, font: "body" } };
    return l;
  };
  return {
    ...spec,
    themeOverride: { ...spec.themeOverride, fonts: { ...spec.themeOverride?.fonts, display: fonts.display, heavy: fonts.display, body: fonts.body } },
    layers: spec.layers.map(mapLayer),
  };
}

/** 提案の材料にする文面（テキストレイヤーと、文字を持つコンポーネント） */
export function specTexts(spec: PosterSpec): string[] {
  const out: string[] = [];
  const walk = (l: Layer) => {
    if (l.type === "group") l.children.forEach(walk);
    else if (l.type === "text") out.push(l.text);
    else if (l.type === "component") for (const k of ["text", "label", "caption"]) if (typeof l.props?.[k] === "string") out.push(l.props[k]);
  };
  spec.layers.forEach(walk);
  return out.map((t) => t.trim()).filter(Boolean);
}
