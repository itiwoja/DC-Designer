// 配布物の検査：許可リスト・禁止物・秘密値・開発者の絶対 path。
// 使い方: node scripts/inspect-desktop.mjs <ステージ dir | release/win-unpacked>
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ASSET_EXT = /\.(js|mjs|css|woff2?|png|svg|wav|mp3|ico|jpg|jpeg|webp|json)$/i;
const ALLOWED = [
  /^package\.json$/,
  /^LICENSE$/,
  /^dist\/index\.html$/,
  /^dist\/assets\/.+/,
  /^build\/desktop\/(main\.cjs|preload\.cjs|worker\.mjs)$/,
  /^build\/desktop\/chunks\/[^/]+\.(mjs|cjs)$/,
  /^build\/pdf-assets\/(cmaps|standard_fonts|wasm)\/.+/,
];
const FORBIDDEN = [
  [/(^|\/)\.env(\.|$)/, ".env"],
  [/(^|\/)data\//, "data/"],
  [/(^|\/)generated\//, "generated/"],
  [/\.map$/i, "sourcemap"],
  [/(^|\/)node_modules\//, "node_modules/"],
  [/(^|\/)\.git(\/|$)/, ".git"],
  [/(^|\/)backup\//, "backup/"],
  [/(^|\/)\.claude(\/|$)/, ".claude"],
  [/(^|\/)\.output(\/|$)/, ".output"],
  [/(^|\/)tests?\//, "tests"],
  [/\.(test|spec)\.[cm]?[jt]sx?$/, "test"],
];
const TEXT_EXT = /\.(js|cjs|mjs|css|html|json|svg|txt|md|ts|yml|yaml)$/i;
const SECRET_PATTERNS = [
  [/sk-or-v1-/, "OpenRouter key"],
  [/sk-[A-Za-z0-9_-]{20,}/, "sk- key"],
  [/AIza[0-9A-Za-z_-]{35}/, "Google API key"],
  [/ghp_[A-Za-z0-9]{10,}/, "GitHub token"],
  [/github_pat_[A-Za-z0-9_]{10,}/, "GitHub PAT"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\b[A-Z][A-Z0-9_]*(API_KEY|SECRET|TOKEN)\s*=\s*["']?[A-Za-z0-9_-]{8,}/, "env assignment"],
];
const PATH_PATTERNS = [
  [/\/home\/[A-Za-z0-9._-]+\//, "developer path (/home/)"],
  [/\/mnt\/c\/Users\//i, "developer path (/mnt/c/Users/)"],
  [/[A-Za-z]:\\{1,2}Users\\{1,2}[A-Za-z0-9._-]+/i, "developer path (C:\\Users\\)"],
];

/** 相対 path（/ 区切り）の判定。問題なければ null、あれば理由 */
export function checkPath(rel) {
  for (const [re, name] of FORBIDDEN) if (re.test(rel)) return `forbidden: ${name}`;
  if (!ALLOWED.some((re) => re.test(rel))) return "not in allowlist";
  if (/^dist\/assets\//.test(rel) && !ASSET_EXT.test(rel)) return "extension not allowed";
  return null;
}

/** テキストの中身の検査。値は返さず種類だけ返す */
export function scanContent(rel, buf) {
  if (!TEXT_EXT.test(rel) && path.posix.basename(rel) !== "LICENSE") return [];
  const text = buf.toString("utf8");
  const kinds = new Set();
  for (const [re, kind] of [...SECRET_PATTERNS, ...PATH_PATTERNS]) if (re.test(text)) kinds.add(kind);
  return [...kinds].map((kind) => ({ file: rel, kind }));
}

/** entries: [{ rel, read: () => Buffer }] → { problems, files } */
export function inspectEntries(entries) {
  const problems = [];
  const files = [];
  for (const { rel, read } of entries) {
    const reason = checkPath(rel);
    if (reason) problems.push({ file: rel, kind: reason });
    const buf = read();
    problems.push(...scanContent(rel, buf).filter(() => !reason || !reason.startsWith("forbidden")));
    files.push({ path: rel, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex") });
  }
  return { problems, files };
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else out.push({ rel: path.relative(base, full).split(path.sep).join("/"), read: () => readFileSync(full) });
  }
  return out;
}

export function dirEntries(dir) {
  return walk(dir);
}

export async function asarEntries(asarPath) {
  const require = createRequire(import.meta.url);
  const asar = require("@electron/asar");
  const list = asar.listPackage(asarPath, { isPack: false });
  const entries = [];
  for (const item of list) {
    const rel = item.replace(/\\/g, "/").replace(/^\//, "");
    let buf;
    try {
      buf = asar.extractFile(asarPath, rel);
    } catch {
      continue; // ディレクトリ
    }
    entries.push({ rel, read: () => buf });
  }
  return entries;
}

export function writeManifest(file, files) {
  mkdirSync(path.dirname(file), { recursive: true });
  const total = files.reduce((s, f) => s + f.size, 0);
  writeFileSync(file, JSON.stringify({ fileCount: files.length, totalSize: total, files }, null, 2));
  return total;
}

/** ステージ dir または win-unpacked を検査して結果を表示。問題があれば false */
export async function inspectTarget(target) {
  const asarPath = path.join(target, "resources", "app.asar");
  const isPacked = existsSync(asarPath);
  const entries = isPacked ? await asarEntries(asarPath) : dirEntries(target);
  const { problems, files } = inspectEntries(entries);
  // asarUnpack で外に出したファイルは worker.mjs だけ許す
  const unpackedDir = path.join(target, "resources", "app.asar.unpacked");
  if (isPacked && existsSync(unpackedDir)) {
    for (const { rel } of dirEntries(unpackedDir)) {
      if (rel !== "build/desktop/worker.mjs") problems.push({ file: `app.asar.unpacked/${rel}`, kind: "not in allowlist" });
    }
  }
  const manifest = isPacked ? path.resolve(target, "..", "desktop-manifest.json") : path.resolve(target, "..", "manifest.json");
  const total = writeManifest(manifest, files);
  console.log(`inspect: ${files.length} files, ${total} bytes -> ${path.relative(process.cwd(), manifest)}`);
  for (const p of problems) console.error(`  NG ${p.file}: ${p.kind}`);
  if (problems.length) console.error(`inspect: ${problems.length} problem(s)`);
  return problems.length === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node scripts/inspect-desktop.mjs <stage dir | release/win-unpacked>");
    process.exit(2);
  }
  process.exit((await inspectTarget(path.resolve(target))) ? 0 : 1);
}
