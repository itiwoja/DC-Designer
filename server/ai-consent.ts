/**
 * AI 送信ゲート（EXE-FR-004）。製品版は ChatGPT へ送る直前に main へ確認を依頼し、
 * approve かつ main の payloadHash が自分の snapshot と一致したときだけ送る。許可は1回で消費する。
 * 開発版（backend 未設定）はゲートなし
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { AI_CONSENT_TTL_MS, payloadHash, type AiConsentPayload, type AiSubject } from "../desktop/aiPayload";
import type { MainToWorker, WorkerToMain } from "../desktop/protocol";
import { allowAiSendOnce } from "./egress";
import { httpError } from "./http-error";

export type ConsentDecision = Extract<MainToWorker, { type: "ai-consent-result" }>;
export type AiOutcome = Extract<WorkerToMain, { type: "ai-outcome" }>["outcome"];

export interface ConsentBackend {
  /**
   * main に確認を依頼し、答えを待つ。決定の前に signal が中断されたら main に取り消しを伝え、
   * signal.reason で reject する
   */
  ask(payload: AiConsentPayload, signal?: AbortSignal): Promise<ConsentDecision>;
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
  /** 取り消しを伝えたが、main が先に承認していた依頼（送らないので failed と知らせて main の状態を閉じる） */
  const cancelled = new Set<string>();
  port.on("message", ({ data }) => {
    const m = data as MainToWorker | null;
    if (m?.type !== "ai-consent-result") return;
    if (cancelled.delete(m.requestId)) {
      if (m.decision === "approve") port.postMessage({ type: "ai-outcome", requestId: m.requestId, outcome: "failed" });
      return;
    }
    waiting.get(m.requestId)?.(m);
  });
  return {
    ask(payload, signal) {
      // worker を起動し直しても main が覚えている過去の ID と重ならないようにする
      const requestId = `c-${randomUUID()}`;
      return new Promise<ConsentDecision>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const onAbort = () => {
          if (!waiting.delete(requestId)) return;
          clearTimeout(t);
          cancelled.add(requestId);
          port.postMessage({ type: "ai-consent-cancel", requestId });
          reject(signal!.reason);
        };
        // 期限内に答えが無ければ expired 扱い（送らない）
        const t = setTimeout(() => { waiting.delete(requestId); signal?.removeEventListener("abort", onAbort); resolve({ type: "ai-consent-result", requestId, decision: "expired" }); }, timeoutMs);
        waiting.set(requestId, (m) => { clearTimeout(t); waiting.delete(requestId); signal?.removeEventListener("abort", onAbort); resolve(m); });
        signal?.addEventListener("abort", onAbort, { once: true });
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

const subjectStore = new AsyncLocalStorage<AiSubject | undefined>();
/** 画面が要求に付けた対象作品を、この呼び出しの間だけ requireConsent が payload に入れられるようにする */
export const runWithAiSubject = <T>(subject: AiSubject | undefined, fn: () => T): T => subjectStore.run(subject, fn);

const DENIED: Record<string, string> = {
  deny: "AI への送信を取りやめました",
  expired: "AI への送信の確認が期限切れになりました。もう一度操作してください",
  invalid: "AI へ送る内容を確認できなかったため、送信しませんでした",
};

/**
 * 送る直前に呼ぶ。許可されたときだけ resolve する（値は ai-outcome 用の requestId。ゲートなしなら undefined）。
 * 拒否・期限切れ・不正・ハッシュ不一致は 403
 */
export async function requireConsent(base: AiConsentPayload, signal?: AbortSignal): Promise<string | undefined> {
  if (!backend) {
    if (isDesktopMode()) throw httpError(403, "AI への送信を確認できないため、送信しませんでした");
    return undefined;
  }
  const subject = subjectStore.getStore();
  const payload: AiConsentPayload = subject ? { ...base, subject } : base;
  let r: ConsentDecision;
  try {
    r = await backend.ask(payload, signal);
  } catch (e) {
    // 確認待ちの間に取り消された（main には取り消しを伝え済み）
    if (signal?.aborted) throw httpError(499, "ChatGPT へのリクエストを中断しました");
    throw e;
  }
  if (r.decision !== "approve") throw httpError(403, DENIED[r.decision] ?? DENIED.invalid);
  if (!r.payloadHash || r.payloadHash !== payloadHash(payload)) throw httpError(403, DENIED.invalid);
  // 承認とハッシュ一致を確かめた直後に、この1回分の送信だけを egress に許可する
  allowAiSendOnce();
  return r.requestId;
}

/** dispatch した1回の結果を知らせる。ゲートなし・requestId なしなら何もしない */
export function reportOutcome(requestId: string | undefined, outcome: AiOutcome): void {
  if (requestId && backend) backend.outcome(requestId, outcome);
}
