/** スライドを足す動詞（「追加して」「足して」「作って」など） */
const ADD = String.raw`(?:追加|足し|足す|加え|加える|挿入|増や|差し込|作っ|作る|作成|入れ)`;
/** 何枚か（「1 枚」「もう一枚」）。無くてもよい */
const COUNT = String.raw`(?:もう)?\s*(?:\d+|一|ひと)?\s*枚?`;

/**
 * 「最後にスライドを1枚追加して」「20枚目を追加して」「クロージングのスライドを足して」のような、デッキに新しいスライドを足す指示か。
 * 足すなら追加後のスライド番号（1〜total+1）を返す。「スライドに画像を追加して」「ページ番号を追加して」のような、今のスライドの中身への追加は null
 */
export function addSlidePosition(text: string, current: number, total: number): number | null {
  const t = text.normalize("NFKC");
  if (/台本|ノート|原稿/.test(t)) return null;
  // 「20枚目を追加」は番号だけで足す指示。「20枚目に〜スライドを追加」「3枚目として〜」は位置の指定
  const nthOnly = new RegExp(String.raw`\d+\s*(?:枚目|ページ目|番目)\s*(?:の(?:スライド|ページ))?\s*(?:を|も)?\s*${ADD}`).test(t);
  const nth = t.match(/(\d+)\s*(?:枚目|ページ目|番目)\s*(?:に|として|を|も|の(?:スライド|ページ))/);
  const add = nthOnly
    || new RegExp(String.raw`(?:スライド|ページ)\s*(?:を|も)?\s*${COUNT}\s*${ADD}`).test(t)
    || new RegExp(String.raw`(?:新しい|新規)\s*(?:スライド|ページ)`).test(t)
    // 「もう1枚追加して」は、「画像をもう1枚追加して」のように別のものを数えていなければ
    || (new RegExp(String.raw`^\s*(?:もう)?\s*(?:\d+|一|ひと)\s*枚\s*${ADD}`).test(t));
  if (!add) return null;
  const clamp = (n: number) => Math.min(Math.max(n, 1), total + 1);
  if (nth) return clamp(Number(nth[1]));
  if (/(?:最後|末尾|最終|一番後ろ|いちばん後ろ|終わり)/.test(t)) return total + 1;
  if (/(?:先頭|最初|一番前|いちばん前|表紙の前)/.test(t)) return 1;
  if (/(?:この|今の|現在の)?(?:スライド|ページ)?の?(?:前に|直前)/.test(t) && !/(?:次|後)/.test(t)) return clamp(current);
  return clamp(current + 1);
}
