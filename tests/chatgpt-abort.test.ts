import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("openai", () => {
  class APIError extends Error {
    status?: number;
    error?: unknown;
  }
  class OpenAI {
    static APIError = APIError;
    responses = { create };
  }
  return { default: OpenAI };
});
vi.mock("../server/chatgpt-auth", () => ({ authStatus: () => ({}), getAccessToken: async () => "token", USAGE_URL: "" }));

// モデル一覧の取得も外へ出さない
vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ models: [{ slug: "test-model", visibility: "list" }] }))));
process.env.CHATGPT_MODEL = "test-model";

const { askChatGPT, ChatGPTError } = await import("../server/chatgpt");

async function* events(...evs: object[]) { for (const e of evs) yield e; }
const turns = [{ role: "user" as const, text: "hi" }];

beforeEach(() => {
  create.mockReset();
});

describe("askChatGPT の中断", () => {
  it("signal を responses.create の第 2 引数で渡す", async () => {
    create.mockResolvedValue(events({ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed" }) as any);
    const ac = new AbortController();
    expect(await askChatGPT("sys", turns, undefined, ac.signal)).toBe("ok");
    expect(create.mock.calls[0][1]).toEqual({ signal: ac.signal });
  });

  it("送る前に中断済みなら ChatGPT を呼ばない", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(askChatGPT("sys", turns, undefined, ac.signal)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it("ストリームが途中で切れても、中断後は送り直さず ChatGPTError(499) にする", async () => {
    const ac = new AbortController();
    create.mockImplementation(async () => {
      ac.abort();
      return events({ type: "response.output_text.delta", delta: "a" }); // completed なしで終わる
    });
    const err = await askChatGPT("sys", turns, undefined, ac.signal).catch((e) => e);
    expect(err).toBeInstanceOf(ChatGPTError);
    expect(err.code).toBe("aborted");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("SDK が中断の例外を投げても 502 の障害扱いにせず、送り直さない", async () => {
    const ac = new AbortController();
    const OpenAI = (await import("openai")).default as any;
    create.mockImplementation(async () => {
      ac.abort();
      throw new OpenAI.APIError("Request was aborted.");
    });
    const err = await askChatGPT("sys", turns, undefined, ac.signal).catch((e) => e);
    expect(err).toBeInstanceOf(ChatGPTError);
    expect(err.status).toBe(499);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("中断しないときは従来どおり切断で送り直す", async () => {
    create
      .mockResolvedValueOnce(events({ type: "response.output_text.delta", delta: "a" }) as any)
      .mockResolvedValueOnce(events({ type: "response.output_text.delta", delta: "b" }, { type: "response.completed" }) as any);
    expect(await askChatGPT("sys", turns)).toBe("b");
    expect(create).toHaveBeenCalledTimes(2);
  });
});
