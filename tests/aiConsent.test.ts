import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payloadHash, toAiImage, type AiConsentPayload } from "../desktop/aiPayload";

const create = vi.fn();
let lastOptions: any;
vi.mock("openai", () => {
  class APIError extends Error {
    status?: number;
    error?: unknown;
  }
  class OpenAI {
    static APIError = APIError;
    responses = { create };
    constructor(o: unknown) { lastOptions = o; }
  }
  return { default: OpenAI };
});
vi.mock("../server/chatgpt-auth", () => ({ authStatus: () => ({}), getAccessToken: async () => "token", USAGE_URL: "" }));
vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ models: [{ slug: "test-model", visibility: "list" }] }))));
process.env.CHATGPT_MODEL = "test-model";

const { askChatGPT } = await import("../server/chatgpt");
const { createMainConsentBackend, setConsentBackend, requireConsent } = await import("../server/ai-consent");

async function* events(...evs: object[]) { for (const e of evs) yield e; }
const done = () => events({ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed" });
const png = Buffer.from("fakepng").toString("base64");
const turns = [{ role: "user" as const, text: "hi", images: [{ mediaType: "image/png", data: png, detail: "high" as const }] }];

/** 偽の parentPort。respond が返した結果を main の答えとして返す */
function fakePort(respond: (m: any) => any | undefined) {
  let listener: (e: { data: unknown }) => void = () => {};
  const sent: any[] = [];
  return {
    sent,
    on: (_: "message", cb: (e: { data: unknown }) => void) => { listener = cb; },
    postMessage(m: any) {
      sent.push(m);
      if (m.type !== "ai-consent") return;
      const r = respond(m);
      if (r) queueMicrotask(() => listener({ data: { type: "ai-consent-result", requestId: m.requestId, ...r } }));
    },
  };
}
const approve = (m: any) => ({ decision: "approve", payloadHash: payloadHash(m.payload) });

beforeEach(() => { create.mockReset(); lastOptions = undefined; });
afterEach(() => { setConsentBackend(null); delete process.env.DC_DESIGNER_DESKTOP; });

describe("AI 送信ゲート（製品版）", () => {
  beforeEach(() => { process.env.DC_DESIGNER_DESKTOP = "1"; });

  it("approve かつハッシュ一致なら、確認した内容を1回だけ送る", async () => {
    const port = fakePort(approve);
    setConsentBackend(createMainConsentBackend(port));
    create.mockResolvedValue(done());
    expect(await askChatGPT("sys", turns, undefined, undefined, "レイアウトの生成")).toBe("ok");
    expect(create).toHaveBeenCalledTimes(1);
    const consent = port.sent.find((m) => m.type === "ai-consent");
    expect(consent.payload.purpose).toBe("レイアウトの生成");
    expect(consent.payload.turns[0].images[0]).toEqual(toAiImage("image/png", Buffer.from(png, "base64")));
    const body = create.mock.calls[0][0];
    expect(body.input[0].content[0].image_url).toBe(`data:image/png;base64,${png}`);
    expect(body.input[0].content[0].detail).toBe("high");
    expect(port.sent.find((m) => m.type === "ai-outcome")).toMatchObject({ outcome: "completed" });
  });

  it.each([
    ["deny", { decision: "deny" }],
    ["expired", { decision: "expired" }],
    ["invalid", { decision: "invalid" }],
    ["ハッシュ不一致", { decision: "approve", payloadHash: "0".repeat(64) }],
    ["ハッシュなし", { decision: "approve" }],
  ])("%s なら送らず 403", async (_n, result) => {
    setConsentBackend(createMainConsentBackend(fakePort(() => result)));
    const err = await askChatGPT("sys", turns).catch((e) => e);
    expect(err.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it("main が答えないままタイムアウトしたら送らない", async () => {
    setConsentBackend(createMainConsentBackend(fakePort(() => undefined), 20));
    const err = await askChatGPT("sys", turns).catch((e) => e);
    expect(err.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it("backend が無ければ送らない", async () => {
    await expect(askChatGPT("sys", turns)).rejects.toMatchObject({ status: 403 });
    expect(create).not.toHaveBeenCalled();
  });

  it("ストリームが切れても再送せず、送達不明として知らせる", async () => {
    const port = fakePort(approve);
    setConsentBackend(createMainConsentBackend(port));
    create.mockResolvedValue(events({ type: "response.output_text.delta", delta: "a" }));
    const err = await askChatGPT("sys", turns).catch((e) => e);
    expect(err.code).toBe("outcome_unknown");
    expect(create).toHaveBeenCalledTimes(1);
    expect(port.sent.filter((m) => m.type === "ai-consent")).toHaveLength(1);
    expect(port.sent.find((m) => m.type === "ai-outcome")).toMatchObject({ outcome: "outcomeUnknown" });
  });

  it("client にはリダイレクトを追わない fetch を渡す", async () => {
    setConsentBackend(createMainConsentBackend(fakePort(approve)));
    create.mockResolvedValue(done());
    await askChatGPT("sys", turns);
    const f = fetch as any;
    f.mockClear();
    await lastOptions.fetch("https://example.test/", {});
    expect(f.mock.calls[0][1].redirect).toBe("error");
  });

  it("requireConsent は同じ payload の別ハッシュを受け付けない", async () => {
    const p: AiConsentPayload = { providerId: "chatgpt", endpoint: "https://api.openai.com/v1/responses", model: "m", providerRouting: "direct", purpose: "x", instructions: "i", turns: [{ role: "user", text: "t" }] };
    setConsentBackend(createMainConsentBackend(fakePort((m) => ({ decision: "approve", payloadHash: payloadHash({ ...m.payload, instructions: "other" }) }))));
    await expect(requireConsent(p)).rejects.toMatchObject({ status: 403 });
  });
});

describe("確認待ちの取り消しと subject", () => {
  beforeEach(() => { process.env.DC_DESIGNER_DESKTOP = "1"; });
  const base: AiConsentPayload = { providerId: "chatgpt", endpoint: "https://api.openai.com/v1/responses", model: "m", providerRouting: "direct", purpose: "x", instructions: "i", turns: [{ role: "user", text: "t" }] };

  it("確認待ち中に中断すると ai-consent-cancel を送り 499 で終わる。送信はしない", async () => {
    const port = fakePort(() => undefined); // main は答えない
    setConsentBackend(createMainConsentBackend(port));
    const ac = new AbortController();
    const p = askChatGPT("sys", turns, undefined, ac.signal).catch((e) => e);
    await new Promise((r) => setTimeout(r, 10));
    const consent = port.sent.find((m) => m.type === "ai-consent");
    ac.abort();
    const err = await p;
    expect(err).toMatchObject({ status: 499 });
    expect(port.sent.find((m) => m.type === "ai-consent-cancel")).toEqual({ type: "ai-consent-cancel", requestId: consent.requestId });
    expect(create).not.toHaveBeenCalled();
  });

  it("中断済みの signal なら依頼自体を出さない。取り消し後に届いた承認は failed と知らせる", async () => {
    const sent: any[] = [];
    let listener: (e: { data: unknown }) => void = () => {};
    const port = { on: (_: "message", cb: typeof listener) => { listener = cb; }, postMessage: (m: any) => { sent.push(m); } };
    setConsentBackend(createMainConsentBackend(port));
    const done0 = new AbortController(); done0.abort();
    await expect(requireConsent(base, done0.signal)).rejects.toMatchObject({ status: 499 });
    expect(sent).toEqual([]);

    const ac = new AbortController();
    const p = requireConsent(base, ac.signal).catch((e) => e);
    const requestId = sent[0].requestId;
    ac.abort();
    expect(await p).toMatchObject({ status: 499 });
    // main が先に承認していた：送らないので結果を failed として返す
    listener({ data: { type: "ai-consent-result", requestId, decision: "approve", payloadHash: "h" } });
    expect(sent.at(-1)).toEqual({ type: "ai-outcome", requestId, outcome: "failed" });
  });

  it("runWithAiSubject の subject が payload に入り、ハッシュが変わる", async () => {
    const { runWithAiSubject } = await import("../server/ai-consent");
    const subject = { kind: "poster" as const, id: "abcdefghij12", title: "夏祭り" };
    const port = fakePort(approve);
    setConsentBackend(createMainConsentBackend(port));
    await runWithAiSubject(subject, () => requireConsent(base));
    await requireConsent(base);
    const [withSubject, without] = port.sent.filter((m) => m.type === "ai-consent");
    expect(withSubject.payload.subject).toEqual(subject);
    expect(without.payload.subject).toBeUndefined();
    expect(payloadHash(withSubject.payload)).not.toBe(payloadHash(without.payload));
    const { canonicalPayload } = await import("../desktop/aiPayload");
    expect(JSON.parse(canonicalPayload(withSubject.payload)).subject).toEqual(subject);
    expect(JSON.parse(canonicalPayload(without.payload)).subject).toBeNull();
  });
});

describe("開発版", () => {
  it("ゲートを通らず、切断では従来どおり送り直す", async () => {
    create
      .mockResolvedValueOnce(events({ type: "response.output_text.delta", delta: "a" }))
      .mockResolvedValueOnce(done());
    expect(await askChatGPT("sys", turns)).toBe("ok");
    expect(create).toHaveBeenCalledTimes(2);
    expect(lastOptions.fetch).toBeUndefined();
  });
});
