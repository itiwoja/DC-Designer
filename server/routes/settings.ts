import type { Router } from "express";
import { authStatus, USAGE_URL } from "../chatgpt-auth";
import { chatGPTModel, modelSettings, setChatGPTModel } from "../chatgpt";
import { aiStatus, setAIProvider } from "../ai";
import { availableProviders, imageProviderName } from "../imagegen";
import { openRouterModel, setOpenRouterModel } from "../openrouter";
import { optString } from "../request-parsers";
import type { RouteHandlers } from "../route-handlers";

/** サーバーの状態と AI プロバイダー・モデルの設定 */
export function registerSettingsRoutes(app: Router, { route }: RouteHandlers) {
  app.get("/api/status", route(async () => {
    const chatgpt = await authStatus();
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
}
