/**
 * OpenRouter（https://openrouter.ai）経由の推論（Chat Completions 互換 API）。.env の OPENROUTER_API_KEY を使う
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import type { ChatCompletionContentPart, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Turn } from "./chatgpt";
import { httpError } from "./http-error";

const BASE_URL = "https://openrouter.ai/api/v1";
/** OPENROUTER_MODEL が無いときのモデル（画像を読めるモデルにする。参考画像の再現・見比べで画像を渡す） */
export const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-5.5";
const CREDITS_URL = "https://openrouter.ai/settings/credits";

export const openRouterAvailable = () => !!process.env.OPENROUTER_API_KEY;

export type OpenRouterModel = { slug: string; display_name: string };
let modelCache: OpenRouterModel[] | null = null;

/**
 * 選べるモデルの一覧（名前順）。参考画像の再現・見比べで画像を渡すので、画像を読めて文章を返すモデルだけにする。
 * :batch は逐次の応答に使えないので除く。一覧はサーバーの起動中は使い回す
 */
export async function listOpenRouterModels(): Promise<OpenRouterModel[]> {
  if (modelCache) return modelCache;
  const res = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw openRouterError(res.status, json?.error?.message ?? `HTTP ${res.status}`);
  modelCache = (json.data ?? [])
    .filter((m: any) => m.architecture?.input_modalities?.includes("image") && m.architecture?.output_modalities?.includes("text") && !String(m.id).endsWith(":batch"))
    .map((m: any) => ({ slug: String(m.id), display_name: String(m.name ?? m.id) }))
    .sort((a: OpenRouterModel, b: OpenRouterModel) => a.display_name.localeCompare(b.display_name));
  return modelCache!;
}

/** 画面で選んだモデルの保存先（data/openrouter-model.json。テストでは DATA_DIR で差し替える） */
const MODEL_FILE = join(process.env.DATA_DIR || fileURLToPath(new URL("../data/", import.meta.url)), "openrouter-model.json");

/** 画面で選んだモデル（未選択なら undefined = 自動） */
function savedModel(): string | undefined {
  try {
    if (!existsSync(MODEL_FILE)) return undefined;
    const slug = JSON.parse(readFileSync(MODEL_FILE, "utf8"))?.model;
    return typeof slug === "string" && slug ? slug : undefined;
  } catch { return undefined; }
}

/** 使うモデルを保存する。空文字なら自動（OPENROUTER_MODEL か既定）に戻す。一覧に無いモデルは選べない */
export async function setOpenRouterModel(slug: string): Promise<void> {
  if (slug && !(await listOpenRouterModels()).some((m) => m.slug === slug)) throw httpError(400, `OpenRouter で選べないモデルです（${slug}）`);
  mkdirSync(dirname(MODEL_FILE), { recursive: true });
  writeFileSync(MODEL_FILE + ".tmp", JSON.stringify({ model: slug || undefined }));
  renameSync(MODEL_FILE + ".tmp", MODEL_FILE);
}

/** 自動のときのモデル */
const autoModel = () => process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
/** 使うモデル。画面で選んだモデルがあればそれ、無ければ自動 */
export const openRouterModel = () => savedModel() ?? autoModel();

/**
 * 設定画面用: 今使うモデル・選べるモデル一覧（取れなければ undefined とその理由）・画面で選んだモデル（"" は自動）・自動のときのモデル
 * 一覧が取れない（キーが無効など）ときは modelsError を返し、画面でキーの問題を先に知らせる（最初の生成で初めて 401 を見ることにならないように）
 */
export async function openRouterSettings() {
  let models: OpenRouterModel[] | undefined;
  let modelsError: string | undefined;
  try { models = await listOpenRouterModels(); } catch (e) { modelsError = e instanceof Error ? e.message : String(e); }
  return { model: openRouterModel(), models, modelsError, modelChoice: savedModel() ?? "", autoModel: autoModel() };
}

/** OpenRouter のエラーを、ユーザーが次に何をすればよいか分かる文に変換 */
function openRouterError(status: number, raw: string) {
  const msg: Record<number, string> = {
    401: "OpenRouter の API キーが無効です。.env の OPENROUTER_API_KEY を確認して、API サーバーを再起動してください",
    402: `OpenRouter のクレジットが足りません。残高を確認してください（${CREDITS_URL}）`,
    429: "OpenRouter のレート制限に達しました。しばらくしてから再試行してください",
  };
  return httpError(status >= 400 ? status : 502, msg[status] ?? `OpenRouter エラー（${openRouterModel()}）: ${raw}`);
}

const toMessages = (instructions: string, turns: Turn[]): ChatCompletionMessageParam[] => [
  { role: "system", content: instructions },
  ...turns.map((t): ChatCompletionMessageParam =>
    t.role === "user"
      ? {
          role: "user",
          content: [
            ...(t.images ?? []).map((r): ChatCompletionContentPart => ({ type: "image_url", image_url: { url: `data:${r.mediaType};base64,${r.data}`, detail: r.detail ?? "auto" } })),
            { type: "text", text: t.text },
          ],
        }
      : { role: "assistant", content: t.text },
  ),
];

/** 応答ストリームが finish_reason を受け取る前に切れたとき、最初から送り直す回数 */
const STREAM_RETRIES = 2;

/** 会話を送り、ストリームで返ってきたテキスト全体を返す。onText には受け取り途中のテキスト全体を渡す（進み具合の表示用） */
export async function askOpenRouter(instructions: string, turns: Turn[], onText?: (text: string) => void, signal?: AbortSignal): Promise<string> {
  if (!openRouterAvailable()) throw httpError(400, "OpenRouter の API キーがありません。.env に OPENROUTER_API_KEY を設定して、API サーバーを再起動してください");
  // 再送はこちらで制御する（SDK の既定の再送に任せると、レート制限などの表示が最長 10 秒ほど遅れる。chatgpt.ts と同じ）
  const client = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: BASE_URL, maxRetries: 0, defaultHeaders: { "X-Title": "DC-Designer" } });
  const maxTokens = Number(process.env.OPENROUTER_MAX_TOKENS) || undefined;
  const aborted = () => httpError(499, "OpenRouter へのリクエストを中断しました");
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    let text = "";
    let finish: string | null = null;
    try {
      const stream = await client.chat.completions.create({ model: openRouterModel(), messages: toMessages(instructions, turns), stream: true, max_tokens: maxTokens }, { signal });
      // 途中のエラーチャンクは SDK が APIError（status なし）にして投げる
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (choice?.delta?.content) { text += choice.delta.content; onText?.(text); }
        if (choice?.finish_reason) finish = choice.finish_reason;
      }
    } catch (e) {
      // 中断（APIUserAbortError など）は OpenRouter の障害ではないので、そのまま中断として投げる
      if (signal?.aborted) throw aborted();
      if (e instanceof OpenAI.APIError) throw openRouterError(e.status ?? 0, (e.error as { message?: string } | undefined)?.message ?? e.message);
      throw e;
    }
    if (finish === "length") throw httpError(502, `OpenRouter の応答が出力の上限で途中終了しました（${openRouterModel()}）。.env の OPENROUTER_MAX_TOKENS を増やすか、別のモデルを試してください`);
    if (finish) return text;
    if (signal?.aborted) throw aborted();
    if (attempt < STREAM_RETRIES) {
      console.warn(`[openrouter] 応答ストリームが完了前に切れたので送り直します（${attempt + 1}/${STREAM_RETRIES}、${text.length} 文字受信）`);
      continue;
    }
    throw httpError(502, `OpenRouter の応答ストリームが完了前に切れました（${STREAM_RETRIES + 1} 回試行）。しばらくしてから再試行してください`);
  }
}
