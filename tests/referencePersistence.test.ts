import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PosterSpecSchema } from "../src/schema";

const ai = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock("../server/chatgpt", async (original) => ({ ...await original<typeof import("../server/chatgpt")>(), askChatGPT: ai.ask }));
const folder = mkdtempSync(join(tmpdir(), "reference-persistence-"));
const written = new Set<string>();
beforeAll(async () => {
  vi.stubEnv("GENERATED_DIR", folder);
  // planner → ai → openai SDK の読み込みは遅い環境（WSL の /mnt/c など）で数秒かかるので、テストの時間に含めない
  await import("../server/planner");
}, 60_000);
afterAll(() => {
  for (const file of written) unlinkSync(file);
  rmdirSync(folder);
  vi.unstubAllEnvs();
});

it("添付の実PNGを保存し、AIが返したファイル名を描画可能な保存URLに置き換える", async () => {
  const { storeReferences } = await import("../server/references");
  const { editPoster } = await import("../server/planner");
  const canvas = createCanvas(12, 8), context = canvas.getContext("2d");
  context.fillStyle = "#ff8800"; context.fillRect(0, 0, 12, 8);
  const bytes = canvas.toBuffer("image/png");
  const references = storeReferences([{ name: "image.png", mediaType: "image/png", data: bytes.toString("base64") }])!;
  const file = join(folder, basename(references[0].src!)); written.add(file);
  expect(readFileSync(file)).toEqual(bytes);
  const original = PosterSpecSchema.parse({ meta: { title: "添付実データ", width: 1000, height: 1414 }, theme: "ocean", layers: [] });
  ai.ask.mockResolvedValue(JSON.stringify({ reply: "配置した", spec: { ...original, layers: [{ id: "attached", type: "image", src: "image.png", x: 10, y: 20, w: 120, h: 80 }] } }));
  const result = await editPoster({ spec: original, instruction: "添付画像を入れて", references });
  expect(result.spec?.layers[0]).toMatchObject({ src: references[0].src, x: 10, y: 20, w: 120, h: 80 });
  expect(ai.ask.mock.calls[0][1][0].text).toContain(references[0].src);
  const decoded = await loadImage(readFileSync(file));
  expect([decoded.width, decoded.height]).toEqual([12, 8]);
});
