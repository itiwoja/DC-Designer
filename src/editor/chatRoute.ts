import { addSlidePosition } from "./addSlide";
import { isMissingNotesRequest, isWriteNotesRequest } from "./notes";
import { isRenumberRequest } from "./pageNumbers";
import { isWholeDeckRequest, slideRefs } from "./slideRefs";
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
  /** 開いているスライド・ポスターを AI に直させる（ふつうの修正） */
  | { kind: "edit" };

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
    if (deck.total > 1 && isWholeDeckRequest(text)) return { kind: "edit-across" };
  }
  return { kind: "edit" };
}
