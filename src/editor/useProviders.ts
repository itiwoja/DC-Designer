import { useCallback, useState } from "react";
import { api, type AIProvider, type Status } from "./api";
import { readPref, writePref } from "./storage";
import type { Notice } from "./Toasts";
import { useLoadWithRetry } from "./ui";

const IMAGE_PROVIDER_KEY = "dc-designer:image-provider";
const AUTO_IMAGES_KEY = "dc-designer:auto-images";

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

/** サーバーの状態（ChatGPT・画像生成）と、使う AI・画像生成・モデルの選択 */
export function useProviders(notify: (n: Omit<Notice, "id">) => void) {
  const [status, setStatus] = useState<Status | null>(null);
  const refreshStatus = useLoadWithRetry(useCallback(() => api.status().then(setStatus), []));
  const apiUp = !!status;
  const gpt = status?.chatgpt;
  // レイアウト生成・AI 修正に使う AI（ChatGPT プランか OpenRouter）。どちらも使えなければ undefined。
  // ai を返さない古い API サーバー（再起動前）のあいだは、従来どおり ChatGPT プランが使えれば ChatGPT
  const aiProvider = status?.ai ? status.ai.provider : gpt?.signedIn && gpt.planEnabled ? "chatgpt" : undefined;
  const openrouter = status?.ai?.openrouter;
  const aiReady = !status || !!aiProvider;
  /** 進み具合の表示での AI の呼び名 */
  const aiName = aiProvider === "openrouter" ? "AI" : "ChatGPT";
  const [imageProvider, setImageProvider] = useState(() => readPref(IMAGE_PROVIDER_KEY) ?? "");
  const [autoImages, setAutoImages] = useState(() => readPref(AUTO_IMAGES_KEY) !== "0");
  // ダミー画像（placeholder）は選択肢に出さない
  const imageChoices = status?.imageProviders.filter((p) => p !== "placeholder") ?? [];
  // 選んだプロバイダが使えなくなっていたら（キー削除など）サーバーの既定 → 先頭の選択肢に戻す
  const activeImageProvider = imageChoices.includes(imageProvider) ? imageProvider
    : status && imageChoices.includes(status.imageProvider) ? status.imageProvider
    // 選んでいないときは、ChatGPT のプラン枠で作れる Codex を、起動しているか分からない ComfyUI より先にする
    : imageChoices.includes("codex") ? "codex" : imageChoices[0];
  const chooseImageProvider = (p: string) => { setImageProvider(p); writePref(IMAGE_PROVIDER_KEY, p); };
  const changeModel = (set: (model: string) => Promise<unknown>) => (model: string) =>
    set(model).then(refreshStatus, (e) => notify({ kind: "error", text: `モデルを変更できませんでした: ${errorText(e)}` }));
  const chooseChatGPTModel = changeModel(api.setChatGPTModel);
  const chooseOpenRouterModel = changeModel(api.setOpenRouterModel);
  const chooseAIProvider = (provider: AIProvider | "") =>
    api.setAIProvider(provider).then(refreshStatus, (e) => notify({ kind: "error", text: `AI を切り替えられませんでした: ${errorText(e)}` }));
  const toggleAutoImages = (on: boolean) => { setAutoImages(on); writePref(AUTO_IMAGES_KEY, on ? "1" : "0"); };
  return {
    status, setStatus, refreshStatus, apiUp, gpt, aiProvider, openrouter, aiReady, aiName,
    autoImages, toggleAutoImages, imageChoices, activeImageProvider, chooseImageProvider,
    chooseChatGPTModel, chooseOpenRouterModel, chooseAIProvider,
  };
}
