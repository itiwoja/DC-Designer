import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PosterSpecSchema } from "../src/schema";
import { askAI } from "../server/ai";
import { critiquePoster } from "../server/poster-critique";
import { createRouteHandlers } from "../server/route-handlers";
import { registerAiRoutes } from "../server/routes/ai";

vi.mock("../server/ai", () => ({ askAI: vi.fn() }));
let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  vi.clearAllMocks();
});

const spec = PosterSpecSchema.parse({
  meta: { title: "テスト" },
  layers: [{ id: "t", type: "text", text: "文化祭", x: 100, y: 100, w: 400, h: 100 }],
});
const render = { mediaType: "image/png" as const, data: "AAAA" };

describe("critiquePoster", () => {
  it("changes を spec に当てて返し、描画画像を high で送る", async () => {
    vi.mocked(askAI).mockResolvedValue(JSON.stringify({ reply: "左端をそろえた", changes: { update: [{ id: "t", x: 60 }] } }));
    const got = await critiquePoster({ render, spec });
    expect(got.reply).toBe("左端をそろえた");
    expect(got.spec?.layers[0]).toMatchObject({ id: "t", x: 60, text: "文化祭" });
    const [, turns] = vi.mocked(askAI).mock.calls[0];
    expect(turns[0].images).toEqual([{ ...render, detail: "high" }]);
    expect(turns[0].text).toContain("意図しない折り返し");
    expect(turns[0].text).toContain('"id":"t"');
  });

  it("changes が null なら spec なし", async () => {
    vi.mocked(askAI).mockResolvedValue(JSON.stringify({ reply: "直すところはありません", changes: null }));
    await expect(critiquePoster({ render, spec })).resolves.toEqual({ reply: "直すところはありません" });
  });

  it("ブリーフがあれば文面に入り、無ければ入らない", async () => {
    vi.mocked(askAI).mockResolvedValue(JSON.stringify({ reply: "", changes: null }));
    await critiquePoster({ render, spec, brief: "11月3日 体育館で文化祭" });
    expect(vi.mocked(askAI).mock.calls[0][1][0].text).toContain("11月3日 体育館で文化祭");
    await critiquePoster({ render, spec });
    expect(vi.mocked(askAI).mock.calls[1][1][0].text).not.toContain("# ブリーフ");
  });
});

describe("POST /api/plan/refine", () => {
  it("描画画像と spec を受けて直した spec を返す", async () => {
    vi.mocked(askAI).mockResolvedValue(JSON.stringify({ reply: "直した", changes: { update: [{ id: "t", x: 60 }] } }));
    const app = express();
    app.use(express.json());
    registerAiRoutes(app, createRouteHandlers({ desktop: false }));
    server = createServer(app);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (body: unknown) => fetch(`${base}/api/plan/refine`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const lines = (await (await post({ spec, render, brief: "文化祭" })).text()).trim().split("\n").map((l) => JSON.parse(l));
    const result = lines.at(-1).result;
    expect(result.reply).toBe("直した");
    expect(result.spec.layers[0].x).toBe(60);

    // render が画像でなければ 400 相当のエラー行
    const bad = (await (await post({ spec, render: {} })).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(bad.at(-1)).toMatchObject({ status: 400 });
  });
});
