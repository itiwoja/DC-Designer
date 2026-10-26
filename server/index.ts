import "dotenv/config";
import express from "express";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { storeReferences } from "./references";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { AssetContext, AssetRequest, PosterSpecSchema } from "../src/schema";
import { IG_MAX_IMAGES } from "../src/instagram";
import { editPoster, type OnProgress, type Progress, planCarousel, planPoster, planSlide, refineReproduction, reproducePoster, summarizeChat, writeNotes } from "./planner";
import { optString, parseAcross, parseDeckContext, parseImage, parseTurns, strings } from "./request-parsers";
import { availableProviders, GENERATED_DIR, generateAsset, imageProviderName, saveUpload } from "./imagegen";
import { authStatus, ChatGPTAuthError, handleCallback, logout, safeReturnTo, startLogin, USAGE_URL } from "./chatgpt-auth";
import { chatGPTModel, ChatGPTError, modelSettings, setChatGPTModel } from "./chatgpt";
import { aiProvider, aiStatus, setAIProvider } from "./ai";
import { openRouterAvailable, openRouterModel, setOpenRouterModel } from "./openrouter";
import { embedFonts, fontStatus, installFonts, suggestFonts } from "./fonts";
import { httpError } from "./http-error";
import { addDeckSlide, createDeck, createPoster, deckOfPoster, deleteDeck, deleteGenerated, deletePoster, duplicateDeck, duplicatePoster, getDeck, getPoster, listDecks, listGenerated, listPosters, removeDeckSlide, updateDeck, updatePoster } from "./library";

// WSL は IPv6 が届かず IPv4 の接続も 250ms（Node の既定）を超えることがあり、全アドレスが ETIMEDOUT → "Connection error." になる
setDefaultAutoSelectFamilyAttemptTimeout(2000);

const port = Number(process.env.API_PORT || 8787);
const app = express();

/** Host ヘッダーのホスト名（ポートを除く）がループバックか */
const isLoopbackHost = (host: string | undefined) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host ?? "");
// DNS リバインディング対策: 外部サイトが自分のドメインを 127.0.0.1 に向けても、Host がそのドメインのままなので弾ける
// （Vite のプロキシは元の Host（localhost:5173 など）を転送するので、ポートは問わない）
app.use((req, res, next) => {
  if (isLoopbackHost(req.headers.host)) return next();
  res.status(403).json({ error: "このホスト名からのアクセスは許可されていません" });
});
app.use(express.json({ limit: "40mb" }));
app.use("/generated", express.static(GENERATED_DIR));
const pdfAssets = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
for (const dir of ["cmaps", "standard_fonts", "wasm"]) {
  app.use(`/api/pdf-assets/${dir}`, express.static(join(pdfAssets, dir)));
}

function sendError(res: express.Response, e: unknown) {
  console.error(e);
  if (e instanceof ChatGPTAuthError) return res.status(401).json({ error: e.message, code: "chatgpt_auth" });
  if (e instanceof ChatGPTError) return res.status(e.status >= 400 ? e.status : 502).json({ error: e.message, code: e.code });
  const status = (e as { status?: number })?.status;
  res.status(status && status >= 400 && status < 500 ? status : 500).json({ error: e instanceof Error ? e.message : String(e) });
}

/** fn の戻り値を JSON で返す。例外は sendError でエラー応答にする（400 などは httpError で投げる） */
const route = (fn: (req: express.Request, signal: AbortSignal) => unknown) => async (req: express.Request, res: express.Response) => {
  // 応答を返し終える前に接続が切れたら（画面でキャンセルしたなど）処理も中断する
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableFinished) abort.abort(); });
  try { res.json(await fn(req, abort.signal)); } catch (e) { sendError(res, e); }
};
/**
 * 時間のかかる生成用: 進み具合を 1 行 1 JSON（NDJSON）で流し、最後に {"result"} か {"error"} を送る。
 * 進み具合は 0.5 秒に 1 回まで（最後の状態は必ず送る）
 */
const progressRoute = (fn: (req: express.Request, onProgress: OnProgress, signal: AbortSignal) => Promise<unknown>) => async (req: express.Request, res: express.Response) => {
  // 応答を返し終える前に接続が切れたら（画面でキャンセルしたなど）処理も中断する
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableFinished) abort.abort(); });
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
    const result = await fn(req, onProgress, abort.signal);
    clearTimeout(timer);
    line({ result });
  } catch (e) {
    clearTimeout(timer);
    console.error(e);
    const status = e instanceof ChatGPTAuthError ? 401 : e instanceof ChatGPTError ? (e.status >= 400 ? e.status : 502) : (e as { status?: number })?.status ?? 500;
    const code = e instanceof ChatGPTAuthError ? "chatgpt_auth" : e instanceof ChatGPTError ? e.code : undefined;
    line({ error: e instanceof Error ? e.message : String(e), code, status });
  }
  res.end();
};
const param = (req: express.Request) => String(req.params.id);

app.get("/api/status", route(async () => {
  const chatgpt = authStatus();
  const ready = chatgpt.signedIn && chatgpt.planEnabled;
  const model = ready ? await chatGPTModel().catch(() => undefined) : undefined;
  const settings = ready ? await modelSettings().catch(() => undefined) : undefined;
  return { imageProvider: imageProviderName(), imageProviders: availableProviders(), chatgpt: { ...chatgpt, model, ...settings, usageUrl: USAGE_URL }, ai: await aiStatus() };
}));
/** レイアウト生成・AI 修正に使う AI を選ぶ（"chatgpt" | "openrouter"、"" で自動） */
app.put("/api/ai/provider", route((req) => {
  setAIProvider(optString(req.body?.provider, 20) ?? "");
  return aiStatus();
}));
/** OpenRouter で使うモデルを選ぶ（"" で自動 = OPENROUTER_MODEL か既定） */
app.put("/api/openrouter/model", route(async (req) => {
  await setOpenRouterModel(optString(req.body?.model, 200) ?? "");
  return { model: openRouterModel() };
}));
/** レイアウト生成・AI 修正に使う ChatGPT のモデルを選ぶ（"" で自動） */
app.put("/api/chatgpt/model", route(async (req) => {
  await setChatGPTModel(optString(req.body?.model, 200) ?? "");
  return { model: await chatGPTModel() };
}));

// ---------- Sign in with ChatGPT ----------
/** ブラウザをここへ遷移させる → OpenAI の認可画面へリダイレクト（?account=new は別のアカウントで新規登録） */
app.get("/api/auth/chatgpt/login", (req, res) => {
  res.redirect(startLogin({ port, returnTo: safeReturnTo(req.query.returnTo), popup: req.query.popup === "1", newAccount: req.query.account === "new" }));
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

app.post("/api/auth/chatgpt/logout", route(async () => {
  await logout();
  return { ok: true };
}));

// ---------- 生成・編集（ChatGPT） ----------
/** ブリーフ（＋参考画像）→ PosterSpec */
app.post("/api/plan", route(async (req, signal) => {
  const { brief, theme, references } = req.body ?? {};
  if (!brief) throw httpError(400, "brief は必須です");
  return { spec: await planPoster({ brief, theme, references: storeReferences(references), signal }) };
}));

/** ブリーフ（＋参考画像）→ Instagram のカルーセル投稿（同じ大きさの PosterSpec を 1〜20 枚） */
app.post("/api/plan/instagram", progressRoute(async (req, onProgress, signal) => {
  const { brief, width, height, count, references } = req.body ?? {};
  if (!brief) throw httpError(400, "brief は必須です");
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 100 || height < 100) throw httpError(400, "width / height が不正です");
  const n = Number.isInteger(count) && count >= 1 && count <= IG_MAX_IMAGES ? count : undefined;
  return planCarousel({ brief, width, height, count: n, references: storeReferences(references), onProgress, signal });
}));

/** 参考画像 → それをそのまま写し取った PosterSpec（A4 モードの「参考画像を再現」） */
app.post("/api/reproduce", progressRoute(async (req, onProgress, signal) => {
  const { width, height, brief } = req.body ?? {};
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 100 || height < 100) throw httpError(400, "width / height が不正です");
  return { spec: await reproducePoster({ reference: parseImage(req.body?.reference, "reference"), width, height, brief: optString(brief, 4000), onProgress, signal }) };
}));

/** 再現の仕上げ: 参考画像と現在の描画結果を見比べて spec を直す（spec が無ければ直すところなし） */
app.post("/api/reproduce/refine", progressRoute(async (req, onProgress, signal) => {
  const spec = PosterSpecSchema.parse(req.body?.spec);
  return refineReproduction({ reference: parseImage(req.body?.reference, "reference"), render: parseImage(req.body?.render, "render"), spec, onProgress, signal });
}));

/** チャットの古いやりとりを既存の要約に畳み込む（ローリング要約） */
app.post("/api/chat/summarize", route(async (req, signal) => {
  const turns = parseTurns(req.body?.turns).slice(-60);
  if (!turns.length) throw httpError(400, "turns は必須です");
  return { summary: await summarizeChat({ summary: optString(req.body?.summary, 3000), turns, signal }) };
}));

/** 既存 PosterSpec ＋ 指示 → 修正版 PosterSpec（deck があれば、書き換えるスライド番号 target も返す） */
app.post("/api/edit", route(async (req, signal) => {
  const spec = PosterSpecSchema.parse(req.body?.spec);
  const { instruction, selectedIds } = req.body ?? {};
  if (!instruction) throw httpError(400, "instruction は必須です");
  const deck = parseDeckContext(req.body?.deck);
  const history = parseTurns(req.body?.history).slice(-30);
  return editPoster({ spec, instruction, selectedIds, deck, across: parseAcross(req.body?.across), history, memory: optString(req.body?.memory, 3000), instagram: req.body?.instagram === true, references: storeReferences(req.body?.references), signal });
}));

/** デッキの並び（文字）＋お手本のスライド ＋ 指示 → 新しく追加する 1 枚の PosterSpec（追加は画面側で行う） */
app.post("/api/slide", route(async (req, signal) => {
  const { instruction } = req.body ?? {};
  if (!instruction) throw httpError(400, "instruction は必須です");
  const total = Number(req.body?.total), position = Number(req.body?.position);
  if (!Number.isInteger(total) || !Number.isInteger(position) || position < 1 || position > total + 1) throw httpError(400, "total / position が不正です");
  const outline = (Array.isArray(req.body?.outline) ? req.body.outline : []).slice(0, 200).map((s: any) => ({
    number: Number(s?.number), title: optString(s?.title, 200), texts: strings(s?.texts, 30).map((t) => t.slice(0, 300)),
  })).filter((s: { number: number }) => Number.isInteger(s.number));
  const samples = (Array.isArray(req.body?.samples) ? req.body.samples : []).slice(0, 3)
    .map((s: any) => ({ number: Number(s?.number), title: optString(s?.title, 200), spec: PosterSpecSchema.parse(s?.spec) }));
  if (!samples.length) throw httpError(400, "samples は必須です");
  return planSlide({
    instruction: String(instruction), position, total, deckTitle: optString(req.body?.title, 200), outline, samples,
    history: parseTurns(req.body?.history).slice(-30), memory: optString(req.body?.memory, 3000), instagram: req.body?.instagram === true, references: storeReferences(req.body?.references), signal,
  });
}));

/** デッキの全スライドの文字・画像の説明（＋既存の台本）→ targets の番号のスライドの台本 */
app.post("/api/notes", route(async (req, signal) => {
  const slides = (Array.isArray(req.body?.slides) ? req.body.slides : []).slice(0, 200).map((s: any) => ({
    number: Number(s?.number), title: optString(s?.title, 200), texts: strings(s?.texts, 100).map((t) => t.slice(0, 1000)), images: strings(s?.images, 20).map((t) => t.slice(0, 300)), notes: optString(s?.notes, 3000),
  })).filter((s: { number: number }) => Number.isInteger(s.number));
  const targets = (Array.isArray(req.body?.targets) ? req.body.targets : []).map(Number).filter(Number.isInteger).slice(0, 30);
  if (!slides.length || !targets.length) throw httpError(400, "slides と targets は必須です");
  return { notes: await writeNotes({ deckTitle: optString(req.body?.title, 200), slides, targets, request: optString(req.body?.request, 1000), signal }) };
}));

// ---------- 画像 ----------
/** 画像アセット 1 点を生成 */
app.post("/api/asset", route((req, signal) => generateAsset(AssetRequest.parse(req.body?.asset), AssetContext.parse(req.body?.context ?? {}), req.body?.provider, signal)));

/** 手持ちの画像ファイルを取り込む（{ mediaType, data: base64 }） */
app.post("/api/upload", route((req) => {
  const { mediaType, data } = req.body ?? {};
  if (typeof mediaType !== "string" || typeof data !== "string") throw httpError(400, "mediaType と data は必須です");
  return saveUpload(mediaType, data);
}));

// ---------- フォント（提案・インストール状況・インストール） ----------
const families = (v: unknown) => strings(v, 20);
app.post("/api/fonts/suggest", route(async (req, signal) => {
  const { kind, mood, title, texts, current } = req.body ?? {};
  return { proposals: await suggestFonts({ kind: kind === "poster" || kind === "instagram" ? kind : "slides", mood, title, texts: strings(texts, 200), current, signal }) };
}));
app.post("/api/fonts/status", route((req) => fontStatus(families(req.body?.families))));
app.post("/api/fonts/install", route((req) => installFonts(families(req.body?.families))));
app.post("/api/fonts/embed", route(async (req) => {
  const list: unknown[] = Array.isArray(req.body?.fonts) ? req.body.fonts.slice(0, 20) : [];
  const fonts = list.flatMap((f) => {
    const { family, bold, text } = (f ?? {}) as Record<string, unknown>;
    return typeof family === "string" && typeof text === "string" ? [{ family, bold: bold === true, text }] : [];
  });
  return { fonts: await embedFonts(fonts) };
}));

// ---------- 成果物（保存したポスターと画像） ----------
app.get("/api/posters", route(() => ({ posters: listPosters() })));
app.post("/api/posters", route((req) => createPoster(req.body?.spec)));
app.get("/api/posters/:id", route((req) => getPoster(param(req))));
app.put("/api/posters/:id", route((req) => updatePoster(param(req), req.body?.spec)));
app.post("/api/posters/:id/duplicate", route((req) => duplicatePoster(param(req))));
app.delete("/api/posters/:id", route((req) => { deletePoster(param(req)); return { ok: true }; }));
// デッキ（PPTX のスライドの並び）。スライドの中身は通常のポスターとして /api/posters で読み書きする
app.get("/api/decks", route(() => ({ decks: listDecks() })));
app.post("/api/decks", route((req) => createDeck(req.body?.name, req.body?.specs, req.body?.kind)));
app.get("/api/decks/:id", route((req) => getDeck(param(req))));
app.post("/api/decks/:id/duplicate", route((req) => duplicateDeck(param(req))));
app.delete("/api/decks/:id", route((req) => ({ ok: true, deleted: deleteDeck(param(req)) })));
app.put("/api/decks/:id", route((req) => updateDeck(param(req), req.body ?? {})));
app.post("/api/decks/:id/slides", route((req) => addDeckSlide(param(req), req.body ?? {})));
app.delete("/api/decks/:id/slides/:posterId", route((req) => removeDeckSlide(param(req), String(req.params.posterId))));
// ?specs=1 で全スライドの spec も返す（エディタはプロジェクトを開いたとき全スライドをまとめて読み込む）
app.get("/api/posters/:id/deck", route((req) => ({ deck: deckOfPoster(param(req), req.query.specs === "1") })));
/** 画像一覧。body.specs に編集中の spec を渡すと、それが使う画像も「使用中」として扱う */
app.post("/api/generated/list", route((req) => ({ files: listGenerated(req.body?.specs ?? []) })));
/** 未使用の画像だけを削除する（使用中のものは無視） */
app.post("/api/generated/delete", route((req) => ({ deleted: deleteGenerated(req.body?.names ?? [], req.body?.specs ?? []) })));

// OAuth のコールバックは http://127.0.0.1:<port> 固定。既定の "::" だと WSL が Windows 側へ [::1] しか転送せず、
// ブラウザから 127.0.0.1 に届かないので IPv4 ループバックに明示的にバインドする
app.listen(port, "127.0.0.1", () => {
  console.log(`[api] http://127.0.0.1:${port}  AI: ${aiProvider() ?? "なし"}${openRouterAvailable() ? ` (OpenRouter: ${openRouterModel()})` : ""}  image provider: ${imageProviderName()} (available: ${availableProviders().join(", ")})`);
});
