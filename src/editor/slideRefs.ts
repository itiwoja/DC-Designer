/** 「18,19」「18・19」「18と19」「18〜20」などの番号の並び（範囲は展開する） */
const NUM_LIST = String.raw`\d+(?:\s*(?:[,、・&/]|と|及び|および|や|から|か|〜|~|-|–)\s*\d+)*`;
const RANGE = String.raw`(?:〜|~|-|–|から)`;

const expand = (list: string): number[] => {
  const out: number[] = [];
  // 「か」で区切ると「3から5」の「から」まで割れるので、「から」は範囲として残す
  for (const part of list.split(/\s*(?:[,、・&/]|と|及び|および|や|か(?!ら))\s*/)) {
    const r = part.match(/^(\d+)\s*(?:〜|~|-|–|から)\s*(\d+)$/);
    if (!r) { out.push(Number(part)); continue; }
    const [a, b] = [Number(r[1]), Number(r[2])];
    // 「1〜999」のような極端な範囲で固まらないよう上限を設ける
    if (b >= a && b - a <= 50) for (let n = a; n <= b; n++) out.push(n);
  }
  return out;
};

/**
 * 指示文からスライド番号（1 始まり）を拾う。「スライド8」「8枚目」「8ページ」「p.8」「前／次のスライド」「最後のスライド」に対応。
 * 「スライド18,19」「18・19枚目」「スライド3〜5」のような並び・範囲も拾う。全角数字も可。範囲外の番号は捨てる
 */
export function slideRefs(text: string, current: number, total: number): number[] {
  // 「8枚目〜10枚目」「スライド3からスライド5」は、範囲の手前の単位を外して「8〜10枚目」「スライド3から5」と同じに読む
  const t = text.normalize("NFKC").replace(new RegExp(String.raw`(\d+)\s*(?:枚目|ページ目?|番目)?\s*(${RANGE})\s*(?:スライド|ページ|slides?|pages?|p\.?)?\s*(?=\d)`, "gi"), "$1$2");
  const found: number[] = [];
  const re = new RegExp(String.raw`(?:スライド|ページ|slides?|pages?|p\.?)\s*(?:no\.?|番号)?\s*(${NUM_LIST})|(${NUM_LIST})\s*(?:枚目|ページ目?|番目|p\b)`, "gi");
  for (const m of t.matchAll(re)) found.push(...expand(m[1] ?? m[2]));
  if (/(?:前|ひとつ前|一つ前|1つ前)の(?:スライド|ページ)/.test(t)) found.push(current - 1);
  if (/(?:次|ひとつ後|一つ後|1つ後)の(?:スライド|ページ)/.test(t)) found.push(current + 1);
  if (/(?:最後|最終)の(?:スライド|ページ)/.test(t)) found.push(total);
  if (/(?:表紙|最初の(?:スライド|ページ))/.test(t)) found.push(1);
  return [...new Set(found)].filter((n) => Number.isInteger(n) && n >= 1 && n <= total);
}

const UNIT = String.raw`(?:スライド|ページ|デッキ|資料|画像|投稿|カルーセル|slides?|pages?)`;

/**
 * 「授業スライド全体をそうして」「全スライドの差し色を変えて」「ほかのスライドにも反映して」のような、デッキのすべてのスライドを直す指示か。
 * 「このスライド全体のバランスを整えて」のような今のスライドだけの指示は除く
 */
export function isWholeDeckRequest(text: string): boolean {
  const t = text.normalize("NFKC").replace(/この(?:スライド|ページ|画像)(?:全体|全部|すべて|全て)/g, "");
  return new RegExp(String.raw`(?:全|全部の|すべての|全ての|各|ほかの|他の|残りの|どの)${UNIT}|${UNIT}(?:全体|全部|すべて|全て|一式|ぜんぶ)|all\s+${UNIT}`, "i").test(t);
}
