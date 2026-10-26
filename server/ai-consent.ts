/**
 * AI 送信ゲート（EXE-FR-004）。製品版は ChatGPT へ送る直前に main へ確認を依頼し、
 * approve かつ main の payloadHash が自分の snapshot と一致したときだけ送る。許可は1回で消費する。
 * 開発版（backend 未設定）はゲートなし
 */
import { randomUUID } from "node:crypto";
import { AI_CONSENT_TTL_MS, payloadHash, type AiConsentPayload } from "../desktop/aiPayload";
import type { MainToWorker, WorkerToMain } from "../desktop/protocol";
import { httpError } from "./http-error";

export type ConsentDecision = Extract<MainToWorker, { type: "ai-consent-result" }>;
export type AiOutcome = Extract<WorkerToMain, { type: "ai-outcome" }>["outcome"];

export interface ConsentBackend {
  /** main に確認を依頼し、答えを待つ */
  ask(payload: AiConsentPayload): Promise<ConsentDecision>;
  /** dispatch した1回の結果を main に知らせる（本文は含めない） */
  outcome(requestId: string, outcome: AiOutcome): void;
}

type ConsentPort = {
  on(event: "message", cb: (e: { data: unknown }) => void): void;
  postMessage(msg: WorkerToMain): void;
};

/** 確認待ちは人の操作なので、期限は AI_CONSENT_TTL_MS に余裕を足す */
const DEFAULT_TIMEOUT_MS = AI_CONSENT_TTL_MS + 30_000;

export function createMainConsentBackend(port: ConsentPort, timeoutMs = DEFAULT_TIMEOUT_MS): ConsentBackend {
  const waiting = new Map<string, (m: ConsentDecision) => void>();
  port.on("message", ({ data }) => {
    const m = data as MainToWorker | null;
    if (m?.type === "ai-consent-result") waiting.get(m.requestId)?.(m);
  });
  return {
    ask(payload) {
      // worker を起動し直しても main が覚えている過去の ID と重ならないようにする
      const requestId = `c-${randomUUID()}`;
      return new Promise<ConsentDecision>((resolve) => {
        // 期限内に答えが無ければ expired 扱い（送らない）
        const t = setTimeout(() => { waiting.delete(requestId); resolve({ type: "ai-consent-result", requestId, decision: "expired" }); }, timeoutMs);
        waiting.set(requestId, (m) => { clearTimeout(t); waiting.delete(requestId); resolve(m); });
        port.postMessage({ type: "ai-consent", requestId, payload });
      });
    },
    outcome(requestId, outcome) { port.postMessage({ type: "ai-outcome", requestId, outcome }); },
  };
}

let backend: ConsentBackend | null = null;
/** 製品版の worker が起動時に差し替える（テストは null で既定＝ゲートなしに戻す） */
export function setConsentBackend(b: ConsentBackend | null): void { backend = b; }

/** 製品版か（DC_DESIGNER_DESKTOP=1） */
export const isDesktopMode = () => process.env.DC_DESIGNER_DESKTOP === "1";

const DENIED: Record<string, string> = {
  deny: "AI への送信を取りやめました",
  expired: "AI への送信の確認が期限切れになりました。もう一度操作してください",
  invalid: "AI へ送る内容を確認できなかったため、送信しませんでした",
};

/**
 * 送る直前に呼ぶ。許可されたときだけ resolve する（値は ai-outcome 用の requestId。ゲートなしなら undefined）。
 * 拒否・期限切れ・不正・ハッシュ不一致は 403
 */
export async function requireConsent(payload: AiConsentPayload): Promise<string | undefined> {
  if (!backend) {
    if (isDesktopMode()) throw httpError(403, "AI への送信を確認できないため、送信しませんでした");
    return undefined;
  }
  const r = await backend.ask(payload);
  if (r.decision !== "approve") throw httpError(403, DENIED[r.decision] ?? DENIED.invalid);
  if (!r.payloadHash || r.payloadHash !== payloadHash(payload)) throw httpError(403, DENIED.invalid);
  return r.requestId;
}

/** dispatch した1回の結果を知らせる。ゲートなし・requestId なしなら何もしない */
export function reportOutcome(requestId: string | undefined, outcome: AiOutcome): void {
  if (requestId && backend) backend.outcome(requestId, outcome);
}
