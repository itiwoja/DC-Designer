import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { AssetContext, AssetRequest } from "../src/schema";
import { httpError } from "./http-error";
import { getSecret, hasSecret } from "./secrets";

/** 生成・取り込んだ画像の置き場所（/generated/<ファイル名> で配信。テストでは GENERATED_DIR で差し替える） */
export const GENERATED_DIR = process.env.GENERATED_DIR || fileURLToPath(new URL("../public/generated/", import.meta.url));
mkdirSync(GENERATED_DIR, { recursive: true });

type GenerateResult = { src: string; provider: string; cached: boolean };

const ROLE_HINT = {
  hero: "Main visual of the poster: strong focal point, rich detail, clear silhouette.",
  supporting: "Supporting visual: clear subject, moderate detail.",
  small: "Small spot illustration: simple bold shapes, readable at a small size, minimal detail.",
} as const;

const COMPONENT_HINT: Record<string, string> = {
  laptop: "Show only the screen content edge to edge (no device frame, no desk, no hands).",
  phone: "Show only the screen content edge to edge (no device frame, no hands).",
  polaroid: "A single photo, no white border or frame (the frame is added separately).",
  circlePhoto: "A single photo with the subject centered (it is cropped to a circle), no border or frame.",
  roundPhoto: "A single photo with the subject centered (it is cropped to a rounded square), no border or frame.",
};

function buildPrompt(asset: AssetRequest, ctx: AssetContext = {}): string {
  // ポスター共通の画風 → 個別の追加指定 の順に足す。どの画像も同じ画風・同じ配色になるようにする
  const style = [ctx.style, asset.style].filter(Boolean).join(", ") || "high quality, poster-ready";
  return [
    asset.prompt,
    `Style: ${style}.`,
    ctx.palette?.length ? `Color palette harmonized with the poster: ${ctx.palette.join(", ")}.` : "",
    ctx.role ? ROLE_HINT[ctx.role] : "",
    ctx.component ? COMPONENT_HINT[ctx.component] ?? "" : "",
    asset.transparent
      ? "Single isolated subject, cut-out sticker style, fully transparent background, no shadow on background, no frame."
      : "Fill the whole frame, no borders.",
    "Do not add any captions, text, watermarks or logos unless the prompt explicitly asks for UI labels.",
  ].filter(Boolean).join(" ");
}

const SIZES = { square: "1024x1024", landscape: "1536x1024", portrait: "1024x1536" } as const;

type ImageProvider = "openai" | "gemini" | "comfyui" | "codex" | "placeholder";

/** 透過背景を出せないプロバイダ。透過アセットは OpenAI が使えればそちらに回し、無ければ白背景で生成する */
const NO_TRANSPARENCY: ImageProvider[] = ["gemini", "comfyui"];

/** キーが揃っていて今すぐ使えるプロバイダ（placeholder は常に使える）。
 *  ComfyUI はキー不要なので常に選択肢に出す（起動していなければ生成時に接続エラーを返す） */
export function availableProviders(): ImageProvider[] {
  const list: ImageProvider[] = [];
  const desktop = process.env.DC_DESIGNER_DESKTOP === "1"; // 製品版は画像生成（OpenAI・Gemini）・Codex・ComfyUI を使わない
  if (!desktop && hasSecret("openai", "apiKey")) list.push("openai");
  if (!desktop && hasSecret("gemini", "apiKey")) list.push("gemini");
  if (!desktop) list.push("comfyui");
  if (!desktop && (process.env.IMAGE_PROVIDER || "").toLowerCase() === "codex") list.push("codex");
  list.push("placeholder");
  return list;
}

/** 既定のプロバイダ。IMAGE_PROVIDER のキーが無ければ、使える方 → placeholder の順に落とす */
function provider(requested?: string): ImageProvider {
  const avail = availableProviders();
  const p = (requested || process.env.IMAGE_PROVIDER || "openai").toLowerCase() as ImageProvider;
  if (avail.includes(p)) return p;
  // 自動フォールバックでは、起動しているか分からない ComfyUI は選ばない（URL を明示したときだけ）
  return avail.find((a) => a !== "comfyui" || process.env.COMFYUI_URL)!;
}

// openai SDK は読み込みに時間がかかる（/mnt/c 上だと 10 秒以上）ので、起動を遅くしないよう使うときに読み込む
async function generateOpenAI(prompt: string, asset: AssetRequest, signal?: AbortSignal): Promise<Buffer> {
  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey: await getSecret("openai", "apiKey") });
  const res = await openai.images.generate({
    model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-flare",
    prompt,
    size: SIZES[asset.aspect ?? "square"],
    background: asset.transparent ? "transparent" : "opaque",
    output_format: "png",
    quality: (process.env.OPENAI_IMAGE_QUALITY as any) || "medium",
    n: 1,
  }, { signal });
  const b64 = res.data?.[0]?.b64_json;
  if (!b64) throw new Error("画像生成APIが画像を返しませんでした");
  return Buffer.from(b64, "base64");
}

// ---------- Gemini（Interactions API）----------
// https://ai.google.dev/gemini-api/docs/image-generation
const GEMINI_ASPECT = { square: "1:1", landscape: "3:2", portrait: "2:3" } as const;

/** レスポンスから最初の画像（base64）を探す。Interactions / generateContent どちらの形でも拾う */
function findImageData(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, any>;
  if (o.type === "image" && typeof o.data === "string") return o.data;
  if (o.inlineData?.data && String(o.inlineData.mimeType ?? "").startsWith("image/")) return o.inlineData.data;
  for (const v of Object.values(o)) {
    const found = findImageData(v);
    if (found) return found;
  }
}

async function generateGemini(prompt: string, asset: AssetRequest, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "x-goog-api-key": (await getSecret("gemini", "apiKey")) ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image",
      input: [{ type: "text", text: prompt }],
      response_format: {
        type: "image",
        // Interactions API の画像出力は現状 JPEG のみ対応（image/png は 400 になる）
        mime_type: "image/jpeg",
        aspect_ratio: GEMINI_ASPECT[asset.aspect ?? "square"],
        image_size: process.env.GEMINI_IMAGE_SIZE || "1K",
      },
    }),
    signal,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (Array.isArray(json) ? json[0] : json)?.error;
    throw new Error(`Gemini 画像生成 API エラー (${res.status}): ${err?.message ?? JSON.stringify(json).slice(0, 300)}`);
  }
  const b64 = findImageData(json);
  if (!b64) throw new Error("Gemini が画像を返しませんでした（安全フィルタでブロックされた可能性があります）");
  return Buffer.from(b64, "base64");
}

// ---------- ComfyUI（ローカル GPU）----------
// https://docs.comfy.org/development/comfyui-server/comms_routes
// 既定は SDXL 系の素直な txt2img ワークフロー。Flux など別構成にしたいときは COMFYUI_WORKFLOW に
// API 形式（Export (API)）の JSON を置き、{{prompt}} {{negative}} {{width}} {{height}} {{seed}} を埋め込む
const COMFY_SIZES = { square: [1024, 1024], landscape: [1216, 832], portrait: [832, 1216] } as const;
const COMFY_NEGATIVE = "text, letters, watermark, logo, signature, lowres, blurry, jpeg artifacts, deformed, extra fingers";

const COMFY_BASE = (process.env.COMFYUI_URL || "http://127.0.0.1:8188").replace(/\/?$/, "/");
const comfyUrl = (path: string) => new URL(path, COMFY_BASE).toString();

async function comfyFetch(path: string, init?: RequestInit, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(comfyUrl(path), { ...init, signal });
  } catch (e: any) {
    // 中断はそのまま上へ（接続エラーの案内に差し替えない）
    if (signal?.aborted) throw e;
    throw new Error(`ComfyUI に接続できません（${COMFY_BASE} で ComfyUI が起動しているか確認。別の場所なら COMFYUI_URL を設定）: ${e.cause?.message ?? e.message}`);
  }
  if (!res.ok) throw new Error(`ComfyUI エラー (${res.status}) ${path}: ${(await res.text()).slice(0, 500)}`);
  return res;
}

/** COMFYUI_CHECKPOINT が未指定なら、ComfyUI に入っている最初のチェックポイントを使う */
let comfyCheckpoint: Promise<string> | undefined;
function resolveCheckpoint(): Promise<string> {
  if (process.env.COMFYUI_CHECKPOINT) return Promise.resolve(process.env.COMFYUI_CHECKPOINT);
  comfyCheckpoint ??= comfyFetch("object_info/CheckpointLoaderSimple")
    .then((r) => r.json())
    .then((info: any) => {
      const names: string[] = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
      if (!names.length) throw new Error("ComfyUI の models/checkpoints にモデルがありません（COMFYUI_CHECKPOINT も未指定）");
      return names[0];
    })
    .catch((e) => { comfyCheckpoint = undefined; throw e; });
  return comfyCheckpoint;
}

function defaultComfyWorkflow(ckpt: string) {
  const num = (k: string, d: number) => Number(process.env[k]) || d;
  return {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: "{{width}}", height: "{{height}}", batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "{{prompt}}", clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "{{negative}}", clip: ["4", 1] } },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: "{{seed}}",
        steps: num("COMFYUI_STEPS", 25),
        cfg: num("COMFYUI_CFG", 6),
        sampler_name: process.env.COMFYUI_SAMPLER || "dpmpp_2m",
        scheduler: process.env.COMFYUI_SCHEDULER || "karras",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "dc-designer", images: ["8", 0] } },
  };
}

/** 値がちょうど "{{name}}" の文字列は型ごと置き換え、文字列の一部なら文字列として埋め込む */
function fillPlaceholders(node: unknown, vars: Record<string, string | number>): unknown {
  if (typeof node === "string") {
    const whole = node.match(/^\{\{(\w+)\}\}$/);
    if (whole && whole[1] in vars) return vars[whole[1]];
    return node.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  }
  if (Array.isArray(node)) return node.map((v) => fillPlaceholders(v, vars));
  if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fillPlaceholders(v, vars)]));
  return node;
}

async function generateComfyUI(prompt: string, asset: AssetRequest, signal?: AbortSignal): Promise<Buffer> {
  const [width, height] = COMFY_SIZES[asset.aspect ?? "square"];
  const vars = {
    prompt,
    negative: process.env.COMFYUI_NEGATIVE ?? COMFY_NEGATIVE,
    width,
    height,
    // 同じプロンプトなら同じ絵になるよう seed をプロンプトから決める
    seed: parseInt(createHash("md5").update(prompt).digest("hex").slice(0, 12), 16),
  };
  const template = process.env.COMFYUI_WORKFLOW
    ? JSON.parse(readFileSync(process.env.COMFYUI_WORKFLOW, "utf8"))
    : defaultComfyWorkflow(await resolveCheckpoint());

  const queued: any = await comfyFetch("prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: fillPlaceholders(template, vars), client_id: "dc-designer" }),
  }, signal).then((r) => r.json());
  const id: string = queued.prompt_id;
  if (!id) throw new Error(`ComfyUI がジョブを受け付けませんでした: ${JSON.stringify(queued).slice(0, 300)}`);

  // 完了は /history/{id} に出てくるまでポーリングで待つ（WebSocket を張らずに済ませる）
  const deadline = Date.now() + Number(process.env.COMFYUI_TIMEOUT_MS || 600_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    signal?.throwIfAborted();
    const entry: any = (await comfyFetch(`history/${id}`, undefined, signal).then((r) => r.json()))[id];
    if (!entry) continue;
    if (entry.status?.status_str === "error") {
      const msg = entry.status.messages?.find((m: any) => m[0] === "execution_error")?.[1];
      throw new Error(`ComfyUI の実行に失敗しました: ${msg?.exception_message ?? "不明なエラー"}`);
    }
    const images = Object.values<any>(entry.outputs ?? {}).flatMap((o) => o.images ?? []);
    const img = images.find((i: any) => i.type === "output") ?? images[0];
    if (!img) {
      if (entry.status?.completed) throw new Error("ComfyUI のワークフローが画像を出力しませんでした（SaveImage ノードがあるか確認）");
      continue;
    }
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? "", type: img.type ?? "output" });
    return Buffer.from(await (await comfyFetch(`view?${q}`, undefined, signal)).arrayBuffer());
  }
  throw new Error("ComfyUI の画像生成がタイムアウトしました（COMFYUI_TIMEOUT_MS）");
}

// ---------- Codex CLI（ChatGPT プラン枠）----------
// codex exec の組み込み image_gen ツールで生成する。WSL / Windows 版 CLI 0.159 以前では image_gen が
// セッションに出てこない不具合があった（openai/codex#19133）。0.160.1 で動作確認済み。
// エージェントが自前で描いた偽画像を掴まないよう、read-only サンドボックスで実行し、
// image_gen だけが書き込める $CODEX_HOME/generated_images に新しく出来た PNG のみを採用する。
const CODEX_GEN_DIR = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "generated_images");
const ASPECT_HINT = { square: "square 1:1", landscape: "landscape 3:2", portrait: "portrait 2:3" } as const;

function listPngs(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listPngs(p, out);
    else if (e.name.toLowerCase().endsWith(".png")) out.push(p);
  }
  return out;
}

export type CodexErrorCode = "timeout" | "deadline" | "canceled" | "spawn" | "exit" | "auth" | "unavailable" | "no_image";

/** Codex 経由の生成で起きた失敗。code で原因を区別できる */
export class CodexError extends Error {
  constructor(public code: CodexErrorCode, message: string) {
    super(message);
    this.name = "CodexError";
  }
}

/** 子プロセスの出力は末尾 8KB だけ残す（長い出力でメモリを使い切らないように） */
const CODEX_OUT_TAIL = 8 * 1024;
function keepTail(buf: Buffer, chunk: Buffer): Buffer {
  const all = Buffer.concat([buf, chunk]);
  return all.length > CODEX_OUT_TAIL ? all.subarray(-CODEX_OUT_TAIL) : all;
}

/** 数値の環境変数を呼び出しごとに読む（未設定・0 などは既定値） */
const envMs = (name: string, fallback: number) => Number(process.env[name]) || fallback;

/** 子プロセス（POSIX ではプロセスグループごと）に終了シグナルを送る。例外は外に出さない */
function killTree(child: ChildProcess, sig: NodeJS.Signals): void {
  try {
    if (!child.pid) {
      child.kill(sig);
    } else if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {});
    } else {
      try {
        process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    }
  } catch {
    // すでに終了している場合など。止められなくても呼び出し元は確定させる
  }
}

/** 実行中の codex。別プロセスグループなので、サーバーが Ctrl+C などで止まるときに巻き添えにならない分をここで止める */
const activeCodex = new Set<ChildProcess>();
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  const killAll = () => activeCodex.forEach((c) => killTree(c, "SIGKILL"));
  process.on("exit", killAll);
  // once なので、送り直したシグナルは既定の動作（終了）になる
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(s, () => { killAll(); process.kill(process.pid, s); });
}

/** abort の理由から CodexError を作る。期限切れ（TimeoutError）は deadline、それ以外はキャンセル */
function abortedError(reason: unknown): CodexError {
  if ((reason as any)?.name === "TimeoutError") {
    const min = Math.round(envMs("CODEX_DEADLINE_MS", 900_000) / 60_000);
    return new CodexError("deadline", `画像生成が ${min} 分以内に終わりませんでした（キュー待ちを含む。CODEX_DEADLINE_MS）`);
  }
  return new CodexError("canceled", "画像生成をキャンセルしました");
}

/** codex exec を 1 回実行し、成功時は stdout の末尾を返す。止めるときは子プロセスを止めてから確定させる */
export function runCodex(prompt: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortedError(signal.reason));
    const timeoutMs = envMs("CODEX_TIMEOUT_MS", 300_000);
    const graceMs = envMs("CODEX_KILL_GRACE_MS", 5000);
    const child = spawn(
      process.env.CODEX_BIN || "codex",
      ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", prompt],
      // POSIX ではプロセスグループを分けて、子孫ごと止められるようにする
      { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" },
    );
    if (child.pid && process.platform !== "win32") {
      hookExit();
      activeCodex.add(child);
      child.on("exit", () => activeCodex.delete(child));
    }
    let out: Buffer = Buffer.alloc(0);
    let err: Buffer = Buffer.alloc(0);
    child.stdout.on("data", (d: Buffer) => (out = keepTail(out, d)));
    child.stderr.on("data", (d: Buffer) => (err = keepTail(err, d)));

    let settled = false;
    let stopErr: CodexError | undefined;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    // 確定は 1 回だけ。タイマーと abort リスナーもここで解除する
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    // 停止要求: SIGTERM を送り、猶予後も終わらなければ SIGKILL して close を待たずに確定させる
    const stop = (e: CodexError) => {
      if (settled || stopErr) return;
      stopErr = e;
      killTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        killTree(child, "SIGKILL");
        finish(() => reject(e));
      }, graceMs);
    };
    const onAbort = () => stop(abortedError(signal?.reason));

    timer = setTimeout(
      () => stop(new CodexError("timeout", `codex exec が ${Math.round(timeoutMs / 1000)} 秒以内に終わらなかったため停止しました（CODEX_TIMEOUT_MS）`)),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) =>
      finish(() => reject(stopErr ?? new CodexError("spawn", `codex を起動できません（CODEX_BIN を確認）: ${e.message}`))),
    );
    child.on("close", (code) =>
      finish(() => {
        const errText = err.toString();
        if (stopErr) return reject(stopErr);
        if (code === 0) return resolve(out.toString());
        if (/not logged in|codex login|unauthorized|\b401\b/i.test(`${out}${errText}`))
          return reject(new CodexError("auth", `Codex CLI にサインインしていません（\`codex login\` を実行してください）: ${errText.slice(-300)}`));
        reject(new CodexError("exit", `codex exec が失敗しました (exit ${code}): ${errText.slice(-500)}`));
      }),
    );
  });
}

// 新規ファイルの検出が混ざらないよう 1 枚ずつ直列に実行する。
// 前のジョブは子プロセスが止まるまで次を開始しない（止まらない子が後続を塞ぐ問題は runCodex 側の停止処理で防ぐ）
let codexQueue: Promise<unknown> = Promise.resolve();
let codexJobSeq = 0;

function generateCodex(prompt: string, asset: AssetRequest, signal?: AbortSignal): Promise<Buffer> {
  const id = ++codexJobSeq;
  const log = (msg: string) => console.log(`[codex #${id}] ${msg}`);
  // キュー待ちを含む 1 リクエスト全体の期限。呼び出し元のキャンセルと合成する
  const deadline = AbortSignal.timeout(envMs("CODEX_DEADLINE_MS", 900_000));
  const sig = signal ? AbortSignal.any([signal, deadline]) : deadline;
  log("待機開始");

  const job = codexQueue.then(async () => {
    // キュー待ちの間に期限切れ・キャンセルされていたら、CLI を起動せずに抜ける
    if (sig.aborted) throw abortedError(sig.reason);
    log("起動");
    const before = new Set(listPngs(CODEX_GEN_DIR));
    const startedAt = Date.now();
    const stdout = await runCodex(
      [
        "Call the built-in image_gen tool exactly once with the prompt below, then stop.",
        "Do not create, draw or edit any files yourself. If image_gen is unavailable, reply IMAGE_GEN_UNAVAILABLE and stop.",
        `Aspect ratio: ${ASPECT_HINT[asset.aspect ?? "square"]}.`,
        `Prompt: ${prompt}`,
      ].join("\n"),
      sig,
    );
    log(`終了 (${Date.now() - startedAt} ms)`);
    const created = listPngs(CODEX_GEN_DIR)
      .filter((p) => !before.has(p) && statSync(p).mtimeMs >= startedAt - 1000)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (created.length) {
      log(`画像検出: ${created[0]}`);
      return readFileSync(created[0]);
    }
    if (stdout.includes("IMAGE_GEN_UNAVAILABLE"))
      throw new CodexError("unavailable", "Codex の image_gen ツールが使えませんでした（Codex CLI が古いと openai/codex#19133 で image_gen が出ないので 0.160.1 以降に更新）。IMAGE_PROVIDER=openai に戻してください");
    throw new CodexError("no_image", `Codex の image_gen で画像が生成されませんでした（探索先: ${CODEX_GEN_DIR}）。CLI の出力末尾: ${stdout.slice(-300)}`);
  });
  codexQueue = job.catch(() => {});

  // 呼び出し元へは、ジョブの完了か期限切れ・キャンセルのどちらか早い方を返す（キュー待ち中でも即座に返る）
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortedError(sig.reason));
    if (sig.aborted) onAbort();
    else sig.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([job, aborted])
    .finally(() => sig.removeEventListener("abort", onAbort))
    .catch((e) => {
      log(`失敗 (${e.code ?? "error"}): ${e.message}`);
      throw e;
    });
}

/** 単語区切りで 1 行 max 文字程度に折り返す */
function wrapWords(text: string, max: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const wd of text.split(/\s+/)) {
    if ((cur + " " + wd).length > max) { lines.push(cur); cur = wd; } else cur = cur ? cur + " " + wd : wd;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** APIキーが無いときのダミー画像（パイプライン全体の動作確認用） */
function placeholderSvg(prompt: string, asset: AssetRequest): string {
  const [w, h] = SIZES[asset.aspect ?? "square"].split("x").map(Number);
  const hue = parseInt(createHash("md5").update(prompt).digest("hex").slice(0, 2), 16) * 1.4;
  const lines = wrapWords(asset.prompt, 34);
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,78%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},70%,62%)"/></linearGradient></defs>
${asset.transparent ? `<circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) * 0.42}" fill="url(#g)"/>` : `<rect width="${w}" height="${h}" fill="url(#g)"/>`}
<text x="${w / 2}" y="${h / 2 - lines.length * 22}" font-family="sans-serif" font-size="34" fill="#fff" text-anchor="middle" font-weight="700">
${lines.slice(0, 8).map((l, i) => `<tspan x="${w / 2}" dy="${i === 0 ? 0 : 44}">${esc(l)}</tspan>`).join("")}
</text></svg>`;
}

const GENERATORS: Record<ImageProvider, (prompt: string, asset: AssetRequest, signal?: AbortSignal) => Promise<Buffer | string>> = {
  openai: generateOpenAI,
  gemini: generateGemini,
  comfyui: generateComfyUI,
  codex: generateCodex,
  placeholder: async (prompt, asset) => placeholderSvg(prompt, asset),
};
const EXT: Record<ImageProvider, string> = { openai: "png", gemini: "jpg", comfyui: "png", codex: "png", placeholder: "svg" };

/** アセット 1 点を生成して public/generated に保存する。同じ条件で生成済みならそれを返す */
export async function generateAsset(asset: AssetRequest, ctx: AssetContext = {}, requested?: string, signal?: AbortSignal): Promise<GenerateResult> {
  let prov = provider(requested);
  // Gemini / ComfyUI は透過非対応。透過が要るアセットは OpenAI が使えればそちらで生成し、無ければ白背景にする
  if (NO_TRANSPARENCY.includes(prov) && asset.transparent && availableProviders().includes("openai")) prov = "openai";
  const prompt = NO_TRANSPARENCY.includes(prov) && asset.transparent
    ? buildPrompt(asset, ctx).replace("fully transparent background", "plain solid pure white background")
    : buildPrompt(asset, ctx);
  const key = createHash("sha1").update(JSON.stringify({ prompt, aspect: asset.aspect, t: asset.transparent, prov })).digest("hex").slice(0, 16);
  const file = `${key}.${EXT[prov]}`;
  const path = join(GENERATED_DIR, file);
  if (existsSync(path)) return { src: `/generated/${file}`, provider: prov, cached: true };

  writeFileSync(path, await GENERATORS[prov](prompt, asset, signal));
  return { src: `/generated/${file}`, provider: prov, cached: false };
}

const UPLOAD_EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  // 効果音（アニメーション・画面切り替えで鳴らす音）
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
  "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/webm": "webm",
};
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

/** ユーザーが持ち込んだ画像を生成画像と同じ場所に保存する（spec に base64 を埋め込まず、AI へ送る spec を軽く保つため） */
export function saveUpload(mediaType: string, base64: string): { src: string } {
  const ext = UPLOAD_EXT[mediaType];
  if (!ext) throw httpError(400, "PNG / JPEG / WebP / GIF の画像か、MP3 / WAV / M4A / OGG の音声を選んでください");
  const buf = Buffer.from(base64, "base64");
  if (!buf.length) throw httpError(400, "ファイルが空です");
  if (buf.length > UPLOAD_MAX_BYTES) throw httpError(413, "ファイルが大きすぎます（20MB まで）");
  const file = `up-${createHash("sha1").update(buf).digest("hex").slice(0, 16)}.${ext}`;
  const path = join(GENERATED_DIR, file);
  if (!existsSync(path)) writeFileSync(path, buf);
  return { src: `/generated/${file}` };
}

/** リクエストでプロバイダを指定しないときに使われるもの */
export const imageProviderName = () => provider();
