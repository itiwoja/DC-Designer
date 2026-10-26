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
import { fileBase, FontFetchError, getFontFace, isCatalogFace, readCachedFace, type FontFailCode } from "./font-cache";
import { FONT_BY_FAMILY, FONT_CATALOG, FONT_ROLE_LABELS, fontCovers, installWeights, type FontEntry } from "../src/fonts";
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

// ---------- 全文字入り TTF（取得・検証・キャッシュは font-cache.ts） ----------

export type FontFace = { family: string; weight: number };
export type FontFailure = FontFace & { code: FontFailCode };
const MAX_FACES = 16;

/** リクエストの faces を検証する。カタログ外・weight がカタログに無い・16 件超は 400。重複は 1 つにまとめる */
export function parseFaces(v: unknown): FontFace[] {
  if (!Array.isArray(v) || v.length > MAX_FACES) throw httpError(400, `faces は ${MAX_FACES} 件までの配列で指定してください`);
  const seen = new Map<string, FontFace>();
  for (const f of v) {
    const { family, weight } = (f ?? {}) as Record<string, unknown>;
    if (typeof family !== "string" || typeof weight !== "number" || !isCatalogFace(family, weight)) throw httpError(400, "カタログにないフォントです");
    seen.set(fileBase(family, weight), { family, weight });
  }
  return [...seen.values()];
}

/** install の expect。形式が不正なら 400（内容の不一致は installFonts が 409 にする） */
export function parseExpect(v: unknown): InstallExpect {
  if (!Array.isArray(v) || v.length > MAX_FACES) throw httpError(400, "expect の形式が不正です");
  return v.map((x) => {
    const { family, weight, sha256 } = (x ?? {}) as Record<string, unknown>;
    if (typeof family !== "string" || typeof weight !== "number" || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw httpError(400, "expect の形式が不正です");
    return { family, weight, sha256 };
  });
}

const failCode = (e: unknown): FontFailCode => (e instanceof FontFetchError ? e.code : "NETWORK_FAILED");

/** faces を取得（キャッシュに無ければ通信）。失敗した face は failed に入れる */
async function acquireFaces(faces: FontFace[]) {
  const ok: Awaited<ReturnType<typeof getFontFace>>[] = [];
  const failed: FontFailure[] = [];
  await Promise.all(faces.map(async (f) => {
    try {
      ok.push(await getFontFace(f.family, f.weight));
    } catch (e) {
      console.warn("フォントを用意できませんでした:", f.family, f.weight, failCode(e));
      failed.push({ ...f, code: failCode(e) });
    }
  }));
  const order = (x: FontFace, y: FontFace) => faces.findIndex((f) => f.family === x.family && f.weight === x.weight) - faces.findIndex((f) => f.family === y.family && f.weight === y.weight);
  return { ok: ok.sort(order), failed: failed.sort(order) };
}

/** 画面の表示・SVG 書き出し用に TTF（base64）を返す */
export async function fontFiles(faces: FontFace[]) {
  const { ok, failed } = await acquireFaces(faces);
  return { files: ok.map((f) => ({ family: f.family, weight: f.weight, sha256: f.sha256, data: f.data.toString("base64") })), failed };
}

/** キャッシュに用意して hash だけ返す（OS 登録の確認の前に使う） */
export async function acquireFonts(faces: FontFace[]) {
  const { ok, failed } = await acquireFaces(faces);
  return { faces: ok.map((f) => ({ family: f.family, weight: f.weight, sha256: f.sha256, byteLength: f.byteLength, fromCache: f.fromCache })), failed };
}

// ---------- PPTX への埋め込み ----------

/**
 * PowerPoint に埋め込むフォント（EOT）を作る。標準（400 に近いウェイト）と太字（700）だけで、太字が無いフォントは標準だけ。
 * キャッシュの全文字入り TTF から作る（作品の文字は使わない）
 */
export async function embedFonts(requests: { family: string; bold: boolean }[]): Promise<{ family: string; bold: boolean; data: string }[]> {
  const out: { family: string; bold: boolean; data: string }[] = [];
  for (const r of requests) {
    const e = FONT_BY_FAMILY.get(r.family);
    if (!e) continue;
    const [regular, bold = regular] = installWeights(e);
    if (r.bold && bold === regular) continue;
    try {
      const { data: ttf } = await getFontFace(e.family, r.bold ? bold : regular);
      if (embeddingRestricted(fontInfo(ttf).fsType)) continue;
      out.push({ family: r.family, bold: r.bold, data: ttfToEot(ttf).toString("base64") });
    } catch (err) {
      console.warn("PPTX 用のフォントを用意できませんでした:", r.family, err instanceof FontFetchError ? err.code : "FAILED");
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

export type InstallExpect = { family: string; weight: number; sha256: string }[];

/** installWeights の face 集合が expect と完全一致し、キャッシュ実体の sha256 も一致するか（不一致は 409） */
function verifyExpect(entries: FontEntry[], expect: InstallExpect): Map<string, string> {
  const faces = entries.flatMap((e) => installWeights(e).map((w) => ({ family: e.family, weight: w })));
  const want = new Map(expect.map((x) => [fileBase(x.family, x.weight), x.sha256]));
  if (want.size !== expect.length || want.size !== new Set(faces.map((f) => fileBase(f.family, f.weight))).size) throw httpError(409, "インストールする内容が確認済みの内容と一致しません");
  for (const f of faces) {
    const cached = readCachedFace(f.family, f.weight);
    if (want.get(fileBase(f.family, f.weight)) !== cached?.sha256) throw httpError(409, "インストールする内容が確認済みの内容と一致しません");
  }
  return want;
}

/**
 * 未インストールのものだけ入れる。戻り値は新しく入れたファミリー。
 * expect があれば、キャッシュ実体と一致する場合だけ実行する（再ダウンロードしない）。製品版は expect 必須
 */
export async function installFonts(families: string[], expect?: InstallExpect): Promise<{ target: string; installed: string[]; already: string[] }> {
  const entries = families.map((f) => {
    const e = FONT_BY_FAMILY.get(f);
    if (!e) throw httpError(400, `カタログにないフォントはインストールできません: ${f}`);
    return e;
  });
  if (!expect && process.env.DC_DESIGNER_DESKTOP === "1") throw httpError(400, "expect は必須です");
  const want = expect && verifyExpect(entries, expect);
  const list = await cachedInstalledNames(true);
  const todo = entries.filter((e) => !hasFamily(list, e.family));
  const already = entries.filter((e) => !todo.includes(e)).map((e) => e.family);
  if (!todo.length) return { target: fontTarget, installed: [], already };

  const files: FontFile[] = [];
  for (const e of todo) {
    for (const w of installWeights(e)) {
      try {
        const face = want ? readCachedFace(e.family, w) : await getFontFace(e.family, w);
        // 登録する bytes そのものを確認済みの hash と照合する（照合後の差し替えを防ぐ）
        if (!face || (want && want.get(fileBase(e.family, w)) !== face.sha256)) throw httpError(409, "キャッシュが変わりました");
        files.push({ family: e.family, weight: w, data: face.data });
      } catch (err) {
        if (err instanceof FontFetchError) throw httpError(502, `${e.family} のフォントを用意できませんでした`);
        throw err;
      }
    }
  }
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
