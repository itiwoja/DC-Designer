/**
 * 画面からの要求の取り消し管理（sender の webContents.id + callId ごとの AbortController）。
 * electron に依存しないので vitest で確かめられる
 */

/** 画面が作る callId の形 */
export const CALL_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** IPC.request の第3引数から callId を取り出す。無ければ undefined、形が不正なら null */
export function parseCallOptions(v: unknown): { callId?: string } | null {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const { callId, ...rest } = v as Record<string, unknown>;
  if (Object.keys(rest).length) return null;
  if (callId === undefined) return {};
  return typeof callId === "string" && CALL_ID_RE.test(callId) ? { callId } : null;
}

export function createCallRegistry() {
  const calls = new Map<string, AbortController>();
  const key = (senderId: number, callId: string) => `${senderId}:${callId}`;
  return {
    /** 登録して AbortController を返す。同じ callId が実行中なら null */
    begin(senderId: number, callId: string): AbortController | null {
      const k = key(senderId, callId);
      if (calls.has(k)) return null;
      const ac = new AbortController();
      calls.set(k, ac);
      return ac;
    },
    /** 終わったら消す（取り消し済みでも呼ぶ） */
    end(senderId: number, callId: string, ac: AbortController): void {
      const k = key(senderId, callId);
      if (calls.get(k) === ac) calls.delete(k);
    },
    /** その sender が登録した callId だけ中断する。中断したら true */
    cancel(senderId: number, callId: unknown): boolean {
      if (typeof callId !== "string" || !CALL_ID_RE.test(callId)) return false;
      const ac = calls.get(key(senderId, callId));
      if (!ac) return false;
      ac.abort();
      return true;
    },
    size: () => calls.size,
  };
}
