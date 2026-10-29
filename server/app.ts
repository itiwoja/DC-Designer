import express from "express";
import { timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { GENERATED_DIR } from "./imagegen";
import { createRouteHandlers } from "./route-handlers";
import { registerAiRoutes } from "./routes/ai";
import { registerAuthRoutes } from "./routes/auth";
import { registerFontRoutes } from "./routes/fonts";
import { registerImageRoutes } from "./routes/images";
import { registerLibraryRoutes } from "./routes/library";
import { registerSettingsRoutes } from "./routes/settings";
import { API_PROTOCOL_VERSION, DESKTOP_ORIGIN, DESKTOP_TOKEN_HEADER, type DesktopHealth } from "../desktop/protocol";
import { DESKTOP_ID_RE, DESKTOP_INTERNAL_OPERATIONS, DESKTOP_OPERATIONS, type DesktopOperation } from "../desktop/operations";

// このファイルとその import 先は dotenv を読まない（製品版は環境変数を worker 起動時に固定するため）。開発版は server/index.ts が読む

export type AppOptions =
  | { mode: "dev"; port: number }
  | { mode: "desktop"; token: string; instanceId: string; appVersion: string; getPort: () => number };

export type AppHandle = {
  app: express.Express;
  /**
   * AI 操作が進行中なら受付を止めずにすぐ { busy: true } を返す。
   * そうでなければ新しい書き込み（GET 以外）を 503 にし、進行中の書き込みが 0 になったら { busy: false } で解決する
   */
  drain: () => Promise<{ busy: boolean }>;
  /** drain を取り消して受付を再開する */
  resume: () => void;
};

/** Host ヘッダーのホスト名（ポートを除く）がループバックか */
const isLoopbackHost = (host: string | undefined) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host ?? "");

/** 長さが違っても例外にならない定数時間比較 */
function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** 製品版で通す (method, path) か。route パターンの `:id` は DESKTOP_ID_RE に合うものだけ */
export function isDesktopAllowed(method: string, path: string): boolean {
  const segs = path.split("/");
  return [...Object.values(DESKTOP_OPERATIONS), ...Object.values(DESKTOP_INTERNAL_OPERATIONS)].some((op: DesktopOperation) => {
    if (op.method !== method) return false;
    const want = op.route.split("/");
    return want.length === segs.length && want.every((w, i) => (w.startsWith(":") ? DESKTOP_ID_RE.test(segs[i]) : w === segs[i]));
  });
}

/** AI 操作の route（操作表の ai.* と fonts.suggest）。閉じる調停で「処理が実行中」として扱う */
const AI_ROUTES: ReadonlySet<string> = new Set(
  Object.entries(DESKTOP_OPERATIONS)
    .filter(([name]) => name.startsWith("ai.") || name === "fonts.suggest")
    .map(([, op]) => (op as DesktopOperation).route),
);

export function createApp(opts: AppOptions): AppHandle {
  const app = express();
  const desktop = opts.mode === "desktop";
  let draining = false;
  let inflight = 0;
  let aiInflight = 0;
  let waiters: (() => void)[] = [];
  const settle = () => { if (inflight === 0) { const w = waiters; waiters = []; w.forEach((f) => f()); } };

  if (opts.mode === "desktop") {
    const { token, instanceId, appVersion, getPort } = opts;
    app.use((req, res, next) => {
      if (req.headers.host !== `127.0.0.1:${getPort()}`) return void res.status(403).json({ error: "forbidden", code: "FORBIDDEN" });
      const given = req.headers[DESKTOP_TOKEN_HEADER];
      if (typeof given !== "string" || !safeEqual(given, token)) return void res.status(401).json({ error: "unauthorized", code: "UNAUTHORIZED" });
      if (req.headers.origin !== DESKTOP_ORIGIN) return void res.status(403).json({ error: "forbidden", code: "FORBIDDEN" });
      next();
    });
    app.get("/api/desktop/health", (_req, res) => {
      const health: DesktopHealth = { instanceId, apiProtocolVersion: API_PROTOCOL_VERSION, appVersion, ready: true };
      res.json(health);
    });
    app.use((req, res, next) => {
      const path = req.path;
      if (!isDesktopAllowed(req.method, path)) return void res.status(404).json({ error: "この版では使えません", code: "DESKTOP_UNAVAILABLE" });
      if (req.method !== "GET") {
        if (draining) return void res.status(503).json({ error: "終了処理中です", code: "BUSY" });
        inflight++;
        const ai = req.method === "POST" && AI_ROUTES.has(path);
        if (ai) aiInflight++;
        res.on("close", () => { inflight--; if (ai) aiInflight--; settle(); });
      }
      next();
    });
  } else {
    // DNS リバインディング対策: 外部サイトが自分のドメインを 127.0.0.1 に向けても、Host がそのドメインのままなので弾ける
    // （Vite のプロキシは元の Host（localhost:5173 など）を転送するので、ポートは問わない）
    app.use((req, res, next) => {
      if (isLoopbackHost(req.headers.host)) return next();
      res.status(403).json({ error: "このホスト名からのアクセスは許可されていません" });
    });
  }
  app.use(express.json({ limit: "40mb" }));
  if (opts.mode === "dev") {
    // 製品版は main が同梱資源・ファイルとして直接配信する
    app.use("/generated", express.static(GENERATED_DIR));
    const pdfAssets = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
    for (const dir of ["cmaps", "standard_fonts", "wasm"]) {
      app.use(`/api/pdf-assets/${dir}`, express.static(join(pdfAssets, dir)));
    }
  }

  const handlers = createRouteHandlers({ desktop });
  registerSettingsRoutes(app, handlers);
  registerAuthRoutes(app, handlers, { desktop, getPort: () => opts.mode === "desktop" ? opts.getPort() : opts.port });
  registerAiRoutes(app, handlers);
  registerImageRoutes(app, handlers);
  registerFontRoutes(app, handlers);
  registerLibraryRoutes(app, handlers);

  return {
    app,
    drain: () => {
      if (aiInflight > 0) return Promise.resolve({ busy: true });
      draining = true;
      return new Promise<{ busy: boolean }>((r) => { waiters.push(() => r({ busy: false })); settle(); });
    },
    resume: () => { draining = false; },
  };
}
