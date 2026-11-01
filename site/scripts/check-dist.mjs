// ビルド後の dist の HTML を検査する（npm run test:dist）。依存は Node 標準だけ。
// 根拠：SITE-NFR-006（CSP とインラインの禁止）、SITE-D-31・32、docs/design/11_tech_spec.md §11。
// 違反があればファイル名と理由を出して exit 1。
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const BASE_PATH = "/DC-Designer/";
export const EXE_PREFIX = "https://github.com/itiwoja/DC-Designer/releases/download/v";

// SITE-NFR-006 の指令。各指令の値（トークン）がすべて含まれていること
export const REQUIRED_CSP = {
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  "connect-src": ["'self'"],
  "img-src": ["'self'", "data:"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'none'"],
};

// 開始タグ（引用符の中の > は無視する）
const TAG_RE = /<([a-zA-Z][^\s>/]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

function tagsOf(html) {
  // コメントは検査の対象にしない
  const text = html.replace(/<!--[\s\S]*?-->/g, "");
  const out = [];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text))) {
    out.push({ name: m[1].toLowerCase(), attrs: parseAttrs(m[2]) });
  }
  return out;
}

const isExternal = (url) => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(url.trim());

/**
 * 1 つの HTML を検査して、違反の理由の配列を返す（無ければ空）。
 * @param {string} file dist からの相対パス（"404.html"・"download/index.html" など。区切りは / ）
 * @param {string} html
 * @returns {string[]}
 */
export function checkHtml(file, html) {
  const problems = [];
  const tags = tagsOf(html);

  for (const t of tags) {
    if (t.name === "script" && !("src" in t.attrs)) {
      problems.push("src の無い <script> があります（インライン JS は使えません）");
    }
    if (t.name === "style") {
      problems.push("<style> があります（インライン CSS は使えません）");
    }
    if ("style" in t.attrs) {
      problems.push(`style 属性があります（<${t.name}>）`);
    }
    if (t.name === "script" && t.attrs.src && isExternal(t.attrs.src)) {
      problems.push(`外部オリジンの <script> があります：${t.attrs.src}`);
    }
    if (t.name === "link" && /(^|\s)stylesheet(\s|$)/i.test(t.attrs.rel ?? "") && t.attrs.href && isExternal(t.attrs.href)) {
      problems.push(`外部オリジンのスタイルシートがあります：${t.attrs.href}`);
    }
  }

  // CSP
  const csp = tags.find((t) => t.name === "meta" && (t.attrs["http-equiv"] ?? "").toLowerCase() === "content-security-policy");
  if (!csp) {
    problems.push('<meta http-equiv="Content-Security-Policy"> がありません');
  } else {
    const directives = new Map();
    for (const part of (csp.attrs.content ?? "").split(";")) {
      const [name, ...values] = part.trim().split(/\s+/);
      if (name) directives.set(name.toLowerCase(), values);
    }
    for (const [name, tokens] of Object.entries(REQUIRED_CSP)) {
      const have = directives.get(name);
      if (!have) {
        problems.push(`CSP に ${name} がありません`);
        continue;
      }
      const missing = tokens.filter((tk) => !have.includes(tk));
      if (missing.length > 0) problems.push(`CSP の ${name} に ${missing.join(" ")} がありません`);
    }
  }

  // 404.html は任意の深さの URL で配られるので、資産は絶対パスで参照する
  if (file === "404.html") {
    for (const t of tags) {
      for (const key of ["href", "src"]) {
        const v = t.attrs[key];
        if (v === undefined || v.startsWith("#")) continue;
        if (!(v.startsWith(BASE_PATH) || /^https:/i.test(v))) {
          problems.push(`404.html の ${key} が ${BASE_PATH} か https: で始まっていません：${v}`);
        }
      }
    }
  }

  // ダウンロードページの exe は GitHub Releases の版つき URL
  if (file === "download/index.html") {
    const exes = tags.filter((t) => t.name === "a" && /\.exe(?:[?#]|$)/i.test(t.attrs.href ?? ""));
    if (exes.length === 0) problems.push("exe へのリンクがありません");
    for (const t of exes) {
      if (!t.attrs.href.startsWith(EXE_PREFIX)) {
        problems.push(`exe のリンクが ${EXE_PREFIX} で始まっていません：${t.attrs.href}`);
      }
    }
  }

  return problems;
}

function listHtml(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listHtml(p));
    else if (name.endsWith(".html")) out.push(p);
  }
  return out;
}

/** dist 全体を検査して、{ file, reason } の配列を返す */
export function checkDist(distDir) {
  if (!existsSync(distDir)) return [{ file: distDir, reason: "dist がありません（先に npm run build）" }];
  const files = listHtml(distDir);
  if (files.length === 0) return [{ file: distDir, reason: "HTML が 1 つもありません" }];
  const violations = [];
  for (const p of files) {
    const rel = relative(distDir, p).split(sep).join("/");
    for (const reason of checkHtml(rel, readFileSync(p, "utf8"))) violations.push({ file: rel, reason });
  }
  return violations;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && fileURLToPath(new URL(`file://${process.argv[1]}`)) === self) {
  const distDir = process.argv[2] ?? join(dirname(self), "../dist");
  const violations = checkDist(distDir);
  if (violations.length > 0) {
    for (const v of violations) console.error(`${v.file}: ${v.reason}`);
    console.error(`dist の検査に失敗しました（${violations.length} 件）`);
    process.exit(1);
  }
  console.log("dist の検査に成功しました");
}
