import type { Request, Response } from "express";
import { ChatGPTAuthError } from "./chatgpt-auth";
import { ChatGPTError } from "./chatgpt";
import type { OnProgress, Progress } from "./planner";

/** 応答を返し終える前に接続が切れたら（画面でキャンセルしたなど）処理も中断する */
function requestSignal(res: Response): AbortSignal {
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableFinished) abort.abort(); });
  return abort.signal;
}

/** JSON / NDJSON 共通のエラー方針。製品版かどうかはアプリごとに固定する */
export function createRouteHandlers({ desktop }: { desktop: boolean }) {
  /** 例外を応答用の (status, message, code) にする。製品版は利用者向けでない例外の中身を出さない */
  function describeError(e: unknown): { status: number; message: string; code?: string } {
    if (e instanceof ChatGPTAuthError) return { status: 401, message: e.message, code: "chatgpt_auth" };
    if (e instanceof ChatGPTError) return { status: e.status >= 400 ? e.status : 502, message: e.message, code: e.code };
    const status = (e as { status?: number })?.status;
    const client = !!status && status >= 400 && status < 500;
    const message = desktop && !client ? "内部エラーが発生しました" : e instanceof Error ? e.message : String(e);
    return { status: client ? status : 500, message };
  }

  function logError(e: unknown) {
    // 製品版は例外の中身（path を含みうる）をログ・応答に出さない
    if (desktop) console.error("[api] error:", e instanceof Error ? e.name : "unknown");
    else console.error(e);
  }

  /** fn の戻り値を JSON で返す。400 などのエラーは httpError で投げる */
  const route = (fn: (req: Request, signal: AbortSignal) => unknown) => async (req: Request, res: Response) => {
    const signal = requestSignal(res);
    try {
      res.json(await fn(req, signal));
    } catch (e) {
      logError(e);
      const { status, message, code } = describeError(e);
      res.status(status).json(code ? { error: message, code } : { error: message });
    }
  };

  /**
   * 時間のかかる生成用: 進み具合を 1 行 1 JSON（NDJSON）で流し、最後に {"result"} か {"error"} を送る。
   * 書き出し中の進み具合は 0.5 秒に 1 回まで、thinking への切り替えはすぐ送る
   */
  const progressRoute = (fn: (req: Request, onProgress: OnProgress, signal: AbortSignal) => Promise<unknown>) => async (req: Request, res: Response) => {
    const signal = requestSignal(res);
    res.status(200).setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders();
    const line = (o: unknown) => { if (!res.writableEnded) res.write(JSON.stringify(o) + "\n"); };
    let last = 0;
    let pending: Progress | undefined;
    let timer: NodeJS.Timeout | undefined;
    const flush = () => { timer = undefined; if (pending) { line({ progress: pending }); pending = undefined; last = Date.now(); } };
    const onProgress = (p: Progress) => {
      pending = p;
      if (p.phase === "thinking") { clearTimeout(timer); flush(); return; }
      if (!timer) timer = setTimeout(flush, Math.max(0, 500 - (Date.now() - last)));
    };
    try {
      const result = await fn(req, onProgress, signal);
      clearTimeout(timer);
      line({ result });
    } catch (e) {
      clearTimeout(timer);
      logError(e);
      const { status, message, code } = describeError(e);
      line({ error: message, code, status });
    }
    res.end();
  };

  return { route, progressRoute };
}

export type RouteHandlers = ReturnType<typeof createRouteHandlers>;
