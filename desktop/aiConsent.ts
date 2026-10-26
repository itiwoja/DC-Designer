/**
 * AI 送信内容の検証と結果管理。Electron に依存しない。
 * AI 操作は追加の確認窓を出さず、検証済みの内容を1回だけ送信する。
 * IPC との互換性のため Consent の名前を維持する。本文・画像は保持しない。
 */
import { verifyAiPayload } from "./aiPayload";

export type AiOutcome = "completed" | "failed" | "outcomeUnknown";
export type AiConsentState = "dispatching" | AiOutcome;
/** worker へ返す ai-consent-result の中身 */
export type AiConsentDecision = {
  decision: "approve" | "deny" | "expired" | "invalid";
  payloadHash?: string;
};

const MAX_REMEMBERED = 200;

export function createAiConsentBroker() {
  const entries = new Map<string, AiConsentState>();

  /** 重複送信を防ぐため、終了した依頼の記録は一定数だけ残す */
  function prune(): void {
    const done = [...entries].filter(([, state]) => state !== "dispatching");
    for (const [id] of done.slice(0, Math.max(0, done.length - MAX_REMEMBERED))) entries.delete(id);
  }

  /** worker の依頼を検証し、利用者の追加操作を待たずに結果を返す */
  async function request(requestId: unknown, raw: unknown): Promise<AiConsentDecision> {
    if (typeof requestId !== "string" || !requestId || requestId.length > 100 || entries.has(requestId)) {
      return { decision: "invalid" };
    }
    const v = verifyAiPayload(raw);
    if (!v) return { decision: "invalid" };
    entries.set(requestId, "dispatching");
    return { decision: "approve", payloadHash: v.payloadHash };
  }

  /** 送信中の依頼だけ結果を受け付ける。終端からは戻らない */
  function outcome(requestId: string, result: AiOutcome): void {
    if (entries.get(requestId) !== "dispatching") return;
    entries.set(requestId, result);
    prune();
  }

  /** worker が落ちた・再起動した：送信中の依頼は結果不明にする */
  function reset(): void {
    for (const [id, state] of entries) {
      if (state === "dispatching") entries.set(id, "outcomeUnknown");
    }
    prune();
  }

  return { request, outcome, reset, stateOf: (requestId: string) => entries.get(requestId) };
}
