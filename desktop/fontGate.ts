/**
 * フォント操作のゲート（EXE-FR-005 / EXE-API-005）。Google Fonts からの取得は初回に1回だけ許可を取り、
 * Windows への OS 登録は検証済みキャッシュの face・hash を main が確定してから別に確認する。
 * 同意は main のネイティブダイアログだけで得る（renderer から同意済みを渡す契約にしない）
 */
import fs from "node:fs";
import path from "node:path";
import type { MessageBoxOptions } from "electron";
import { FONT_BY_FAMILY, installWeights } from "../src/fonts";
import type { DesktopResult } from "./bridge";
import { DESKTOP_INTERNAL_OPERATIONS, type DesktopOperation } from "./operations";

export type FontFace = { family: string; weight: number; sha256: string };
type Resolved = { op: DesktopOperation; path: string; body?: unknown };

export type FontGateDeps = {
  /** `<userRoot>/fonts/consent.json` */
  consentFile: string;
  request: (op: DesktopOperation, path: string, body: unknown) => Promise<DesktopResult>;
  /** 取得の許可（main がネイティブダイアログを出す） */
  confirmConsent: () => Promise<boolean>;
  /** OS 登録の確認（対象 face を示す。承認だけ true） */
  confirmInstall: (faces: FontFace[]) => Promise<boolean>;
  now?: () => number;
};

const MAX_FAMILIES = 16;
/** 登録確認の有効期間：face 集合を確定してから登録を送るまで */
export const INSTALL_WINDOW_MS = 5 * 60 * 1000;
const GATED = new Set(["fonts.files", "fonts.embed", "fonts.install"]);
const ACQUIRE_OP: DesktopOperation = DESKTOP_INTERNAL_OPERATIONS["fonts.acquire"];

const fail = (code: string, error: string): DesktopResult => ({ ok: false, error, code });
const invalid = () => fail("INVALID_ARGUMENT", "要求の形式が正しくありません");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function createFontGate(deps: FontGateDeps) {
  const now = deps.now ?? Date.now;
  let pending: Promise<boolean> | null = null;

  function hasConsent(): boolean {
    try {
      const j: unknown = JSON.parse(fs.readFileSync(deps.consentFile, "utf8"));
      return isObj(j) && j.version === 1 && typeof j.grantedAt === "number";
    } catch { return false; }
  }

  function revokeConsent(): void {
    fs.rmSync(deps.consentFile, { force: true });
  }

  /** 許可を確かめる。無ければ確認を1回だけ出す（同時の要求は同じ Promise を待つ）。拒否は保存しない */
  function ensureConsent(): Promise<boolean> {
    if (hasConsent()) return Promise.resolve(true);
    if (pending) return pending;
    const p = (async () => {
      if (!(await deps.confirmConsent())) return false;
      fs.mkdirSync(path.dirname(deps.consentFile), { recursive: true });
      fs.writeFileSync(deps.consentFile, JSON.stringify({ version: 1, grantedAt: now() }));
      return true;
    })();
    pending = p;
    const clear = () => { if (pending === p) pending = null; };
    p.then(clear, clear);
    return p;
  }

  const denied = () => fail("FONT_CONSENT_DENIED", "フォントの取得を許可していません");

  async function install(r: Resolved): Promise<DesktopResult> {
    // 画面から受けるのは families だけ。expect 等の余計な項目は拒否する
    if (!isObj(r.body) || Object.keys(r.body).some((k) => k !== "families")) return invalid();
    const families = r.body.families;
    if (!Array.isArray(families) || families.length === 0 || families.length > MAX_FAMILIES) return invalid();
    if (!families.every((f) => typeof f === "string" && FONT_BY_FAMILY.has(f)) || new Set(families).size !== families.length) return invalid();
    if (!(await ensureConsent())) return denied();

    const want = (families as string[]).flatMap((family) => installWeights(FONT_BY_FAMILY.get(family)!).map((weight) => ({ family, weight })));
    const got = await deps.request(ACQUIRE_OP, ACQUIRE_OP.route, { faces: want });
    if (!got.ok) return got;
    const faces = parseAcquired(got.data, want);
    if (!faces) return fail("FONT_ACQUIRE_FAILED", "フォントの取得に失敗しました");

    const decidedAt = now();
    if (!(await deps.confirmInstall(faces))) {
      return { ok: true, data: { target: "windows", installed: [], already: [], osInstallState: "declined" } };
    }
    if (now() - decidedAt > INSTALL_WINDOW_MS) return fail("FONT_CONFIRM_EXPIRED", "確認の有効期限が切れました。もう一度お試しください");
    return deps.request(r.op, r.path, { families, expect: faces });
  }

  return {
    handles: (name: string) => GATED.has(name),
    async handle(name: string, r: Resolved): Promise<DesktopResult> {
      if (name === "fonts.install") return install(r);
      if (!GATED.has(name)) return invalid();
      if (!(await ensureConsent())) return denied();
      return deps.request(r.op, r.path, r.body);
    },
    hasConsent,
    revokeConsent,
  };
}

/** acquire の応答が、要求した face をすべて（余計なく）含むときだけ face 一覧を返す */
function parseAcquired(data: unknown, want: { family: string; weight: number }[]): FontFace[] | null {
  if (!isObj(data) || !Array.isArray(data.faces)) return null;
  if (Array.isArray(data.failed) && data.failed.length > 0) return null;
  const faces: FontFace[] = [];
  for (const f of data.faces) {
    if (!isObj(f) || typeof f.family !== "string" || typeof f.weight !== "number" || typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) return null;
    faces.push({ family: f.family, weight: f.weight, sha256: f.sha256 });
  }
  const key = (f: { family: string; weight: number }) => `${f.family}\n${f.weight}`;
  const have = new Set(faces.map(key));
  if (faces.length !== want.length || have.size !== faces.length || !want.every((w) => have.has(key(w)))) return null;
  return faces;
}

const TITLE = "DC-Designer";

/** 取得の許可ダイアログ（Electron の MessageBoxOptions 互換。既定は「許可しない」） */
export function consentDialogOptions(): MessageBoxOptions {
  return {
    type: "question",
    title: TITLE,
    message: "Google Fonts からフォントを取得してよいですか？",
    detail: [
      "ポスターの表示や書き出しに必要なフォントを、Google Fonts から自動で取得します。",
      "",
      "・送るのはフォント名だけです。作品の文字や画像は送りません。",
      "・あなたのIPアドレス、選んだフォント名、時刻が Google に伝わります。",
      "・この許可は初回の1回だけ聞きます。あとからメニューで取り消せます。",
    ].join("\n"),
    buttons: ["許可しない", "許可する"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

/** Windows へのフォント登録ダイアログ（既定は「インストールしない」） */
export function installDialogOptions(faces: FontFace[]): MessageBoxOptions {
  const list = faces.map((f) => `・${f.family}（${f.weight}）`).join("\n");
  return {
    type: "question",
    title: TITLE,
    message: "このフォントを Windows にインストールしますか？",
    detail: [
      list,
      "",
      "ライセンス：Google Fonts（SIL Open Font License 等。フォントごとの条件に従う）",
      "登録先：このWindowsユーザーのフォント（管理者権限は不要です）",
      "",
      "インストールしなくても、DC-Designer の中では使えます。",
    ].join("\n"),
    buttons: ["インストールしない", "インストールする"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
