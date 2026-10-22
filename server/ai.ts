/**
 * レイアウト生成・AI 修正・フォント提案に使う AI（ChatGPT プラン / OpenRouter）の選択と呼び出し
 * 優先順: 画面で選んだもの（data/ai-provider.json）> .env の AI_PROVIDER > 自動（ChatGPT プランが使えれば ChatGPT、無ければ OpenRouter）
 * 明示したほうが使えないときは別の AI に切り替えない（ChatGPT を選んだのに OpenRouter で課金されないように）
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authStatus } from "./chatgpt-auth";
import { askChatGPT, type Turn } from "./chatgpt";
import { askOpenRouter, openRouterAvailable, openRouterSettings } from "./openrouter";
import { httpError } from "./http-error";

export type AIProvider = "chatgpt" | "openrouter";
const isProvider = (v: unknown): v is AIProvider => v === "chatgpt" || v === "openrouter";

/** 画面で選んだ AI の保存先（テストでは DATA_DIR で差し替える） */
const CHOICE_FILE = join(process.env.DATA_DIR || fileURLToPath(new URL("../data/", import.meta.url)), "ai-provider.json");

/** 画面で選んだ AI（未選択なら undefined = .env か自動） */
function savedChoice(): AIProvider | undefined {
  try {
    if (!existsSync(CHOICE_FILE)) return undefined;
    const p = JSON.parse(readFileSync(CHOICE_FILE, "utf8"))?.provider;
    return isProvider(p) ? p : undefined;
  } catch { return undefined; }
}

/** 使う AI を保存する。空文字なら .env か自動に戻す */
export function setAIProvider(provider: string): void {
  if (provider && !isProvider(provider)) throw httpError(400, `不明な AI です（${provider}）`);
  mkdirSync(dirname(CHOICE_FILE), { recursive: true });
  writeFileSync(CHOICE_FILE + ".tmp", JSON.stringify({ provider: provider || undefined }));
  renameSync(CHOICE_FILE + ".tmp", CHOICE_FILE);
}

function usable(p: AIProvider): boolean {
  if (p === "openrouter") return openRouterAvailable();
  const s = authStatus();
  return s.signedIn && s.planEnabled;
}

/** 明示（画面の選択か .env）があればそれ（使えなければ undefined）、無ければ使えるほう */
function resolve(explicit: AIProvider | undefined): AIProvider | undefined {
  if (explicit) return usable(explicit) ? explicit : undefined;
  return usable("chatgpt") ? "chatgpt" : usable("openrouter") ? "openrouter" : undefined;
}
const envChoice = () => { const p = (process.env.AI_PROVIDER || "").toLowerCase(); return isProvider(p) ? p : undefined; };

/** 今使う AI。どれも使えなければ undefined */
export const aiProvider = () => resolve(savedChoice() ?? envChoice());

/**
 * 設定画面用: 今使う AI・画面で選んだもの（"" は自動）・明示しているもの（画面か .env の AI_PROVIDER。無ければ自動）・自動のときの AI・OpenRouter の設定（キーが無ければ null）
 * explicit は「選んだ AI が使えない」案内の判定用（.env で選んだときも画面の選択と同じ案内にする）
 */
export async function aiStatus() {
  return {
    provider: aiProvider(),
    choice: savedChoice() ?? "",
    explicit: savedChoice() ?? envChoice(),
    autoProvider: resolve(envChoice()),
    openrouter: openRouterAvailable() ? await openRouterSettings() : null,
  };
}

/**
 * 会話を今使う AI に送り、返ってきたテキスト全体を返す。
 * 使えないときは明示した AI（無ければ ChatGPT）に送り、そちらのエラー（キーが無い・サインインが要る）にする
 */
export function askAI(instructions: string, turns: Turn[], onText?: (text: string) => void, signal?: AbortSignal): Promise<string> {
  const p = aiProvider() ?? savedChoice() ?? envChoice();
  return p === "openrouter" ? askOpenRouter(instructions, turns, onText, signal) : askChatGPT(instructions, turns, onText, signal);
}
