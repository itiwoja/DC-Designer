/**
 * ChatGPT サインインのゲート（main 専用・Electron 非依存）。worker の内部操作で認可 URL を作らせ、既定のブラウザで開き、
 * 一時的なループバックの受け口（127.0.0.1:動的ポート /auth/callback）でコールバックを受けて worker へ渡す。
 * 画面へ返すのは { result } だけ（URL・code・token は渡さない）
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { DesktopResult } from "./bridge";
import { DESKTOP_INTERNAL_OPERATIONS, type DesktopOperation } from "./operations";

export type AuthGateDeps = {
  request: (op: DesktopOperation, path: string, body: unknown) => Promise<DesktopResult>;
  /** 既定のブラウザで開く（shell.openExternal）。許可したホストの URL だけが渡る */
  openExternal: (url: string) => Promise<void>;
  /** 受け口を開けておく期限（ms）。既定 10 分 */
  timeoutMs?: number;
};

export const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const START_OP: DesktopOperation = DESKTOP_INTERNAL_OPERATIONS["auth.start"];
const COMPLETE_OP: DesktopOperation = DESKTOP_INTERNAL_OPERATIONS["auth.complete"];
/** worker へ渡すコールバックの query（これ以外は捨てる） */
const QUERY_KEYS = ["state", "code", "error", "error_description", "client_id"] as const;
const MAX_VALUE = 4096;

const fail = (code: string, error: string): DesktopResult => ({ ok: false, error, code });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** https://auth.openai.com/ の URL だけを許可する */
function allowedAuthUrl(url: unknown): URL | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "auth.openai.com" && !u.username && !u.password && (u.port === "" || u.port === "443") ? u : null;
  } catch { return null; }
}

const page = (message: string) =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>DC-Designer</title></head><body style="font-family:sans-serif;padding:2em"><p>${message}</p></body></html>`;
const PAGE_OK = page("サインインが完了しました。DC-Designer に戻ってください。");
const PAGE_FAIL = page("サインインを完了できませんでした。DC-Designer に戻ってもう一度お試しください。");
const PAGE_RETRY = page("サインインを続けています。開き直したブラウザの画面で操作してください。");

export function createAuthGate(deps: AuthGateDeps) {
  const timeoutMs = deps.timeoutMs ?? AUTH_TIMEOUT_MS;
  let running: Promise<DesktopResult> | null = null;

  async function run(newAccount: boolean): Promise<DesktopResult> {
    let expectedState: string | null = null;
    let retried = false;
    let settle!: (r: DesktopResult) => void;
    const done = new Promise<DesktopResult>((r) => { settle = r; });

    const server = http.createServer((req, res) => {
      void onRequest(req, res).catch(() => {
        if (!res.headersSent) respond(res, 500, PAGE_FAIL);
        settle(fail("AUTH_FAILED", "サインインに失敗しました"));
      });
    });

    function respond(res: http.ServerResponse, status: number, html: string) {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", connection: "close" });
      res.end(html);
    }

    async function onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
      const port = (server.address() as AddressInfo | null)?.port;
      if (!port || req.headers.host !== `127.0.0.1:${port}`) return respond(res, 400, PAGE_FAIL);
      let u: URL;
      try { u = new URL(req.url ?? "", `http://127.0.0.1:${port}`); } catch { return respond(res, 400, PAGE_FAIL); }
      if (u.pathname !== "/auth/callback" || req.method !== "GET") return respond(res, 404, PAGE_FAIL);

      const query: Record<string, string> = {};
      for (const k of QUERY_KEYS) {
        const v = u.searchParams.get(k);
        if (v !== null && v.length <= MAX_VALUE) query[k] = v;
      }
      // 期待する state と一致するときだけ worker へ渡す（1つの state は1回だけ）
      if (!expectedState || query.state !== expectedState) return respond(res, 400, PAGE_FAIL);
      expectedState = null;

      const got = await deps.request(COMPLETE_OP, COMPLETE_OP.route, { query });
      if (!got.ok) { respond(res, 200, PAGE_FAIL); return settle(got); }
      const d = got.data;
      if (isObj(d) && d.kind === "done" && (d.result === "signed-in" || d.result === "no-plan")) {
        respond(res, 200, PAGE_OK);
        return settle({ ok: true, data: { result: d.result } });
      }
      if (isObj(d) && d.kind === "retry") {
        const next = !retried ? allowedAuthUrl(d.url) : null;
        const state = next?.searchParams.get("state");
        if (next && state) {
          retried = true;
          expectedState = state;
          respond(res, 200, PAGE_RETRY);
          try { await deps.openExternal(next.href); } catch { return settle(fail("AUTH_OPEN_FAILED", "ブラウザを開けませんでした")); }
          return;
        }
        respond(res, 200, PAGE_FAIL);
        return settle(fail("AUTH_FAILED", "サインインを完了できませんでした。もう一度お試しください"));
      }
      respond(res, 200, PAGE_FAIL);
      const message = isObj(d) && d.kind === "error" && typeof d.message === "string" ? d.message.slice(0, 500) : "サインインに失敗しました";
      settle(fail("AUTH_FAILED", message));
    }

    let timer: NodeJS.Timeout | undefined;
    const close = () => {
      if (timer) clearTimeout(timer);
      if (server.listening) server.close();
      // 応答を書き終える猶予を置いてから、残った接続を切る
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 1000).unref();
    };

    try {
      await new Promise<void>((ok, ng) => { server.once("error", ng); server.listen(0, "127.0.0.1", ok); });
      const port = (server.address() as AddressInfo).port;

      const started = await deps.request(START_OP, START_OP.route, { port, newAccount });
      if (!started.ok) return started;
      const url = isObj(started.data) ? allowedAuthUrl(started.data.url) : null;
      const state = url?.searchParams.get("state");
      if (!url || !state) return fail("AUTH_FAILED", "サインインを開始できませんでした");
      expectedState = state;

      timer = setTimeout(() => settle(fail("AUTH_TIMEOUT", "サインインがタイムアウトしました。もう一度お試しください")), timeoutMs);
      try { await deps.openExternal(url.href); } catch { return fail("AUTH_OPEN_FAILED", "ブラウザを開けませんでした"); }
      return await done;
    } catch {
      return fail("AUTH_FAILED", "サインインに失敗しました");
    } finally {
      close();
    }
  }

  return {
    /** サインイン中に呼ばれたら同じ結果を待たせる（同時に2つは走らせない） */
    signIn(opts: { newAccount?: boolean } = {}): Promise<DesktopResult> {
      if (running) return running;
      const p = run(opts.newAccount === true);
      running = p;
      const clear = () => { if (running === p) running = null; };
      p.then(clear, clear);
      return p;
    },
  };
}
