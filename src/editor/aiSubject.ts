/** AI 依頼の対象作品（subject）と、製品版で「確認を待つ間に作品が変わった」ことの判定 */

/** AI 操作の要求本文に付ける、対象の保存済み作品（worker が検証して確認窓に出す） */
export type AiSubject = { kind: "poster" | "deck"; id: string; title: string };

const ID = /^[a-z0-9]{12}$/;
const MAX_TITLE = 200;

const make = (kind: AiSubject["kind"], id: string | null | undefined, title: string | undefined): AiSubject | undefined =>
  id && ID.test(id) ? { kind, id, title: (title?.trim() || "無題").slice(0, MAX_TITLE) } : undefined;

/** 保存済みのポスター単体。保存前（id が無い・形が違う）なら付けない */
export const posterSubject = (id: string | null | undefined, title: string | undefined) => make("poster", id, title);

/** 保存済みのデッキ（スライド・Instagram 投稿） */
export const deckSubject = (deck: { id: string; name: string } | null | undefined) => (deck ? make("deck", deck.id, deck.name) : undefined);

/** デッキを開いていればデッキ、そうでなければポスター単体 */
export const workSubject = (deck: { id: string; name: string } | null | undefined, posterId: string | null | undefined, posterTitle: string | undefined) =>
  deck ? deckSubject(deck) : posterSubject(posterId, posterTitle);

/** subject を持つ要求本文にだけ subject を足す（無ければ本文をそのまま返す） */
export const withSubject = <T extends object>(body: T, subject: AiSubject | undefined): T | (T & { subject: AiSubject }) => (subject ? { ...body, subject } : body);

/** 製品版で、結果を捨てるときの表示 */
export const WORK_CHANGED_MESSAGE = "確認を待つ間に作品が変更されたため、AI の結果を反映しませんでした。もう一度操作してください";

/**
 * 作品の「版」を見張る。read は作品を表す参照の並び（開いている作品の id と、各スライド／ポスターの spec など）を返す。
 * 編集は spec を新しい値に置き換えるので、参照が 1 つでも変われば編集されたとみなす。
 * enabled が偽（開発版）なら常に「変わっていない」
 */
export function watchWork(enabled: boolean, read: () => readonly unknown[]): () => boolean {
  if (!enabled) return () => false;
  const start = read();
  return () => {
    const now = read();
    return now.length !== start.length || now.some((v, i) => v !== start[i]);
  };
}
