/**
 * Google Fonts から「全文字入りの TTF」を取得・検証し、ローカルにキャッシュする（EXE-FR-005）。
 * 作品の文字は一切送らない（サブセット指定は使わない）。通信先は CSS が fonts.googleapis.com、実体が fonts.gstatic.com だけ。
 * 表示・書き出し・PPTX 埋め込み・OS 登録はすべてこのキャッシュの TTF を使う
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fontInfo } from "./eot";
import { FONT_BY_FAMILY, googleCssUrl } from "../src/fonts";

export const CSS_HOST = "fonts.googleapis.com";
export const FILE_HOST = "fonts.gstatic.com";
export const MAX_FONT_BYTES = 32 << 20;
export const MAX_CSS_BYTES = 256 << 10;
const TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;
const FONT_TYPES = ["font/ttf", "font/sfnt", "font/otf", "application/x-font-ttf", "application/x-font-truetype", "application/font-sfnt", "application/octet-stream"];

export type FontFailCode = "NETWORK_FAILED" | "VALIDATION_FAILED";
/** code だけを呼び出し側に見せる（外部の本文やパスは載せない） */
export class FontFetchError extends Error {
  constructor(readonly code: FontFailCode, message: string) {
    super(message);
  }
}
const network = (m: string) => new FontFetchError("NETWORK_FAILED", m);
const invalid = (m: string) => new FontFetchError("VALIDATION_FAILED", m);

export const fileBase = (family: string, weight: number) => `${family.replace(/\s+/g, "")}-${weight}`;
const sha256Of = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** 製品版は FONT_CACHE_DIR、開発版は <DATA_DIR>/font-cache（無ければ data/font-cache） */
export function fontCacheDir() {
  return process.env.FONT_CACHE_DIR || join(process.env.DATA_DIR || fileURLToPath(new URL("../data/", import.meta.url)), "font-cache");
}

// ---------- 取得 ----------

function checkUrl(raw: string, host: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid("URL が不正です");
  }
  if (url.protocol !== "https:" || url.hostname !== host || url.port !== "" || url.username || url.password) throw invalid("許可されていない通信先です");
  return url;
}

async function readLimited(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > max) {
    await res.body?.cancel().catch(() => {});
    throw invalid("サイズが上限を超えています");
  }
  if (!res.body) {
    const all = Buffer.from(await res.arrayBuffer());
    if (all.length > max) throw invalid("サイズが上限を超えています");
    return all;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw invalid("サイズが上限を超えています");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** リダイレクトは自動で追わず、毎回 Location を検証する。リファラ・Cookie・ヘッダーは付けない */
async function fetchChecked(start: string, host: string, max: number, types: (t: string) => boolean): Promise<Buffer> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url = checkUrl(start, host);
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetch(url, { redirect: "manual", referrer: "", credentials: "omit", signal });
    } catch {
      throw network("接続できませんでした");
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      const loc = res.headers.get("location");
      if (!loc || hop >= MAX_REDIRECTS) throw invalid("リダイレクトが不正です");
      url = checkUrl(new URL(loc, url).toString(), host);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw network(`取得に失敗しました（HTTP ${res.status}）`);
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!types(type)) {
      await res.body?.cancel().catch(() => {});
      throw invalid("想定外の Content-Type です");
    }
    try {
      return await readLimited(res, max);
    } catch (e) {
      throw e instanceof FontFetchError ? e : network("受信に失敗しました");
    }
  }
}

/** CSS から TrueType の実体 URL を 1 つ取り出す。@import があれば拒否 */
function ttfUrlFromCss(css: string): string {
  if (/@import/i.test(css)) throw invalid("CSS に外部の @import があります");
  const urls = [...css.matchAll(/url\(\s*['"]?(https:[^'")\s]+)['"]?\s*\)\s*format\(\s*['"]truetype['"]\s*\)/gi)].map((m) => m[1]);
  if (urls.length !== 1) throw invalid("CSS から TTF の URL を特定できません");
  return urls[0];
}

/** sfnt の形（TrueType / OpenType）と、名前・OS/2 テーブルが読めることを確かめる */
export function validateSfnt(data: Buffer) {
  if (data.length < 12) throw invalid("フォントが壊れています");
  const tag = data.readUInt32BE(0);
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) throw invalid("フォントの形式が不正です");
  try {
    fontInfo(data);
  } catch {
    throw invalid("フォントのテーブルを読めません");
  }
}

async function download(family: string, weight: number): Promise<Buffer> {
  const css = await fetchChecked(googleCssUrl(family, [weight]), CSS_HOST, MAX_CSS_BYTES, (t) => t === "text/css");
  const data = await fetchChecked(ttfUrlFromCss(css.toString("utf8")), FILE_HOST, MAX_FONT_BYTES, (t) => FONT_TYPES.includes(t));
  validateSfnt(data);
  return data;
}

// ---------- キャッシュ ----------

type IndexEntry = { family: string; weight: number; sha256: string; byteLength: number; sourceHost: string; validatedAt: string };
type Index = Record<string, IndexEntry>;

const indexPath = () => join(fontCacheDir(), "index.json");
const ttfPath = (family: string, weight: number) => join(fontCacheDir(), `${fileBase(family, weight)}.ttf`);

function readIndex(): Index {
  try {
    const v = JSON.parse(readFileSync(indexPath(), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** tmp に書いてから rename で置き換える */
function writeAtomic(path: string, data: Buffer | string) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export type CachedFace = { family: string; weight: number; sha256: string; byteLength: number; data: Buffer; fromCache: boolean };

/** index と sha256 が一致する検証済みキャッシュだけを返す（不一致・欠損は null） */
export function readCachedFace(family: string, weight: number): CachedFace | null {
  const entry = readIndex()[fileBase(family, weight)];
  if (!entry || entry.family !== family || entry.weight !== weight) return null;
  let data: Buffer;
  try {
    data = readFileSync(ttfPath(family, weight));
  } catch {
    return null;
  }
  if (data.length !== entry.byteLength || sha256Of(data) !== entry.sha256) return null;
  return { family, weight, sha256: entry.sha256, byteLength: data.length, data, fromCache: true };
}

const inflight = new Map<string, Promise<CachedFace>>();

/** カタログの face の全文字入り TTF を返す。キャッシュに無い・壊れていれば取得して検証してから置く。同じ face は進行中の取得を共有 */
export function getFontFace(family: string, weight: number): Promise<CachedFace> {
  const key = `${fontCacheDir()}\0${fileBase(family, weight)}`;
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    const hit = readCachedFace(family, weight);
    if (hit) return hit;
    const data = await download(family, weight);
    const dir = fontCacheDir();
    mkdirSync(dir, { recursive: true });
    const sha256 = sha256Of(data);
    writeAtomic(ttfPath(family, weight), data);
    const index = readIndex();
    index[fileBase(family, weight)] = { family, weight, sha256, byteLength: data.length, sourceHost: FILE_HOST, validatedAt: new Date().toISOString() };
    writeAtomic(indexPath(), JSON.stringify(index, null, 2));
    return { family, weight, sha256, byteLength: data.length, data, fromCache: false };
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export const isCatalogFace = (family: string, weight: number) => !!FONT_BY_FAMILY.get(family)?.weights.includes(weight);
