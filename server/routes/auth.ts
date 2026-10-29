import type { Router } from "express";
import { completeLogin, handleCallback, logout, safeReturnTo, startLogin } from "../chatgpt-auth";
import { httpError } from "../http-error";
import type { RouteHandlers } from "../route-handlers";

/** ブラウザ版と製品版の Sign in with ChatGPT */
export function registerAuthRoutes(app: Router, { route }: RouteHandlers, { desktop, getPort }: { desktop: boolean; getPort: () => number }) {
  /** ブラウザをここへ遷移させる → OpenAI の認可画面へリダイレクト（?account=new は別のアカウントで新規登録） */
  app.get("/api/auth/chatgpt/login", async (req, res) => {
    const returnTo = safeReturnTo(req.query.returnTo);
    try {
      res.redirect(await startLogin({ port: getPort(), returnTo, popup: req.query.popup === "1", newAccount: req.query.account === "new" }));
    } catch (e) {
      res.redirect(`${returnTo}/?${new URLSearchParams({ chatgpt_error: e instanceof Error ? e.message : String(e) })}`);
    }
  });

  /** OpenAI からのループバックコールバック（http://127.0.0.1:<port>/auth/callback） */
  app.get("/auth/callback", async (req, res) => {
    try {
      res.redirect(await handleCallback(req.query));
    } catch (e) {
      console.error(e);
      const msg = e instanceof Error ? e.message : String(e);
      res.redirect(`${safeReturnTo(undefined)}/?${new URLSearchParams({ chatgpt_error: msg })}`);
    }
  });

  // 製品版専用（main の authGate だけが呼ぶ）。ブラウザのリダイレクトは使わず、認可 URL と結果を JSON で受け渡す
  if (desktop) app.post("/api/auth/chatgpt/start", route(async (req) => {
    const { port, newAccount, ...rest } = (req.body ?? {}) as Record<string, unknown>;
    if (Object.keys(rest).length || !Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65535) throw httpError(400, "port が正しくありません");
    if (newAccount !== undefined && typeof newAccount !== "boolean") throw httpError(400, "newAccount が正しくありません");
    return { url: await startLogin({ port: port as number, returnTo: "http://127.0.0.1", newAccount: newAccount === true }) };
  }));
  if (desktop) app.post("/api/auth/chatgpt/complete", route(async (req) => {
    const { query, ...rest } = (req.body ?? {}) as Record<string, unknown>;
    const entries = query && typeof query === "object" && !Array.isArray(query) ? Object.entries(query) : null;
    if (Object.keys(rest).length || !entries || entries.length > 20 || !entries.every(([k, v]) => k.length <= 64 && typeof v === "string" && v.length <= 4096)) throw httpError(400, "query が正しくありません");
    return completeLogin(Object.fromEntries(entries));
  }));

  app.post("/api/auth/chatgpt/logout", route(async () => {
    await logout();
    return { ok: true };
  }));
}
