// ビルド時のリリース情報の取得・検証（SITE-FR-008、SITE-API-001・002、SITE-D-25・29・32）。
// 失敗はすべて Error を投げてビルドを止める。GITHUB_TOKEN はログにもエラー文にも出さない。
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { LatestRelease, Release, ReleaseAsset, ReleaseData } from "./types.ts";
import { SITE_CONFIG, downloadPrefix } from "./config.ts";
import { renderReleaseNotes } from "./markdown.ts";

/** GitHub API の Release のうち、使うフィールドだけ（SITE-API-001） */
export interface GhAsset {
  name: string;
  size: number;
  browser_download_url: string;
}
export interface GhRelease {
  tag_name: string;
  name?: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  body?: string | null;
  html_url: string;
  assets?: GhAsset[];
}

const API_URL = `https://api.github.com/repos/${SITE_CONFIG.repo}/releases?per_page=100`;
const MAX_RELEASES = 100;
const RETRY_WAIT_MS = [1000, 2000, 4000];

/** SHA256SUMS.txt を読めなかったときのエラー（呼び出し側で版つきの文言にする） */
export class Sha256ParseError extends Error {}

// ---------- 純粋関数 ----------

/** `1.2.3` や `1.2.3-beta.1` を比べる。a < b なら負、等しければ 0、a > b なら正。プレリリース付きは同じ数字の正式版より小さい */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.trim().replace(/^v/i, "").split("-", 2) as [string, string | undefined];
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === undefined) return 1;
  if (pb.pre === undefined) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** draft を除き、prerelease でないもののうち published_at が最新のもの。無ければ null */
export function pickLatestStable<T extends Pick<GhRelease, "draft" | "prerelease" | "published_at">>(
  releases: readonly T[],
): T | null {
  let best: T | null = null;
  for (const r of releases) {
    if (r.draft || r.prerelease) continue;
    if (best === null || Date.parse(r.published_at) > Date.parse(best.published_at)) best = r;
  }
  return best;
}

/** SHA256SUMS.txt からファイル名の行を探し、64 桁を小文字で返す。`*` 付き・空白 2 つの両方を読む */
export function parseSha256Sums(text: string, fileName: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    if (m && m[2] === fileName) return m[1]!.toLowerCase();
  }
  throw new Sha256ParseError(`${fileName} の SHA-256 を読めません`);
}

/** リリースノートの `SHA-256: \`<64桁>\`` 行の値（小文字）。無ければ null */
export function extractNotesSha256(body: string): string | null {
  const m = /SHA-256:\s*`([0-9a-fA-F]{64})`/.exec(body);
  return m ? m[1]!.toLowerCase() : null;
}

/** 署名つきと言えるのは、未署名の文言が無く、かつ signedSince が設定済みで version >= signedSince のときだけ（SITE-D-25・29） */
export function isSigned(body: string, version: string, signedSince: string | null, marker: string): boolean {
  if (body.includes(marker)) return false;
  if (!signedSince) return false;
  return compareVersions(version, signedSince) >= 0;
}

// ---------- 取得 ----------

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  token?: string;
}

const apiError = (status: number | string) => new Error(`GitHub API の取得に失敗しました（HTTP ${status}）`);

/** SITE-API-001：Release 一覧。再試行は 5xx と通信失敗だけ、1・2・4 秒あけて 3 回まで */
export async function fetchReleasesFromApi(opts: FetchOptions = {}): Promise<GhRelease[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? sleepMs;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = opts.token ?? process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  for (let attempt = 0; ; attempt++) {
    let status = 0;
    try {
      const res = await doFetch(API_URL, { headers });
      status = res.status;
      if (res.ok) {
        const json: unknown = await res.json();
        if (!Array.isArray(json)) throw apiError(status);
        return json as GhRelease[];
      }
    } catch (e) {
      // 通信失敗は status 0 のまま再試行へ。apiError（形が違う）はそのまま投げる
      if (e instanceof Error && e.message.startsWith("GitHub API")) throw e;
    }
    const retryable = status === 0 || status >= 500;
    if (!retryable || attempt >= RETRY_WAIT_MS.length) throw apiError(status);
    await sleep(RETRY_WAIT_MS[attempt]!);
  }
}

/** SITE-API-002：SHA256SUMS.txt。認証ヘッダーを付けない（転送先へ漏らさない）。API-001 の関数は使い回さない */
export async function fetchSha256SumsText(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`SHA256SUMS.txt の取得に失敗しました（HTTP ${res.status}）`);
  return res.text();
}

// ---------- 組み立て・検証 ----------

const installerName = (version: string) => `DC-Designer-Setup-${version}.exe`;
const CHECKSUMS_NAME = "SHA256SUMS.txt";

function toAsset(a: GhAsset, kind: ReleaseAsset["kind"], sha256: string | null): ReleaseAsset {
  return { name: a.name, kind, size: a.size, browserDownloadUrl: a.browser_download_url, sha256 };
}

function toRelease(r: GhRelease): Release {
  const version = r.tag_name.replace(/^v/, "");
  const body = r.body ?? "";
  return {
    tag: r.tag_name,
    version,
    name: r.name || r.tag_name,
    publishedAt: r.published_at,
    prerelease: r.prerelease,
    bodyHtml: renderReleaseNotes(body),
    htmlUrl: r.html_url,
    signed: isSigned(body, version, SITE_CONFIG.signedSince, SITE_CONFIG.unsignedMarker),
  };
}

/** API の応答から ReleaseData を作り、SITE-D-32 の検査をする。SHA256SUMS.txt の取得は呼び出し側から渡す */
export async function buildReleaseData(
  raw: readonly GhRelease[],
  fetchSums: (url: string, release: GhRelease) => Promise<string>,
): Promise<ReleaseData> {
  const published = raw
    .filter((r) => !r.draft)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
    .slice(0, MAX_RELEASES);

  const latestRaw = pickLatestStable(published);
  if (!latestRaw) throw new Error("公開済みの安定版がありません");

  const base = toRelease(latestRaw);
  const { version } = base;
  const assets = latestRaw.assets ?? [];

  const exeName = installerName(version);
  const exe = assets.find((a) => a.name === exeName);
  if (!exe) throw new Error(`v${version} に ${exeName} がありません`);
  const sums = assets.find((a) => a.name === CHECKSUMS_NAME);
  if (!sums) throw new Error(`v${version} に ${CHECKSUMS_NAME} がありません`);

  // SITE-D-32：ダウンロード先の接頭辞
  const prefix = downloadPrefix(version);
  for (const a of [exe, sums]) {
    if (!a.browser_download_url.startsWith(prefix)) {
      throw new Error(`ダウンロード先が想定と違います（${a.browser_download_url}）`);
    }
  }

  let sha256: string;
  try {
    sha256 = parseSha256Sums(await fetchSums(sums.browser_download_url, latestRaw), exeName);
  } catch (e) {
    if (e instanceof Sha256ParseError) throw new Error(`v${version} の SHA-256 を読めません`);
    throw e;
  }

  // SITE-D-32：リリースノートの SHA-256 との一致
  const notesSha = extractNotesSha256(latestRaw.body ?? "");
  if (notesSha === null || notesSha !== sha256) throw new Error("SHA-256 がリリースノートと一致しません");

  const latest: LatestRelease = {
    ...base,
    installer: { ...toAsset(exe, "installer", sha256), kind: "installer", sha256 },
    checksums: { ...toAsset(sums, "checksums", null), kind: "checksums" },
  };
  return { latest, releases: published.map(toRelease) };
}

/** テスト・オフライン用：SITE_RELEASES_FIXTURE の JSON を読む */
async function loadFixture(path: string): Promise<{ raw: GhRelease[]; fetchSums: (url: string, r: GhRelease) => Promise<string> }> {
  const raw = JSON.parse(await readFile(path, "utf8")) as GhRelease[];
  const sumsDir = join(dirname(path), `${basename(path)}.sums`);
  return {
    raw,
    fetchSums: (_url, r) => readFile(join(sumsDir, r.tag_name, CHECKSUMS_NAME), "utf8"),
  };
}

let cache: Promise<ReleaseData> | null = null;

/** ビルド中 1 回だけ取得する（モジュール内でメモ化） */
export function getReleaseData(): Promise<ReleaseData> {
  cache ??= (async () => {
    const fixture = process.env.SITE_RELEASES_FIXTURE;
    if (fixture) {
      const { raw, fetchSums } = await loadFixture(fixture);
      return buildReleaseData(raw, fetchSums);
    }
    return buildReleaseData(await fetchReleasesFromApi(), (url) => fetchSha256SumsText(url));
  })();
  return cache;
}

/** テスト用：メモ化を捨てる */
export function resetReleaseCache(): void {
  cache = null;
}
