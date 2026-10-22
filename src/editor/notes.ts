const NOTES_WORD = /台本|ノート|原稿|トーク|話す内容|しゃべる内容|喋る内容|スピーカーノート|speaker\s*notes?|notes/i;

const MISSING = String.raw`(?:無い|ない|無し|なし|空|未記入|未入力|書かれていない|書いていない|書いてない|入っていない|入ってない)`;
/** 「無い」などが台本を指しているか（「台本が無い」「空の台本」）。「〜じゃないということ。…台本を書き換えて」のような離れた「ない」は拾わない */
const MISSING_NOTES = new RegExp(String.raw`(?:${NOTES_WORD.source})[^。．.!！?？\n]{0,4}?${MISSING}|${MISSING}[のな]?(?:${NOTES_WORD.source})`, "i");
const REWRITE = /書き直|書きなお|書き換|書きかえ|作り直|作りなお/;

/**
 * 「台本が無いスライドに台本を書いて」「全スライドの台本を作って」のような、デッキ全体の空の台本を埋める指示か。
 * 「このスライドの台本を書いて」のような 1 枚だけの指示は AI のふつうの修正に任せるので、無い・空・全体を指す語を必須にする
 */
export function isMissingNotesRequest(text: string): boolean {
  const t = text.normalize("NFKC");
  const notes = NOTES_WORD.test(t);
  // 「全スライドの台本を書き直して」は空の台本だけでなく全部を書き直す指示なので、全体を指す語だけでは拾わない
  const scope = MISSING_NOTES.test(t) || (/(?:全スライド|全ページ|全部|すべて|全て|各スライド|残り|ほかの|他の)/.test(t) && !REWRITE.test(t));
  const write = /(?:書|作|入れ|埋め|追加|生成|付け|つけ|用意|考え|write|generate|fill)/i.test(t);
  return notes && scope && write;
}

/**
 * 「このスライドの台本を書いて」「3 枚目の台本を書き直して」のような、AI に台本を一から書かせる指示か（対象のスライドは slideRefs で拾う）。
 * 「台本をもっと短くして」のような今の台本の手直しや、「台本に『よろしくお願いします』と書いて」のような書く中身の指定は AI のふつうの修正に任せる
 */
export function isWriteNotesRequest(text: string): boolean {
  const t = text.normalize("NFKC");
  if (!NOTES_WORD.test(t) || /[「『"“]|と(?:書|入れ)/.test(t)) return false;
  return /書いて|書く|書き直|書きなお|書き換|書きかえ|作り直|作りなお|作って|作る|作成|生成|考えて|用意|write|generate/i.test(t);
}
