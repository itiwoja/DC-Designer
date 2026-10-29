import type { Router } from "express";
import { PosterSpecSchema } from "../../src/schema";
import { IG_MAX_IMAGES } from "../../src/instagram";
import { runWithAiSubject } from "../ai-consent";
import { httpError } from "../http-error";
import { editPoster, planCarousel, planPoster, planSlide, refineReproduction, reproducePoster, summarizeChat, writeNotes } from "../planner";
import { storeReferences } from "../references";
import { optString, parseAcross, parseDeckContext, parseImage, parseSubject, parseTurns, strings } from "../request-parsers";
import type { RouteHandlers } from "../route-handlers";

/** レイアウト生成・編集・参考画像の再現・会話と台本の生成 */
export function registerAiRoutes(app: Router, { route, progressRoute }: RouteHandlers) {
  /** ブリーフ（＋参考画像）→ PosterSpec */
  app.post("/api/plan", route(async (req, signal) => {
    const subject = parseSubject(req.body?.subject);
    const { brief, theme, references } = req.body ?? {};
    if (!brief) throw httpError(400, "brief は必須です");
    return runWithAiSubject(subject, async () => ({ spec: await planPoster({ brief, theme, references: storeReferences(references), signal }) }));
  }));

  /** ブリーフ（＋参考画像）→ Instagram のカルーセル投稿（同じ大きさの PosterSpec を 1〜20 枚） */
  app.post("/api/plan/instagram", progressRoute(async (req, onProgress, signal) => {
    const subject = parseSubject(req.body?.subject);
    const { brief, width, height, count, references } = req.body ?? {};
    if (!brief) throw httpError(400, "brief は必須です");
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 100 || height < 100) throw httpError(400, "width / height が不正です");
    const n = Number.isInteger(count) && count >= 1 && count <= IG_MAX_IMAGES ? count : undefined;
    return runWithAiSubject(subject, () => planCarousel({ brief, width, height, count: n, references: storeReferences(references), onProgress, signal }));
  }));

  /** 参考画像 → それをそのまま写し取った PosterSpec（A4 モードの「参考画像を再現」） */
  app.post("/api/reproduce", progressRoute(async (req, onProgress, signal) => {
    const subject = parseSubject(req.body?.subject);
    const { width, height, brief } = req.body ?? {};
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 100 || height < 100) throw httpError(400, "width / height が不正です");
    return runWithAiSubject(subject, async () => ({ spec: await reproducePoster({ reference: parseImage(req.body?.reference, "reference"), width, height, brief: optString(brief, 4000), onProgress, signal }) }));
  }));

  /** 再現の仕上げ: 参考画像と現在の描画結果を見比べて spec を直す（spec が無ければ直すところなし） */
  app.post("/api/reproduce/refine", progressRoute(async (req, onProgress, signal) => {
    const subject = parseSubject(req.body?.subject);
    const spec = PosterSpecSchema.parse(req.body?.spec);
    return runWithAiSubject(subject, () => refineReproduction({ reference: parseImage(req.body?.reference, "reference"), render: parseImage(req.body?.render, "render"), spec, onProgress, signal }));
  }));

  /** チャットの古いやりとりを既存の要約に畳み込む（ローリング要約） */
  app.post("/api/chat/summarize", route(async (req, signal) => {
    const subject = parseSubject(req.body?.subject);
    const turns = parseTurns(req.body?.turns).slice(-60);
    if (!turns.length) throw httpError(400, "turns は必須です");
    return runWithAiSubject(subject, async () => ({ summary: await summarizeChat({ summary: optString(req.body?.summary, 3000), turns, signal }) }));
  }));

  /** 既存 PosterSpec ＋ 指示 → 修正版 PosterSpec（deck があれば、書き換えるスライド番号 target も返す） */
  app.post("/api/edit", route(async (req, signal) => {
    const subject = parseSubject(req.body?.subject);
    const spec = PosterSpecSchema.parse(req.body?.spec);
    const { instruction, selectedIds } = req.body ?? {};
    if (!instruction) throw httpError(400, "instruction は必須です");
    const deck = parseDeckContext(req.body?.deck);
    const history = parseTurns(req.body?.history).slice(-30);
    return runWithAiSubject(subject, () => editPoster({ spec, instruction, selectedIds, deck, across: parseAcross(req.body?.across), history, memory: optString(req.body?.memory, 3000), instagram: req.body?.instagram === true, references: storeReferences(req.body?.references), signal }));
  }));

  /** デッキの並び（文字）＋お手本のスライド ＋ 指示 → 新しく追加する 1 枚の PosterSpec（追加は画面側で行う） */
  app.post("/api/slide", route(async (req, signal) => {
    const subject = parseSubject(req.body?.subject);
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
    return runWithAiSubject(subject, () => planSlide({
      instruction: String(instruction), position, total, deckTitle: optString(req.body?.title, 200), outline, samples,
      history: parseTurns(req.body?.history).slice(-30), memory: optString(req.body?.memory, 3000), instagram: req.body?.instagram === true, references: storeReferences(req.body?.references), signal,
    }));
  }));

  /** デッキの全スライドの文字・画像の説明（＋既存の台本）→ targets の番号のスライドの台本 */
  app.post("/api/notes", route(async (req, signal) => {
    const subject = parseSubject(req.body?.subject);
    const slides = (Array.isArray(req.body?.slides) ? req.body.slides : []).slice(0, 200).map((s: any) => ({
      number: Number(s?.number), title: optString(s?.title, 200), texts: strings(s?.texts, 100).map((t) => t.slice(0, 1000)), images: strings(s?.images, 20).map((t) => t.slice(0, 300)), notes: optString(s?.notes, 3000),
    })).filter((s: { number: number }) => Number.isInteger(s.number));
    const targets = (Array.isArray(req.body?.targets) ? req.body.targets : []).map(Number).filter(Number.isInteger).slice(0, 30);
    if (!slides.length || !targets.length) throw httpError(400, "slides と targets は必須です");
    return runWithAiSubject(subject, async () => ({ notes: await writeNotes({ deckTitle: optString(req.body?.title, 200), slides, targets, request: optString(req.body?.request, 1000), signal }) }));
  }));
}
