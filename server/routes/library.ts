import type { Request, Router } from "express";
import { addDeckSlide, createDeck, createPoster, createTemplate, deckOfPoster, deleteDeck, deleteGenerated, deletePoster, deleteTemplate, duplicateDeck, duplicatePoster, getDeck, getPoster, listDecks, listGenerated, listPosters, listTemplates, removeDeckSlide, renameTemplate, updateDeck, updatePoster, useTemplate } from "../library";
import type { RouteHandlers } from "../route-handlers";

/** 成果物（保存したポスター・デッキ・画像）の管理 */
export function registerLibraryRoutes(app: Router, { route }: RouteHandlers) {
  const param = (req: Request) => String(req.params.id);

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
  // テンプレート（ポスター 1 枚／デッキ丸ごとのひな形）。成果物の一覧には混ぜない
  app.get("/api/templates", route(() => ({ templates: listTemplates() })));
  app.post("/api/templates", route((req) => createTemplate(req.body ?? {})));
  app.put("/api/templates/:id", route((req) => renameTemplate(param(req), req.body?.name)));
  app.delete("/api/templates/:id", route((req) => { deleteTemplate(param(req)); return { ok: true }; }));
  app.post("/api/templates/:id/use", route((req) => useTemplate(param(req))));
  /** 画像一覧。body.specs に編集中の spec を渡すと、それが使う画像も「使用中」として扱う */
  app.post("/api/generated/list", route((req) => ({ files: listGenerated(req.body?.specs ?? []) })));
  /** 未使用の画像だけを削除する（使用中のものは無視） */
  app.post("/api/generated/delete", route((req) => ({ deleted: deleteGenerated(req.body?.names ?? [], req.body?.specs ?? []) })));
}
