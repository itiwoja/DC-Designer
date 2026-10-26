/**
 * app://dc-designer の配信規則（純粋関数）。何を配信するかはここだけで決め、main は結果を読んで返すだけにする。
 * 配信するのは dist の静的資源・同梱 PDF.js 資源・生成画像だけ（API の中継はしない）
 */
import path from "node:path";
import { createHash } from "node:crypto";

export const APP_SCHEME = "app";
export const APP_HOST = "dc-designer";
export const APP_ORIGIN_URL = `${APP_SCHEME}://${APP_HOST}/`;

export type AppTarget =
  | { kind: "dist"; segments: string[]; type: string }
  | { kind: "pdf"; dir: string; file: string; type: string }
  | { kind: "generated"; file: string; type: string };

const DIST_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8", json: "application/json; charset=utf-8", txt: "text/plain; charset=utf-8",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  wasm: "application/wasm",
};

/** PDF.js 同梱資源：ディレクトリごとの許可拡張子 */
const PDF_TYPES: Record<string, Record<string, string>> = {
  cmaps: { bcmap: "application/octet-stream" },
  standard_fonts: { pfb: "application/octet-stream", ttf: "font/ttf" },
  wasm: { wasm: "application/wasm", js: "text/javascript; charset=utf-8" },
};

/** 生成・取り込み画像と音声の許可リスト */
const GENERATED_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif",
  svg: "image/svg+xml", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
};

const FILE_RE = /^[A-Za-z0-9._-]+$/;

const extOf = (file: string): string => {
  const i = file.lastIndexOf(".");
  return i > 0 ? file.slice(i + 1).toLowerCase() : "";
};

/** `..` を含まない安全なファイル名か */
const safeFile = (name: string): boolean => FILE_RE.test(name) && !name.includes("..") && name !== "." && name !== "";

/** app://dc-designer/ 配下の URL か（URL.origin は非標準 scheme で "null" になるので protocol と host で見る） */
export function isAppUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** URL から path の各 segment を取り出す。%エンコードを1回だけ戻し、危険な形は null */
function pathSegments(u: URL): string[] | null {
  const raw = u.pathname;
  if (!raw.startsWith("/")) return null;
  const parts = raw.slice(1).split("/");
  const out: string[] = [];
  for (const p of parts) {
    let d: string;
    try { d = decodeURIComponent(p); } catch { return null; }
    if (d.includes("/") || d.includes("\\") || d.includes(":") || d.includes("\0")) return null;
    out.push(d);
  }
  return out;
}

/** リクエスト URL を配信対象に解決する。許可しない形は null（404） */
export function resolveAppTarget(raw: string): AppTarget | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (!isAppUrl(raw) || u.port) return null;
  const segs = pathSegments(u);
  if (!segs) return null;
  if (segs.length === 1 && segs[0] === "") return { kind: "dist", segments: ["index.html"], type: DIST_TYPES.html };
  if (segs.some((s) => !safeFile(s))) return null;

  if (segs[0] === "generated") {
    if (segs.length !== 2) return null;
    const type = GENERATED_TYPES[extOf(segs[1])];
    return type ? { kind: "generated", file: segs[1], type } : null;
  }
  if (segs[0] === "api") {
    if (segs.length !== 4 || segs[1] !== "pdf-assets" || !Object.hasOwn(PDF_TYPES, segs[2])) return null;
    const type = PDF_TYPES[segs[2]][extOf(segs[3])];
    return type ? { kind: "pdf", dir: segs[2], file: segs[3], type } : null;
  }
  const type = DIST_TYPES[extOf(segs[segs.length - 1])];
  return type ? { kind: "dist", segments: segs, type } : null;
}

/** root の下に解決する。root の外へ出る場合は null */
export function resolveUnder(root: string, ...parts: string[]): string | null {
  const base = path.resolve(root);
  const full = path.resolve(base, ...parts);
  return full.startsWith(base + path.sep) ? full : null;
}

/** 解決結果を実ファイルの path にする（存在確認は呼び出し側） */
export function targetFilePath(t: AppTarget, roots: { dist: string; pdfAssets: string; generated: string }): string | null {
  switch (t.kind) {
    case "dist": return resolveUnder(roots.dist, ...t.segments);
    case "pdf": return resolveUnder(roots.pdfAssets, t.dir, t.file);
    case "generated": return resolveUnder(roots.generated, t.file);
  }
}

/** index.html の inline script の CSP ハッシュ（外部 src の script は 'self' で足りる） */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(m[1]) || !m[2].trim()) continue;
    out.push(`'sha256-${createHash("sha256").update(m[2], "utf8").digest("base64")}'`);
  }
  return out;
}

export function buildCsp(scriptHashes: string[] = []): string {
  return [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `script-src 'self' 'wasm-unsafe-eval'${scriptHashes.map((h) => " " + h).join("")}`,
    "connect-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** セッションの通信阻止：app（固定 host）・data・blob・devtools 以外は止める */
export function isAllowedRequestUrl(raw: string): boolean {
  try {
    const p = new URL(raw).protocol;
    if (p === "data:" || p === "blob:" || p === "devtools:") return true;
    return isAppUrl(raw);
  } catch {
    return false;
  }
}

/** 外部リンクとして OS のブラウザへ渡してよいか（https のみ・userinfo なし） */
export function isExternalHttpsUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
}
