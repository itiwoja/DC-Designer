/**
 * フォントの提案（ChatGPT）と OS へのインストール。
 * PPTX にはカタログのフォントを埋め込む（embedFonts）が、埋め込みはスライドで使った文字だけなので、
 * 受け取った人が新しい文字を打つと別のフォントになる。手元の PowerPoint で編集するならインストールしておく。
 * ポスターでも、書き出した画像以外（SVG をほかのアプリで開く・同じフォントで手直しする）のために PC に入れられる。
 * - Windows / WSL: ユーザーフォント（%LOCALAPPDATA%\Microsoft\Windows\Fonts ＋ HKCU のレジストリ）。管理者権限は不要
 * - Linux: ~/.local/share/fonts/dc-designer ＋ fc-cache
 * - macOS: ~/Library/Fonts
 * インストールできるのはカタログ（src/fonts.ts）のフォントだけ
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, release } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { embeddingRestricted, fontInfo, ttfToEot } from "./eot";
import { FONT_BY_FAMILY, FONT_CATALOG, FONT_ROLE_LABELS, fontCovers, googleCssUrl, installWeights, type FontEntry } from "../src/fonts";
import { askAI } from "./ai";
import { extractJson } from "./chatgpt";
import { httpError } from "./http-error";

const run = promisify(execFile);
const isWSL = process.platform === "linux" && /microsoft/i.test(release());
const isWindows = process.platform === "win32" || isWSL;
const fontTarget = isWindows ? "windows" : process.platform === "darwin" ? "mac" : "linux";

const MAC_USER_FONT_DIR = join(homedir(), "Library/Fonts");
const LINUX_FONT_DIR = join(homedir(), ".local/share/fonts/dc-designer");
const FONTS_KEY = "Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function powershell(script: string): Promise<string> {
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`], { maxBuffer: 16 << 20, timeout: 60_000 });
  return stdout;
}

/** インストール済みフォントの名前（Windows はレジストリの値名、それ以外は fc-list のファミリー名・ファイル名） */
async function installedNames(): Promise<string[]> {
  if (isWindows) {
    const out = await powershell(
      ["HKLM", "HKCU"].map((h) => `(Get-ItemProperty -Path ${psQuote(`${h}:\\${FONTS_KEY}`)} -ErrorAction SilentlyContinue).PSObject.Properties.Name`).join("; "),
    );
    // "Meiryo & Meiryo Italic & Meiryo UI (TrueType)" → ["Meiryo", "Meiryo Italic", "Meiryo UI"]
    return out.split(/\r?\n/).flatMap((l) => l.replace(/\s*\((TrueType|OpenType)\)\s*$/i, "").split(" & ")).map((s) => s.trim()).filter(Boolean);
  }
  if (fontTarget === "mac") {
    return [MAC_USER_FONT_DIR, "/Library/Fonts"].flatMap((d) => (existsSync(d) ? readdirSync(d) : []));
  }
  const { stdout } = await run("fc-list", [":", "family"]).catch(() => ({ stdout: "" }));
  return stdout.split("\n").flatMap((l) => l.split(",")).map((s) => s.trim()).filter(Boolean);
}

const fileBase = (family: string, weight: number) => `${family.replace(/\s+/g, "")}-${weight}`;

/** Windows の値名で、ファミリー名の後ろに付くウェイト・スタイル名（"Shippori Mincho B1 Bold" を "Shippori Mincho" と取り違えないため） */
const STYLE_SUFFIX = /^((extra|ultra|semi|demi)\s?)?(thin|hairline|light|regular|normal|book|medium|bold|heavy|black)(\s?italic)?$|^italic$/i;

function hasFamily(names: string[], family: string) {
  const compact = family.replace(/\s+/g, "");
  return names.some((n) => n === family || (n.startsWith(`${family} `) && STYLE_SUFFIX.test(n.slice(family.length + 1))) || n.startsWith(`${compact}-`));
}

/** installedNames は PowerShell を起動して遅いので 1 分キャッシュする */
let namesCache: { at: number; names: string[] } | null = null;
async function cachedInstalledNames(fresh = false) {
  if (!namesCache || fresh || Date.now() - namesCache.at > 60_000) namesCache = { at: Date.now(), names: await installedNames() };
  return namesCache.names;
}

export async function fontStatus(families: string[]): Promise<{ target: string; installed: Record<string, boolean> }> {
  const list = await cachedInstalledNames();
  return { target: fontTarget, installed: Object.fromEntries(families.map((f) => [f, hasFamily(list, f)])) };
}

/** Google Fonts から TTF を取得（UA を付けないと TrueType の URL が返る）。text を渡すとその文字だけのサブセット */
async function downloadTtf(family: string, weight: number, text?: string): Promise<Buffer> {
  const css = await (await fetch(googleCssUrl(family, [weight], text))).text();
  // サブセットの URL は拡張子が付かないので format('truetype') で見分ける
  const url = css.match(/url\((https:[^)]+)\) format\('truetype'\)/)?.[1];
  if (!url) throw new Error(`${family} (${weight}) の TTF が見つかりませんでした`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${family} のダウンロードに失敗しました（HTTP ${res.status}）`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------- PPTX への埋め込み ----------

/** 使った文字に足しておく文字（受け取った人がちょっと直す程度なら同じフォントのままにする） */
const EDIT_CHARS = (() => {
  let s = "";
  for (let c = 0x20; c < 0x7f; c++) s += String.fromCharCode(c);
  for (let c = 0x3041; c <= 0x3096; c++) s += String.fromCharCode(c); // ひらがな
  for (let c = 0x30a1; c <= 0x30fc; c++) s += String.fromCharCode(c); // カタカナ・長音
  return s + "、。・「」『』（）！？：；〜…ー　";
})();
/** Google Fonts は URL が約 8KB を超えると文字を絞らずに全体を返す（さらに長いと 400） */
const MAX_URL = 7800;

/**
 * PowerPoint に埋め込むフォント（EOT）を作る。標準（400 に近いウェイト）と太字（700）だけで、太字が無いフォントは標準だけ。
 * 使った文字だけのサブセットにする。文字が多すぎて絞れなければフォント全体を入れる
 */
export async function embedFonts(requests: { family: string; bold: boolean; text: string }[]): Promise<{ family: string; bold: boolean; data: string }[]> {
  const out: { family: string; bold: boolean; data: string }[] = [];
  for (const r of requests) {
    const e = FONT_BY_FAMILY.get(r.family);
    if (!e) continue;
    const [regular, bold = regular] = installWeights(e);
    if (r.bold && bold === regular) continue;
    const weight = r.bold ? bold : regular;
    const used = [...new Set(r.text.replace(/\s/g, ""))].join("");
    const withEdit = [...new Set(used + EDIT_CHARS)].join("");
    const text = [withEdit, used].find((t) => googleCssUrl(e.family, [weight], t).length <= MAX_URL);
    try {
      const ttf = await downloadTtf(e.family, weight, text);
      if (embeddingRestricted(fontInfo(ttf).fsType)) continue;
      out.push({ family: r.family, bold: r.bold, data: ttfToEot(ttf).toString("base64") });
    } catch (err) {
      console.warn("PPTX 用のフォントを用意できませんでした:", r.family, err);
    }
  }
  return out;
}

const WEIGHT_NAMES: Record<number, string> = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };

let windowsFontDir: { win: string; local: string } | null = null;
async function winFontDir() {
  if (windowsFontDir) return windowsFontDir;
  const win = (await powershell("Join-Path $env:LOCALAPPDATA 'Microsoft\\Windows\\Fonts'")).trim();
  const local = isWSL ? (await run("wslpath", ["-u", win])).stdout.trim() : win;
  return (windowsFontDir = { win, local });
}

type FontFile = { family: string; weight: number; data: Buffer };

/** Windows のユーザーフォントとして置き、HKCU のレジストリに登録する */
async function installOnWindows(files: FontFile[]) {
  const dir = await winFontDir();
  mkdirSync(dir.local, { recursive: true });
  const reg: string[] = [`$k = ${psQuote(`HKCU:\\${FONTS_KEY}`)}`, "if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }"];
  for (const f of files) {
    const name = `${fileBase(f.family, f.weight)}.ttf`;
    writeFileSync(join(dir.local, name), f.data);
    // 値名はフォントのフルネーム（Google Fonts の静的 TTF は "<Family> <Weight名>"）
    reg.push(`New-ItemProperty -Path $k -Name ${psQuote(`${f.family} ${WEIGHT_NAMES[f.weight] ?? f.weight} (TrueType)`)} -Value ${psQuote(`${dir.win}\\${name}`)} -PropertyType String -Force | Out-Null`);
  }
  await powershell(reg.join("; "));
}

/** macOS / Linux はユーザーのフォントフォルダに置くだけ（Linux は fc-cache も更新） */
async function installOnUnix(files: FontFile[]) {
  const dir = fontTarget === "mac" ? MAC_USER_FONT_DIR : LINUX_FONT_DIR;
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, `${fileBase(f.family, f.weight)}.ttf`), f.data);
  if (fontTarget === "linux") await run("fc-cache", ["-f", dir]).catch(() => {});
}

/** 未インストールのものだけ入れる。戻り値は新しく入れたファミリー */
export async function installFonts(families: string[]): Promise<{ target: string; installed: string[]; already: string[] }> {
  const entries = families.map((f) => {
    const e = FONT_BY_FAMILY.get(f);
    if (!e) throw httpError(400, `カタログにないフォントはインストールできません: ${f}`);
    return e;
  });
  const list = await cachedInstalledNames(true);
  const todo = entries.filter((e) => !hasFamily(list, e.family));
  const already = entries.filter((e) => !todo.includes(e)).map((e) => e.family);
  if (!todo.length) return { target: fontTarget, installed: [], already };

  const files: FontFile[] = [];
  for (const e of todo) for (const w of installWeights(e)) files.push({ family: e.family, weight: w, data: await downloadTtf(e.family, w) });
  await (isWindows ? installOnWindows(files) : installOnUnix(files));
  namesCache = null;
  return { target: fontTarget, installed: todo.map((e) => e.family), already };
}

// ---------- 提案 ----------
const Proposal = z.object({
  name: z.string(),
  reason: z.string(),
  display: z.string(),
  body: z.string(),
});
type FontProposal = z.infer<typeof Proposal>;

const catalogText = (fonts: FontEntry[]) => fonts.map((f) => `- ${f.family}（${FONT_ROLE_LABELS[f.role]}・ウェイト ${f.weights.join("/")}）: ${f.mood}`).join("\n");

const SUBJECT = { slides: { who: "プレゼン資料", what: "スライド資料" }, poster: { who: "ポスター・チラシ", what: "ポスター" }, instagram: { who: "SNS（Instagram）投稿", what: "Instagram の投稿画像" } } as const;
export type FontSubject = keyof typeof SUBJECT;

const system = (kind: FontSubject, fonts: FontEntry[]) => `あなたは日本語タイポグラフィに詳しい${SUBJECT[kind].who}のデザイナーです。
${SUBJECT[kind].what}の内容と、依頼された雰囲気に合うフォントの組み合わせ（見出し用 display と本文用 body）を提案します。

# 使えるフォント（この一覧の family 名だけを、表記どおりに使う）
${catalogText(fonts)}

# 方針
- 見出しは個性を出してよいが、本文は小さい文字でも読みやすいもの（ゴシック・丸ゴシック・明朝の標準的なもの）を選ぶ。手書き・ディスプレイ系を本文に使わない
- 見出しと本文の相性（同系統でまとめる／コントラストを付ける）を考える
- 3 案はそれぞれ方向性を変える（例: 雰囲気にぴったり／落ち着いた無難案／遊びのある案）
- 雰囲気の指定がなければ、${SUBJECT[kind].what}の内容と対象から判断する

# 出力
次の JSON のみを出力する。前置き・コードフェンスは不要。
{ "proposals": [ { "name": "案の短い名前（10字程度）", "reason": "なぜ合うか（60字以内）", "display": "見出しの family", "body": "本文の family" } ] }`;

export async function suggestFonts(opts: { kind?: FontSubject; mood?: string; title?: string; texts?: string[]; current?: { display?: string; body?: string }; signal?: AbortSignal }): Promise<FontProposal[]> {
  const kind = opts.kind ?? "slides";
  const sample = (opts.texts ?? []).join("\n").slice(0, 3000);
  const text = [
    opts.mood?.trim() ? `# 希望する雰囲気\n${opts.mood.trim()}` : "# 希望する雰囲気\n（指定なし。内容から判断してください）",
    opts.title ? `# ${SUBJECT[kind].what}のタイトル\n${opts.title}` : "",
    opts.current?.display || opts.current?.body ? `# 現在のフォント\n見出し: ${opts.current.display ?? "-"} / 本文: ${opts.current.body ?? "-"}` : "",
    sample ? `# ${SUBJECT[kind].what}の文面（抜粋）\n${sample}` : "",
  ].filter(Boolean).join("\n\n");
  // 見出しも本文も資料全体に当たるので、かな・英数字だけのフォントは文面がその文字だけのときに限って候補にする
  const all = [opts.title ?? "", ...(opts.texts ?? [])].join("\n");
  const fonts = FONT_CATALOG.filter((f) => all.trim() ? fontCovers(f, all) : f.script === "ja");
  const raw = extractJson(await askAI(system(kind, fonts), [{ role: "user", text }], undefined, opts.signal), "フォント提案の JSON");
  const proposals = z.object({ proposals: z.array(Proposal) }).parse(raw).proposals
    // 候補外の名前（表記ゆれ・存在しないフォント・文字の足りないフォント）は捨てる
    .filter((p) => fonts.some((f) => f.family === p.display) && fonts.some((f) => f.family === p.body));
  if (!proposals.length) throw new Error("使えるフォントの提案が得られませんでした。雰囲気の指定を変えてもう一度試してください");
  return proposals.slice(0, 3);
}
