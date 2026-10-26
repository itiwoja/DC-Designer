/**
 * ChatGPT プラン経由の推論（Responses API）
 * 制約: store:false / stream:true 必須、temperature・max_output_tokens 等は送らない、system ロールは instructions で渡す
 * https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authStatus, getAccessToken, USAGE_URL } from "./chatgpt-auth";

/** detail: 画像の読み取りの細かさ（再現のように細部の位置・文字を読ませるときは "high"） */
export type ImageRef = { mediaType: string; data: string; detail?: "low" | "high" | "auto" };
/** 会話ターン（画像はユーザーの発言にだけ添付できる） */
export type Turn = { role: "user" | "assistant"; text: string; images?: ImageRef[] };

const API_BASE = "https://api.openai.com/v1";

export class ChatGPTError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

/** プラン利用のエラーコードを、ユーザーが次に何をすればよいか分かる文に変換 */
function chatGPTError(status: number, body: any): ChatGPTError {
  const code: string | undefined = body?.error?.code;
  const raw: string = body?.error?.message || body?.detail || body?.message || `HTTP ${status}`;
  const msg: Record<string, string> = {
    subscription_sharing_usage_limit_exceeded: `ChatGPT プランの利用上限に達しました。ChatGPT の設定 → 使用状況（${USAGE_URL}）で確認してください`,
    subscription_sharing_user_not_eligible: "このアカウント／ワークスペースでは ChatGPT プランを他のアプリで利用できません",
    subscription_sharing_usage_unavailable: "ChatGPT プランの利用状況を確認できませんでした。しばらくしてから再試行してください",
    subscription_sharing_user_unavailable: "ChatGPT のアカウント情報を一時的に取得できません。しばらくしてから再試行してください",
    subscription_sharing_invalid_user: "ChatGPT の認証が無効です。サインインし直してください",
    subscription_sharing_unsupported_capability: `ChatGPT プランでは使えない指定が含まれています（${body?.error?.param ?? "不明"}）`,
  };
  const httpStatus = status || (code === "subscription_sharing_usage_limit_exceeded" ? 429 : 502);
  return new ChatGPTError(code && msg[code] ? msg[code] : `ChatGPT エラー: ${raw}`, httpStatus, code);
}

let modelCache: { subject?: string; models: ChatGPTModel[] } | null = null;

export type ChatGPTModel = { slug: string; display_name: string };

/** サインイン中のアカウントで使えるモデル一覧（表示対象のみ・サーバーの並び順）。アカウントごとにキャッシュ */
export async function listModels(): Promise<ChatGPTModel[]> {
  const status = authStatus();
  const subject = status.signedIn ? status.subject : undefined;
  if (modelCache && modelCache.subject === subject) return modelCache.models;
  const res = await fetch(`${API_BASE}/models`, { headers: { Authorization: `Bearer ${await getAccessToken()}` } });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw chatGPTError(res.status, json);
  const models = (json.models ?? []).filter((m: any) => m.visibility === "list").map((m: any) => ({ slug: m.slug, display_name: m.display_name ?? m.slug }));
  modelCache = { subject, models };
  return models;
}

/** 画面で選んだモデルの保存先（data/chatgpt-model.json。テストでは DATA_DIR で差し替える） */
const MODEL_FILE = join(process.env.DATA_DIR || fileURLToPath(new URL("../data/", import.meta.url)), "chatgpt-model.json");

/** 画面で選んだモデル（未選択なら undefined = 自動） */
export function savedModel(): string | undefined {
  try {
    if (!existsSync(MODEL_FILE)) return undefined;
    const slug = JSON.parse(readFileSync(MODEL_FILE, "utf8"))?.model;
    return typeof slug === "string" && slug ? slug : undefined;
  } catch { return undefined; }
}

/** 使うモデルを保存する。空文字なら自動（CHATGPT_MODEL か一覧の先頭）に戻す。一覧に無いモデルは選べない */
export async function setChatGPTModel(slug: string): Promise<void> {
  if (slug && !(await listModels()).some((m) => m.slug === slug)) throw new ChatGPTError(`このアカウントでは使えないモデルです（${slug}）`, 400);
  mkdirSync(dirname(MODEL_FILE), { recursive: true });
  writeFileSync(MODEL_FILE + ".tmp", JSON.stringify({ model: slug || undefined }));
  renameSync(MODEL_FILE + ".tmp", MODEL_FILE);
}

/** 自動のときのモデル。CHATGPT_MODEL が無ければ一覧の先頭 */
async function defaultModel(): Promise<string> {
  if (process.env.CHATGPT_MODEL) return process.env.CHATGPT_MODEL;
  const models = await listModels();
  if (!models.length) throw new Error("このアカウントで使える ChatGPT のモデルがありません");
  return models[0].slug;
}

/** 使うモデル。画面で選んだモデルがこのアカウントで使えればそれ、無ければ自動 */
export async function chatGPTModel(): Promise<string> {
  const saved = savedModel();
  if (saved && (await listModels()).some((m) => m.slug === saved)) return saved;
  return defaultModel();
}

/** 設定画面用: 使えるモデル一覧・画面で選んだモデル・自動のときのモデル */
export async function modelSettings() {
  const [models, auto] = await Promise.all([listModels(), defaultModel()]);
  const saved = savedModel();
  return { models, modelChoice: saved && models.some((m) => m.slug === saved) ? saved : "", autoModel: auto };
}

const toInput = (turns: Turn[]) =>
  turns.map((t) =>
    t.role === "user"
      ? {
          role: "user" as const,
          content: [
            ...(t.images ?? []).map((r) => ({ type: "input_image" as const, image_url: `data:${r.mediaType};base64,${r.data}`, detail: r.detail ?? "auto" })),
            { type: "input_text" as const, text: t.text },
          ],
        }
      : { role: "assistant" as const, content: t.text },
  );

/** 応答ストリームが response.completed の前に切れたとき、最初から送り直す回数（長い再現などで接続が途中で閉じられることがある） */
const STREAM_RETRIES = 2;

// openai SDK は読み込みに時間がかかる（/mnt/c 上だと 10 秒以上）ので、起動を遅くしないよう使うときに読み込む
/** 会話を送り、ストリームで返ってきたテキスト全体を返す。onText には受け取り途中のテキスト全体を渡す（進み具合の表示用） */
export async function askChatGPT(instructions: string, turns: Turn[], onText?: (text: string) => void, signal?: AbortSignal): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const started = Date.now();
    let text = "";
    let completed = false;
    let lastEvent = "(なし)";
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: await getAccessToken(), baseURL: API_BASE, maxRetries: 0 });
    try {
      const stream = await client.responses.create({ model: await chatGPTModel(), instructions, input: toInput(turns), store: false, stream: true }, { signal });
      for await (const ev of stream) {
        lastEvent = ev.type;
        if (ev.type === "response.output_text.delta") { text += ev.delta; onText?.(text); }
        else if (ev.type === "response.completed") completed = true;
        else if (ev.type === "response.failed") throw chatGPTError(0, { error: ev.response.error });
        else if (ev.type === "response.incomplete") throw new Error(`ChatGPT の応答が途中で終了しました（${ev.response.incomplete_details?.reason ?? "incomplete"}）`);
        else if (ev.type === "error") throw chatGPTError(0, { error: { code: ev.code, message: ev.message } });
      }
    } catch (e) {
      // 中断（APIUserAbortError など）は ChatGPT の障害ではないので、そのまま中断として投げる
      if (signal?.aborted) throw new ChatGPTError("ChatGPT へのリクエストを中断しました", 499, "aborted");
      if (e instanceof OpenAI.APIError) throw chatGPTError(e.status ?? 0, { error: e.error, detail: (e.error as any)?.detail, message: e.message });
      throw e;
    }
    if (completed) return text;
    if (signal?.aborted) throw new ChatGPTError("ChatGPT へのリクエストを中断しました", 499, "aborted");
    // SDK は接続が閉じられても例外にせず黙って終わるので、ここで切断と判断する
    const where = `${Math.round((Date.now() - started) / 1000)} 秒・${text.length} 文字受信・最後のイベント ${lastEvent}`;
    if (attempt < STREAM_RETRIES) {
      console.warn(`[chatgpt] 応答ストリームが完了前に切れたので送り直します（${attempt + 1}/${STREAM_RETRIES}、${where}）`);
      continue;
    }
    throw new ChatGPTError(`ChatGPT の応答ストリームが完了前に切れました（${STREAM_RETRIES + 1} 回試行、最後は ${where}）。しばらくしてから再試行してください`, 502, "stream_cut");
  }
}

/** 応答テキストから JSON を取り出す（コードフェンスや前置きが付いていても拾う） */
export function extractJson(text: string, label = "JSON"): unknown {
  const body = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error(`${label} が見つかりませんでした`);
  return JSON.parse(body.slice(start, end + 1));
}
