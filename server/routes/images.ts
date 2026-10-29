import type { Router } from "express";
import { AssetContext, AssetRequest } from "../../src/schema";
import { httpError } from "../http-error";
import { generateAsset, saveUpload } from "../imagegen";
import type { RouteHandlers } from "../route-handlers";

/** 画像アセットの生成と取り込み */
export function registerImageRoutes(app: Router, { route }: RouteHandlers) {
  /** 画像アセット 1 点を生成 */
  app.post("/api/asset", route((req, signal) => generateAsset(AssetRequest.parse(req.body?.asset), AssetContext.parse(req.body?.context ?? {}), req.body?.provider, signal)));

  /** 手持ちの画像ファイルを取り込む（{ mediaType, data: base64 }） */
  app.post("/api/upload", route((req) => {
    const { mediaType, data } = req.body ?? {};
    if (typeof mediaType !== "string" || typeof data !== "string") throw httpError(400, "mediaType と data は必須です");
    return saveUpload(mediaType, data);
  }));
}
