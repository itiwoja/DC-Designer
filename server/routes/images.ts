import type { Router } from "express";
import { AssetContext, AssetRequest } from "../../src/schema";
import { httpError } from "../http-error";
import { generateAsset, saveUpload } from "../imagegen";
import { updateImageSettings } from "../image-settings";
import { installCodex, loginCodex } from "../codex-setup";
import type { RouteHandlers } from "../route-handlers";

/** 画像アセットの生成と取り込み */
export function registerImageRoutes(app: Router, { route, progressRoute }: RouteHandlers) {
  /** 画像アセット 1 点を生成 */
  app.post("/api/asset", route((req, signal) => generateAsset(AssetRequest.parse(req.body?.asset), AssetContext.parse(req.body?.context ?? {}), req.body?.provider, signal)));

  /** 画像生成の設定（{ comfyuiUrl?, codexPath? }。空文字で既定に戻す）。保存後の設定を返す */
  app.put("/api/image/settings", route((req) => updateImageSettings(req.body)));

  /** 製品版：固定版の Codex CLI を入れる（進み具合を NDJSON で流す）。入れた場所と版を返す */
  app.post("/api/codex/install", progressRoute((_req, onProgress, signal) => installCodex(onProgress, signal)));
  /** 製品版：`codex login` でサインインする（ブラウザでのサインインが済むまで待つ） */
  app.post("/api/codex/login", progressRoute((_req, onProgress, signal) => loginCodex(onProgress, signal)));

  /** 手持ちの画像ファイルを取り込む（{ mediaType, data: base64 }） */
  app.post("/api/upload", route((req) => {
    const { mediaType, data } = req.body ?? {};
    if (typeof mediaType !== "string" || typeof data !== "string") throw httpError(400, "mediaType と data は必須です");
    return saveUpload(mediaType, data);
  }));
}
