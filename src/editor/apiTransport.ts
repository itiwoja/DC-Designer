/** 生成の進み具合（サーバーの Progress と同じ形） */
export type AIProgress = { phase: "thinking" | "writing"; attempt: number; chars?: number; items?: number };

import { matchDesktopOperation } from "../../desktop/operations";
import { desktopBridge } from "./desktop";

const abortError = () => new DOMException("The operation was aborted.", "AbortError");
const unavailable = () => Object.assign(new Error("Windows版（段階1）ではこの機能はまだ使えません"), { code: "DESKTOP_UNAVAILABLE", status: 404 });

/** 製品版：限定 IPC で呼ぶ。signal が中断されたら結果を捨てる（IPC 自体は取り消さない） */
async function desktopRequest<T>(bridge: NonNullable<ReturnType<typeof desktopBridge>>, method: string, url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw abortError();
  const match = matchDesktopOperation(method, url);
  if (!match) throw unavailable();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(abortError()); signal?.addEventListener("abort", onAbort); });
  try {
    const res = await Promise.race([bridge.request({ ...match, ...(body === undefined ? {} : { body }) }), aborted]);
    if (!res.ok) throw Object.assign(new Error(res.error), { code: res.code, status: res.status });
    return res.data as T;
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/** JSON API を呼ぶ。失敗時はサーバーの error / code と HTTP ステータスを持つ Error を投げる */
export async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const bridge = desktopBridge();
  if (bridge) return desktopRequest<T>(bridge, method, url, body, signal);
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error ?? `HTTP ${res.status}`), { code: json.code as string | undefined, status: res.status });
  return json as T;
}

/**
 * 進み具合を流してくる API（NDJSON: {"progress"} が何行か続いて、最後に {"result"} か {"error"}）を呼ぶ。
 * 失敗時は request と同じく error / code / status を持つ Error を投げる
 */
export async function postWithProgress<T>(url: string, body: unknown, onProgress?: (p: AIProgress) => void, signal?: AbortSignal): Promise<T> {
  // 段階1の製品版は AI 無効
  if (desktopBridge()) throw unavailable();
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const fail = (o: { error?: string; code?: string; status?: number }) =>
    Object.assign(new Error(o.error ?? `HTTP ${o.status ?? res.status}`), { code: o.code, status: o.status ?? res.status });
  if (!res.ok || !res.body) throw fail(await res.json().catch(() => ({})));
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const text = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!text) continue;
      const msg = JSON.parse(text);
      if (msg.progress) onProgress?.(msg.progress);
      else if ("result" in msg) return msg.result as T;
      else if (msg.error) throw fail(msg);
    }
    if (done) throw new Error("サーバーからの応答が途中で切れました");
  }
}
