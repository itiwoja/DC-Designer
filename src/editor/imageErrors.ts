/**
 * 画像生成の失敗を、通知に足す「理由」の一文にする（末尾の句点は外す。呼び出し側で「。」を付ける）。
 * サーバーは利用者が直し方の分かる文言を返す（server/imagegen-error.ts）。中身の分からない内部エラーと中止は理由に出さない
 */
export function failureReason(e: unknown): string | undefined {
  if ((e as { name?: string })?.name === "AbortError") return undefined;
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const text = raw.trim().replace(/[。.\s]+$/u, "");
  if (!text || text === "内部エラーが発生しました") return undefined;
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
