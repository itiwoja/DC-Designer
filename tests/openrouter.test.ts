import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ChatGPT のサインイン状態はテストごとに差し替える
const auth = vi.hoisted(() => ({ status: { signedIn: false } as { signedIn: boolean; planEnabled?: boolean } }));
vi.mock("../server/chatgpt-auth", () => ({ authStatus: () => auth.status, getAccessToken: async () => "AT", USAGE_URL: "https://chatgpt.com/settings/usage" }));
const chatgpt = vi.hoisted(() => ({ ask: vi.fn(async () => "from chatgpt") }));
vi.mock("../server/chatgpt", () => ({ askChatGPT: chatgpt.ask }));

// openai SDK の読み込みは遅い環境（WSL の /mnt/c など）で 4 秒以上かかり、最初のテストが時間切れになる。先に読み込んでおく（vi.resetModules は node_modules には効かないので一度で足りる）
beforeAll(() => import("openai"), 60_000);

const root = mkdtempSync(join(tmpdir(), "openrouter-test-"));
process.env.DATA_DIR = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** SSE の 1 行（data: ...） */
const sse = (chunks: unknown[], done = true) => new Response(
  chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""),
  { status: 200, headers: { "Content-Type": "text/event-stream" } },
);
const delta = (content: string, finish_reason: string | null = null) => ({ id: "gen-1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content }, finish_reason }] });

let fetchMock: ReturnType<typeof vi.fn>;
const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));

beforeEach(() => {
  vi.resetModules();
  rmSync(join(root, "ai-provider.json"), { force: true });
  rmSync(join(root, "openrouter-model.json"), { force: true });
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  delete process.env.OPENROUTER_MODEL;
  delete process.env.AI_PROVIDER;
  auth.status = { signedIn: false };
  chatgpt.ask.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("askOpenRouter", () => {
  it("system と画像付きの会話を送り、ストリームのテキストをつなげて返す", async () => {
    process.env.OPENROUTER_MODEL = "google/gemini-4-argon";
    fetchMock.mockImplementation(async () => sse([delta("{\"a\":"), delta("1}", "stop")]));
    const { askOpenRouter } = await import("../server/openrouter");
    const seen: string[] = [];
    const text = await askOpenRouter("SYS", [{ role: "user", text: "hi", images: [{ mediaType: "image/png", data: "AAAA", detail: "high" }] }, { role: "assistant", text: "ok" }], (t) => seen.push(t));
    expect(text).toBe("{\"a\":1}");
    expect(seen).toEqual(["{\"a\":", "{\"a\":1}"]);
    expect(fetchMock.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    const [body] = bodies();
    expect(body.model).toBe("google/gemini-4-argon");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "high" } }, { type: "text", text: "hi" }] },
      { role: "assistant", content: "ok" },
    ]);
  });

  it("finish_reason の前にストリームが切れたら送り直し、3 回切れたらエラー", async () => {
    fetchMock.mockImplementation(async () => sse([delta("途中")], false));
    const { askOpenRouter } = await import("../server/openrouter");
    await expect(askOpenRouter("S", [{ role: "user", text: "x" }])).rejects.toThrow(/完了前に切れました/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("ストリームの途中のエラーチャンクはエラーにする", async () => {
    fetchMock.mockImplementation(async () => sse([delta("a"), { ...delta("", "error"), error: { code: "server_error", message: "Provider disconnected" } }]));
    const { askOpenRouter } = await import("../server/openrouter");
    await expect(askOpenRouter("S", [{ role: "user", text: "x" }])).rejects.toThrow(/Provider disconnected/);
  });

  it("出力の上限で切れたら OPENROUTER_MAX_TOKENS を案内する", async () => {
    fetchMock.mockImplementation(async () => sse([delta("{", "length")]));
    const { askOpenRouter } = await import("../server/openrouter");
    await expect(askOpenRouter("S", [{ role: "user", text: "x" }])).rejects.toThrow(/OPENROUTER_MAX_TOKENS/);
  });

  it("クレジット不足（402）は残高の確認を案内し、ステータスも 402 にする", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { code: 402, message: "Insufficient credits" } }), { status: 402, headers: { "Content-Type": "application/json" } }));
    const { askOpenRouter } = await import("../server/openrouter");
    const err = await askOpenRouter("S", [{ role: "user", text: "x" }]).catch((e) => e);
    expect(err.message).toMatch(/クレジットが足りません/);
    expect(err.status).toBe(402);
  });

  it("要求の途中で中断したら、障害ではなく中断（499）として投げる", async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const { askOpenRouter } = await import("../server/openrouter");
    const ac = new AbortController();
    const p = askOpenRouter("S", [{ role: "user", text: "x" }], undefined, ac.signal).catch((e) => e);
    setTimeout(() => ac.abort(), 10);
    const err = await p;
    expect(err.message).toMatch(/中断しました/);
    expect(err.status).toBe(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("キーが無ければ送らずにエラー", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const { askOpenRouter } = await import("../server/openrouter");
    await expect(askOpenRouter("S", [{ role: "user", text: "x" }])).rejects.toThrow(/OPENROUTER_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("OpenRouter のモデル", () => {
  const model = (id: string, name: string, input = ["text", "image"], output = ["text"]) => ({ id, name, architecture: { input_modalities: input, output_modalities: output } });
  const list = () => new Response(JSON.stringify({ data: [
    model("b/vision", "B: Vision"),
    model("a/vision", "A: Vision"),
    model("a/vision:batch", "A: Vision (batch)"),
    model("c/text-only", "C: Text", ["text"]),
    model("d/image-gen", "D: Image", ["text", "image"], ["image"]),
  ] }), { status: 200, headers: { "Content-Type": "application/json" } });

  it("一覧は画像を読めて文章を返すモデルだけを名前順に返し、:batch を除いて、2 回目は取り直さない", async () => {
    fetchMock.mockImplementation(async () => list());
    const { listOpenRouterModels } = await import("../server/openrouter");
    expect(await listOpenRouterModels()).toEqual([{ slug: "a/vision", display_name: "A: Vision" }, { slug: "b/vision", display_name: "B: Vision" }]);
    await listOpenRouterModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/models");
  });

  it("画面で選んだモデルが OPENROUTER_MODEL より優先され、空文字で自動に戻る。一覧に無いモデルは選べない", async () => {
    process.env.OPENROUTER_MODEL = "b/vision";
    fetchMock.mockImplementation(async () => list());
    const or = await import("../server/openrouter");
    expect(await or.openRouterSettings()).toMatchObject({ model: "b/vision", modelChoice: "", autoModel: "b/vision" });
    await or.setOpenRouterModel("a/vision");
    expect(await or.openRouterSettings()).toMatchObject({ model: "a/vision", modelChoice: "a/vision", autoModel: "b/vision" });
    await expect(or.setOpenRouterModel("c/text-only")).rejects.toThrow(/選べないモデル/);
    await or.setOpenRouterModel("");
    expect(or.openRouterModel()).toBe("b/vision");
  });

  it("選んだモデルで推論する", async () => {
    fetchMock.mockImplementation(async (url: string) => url.endsWith("/models") ? list() : sse([delta("ok", "stop")]));
    const or = await import("../server/openrouter");
    await or.setOpenRouterModel("b/vision");
    await or.askOpenRouter("S", [{ role: "user", text: "x" }]);
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]?.body)).model).toBe("b/vision");
  });

  it("一覧が取れなくても設定は返し、models だけ無しにする", async () => {
    fetchMock.mockImplementation(async () => new Response("{}", { status: 500 }));
    const or = await import("../server/openrouter");
    const s = await or.openRouterSettings();
    expect(s.models).toBeUndefined();
    expect(s.model).toBe("anthropic/claude-sonnet-5.5");
  });
});

describe("AI の選択", () => {
  it("自動: ChatGPT プランが使えれば ChatGPT、無ければ OpenRouter", async () => {
    const ai = await import("../server/ai");
    expect(ai.aiProvider()).toBe("openrouter");
    auth.status = { signedIn: true, planEnabled: true };
    expect(ai.aiProvider()).toBe("chatgpt");
    delete process.env.OPENROUTER_API_KEY;
    auth.status = { signedIn: false };
    expect(ai.aiProvider()).toBeUndefined();
  });

  it("画面で選んだ AI が .env の AI_PROVIDER より優先され、空文字で自動に戻る", async () => {
    auth.status = { signedIn: true, planEnabled: true };
    process.env.AI_PROVIDER = "openrouter";
    const ai = await import("../server/ai");
    expect(await ai.aiStatus()).toMatchObject({ provider: "openrouter", choice: "", explicit: "openrouter", autoProvider: "openrouter", openrouter: { model: "anthropic/claude-sonnet-5.5" } });
    ai.setAIProvider("chatgpt");
    expect(await ai.aiStatus()).toMatchObject({ provider: "chatgpt", choice: "chatgpt", explicit: "chatgpt" });
    ai.setAIProvider("");
    expect(ai.aiProvider()).toBe("openrouter");
    expect(() => ai.setAIProvider("gemini")).toThrow(/不明な AI/);
  });

  it("明示した AI が使えなければ、もう一方に切り替えずにその AI のエラーにする", async () => {
    auth.status = { signedIn: true, planEnabled: true };
    process.env.AI_PROVIDER = "openrouter";
    delete process.env.OPENROUTER_API_KEY;
    const ai = await import("../server/ai");
    expect(ai.aiProvider()).toBeUndefined();
    // 画面には「.env で OpenRouter を選んでいる」と伝え、ChatGPT プランの案内にしない
    expect(await ai.aiStatus()).toMatchObject({ provider: undefined, choice: "", explicit: "openrouter", openrouter: null });
    await expect(ai.askAI("S", [{ role: "user", text: "x" }])).rejects.toThrow(/OPENROUTER_API_KEY/);
    expect(chatgpt.ask).not.toHaveBeenCalled();
  });

  it("askAI は選ばれた AI に送る", async () => {
    auth.status = { signedIn: true, planEnabled: true };
    const ai = await import("../server/ai");
    expect(await ai.askAI("S", [{ role: "user", text: "x" }])).toBe("from chatgpt");
    ai.setAIProvider("openrouter");
    fetchMock.mockImplementation(async () => sse([delta("from openrouter", "stop")]));
    expect(await ai.askAI("S", [{ role: "user", text: "x" }])).toBe("from openrouter");
  });
});
