import type { AssetContext, AssetRequest, PosterSpec } from "../schema";
import { postWithProgress, request, type AIProgress, type SetupProgress } from "./apiTransport";
import { withSubject, type AiSubject } from "./aiSubject";
import { runDesktopSignIn } from "./accountView";
import { desktopBridge } from "./desktop";
export type { AIProgress, SetupProgress } from "./apiTransport";
/** 画像生成 1 回の待ち時間の上限（ミリ秒） */
const ASSET_TIMEOUT_MS = 16 * 60_000;
const get = <T>(url: string) => request<T>("GET", url);
const post = <T>(url: string, body: unknown, signal?: AbortSignal) => request<T>("POST", url, body, signal);
const put = <T>(url: string, body: unknown) => request<T>("PUT", url, body);
const del = <T>(url: string) => request<T>("DELETE", url);

/** API が 404（対象が削除済みなど）を返したエラーか */
export const isNotFound = (e: unknown) => (e as { status?: number })?.status === 404;

/** File / Blob を data URL として読む */
export const readDataUrl = (blob: Blob) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result as string);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

export type RefImage = { mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; data: string; name?: string; width?: number; height?: number };

export type ChatGPTStatus =
  | { signedIn: false; previousEmail?: string; usageUrl: string }
  | { signedIn: true; email?: string; name?: string; picture?: string; subject: string; planEnabled: boolean; usageUrl: string;
      /** 今使うモデル・使えるモデル一覧・画面で選んだモデル（"" は自動）・自動のときのモデル */
      model?: string; models?: { slug: string; display_name: string }[]; modelChoice?: string; autoModel?: string };

export type SavedPoster = { id: string; createdAt: string; updatedAt: string; spec: PosterSpec };
export type GeneratedFile = { name: string; src: string; size: number; mtime: string; uploaded: boolean; usedBy: string[] };

export type DeckSlide = { id: string; title: string; updatedAt: string; spec?: PosterSpec };
/** slides: スライドのデッキ（無ければこれ）／ instagram: 以前の版で作った Instagram の投稿（画面には出さない。データは残す） */
export type DeckKind = "slides" | "instagram";
export type Deck = { id: string; name: string; kind?: DeckKind; createdAt: string; updatedAt: string; slides: DeckSlide[] };

/** スライド ID → それが入っているデッキ（プロジェクト） */
export const deckBySlide = (decks: Deck[] | null) => new Map((decks ?? []).flatMap((d) => d.slides.map((s) => [s.id, d] as const)));

/** チャットのやりとり（AI に文脈として渡す）。note は「別のポスターを開いた」などの出来事 */
export type ChatTurn = { role: "user" | "assistant" | "note"; text: string };
/** チャットの文脈: 古い会話の要約 ＋ 直近の原文 */
export type ChatContext = { memory?: string; history: ChatTurn[] };

/** AI 修正の資料全体のスライド（番号は 1 始まり） */
/** spec があるスライドは書き換え・統合の対象、texts だけのスライドは参考（文字の要約） */
export type DeckEditContext = { current: number; total: number; slides: { number: number; title?: string; spec?: PosterSpec; texts?: string[]; notes?: string }[]; /** スライド一覧で複数選択中のスライド番号 */ selected?: number[] };
/** 編集後のデッキの並びの 1 枠。数値 = 元のスライド番号（1 始まり。2 回目以降は複製）、{ spec } = 新しく作るスライド */
export type DeckSlot = number | { spec: PosterSpec };

export type FontProposal = { name: string; reason: string; display: string; body: string };
export type FontStatus = { target: "windows" | "mac" | "linux"; installed: Record<string, boolean> };

export type AIProvider = "chatgpt" | "openrouter";
/**
 * レイアウト生成・AI 修正に使う AI: 今使うもの（無ければ使えない）・画面で選んだもの（"" は自動）・明示しているもの（画面か .env。無ければ自動）・
 * 自動のときのもの・OpenRouter の設定（キーが無ければ null）
 */
export type AIStatus = { provider?: AIProvider; choice: AIProvider | ""; explicit?: AIProvider; autoProvider?: AIProvider; openrouter: OpenRouterStatus | null };
/** OpenRouter: 今使うモデル・選べるモデル一覧（取れなければ無し。modelsError に理由）・画面で選んだモデル（"" は自動）・自動のときのモデル */
export type OpenRouterStatus = { model: string; models?: { slug: string; display_name: string }[]; modelsError?: string; modelChoice: string; autoModel: string };

/** ai は再起動前の古い API サーバーからは届かない（そのあいだは従来どおり ChatGPT プランが使えれば使える扱い） */
export type Status = { imageProvider: string; imageProviders: string[]; chatgpt: ChatGPTStatus; ai?: AIStatus; imageSettings?: ImageSettings; codex?: CodexStatus };
/** 画像生成の設定（空文字は既定）。製品版のみ */
export type ImageSettings = { comfyuiUrl: string; codexPath: string };
/** Codex CLI の状態（製品版のみ） */
export type CodexStatus = {
  state: "ready" | "not_found" | "signed_out"; path?: string;
  /** 見つけた場所：設定で指定／PATH／npm／Codex アプリ同梱／このアプリが入れたもの */
  source?: "configured" | "path" | "npm" | "codex-app" | "app";
  /** この PC にアプリから入れられるか（古い API からは届かない）と、入れる版 */
  canInstall?: boolean; installVersion?: string;
};

/** サインイン用タブから元のタブへ結果を渡すチャンネル名 */
export const AUTH_CHANNEL = "dc-designer:chatgpt-auth";
/** サインイン用タブを開いたときに window へ流すイベント（元のタブがサーバーの状態を見張り始める） */
export const AUTH_STARTED_EVENT = "dc-designer:chatgpt-auth-started";

/** サインイン用タブを開く（newAccount のとき、保存済みのアカウントの情報を使わず新しく登録する） */
function openChatGPTLogin(newAccount: boolean) {
  // 製品版は main が既定のブラウザとループバックの受け口でサインインする（画面から別タブは開けない）
  const bridge = desktopBridge();
  if (bridge) {
    void runDesktopSignIn(bridge, newAccount);
    return;
  }
  const params: Record<string, string> = { returnTo: location.origin, popup: "1" };
  if (newAccount) params.account = "new";
  window.open(`/api/auth/chatgpt/login?${new URLSearchParams(params)}`, "_blank", "noopener");
  window.dispatchEvent(new Event(AUTH_STARTED_EVENT));
}

export const api = {
  status: () => get<Status>("/api/status"),
  /** Sign in with ChatGPT は別タブで行う（API サーバー → OpenAI → ループバック → ?popup=1 付きでここへ戻り、結果を元のタブへ渡して閉じる） */
  chatgptLogin: () => openChatGPTLogin(false),
  /** 別の ChatGPT アカウント・ワークスペースでサインインする（新しく登録し直す） */
  chatgptLoginNewAccount: () => openChatGPTLogin(true),
  chatgptLogout: () => post<{ ok: true }>("/api/auth/chatgpt/logout", {}),
  /** レイアウト生成・AI 修正に使うモデルを選ぶ（"" で自動） */
  setChatGPTModel: (model: string) => put<{ model: string }>("/api/chatgpt/model", { model }),
  /** レイアウト生成・AI 修正に使う AI を選ぶ（"" で自動） */
  setImageSettings: (body: Partial<ImageSettings>) => put<ImageSettings>("/api/image/settings", body),
  /** 製品版：固定版の Codex CLI を入れる（進み具合を onProgress へ） */
  installCodex: (onProgress?: (p: SetupProgress) => void, signal?: AbortSignal) =>
    postWithProgress<{ path: string; version: string; signedIn: boolean }, SetupProgress>("/api/codex/install", {}, onProgress, signal),
  /** 製品版：`codex login` でサインインする（ブラウザでのサインインが済むまで待つ） */
  loginCodex: (onProgress?: (p: SetupProgress) => void, signal?: AbortSignal) =>
    postWithProgress<{ signedIn: true }, SetupProgress>("/api/codex/login", {}, onProgress, signal),
  setAIProvider: (provider: AIProvider | "") => put<AIStatus>("/api/ai/provider", { provider }),
  /** OpenRouter で使うモデルを選ぶ（"" で自動） */
  setOpenRouterModel: (model: string) => put<{ model: string }>("/api/openrouter/model", { model }),
  plan: (brief: string, theme: string | undefined, references: RefImage[], signal?: AbortSignal) =>
    post<{ spec: PosterSpec }>("/api/plan", { brief, theme, references }, signal),
  /** 参考画像をそのまま写し取った spec（A4 モードの「参考画像を再現」）。reference はポスターの大きさに縮めたもの */
  reproduce: (reference: RefImage, width: number, height: number, brief: string, onProgress?: (p: AIProgress) => void, signal?: AbortSignal) =>
    postWithProgress<{ spec: PosterSpec }>("/api/reproduce", { reference, width, height, brief }, onProgress, signal),
  /** 再現の仕上げ: 参考画像と今の描画結果を見比べて直した spec（直すところが無ければ spec なし） */
  refineReproduction: (reference: RefImage, render: RefImage, spec: PosterSpec, onProgress?: (p: AIProgress) => void, signal?: AbortSignal, subject?: AiSubject) =>
    postWithProgress<{ reply: string; spec?: PosterSpec }>("/api/reproduce/refine", withSubject({ reference, render, spec }, subject), onProgress, signal),
  /** チャットでの修正。spec が無ければ変更なし（質問への回答など） */
  /** across はデッキの全スライドへの指示を 1 枚ずつ当てるときの、そのスライドの位置と先に直したスライドの方針 */
  edit: (spec: PosterSpec, instruction: string, selectedIds: string[] | undefined, signal?: AbortSignal, deck?: DeckEditContext, chat?: ChatContext, across?: { number: number; total: number; guide?: string }, references?: RefImage[], subject?: AiSubject) =>
    post<{ reply: string; spec?: PosterSpec; target?: number; others?: { target: number; spec: PosterSpec }[]; sequence?: DeckSlot[] }>("/api/edit", withSubject({ spec, instruction, selectedIds, deck, across, history: chat?.history, memory: chat?.memory, references }, subject), signal),
  /** デッキの並び（文字）とお手本のスライドから、position 番目に追加する新しいスライドを 1 枚作る（追加はしない） */
  planSlide: (body: { instruction: string; position: number; total: number; title?: string; outline: { number: number; title?: string; texts: string[] }[]; samples: { number: number; title?: string; spec: PosterSpec }[]; references?: RefImage[]; subject?: AiSubject }, chat?: ChatContext, signal?: AbortSignal) =>
    post<{ reply: string; spec: PosterSpec }>("/api/slide", { ...body, history: chat?.history, memory: chat?.memory }, signal),
  /** デッキの全スライドの文字・画像の説明（＋既存の台本）から、targets の番号のスライドの台本を書く */
  writeNotes: (body: { title?: string; slides: { number: number; title?: string; texts: string[]; images?: string[]; notes?: string }[]; targets: number[]; request?: string; subject?: AiSubject }, signal?: AbortSignal) =>
    post<{ notes: { number: number; notes: string }[] }>("/api/notes", body, signal),
  /** 古いやりとりを既存の要約に畳み込む（ローリング要約） */
  summarizeChat: (summary: string | undefined, turns: ChatTurn[]) => post<{ summary: string }>("/api/chat/summarize", { summary, turns }),
  asset: async (asset: AssetRequest, context: AssetContext, provider?: string, signal?: AbortSignal) => {
    // サーバーの CODEX_DEADLINE_MS 既定 15 分より少し長くして、待ちきれないときは打ち切る
    const timeout = AbortSignal.timeout(ASSET_TIMEOUT_MS);
    try {
      return await post<{ src: string; provider: string; cached: boolean }>("/api/asset", { asset, context, provider }, signal ? AbortSignal.any([signal, timeout]) : timeout);
    } catch (e) {
      // 打ち切りが時間切れによるもので、呼び出し元のキャンセルではないときは分かる文言にする
      if (timeout.aborted && !signal?.aborted) throw new Error("画像生成が 16 分たっても終わらなかったため打ち切りました。もう一度試すか、AI の設定で別の画像生成を選んでください");
      throw e;
    }
  },
  upload: (file: File) => api.uploadBlob(file, file.type),
  // ---------- 成果物 ----------
  posters: () => get<{ posters: SavedPoster[] }>("/api/posters"),
  poster: (id: string) => get<SavedPoster>(`/api/posters/${id}`),
  createPoster: (spec: PosterSpec) => post<SavedPoster>("/api/posters", { spec }),
  savePoster: (id: string, spec: PosterSpec) => put<SavedPoster>(`/api/posters/${id}`, { spec }),
  duplicatePoster: (id: string) => post<SavedPoster>(`/api/posters/${id}/duplicate`, {}),
  deletePoster: (id: string) => del<{ ok: true }>(`/api/posters/${id}`),
  // ---------- デッキ（PPTX エディターモード） ----------
  decks: () => get<{ decks: Deck[] }>("/api/decks"),
  /**
   * 作ったデッキの種類が頼んだものと違えば（API サーバーが古いコードのままだと kind を捨てる）、作ったものを消して止める。
   * そのまま開くと Instagram の投稿が PowerPoint のスライドとして扱われてしまう
   */
  createDeck: async (name: string, specs: PosterSpec[], kind?: DeckKind) => {
    const deck = await post<Deck>("/api/decks", { name, specs, kind });
    if ((kind ?? "slides") !== (deck.kind ?? "slides")) {
      await api.deleteDeck(deck.id).catch(() => {});
      throw new Error("API サーバーが古いままです。npm run dev を再起動してからやり直してください");
    }
    return deck;
  },
  duplicateDeck: (id: string) => post<Deck>(`/api/decks/${id}/duplicate`, {}),
  /** デッキをスライドごと削除 */
  deleteDeck: (id: string) => del<{ ok: true; deleted: string[] }>(`/api/decks/${id}`),
  deck: (id: string) => get<Deck>(`/api/decks/${id}`),
  /** ポスターが入っているデッキを、全スライドの spec 付きで（プロジェクトを開いたときにまとめて読み込む） */
  deckOf: (posterId: string) => get<{ deck: Deck | null }>(`/api/posters/${posterId}/deck?specs=1`),
  updateDeck: (id: string, body: { name?: string; slides?: string[] }) => put<Deck>(`/api/decks/${id}`, body),
  addDeckSlide: (id: string, body: { spec?: PosterSpec; after?: string }) => post<{ deck: Deck; poster: SavedPoster }>(`/api/decks/${id}/slides`, body),
  removeDeckSlide: (id: string, posterId: string) => del<Deck>(`/api/decks/${id}/slides/${posterId}`),
  /** Blob（PPTX から取り出した画像など）を取り込む */
  uploadBlob: async (blob: Blob, mediaType: string) =>
    post<{ src: string }>("/api/upload", { mediaType, data: (await readDataUrl(blob)).split(",")[1] }),
  // ---------- フォント ----------
  suggestFonts: (body: { kind?: "slides" | "poster"; mood: string; title?: string; texts: string[]; current?: { display?: string; body?: string }; subject?: AiSubject }, signal?: AbortSignal) =>
    post<{ proposals: FontProposal[] }>("/api/fonts/suggest", body, signal),
  fontStatus: (families: string[]) => post<FontStatus>("/api/fonts/status", { families }),
  installFonts: (families: string[]) => post<{ target: FontStatus["target"]; installed: string[]; already: string[] }>("/api/fonts/install", { families }),
  /** カタログの family×weight の TTF を base64 で（最大 16 件。API のフォントキャッシュから） */
  fontFiles: (faces: { family: string; weight: number }[]) =>
    post<{ files: { family: string; weight: number; sha256: string; data: string }[]; failed: { family: string; weight: number; code: string }[] }>("/api/fonts/files", { faces }),
  /** PPTX に埋め込むフォント（EOT を base64 で。使う文字は送らない） */
  embedFonts: (fonts: { family: string; bold: boolean }[]) =>
    post<{ fonts: { family: string; bold: boolean; data: string }[] }>("/api/fonts/embed", { fonts }),
  generated: (specs: PosterSpec[] = []) => post<{ files: GeneratedFile[] }>("/api/generated/list", { specs }),
  deleteGenerated: (names: string[], specs: PosterSpec[] = []) => post<{ deleted: string[] }>("/api/generated/delete", { names, specs }),
};
