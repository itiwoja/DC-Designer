import { addSlidePosition } from "./addSlide";
import { isMissingNotesRequest, isWriteNotesRequest } from "./notes";
import { isRenumberRequest } from "./pageNumbers";
import { isMatchOthersRequest, isWholeDeckRequest, slideRefs } from "./slideRefs";
import { parseSlash, type SlashCommand } from "./slashCommands";

/** チャットに送った文を、どの処理で受けるか */
export type ChatRoute =
  | { kind: "slash-error"; error: string }
  | { kind: "slash"; cmd: SlashCommand; arg: string }
  /** 全スライドのページ番号を手元で振り直す */
  | { kind: "renumber" }
  /** 台本が無いスライドに、まとめて台本を書く */
  | { kind: "missing-notes" }
  /** 指定したスライド（番号）の台本を書く */
  | { kind: "write-notes"; targets: number[] }
  /** 新しいスライドを作って position 枚目に入れる */
  | { kind: "add-slide"; position: number }
  /** 同じ指示を全スライドに当てる */
  | { kind: "edit-across" }
  /** 画像を作る依頼を画像生成に回す。redo は選択中の画像を作り直す依頼（prompt は元のプロンプトに足す注文。空なら元のまま） */
  | { kind: "image"; prompt: string; transparent: boolean; redo: boolean }
  /** 開いているスライド・ポスターを AI に直させる（ふつうの修正） */
  | { kind: "edit" };

const IMAGE_NOUN = /画像|写真|イラスト|挿絵|絵(?!文字)/;
const IMAGE_CREATE = /作って|作成して|生成して|描いて|入れて|足して|追加して|挿入して|載せて|のせて|貼って|用意して|出して/;
/** 選択中の画像を作り直す依頼（「この画像を作り直して」） */
const IMAGE_REDO = /作り直|描き直|生成し直|再生成|撮り直/;
/** 既存の画像の編集・削除、位置の指定、ほかの修正との同居、スライド・ポスター自体の作成は、画像生成ではなく AI の修正に任せる */
const NOT_NEW_IMAGE = /消し|削除|なくし|無くし|外し|隠し|非表示|不要|いらない|ないで|(この|その|あの|選択中の?|今の|現在の)(画像|写真|イラスト)|右|左|上|下(?!さい)|隅|中央|真ん中|端|横|隣|(?<!透明な?)背景(?!を?(なし|無し|透過|抜き|なく))|大きく|小さく|変えて|直して|揃え|目立たせ|整理|フォント|レイアウト|(スライド|ポスター|チラシ|ページ|資料|デザイン)(を|も)?(作|生成|描|追加)|入り|付き|つき|使っ|使った|のある|元に|もとに|参考|(画像|写真|イラスト|挿絵|絵)(の|集|レーター)|キャプション|説明文|出典/;
/** 作り直しに見えても、画像そのものではなく配置・デザインの直しは AI の修正に任せる */
const NOT_IMAGE_REDO = /(画像|写真|イラスト|挿絵|絵)(の|を使|を元|をもと|で)|配置|デザイン|レイアウト|スライド|ポスター|ページ/;
const TRANSPARENT = /透過|透明な?背景|背景(を)?(なし|無し|抜き|なく)|切り抜き/;

/** 「海の写真を作って」のような、新しく画像を作る依頼か */
export function isImageRequest(text: string): boolean {
  return IMAGE_NOUN.test(text) && IMAGE_CREATE.test(text) && !NOT_NEW_IMAGE.test(text);
}
/** 「この画像を作り直して」のような、選択中の画像を作り直す依頼か */
export function isImageRedoRequest(text: string): boolean {
  return IMAGE_NOUN.test(text) && IMAGE_REDO.test(text) && !NOT_IMAGE_REDO.test(text);
}
/**
 * 作り直しの依頼から、元のプロンプトに足す注文だけを取り出す（「この画像を水彩風に作り直して」→「水彩風に」）。
 * 注文が無ければ空（元のプロンプトのまま作り直す）
 */
export function redoPromptOf(text: string): string {
  return text.trim()
    .replace(/^(この|その|あの|選択中の?|今の|現在の)?(画像|写真|イラスト|挿絵|絵)(を|は)?[、,\s]*/, "")
    .replace(/(を|に)?(もう一度|もう1回|もう一回)?(作り直|描き直|生成し直|再生成|撮り直)(して|す)?(ください|下さい|くれる|ほしい|欲しい|もらえる)?[?？!！。\s]*$/, "")
    .trim();
}
/** 「透過で」「背景なしで」など、背景を透明にしたい依頼か */
export const isTransparentRequest = (text: string) => TRANSPARENT.test(text);
/** 依頼文から末尾の「を作って」などを取った、画像生成に渡す説明（空になるなら依頼文のまま） */
export function imagePromptOf(text: string): string {
  const t = text.trim().replace(/(を|も)?(お願い|作って|作成して|生成して|描いて|入れて|足して|追加して|挿入して|載せて|のせて|貼って|用意して|出して)(ください|下さい|くれる|ほしい|欲しい|もらえる)?[?？!！。\s]*$/, "").trim();
  return t || text.trim();
}

/**
 * チャットに送った文の振り分け。上から順に当てはめる（順番に意味がある）。
 * deck はスライドのデッキを開いているときの、開いているスライドの番号（1 始まり。見つからなければ 0）と枚数。
 * poster はポスターモードか（/a4 などポスターだけのコマンドを使えるか）
 */
export function routeChatRequest(text: string, opts: { deck?: { current: number; total: number }; poster: boolean }): ChatRoute {
  const { deck } = opts;
  const slash = parseSlash(text, !!deck, opts.poster);
  if (slash) return "error" in slash ? { kind: "slash-error", error: slash.error } : { kind: "slash", cmd: slash.cmd, arg: slash.arg };
  if (deck) {
    // 「右下のスライド番号の並びを直して」: AI には 1 枚ずつしか見えないので、全スライドの番号を手元で振り直す
    if (isRenumberRequest(text)) return { kind: "renumber" };
    // 「台本が無いスライドに台本を書いて」: AI には 1 枚ずつしか見えないので、デッキ全体の文字を渡して空の台本をまとめて書く
    if (isMissingNotesRequest(text)) return { kind: "missing-notes" };
    // 「このスライドの台本を書いて」: ふつうの修正だとほかのスライドの台本が見えないので、同じ書き方（口調・長さをお手本に合わせる）で書く
    if (isWriteNotesRequest(text)) {
      // 「全スライドの台本を書き直して」は全スライドを書き直す
      const targets = isWholeDeckRequest(text) ? Array.from({ length: deck.total }, (_, i) => i + 1) : slideRefs(text, deck.current, deck.total);
      // 対象のスライドが決まらなければ（開いているスライドも分からなければ）、ふつうの修正として扱う
      if (targets.length || deck.current) return { kind: "write-notes", targets: targets.length ? targets : [deck.current] };
    }
    // 「最後にクロージングのスライドを追加して」: ふつうの修正は今のスライドを書き換えるだけなので、新しいスライドを作ってデッキに入れる
    const position = deck.current ? addSlidePosition(text, deck.current, deck.total) : null;
    if (position) return { kind: "add-slide", position };
    // 「授業スライド全体の差し色を変えて」: ふつうの修正は今のスライドしか書き換えないので、同じ指示を全スライドに当てる
    // 「色味を他のスライドと合わせて」はほかのスライドをお手本にする指示なので、今のスライドだけの修正にする
    if (deck.total > 1 && isWholeDeckRequest(text) && !isMatchOthersRequest(text)) return { kind: "edit-across" };
  }
  // 「海の写真を作って」: 画像生成に回す（置き場所は選択中の要素の位置か中央）。位置の指定や既存の画像の編集は AI の修正に任せる
  if (isImageRedoRequest(text) || isImageRequest(text)) {
    const redo = isImageRedoRequest(text);
    return { kind: "image", prompt: redo ? redoPromptOf(text) : imagePromptOf(text), transparent: isTransparentRequest(text), redo };
  }
  return { kind: "edit" };
}
