/**
 * AI 送信確認の状態機械と待ち行列（EXE-FR-004 / EXE-TBL-004）。Electron に依存しない。
 * 状態は main のメモリだけに持つ（ディスクへ書かない）。
 * prepared → denied / expired / invalidated / dispatching、dispatching → completed / failed / outcomeUnknown。終端から戻らない
 */
import { AI_CONSENT_TTL_MS, verifyAiPayload, type AiConsentPayload } from "./aiPayload";

export type AiConsentState =
  | "prepared" | "denied" | "expired" | "invalidated" | "dispatching" | "completed" | "failed" | "outcomeUnknown";
export type AiOutcome = "completed" | "failed" | "outcomeUnknown";
/** worker へ返す ai-consent-result の中身 */
export type AiConsentDecision = {
  decision: "approve" | "deny" | "expired" | "invalid";
  payloadHash?: string;
};

/** 確認窓に出す内容（main が検証して計算した値） */
export type ConsentView = { requestId: string; payloadHash: string; payload: AiConsentPayload; expiresAt: number };

/** 確認窓の操作口。senderId は窓の webContents.id（承認の送り主の照合に使う） */
export interface ConsentWindowHandle {
  readonly senderId: number;
  close(): void;
  /** 承認後の表示（送信中・結果）。窓が閉じていれば何もしない */
  showOutcome(o: "sending" | AiOutcome): void;
}

export type AiConsentBrokerDeps = {
  now: () => number;
  newId?: () => string;
  /** 確認窓を開く（失敗したら throw してよい。その依頼は invalidated になる） */
  openWindow: (view: ConsentView) => ConsentWindowHandle;
  ttlMs?: number;
  /** 状態遷移の記録（本文・画像・秘密値は渡さない） */
  onTransition?: (t: { id: string; requestId: string; from: AiConsentState | null; to: AiConsentState }) => void;
};

type Entry = {
  id: string;
  requestId: string;
  state: AiConsentState;
  payloadHash: string;
  view: ConsentView | null;
  expiresAt: number;
  handle: ConsentWindowHandle | null;
  shown: boolean;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (d: AiConsentDecision) => void;
};

const MAX_QUEUE = 8;
const MAX_REMEMBERED = 200;
const TERMINAL: AiConsentState[] = ["denied", "expired", "invalidated", "completed", "failed", "outcomeUnknown"];

export type AiConsentBroker = ReturnType<typeof createAiConsentBroker>;

export function createAiConsentBroker(deps: AiConsentBrokerDeps) {
  const ttl = deps.ttlMs ?? AI_CONSENT_TTL_MS;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const entries = new Map<string, Entry>();
  /** 承認後も結果表示のために開いている窓 */
  const lingering = new Set<ConsentWindowHandle>();

  function setState(e: Entry, to: AiConsentState): void {
    const from = e.state;
    e.state = to;
    deps.onTransition?.({ id: e.id, requestId: e.requestId, from, to });
    if (TERMINAL.includes(to)) {
      e.view = null; // 本文・画像を保持しない
      prune();
    }
  }

  /** 重複判定のため終端の記録は一定数だけ残す */
  function prune(): void {
    const done = [...entries.values()].filter((e) => TERMINAL.includes(e.state));
    for (const e of done.slice(0, Math.max(0, done.length - MAX_REMEMBERED))) entries.delete(e.requestId);
  }

  function releaseWindow(e: Entry): void {
    if (e.handle) lingering.delete(e.handle);
    e.handle?.close();
    e.handle = null;
  }

  /** prepared の依頼を終わらせる（承認以外） */
  function finish(e: Entry, to: "denied" | "expired" | "invalidated"): void {
    if (e.state !== "prepared") return;
    if (e.timer) clearTimeout(e.timer);
    e.timer = undefined;
    setState(e, to);
    releaseWindow(e);
    e.resolve({ decision: to === "denied" ? "deny" : to === "expired" ? "expired" : "invalid" });
    pump();
  }

  function pump(): void {
    if ([...entries.values()].some((e) => e.state === "prepared" && e.shown)) return;
    const next = [...entries.values()].find((e) => e.state === "prepared" && !e.shown);
    if (!next || !next.view) return;
    for (const h of [...lingering]) { lingering.delete(h); h.close(); }
    next.shown = true;
    try {
      next.handle = deps.openWindow(next.view);
    } catch {
      next.shown = false;
      finish(next, "invalidated");
    }
  }

  /** worker からの ai-consent。決定が出るまで待つ */
  function request(requestId: unknown, raw: unknown): Promise<AiConsentDecision> {
    if (typeof requestId !== "string" || !requestId || requestId.length > 100 || entries.has(requestId)) {
      return Promise.resolve({ decision: "invalid" });
    }
    const v = verifyAiPayload(raw);
    if (!v) return Promise.resolve({ decision: "invalid" });
    if ([...entries.values()].filter((e) => e.state === "prepared").length >= MAX_QUEUE) {
      return Promise.resolve({ decision: "invalid" });
    }
    return new Promise((resolve) => {
      const expiresAt = deps.now() + ttl;
      const e: Entry = {
        id: newId(), requestId, state: "prepared", payloadHash: v.payloadHash, expiresAt, handle: null, shown: false,
        view: { requestId, payloadHash: v.payloadHash, payload: v.payload, expiresAt }, resolve,
      };
      entries.set(requestId, e);
      deps.onTransition?.({ id: e.id, requestId, from: null, to: "prepared" });
      e.timer = setTimeout(() => finish(e, "expired"), ttl);
      pump();
    });
  }

  /**
   * 確認窓からの決定。窓の webContents（senderId）・requestId・payloadHash が保持値と一致し、
   * 状態が prepared で期限内のときだけ受け付ける。受け付けたら true
   */
  function decide(senderId: number, msg: { requestId: unknown; payloadHash: unknown; decision: unknown }): boolean {
    if (typeof msg.requestId !== "string") return false;
    const e = entries.get(msg.requestId);
    if (!e || e.state !== "prepared" || !e.shown || !e.handle || e.handle.senderId !== senderId) return false;
    if (msg.payloadHash !== e.payloadHash) return false;
    if (msg.decision !== "approve" && msg.decision !== "deny") return false;
    if (deps.now() >= e.expiresAt) { finish(e, "expired"); return false; }
    if (msg.decision === "deny") { finish(e, "denied"); return true; }
    if (e.timer) clearTimeout(e.timer);
    e.timer = undefined;
    setState(e, "dispatching");
    if (e.handle) { lingering.add(e.handle); e.handle.showOutcome("sending"); }
    e.resolve({ decision: "approve", payloadHash: e.payloadHash });
    pump();
    return true;
  }

  /** 窓が閉じた・Esc。承認前なら拒否 */
  function windowClosed(requestId: string): void {
    const e = entries.get(requestId);
    if (e && e.state === "prepared") finish(e, "denied");
  }

  /** worker からの ai-outcome。承認済みの依頼だけ */
  function outcome(requestId: string, o: AiOutcome): void {
    const e = entries.get(requestId);
    if (!e || e.state !== "dispatching") return;
    setState(e, o);
    e.handle?.showOutcome(o);
    if (e.handle) lingering.delete(e.handle);
    e.handle = null;
  }

  /** worker が落ちた・再起動した：保留は破棄し、送信中は結果不明にする */
  function reset(): void {
    for (const e of [...entries.values()]) {
      if (e.state === "prepared") finish(e, "invalidated");
      else if (e.state === "dispatching") outcome(e.requestId, "outcomeUnknown");
    }
  }

  return { request, decide, windowClosed, outcome, reset, stateOf: (requestId: string) => entries.get(requestId)?.state };
}
