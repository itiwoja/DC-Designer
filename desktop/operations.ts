/**
 * Windows 版（Electron）で画面から呼べる API 操作の静的な一覧（EXE-API-009）。
 * 画面は URL・method を渡さず、ここにある operation 名と params だけを渡す。main は同じ一覧で検証してから
 * 固定の内部 API へ中継する。AI 操作は載せる（送信の確認は worker が送る直前に main へ依頼する）が、画像生成（/api/asset）は載せない（認証はログアウトだけ。サインインは authGate が内部操作で行う）。フォント取得・OS 登録は fontGate が許可・確認してから中継する
 */

export type DesktopMethod = "GET" | "POST" | "PUT" | "DELETE";

export type DesktopOperation = {
  method: DesktopMethod;
  /** 内部 API の route。`:name` は params の同名の値（ID の形を検証してから埋める） */
  route: string;
  /** 本文の上限（バイト）。無ければ本文を受け付けない */
  maxBody?: number;
  /** 付けてよい query（値は固定の候補だけ） */
  query?: Record<string, readonly string[]>;
  /** NDJSON で進み具合（{progress}）を流し、最後に {result} か {error} を返す route */
  stream?: true;
  /**
   * ChatGPT の資格情報（secret chatgpt/oauth）を使う操作。実行中だけ worker が資格情報を読み書きできる（EXE-API-006）。
   * route が authStatus / getAccessToken / listModels / askChatGPT / logout / startLogin / completeLogin のどれかを呼ぶものに付ける
   */
  chatgpt?: true;
  /** 閉じる途中（closing）でも通す、閉じる前の確定保存（新しい処理の受付は止めるが、保存だけは通す） */
  closeSave?: true;
};

const MB = 1024 * 1024;

export const DESKTOP_OPERATIONS = {
  "status.get": { method: "GET", route: "/api/status", chatgpt: true },

  "posters.list": { method: "GET", route: "/api/posters" },
  "posters.create": { method: "POST", route: "/api/posters", maxBody: 40 * MB, closeSave: true },
  "posters.get": { method: "GET", route: "/api/posters/:id" },
  "posters.update": { method: "PUT", route: "/api/posters/:id", maxBody: 40 * MB, closeSave: true },
  "posters.duplicate": { method: "POST", route: "/api/posters/:id/duplicate", maxBody: 1024 },
  "posters.delete": { method: "DELETE", route: "/api/posters/:id" },
  "posters.deck": { method: "GET", route: "/api/posters/:id/deck", query: { specs: ["1"] } },

  "decks.list": { method: "GET", route: "/api/decks" },
  "decks.create": { method: "POST", route: "/api/decks", maxBody: 40 * MB },
  "decks.get": { method: "GET", route: "/api/decks/:id" },
  "decks.duplicate": { method: "POST", route: "/api/decks/:id/duplicate", maxBody: 1024 },
  "decks.delete": { method: "DELETE", route: "/api/decks/:id" },
  "decks.update": { method: "PUT", route: "/api/decks/:id", maxBody: 1 * MB },
  "decks.addSlide": { method: "POST", route: "/api/decks/:id/slides", maxBody: 40 * MB },
  "decks.removeSlide": { method: "DELETE", route: "/api/decks/:id/slides/:posterId" },

  "upload.create": { method: "POST", route: "/api/upload", maxBody: 28 * MB },
  "generated.list": { method: "POST", route: "/api/generated/list", maxBody: 40 * MB },
  "generated.delete": { method: "POST", route: "/api/generated/delete", maxBody: 40 * MB },

  // AI 操作（送信の確認は worker の askChatGPT が送る直前に main へ依頼する）。画像生成（/api/asset）は載せない
  "ai.plan": { method: "POST", route: "/api/plan", maxBody: 40 * MB, chatgpt: true },
  "ai.planInstagram": { method: "POST", route: "/api/plan/instagram", maxBody: 40 * MB, stream: true, chatgpt: true },
  "ai.reproduce": { method: "POST", route: "/api/reproduce", maxBody: 40 * MB, stream: true, chatgpt: true },
  "ai.reproduceRefine": { method: "POST", route: "/api/reproduce/refine", maxBody: 40 * MB, stream: true, chatgpt: true },
  "ai.edit": { method: "POST", route: "/api/edit", maxBody: 40 * MB, chatgpt: true },
  "ai.slide": { method: "POST", route: "/api/slide", maxBody: 40 * MB, chatgpt: true },
  "ai.notes": { method: "POST", route: "/api/notes", maxBody: 4 * MB, chatgpt: true },
  "ai.summarize": { method: "POST", route: "/api/chat/summarize", maxBody: 1 * MB, chatgpt: true },
  "fonts.suggest": { method: "POST", route: "/api/fonts/suggest", maxBody: 1 * MB, chatgpt: true },
  "chatgpt.model": { method: "PUT", route: "/api/chatgpt/model", maxBody: 1024, chatgpt: true },

  "auth.logout": { method: "POST", route: "/api/auth/chatgpt/logout", chatgpt: true },

  "fonts.status": { method: "POST", route: "/api/fonts/status", maxBody: 64 * 1024 },
  // 取得・埋め込み・OS 登録は main の fontGate を通す（許可・確認が済むまで worker へ送らない）。fonts.acquire は main 内部専用で載せない
  "fonts.files": { method: "POST", route: "/api/fonts/files", maxBody: 64 * 1024 },
  "fonts.embed": { method: "POST", route: "/api/fonts/embed", maxBody: 64 * 1024 },
  "fonts.install": { method: "POST", route: "/api/fonts/install", maxBody: 64 * 1024 },
} as const satisfies Record<string, DesktopOperation>;

/** main だけが内部で使う操作（画面からは呼べない。worker の許可リストには入る） */
export const DESKTOP_INTERNAL_OPERATIONS = {
  "fonts.acquire": { method: "POST", route: "/api/fonts/acquire", maxBody: 64 * 1024 },
  // ChatGPT サインイン：認可 URL の作成と結果の受け取り（authGate が呼ぶ。画面からは呼べない）
  "auth.start": { method: "POST", route: "/api/auth/chatgpt/start", maxBody: 1024, chatgpt: true },
  "auth.complete": { method: "POST", route: "/api/auth/chatgpt/complete", maxBody: 16 * 1024, chatgpt: true },
} as const satisfies Record<string, DesktopOperation>;

export type DesktopOperationName = keyof typeof DESKTOP_OPERATIONS;

/** route に埋める ID の形（server/library.ts の ID_RE と同じ） */
export const DESKTOP_ID_RE = /^[a-z0-9]{12}$/;

export type DesktopRequest = {
  operation: DesktopOperationName;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
};

/** 画面の (method, url) を operation に対応付ける。一覧に無ければ null（段階1で使えない機能） */
export function matchDesktopOperation(method: string, url: string): Omit<DesktopRequest, "body"> | null {
  const [path, search = ""] = url.split("?");
  const segs = path.split("/");
  for (const [name, op] of Object.entries(DESKTOP_OPERATIONS) as [DesktopOperationName, DesktopOperation][]) {
    if (op.method !== method) continue;
    const want = op.route.split("/");
    if (want.length !== segs.length) continue;
    const params: Record<string, string> = {};
    if (!want.every((w, i) => (w.startsWith(":") ? DESKTOP_ID_RE.test(segs[i]) && ((params[w.slice(1)] = segs[i]), true) : w === segs[i]))) continue;
    const query = Object.fromEntries(new URLSearchParams(search));
    return { operation: name, ...(Object.keys(params).length ? { params } : {}), ...(Object.keys(query).length ? { query } : {}) };
  }
  return null;
}

/**
 * main 側の検証：operation・params・query を一覧と照合し、内部 API の相対 path を組み立てる。
 * 不正なら null（呼び出し側で INVALID_ARGUMENT にする）
 */
export function resolveDesktopRequest(req: unknown): { name: DesktopOperationName; op: DesktopOperation; path: string; body?: unknown } | null {
  if (!req || typeof req !== "object") return null;
  const { operation, params = {}, query = {}, body, ...rest } = req as Record<string, unknown>;
  if (Object.keys(rest).length) return null;
  if (typeof operation !== "string" || !Object.hasOwn(DESKTOP_OPERATIONS, operation)) return null;
  const op: DesktopOperation = DESKTOP_OPERATIONS[operation as DesktopOperationName];
  if (!isStringRecord(params) || !isStringRecord(query)) return null;
  const used = new Set<string>();
  const segs: string[] = [];
  for (const w of op.route.split("/")) {
    if (!w.startsWith(":")) { segs.push(w); continue; }
    const v = params[w.slice(1)];
    if (typeof v !== "string" || !DESKTOP_ID_RE.test(v)) return null;
    used.add(w.slice(1));
    segs.push(v);
  }
  if (Object.keys(params).some((k) => !used.has(k))) return null;
  const allowed = op.query ?? {};
  for (const [k, v] of Object.entries(query)) if (!allowed[k]?.includes(v)) return null;
  if (body !== undefined && op.maxBody === undefined) return null;
  const qs = new URLSearchParams(query).toString();
  return { name: operation as DesktopOperationName, op, path: segs.join("/") + (qs ? `?${qs}` : ""), ...(body !== undefined ? { body } : {}) };
}

const isStringRecord = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
