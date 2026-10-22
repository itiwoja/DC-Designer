/**
 * チャット欄の / コマンド。AI に送らず、手元の操作を直接呼ぶ。
 * - arg: 後ろに内容を書くコマンド（「/image 夕焼けの海」）
 * - deckOnly: スライドのデッキを開いているときだけ使える
 * - posterOnly: ポスターモードのときだけ使える（optional: 後ろに内容を書いても書かなくてもよい）
 */
export type SlashName = "image" | "images" | "undo" | "clear" | "renumber" | "notes" | "a4";
export type SlashCommand = { name: SlashName; label: string; arg?: string; optional?: boolean; deckOnly?: boolean; posterOnly?: boolean };

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "image", label: "画像を生成（選択中の画像は作り直し）", arg: "内容" },
  { name: "images", label: "未生成の画像をまとめて生成" },
  { name: "undo", label: "直前の AI の変更を元に戻す" },
  { name: "renumber", label: "スライド番号を並び順に振り直す", deckOnly: true },
  { name: "notes", label: "台本が無いスライドに台本を書く", deckOnly: true },
  { name: "a4", label: "A4 に印刷できるよう、大きさ・余白・文字の大きさ・配置を整える", arg: "追加の指示", optional: true, posterOnly: true },
  { name: "clear", label: "チャットの履歴と記憶を消去" },
];

const available = (deck: boolean, poster: boolean) => SLASH_COMMANDS.filter((c) => (deck || !c.deckOnly) && (poster || !c.posterOnly));

/** 入力中の候補。「/」から始まり、まだ空白を打っていない間だけ出す（全角の「／」も可） */
export function slashSuggestions(input: string, deck: boolean, poster = false): SlashCommand[] {
  const m = input.normalize("NFKC").match(/^\/(\S*)$/);
  if (!m) return [];
  const q = m[1].toLowerCase();
  return available(deck, poster).filter((c) => c.name.startsWith(q));
}

/**
 * 送信する文がコマンドなら解析する。コマンドでなければ null（ふつうの発言として AI に送る）。
 * 「/」だけ・「//」から始まる文はコマンドとして扱わない（「/」で始まる発言を送りたいとき用）
 */
export function parseSlash(input: string, deck: boolean, poster = false): { cmd: SlashCommand; arg: string } | { error: string } | null {
  const t = input.normalize("NFKC").trim();
  const m = t.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const arg = (m[2] ?? "").trim();
  const cmd = SLASH_COMMANDS.find((c) => c.name === name);
  if (!cmd) return { error: `「/${name}」というコマンドはありません。使えるのは ${available(deck, poster).map((c) => `/${c.name}`).join(" ")} です` };
  if (cmd.deckOnly && !deck) return { error: `/${cmd.name} はスライドのデッキを開いているときだけ使えます` };
  if (cmd.posterOnly && !poster) return { error: `/${cmd.name} はポスターモードのときだけ使えます` };
  if (cmd.arg && !cmd.optional && !arg) return { error: `/${cmd.name} の後ろに${cmd.arg}を書いてください（例: /${cmd.name} 夕焼けの海、水彩風）` };
  return { cmd, arg };
}

/** 入力欄の上に出す候補の一覧 */
export function SlashMenu({ items, active, onPick, onHover }: { items: SlashCommand[]; active: number; onPick: (c: SlashCommand) => void; onHover: (i: number) => void }) {
  return (
    <div className="slash-menu" role="listbox" aria-label="コマンド">
      {items.map((c, i) => (
        <button
          key={c.name}
          role="option"
          aria-selected={i === active}
          className={i === active ? "on" : ""}
          // 入力欄のフォーカスを奪わない
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(c)}
        >
          <code>/{c.name}{c.arg && <i> {c.optional ? `［${c.arg}］` : c.arg}</i>}</code>
          <span>{c.label}</span>
        </button>
      ))}
      <div className="slash-hint"><kbd>↑</kbd><kbd>↓</kbd> 選択 · <kbd>Tab</kbd> 補完 · <kbd>Esc</kbd> 閉じる</div>
    </div>
  );
}
