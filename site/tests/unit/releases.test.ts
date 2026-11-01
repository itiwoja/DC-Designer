import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildReleaseData,
  compareVersions,
  extractNotesSha256,
  fetchReleasesFromApi,
  fetchSha256SumsText,
  getReleaseData,
  isSigned,
  parseSha256Sums,
  pickLatestStable,
  resetReleaseCache,
  Sha256ParseError,
  type GhRelease,
} from "../../src/lib/releases.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/releases.json", import.meta.url));
const SHA = "f75df3993244aac42e39482e9782c9930a05b5b9eed95ca2ceb35f3fdd6d4ae8";
const EXE = "DC-Designer-Setup-1.0.6.exe";
const MARKER = "この版はコード署名をしていません";
const loadRaw = (): GhRelease[] => JSON.parse(readFileSync(FIXTURE, "utf8"));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const sumsOk = async () => `${SHA} *${EXE}\n`;

describe("compareVersions", () => {
  it("数字で比べる", () => {
    expect(compareVersions("1.0.10", "1.0.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.6", "1.0.6")).toBe(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.9.9", "1.0.0")).toBeLessThan(0);
  });
  it("プレリリースは同じ数字の正式版より小さい", () => {
    expect(compareVersions("1.1.0-beta.1", "1.1.0")).toBeLessThan(0);
  });
});

describe("pickLatestStable", () => {
  it("draft と prerelease を除いて publishedAt が最新のものを選ぶ", () => {
    // fixture は draft(v1.0.8)・prerelease(v1.1.0-beta.1) のほうが新しい
    expect(pickLatestStable(loadRaw())?.tag_name).toBe("v1.0.6");
  });
  it("並び順に依存しない", () => {
    expect(pickLatestStable(loadRaw().reverse())?.tag_name).toBe("v1.0.6");
  });
  it("安定版が無ければ null", () => {
    expect(pickLatestStable(loadRaw().filter((r) => r.draft || r.prerelease))).toBeNull();
    expect(pickLatestStable([])).toBeNull();
  });
});

describe("parseSha256Sums", () => {
  it("`*` 付き（実物の形）", () => {
    expect(parseSha256Sums(`${SHA} *${EXE}\n`, EXE)).toBe(SHA);
  });
  it("空白 2 つ（GNU の既定）", () => {
    expect(parseSha256Sums(`${SHA}  ${EXE}\n`, EXE)).toBe(SHA);
  });
  it("CRLF と大文字を許し、小文字で返す", () => {
    expect(parseSha256Sums(`${SHA.toUpperCase()} *${EXE}\r\n`, EXE)).toBe(SHA);
  });
  it("複数行から名前の一致する行を選ぶ", () => {
    const other = "a".repeat(64);
    expect(parseSha256Sums(`${other} *other.exe\n${SHA} *${EXE}\n`, EXE)).toBe(SHA);
  });
  it("該当行が無い（名前の不一致）と失敗", () => {
    expect(() => parseSha256Sums(`${SHA} *other.exe\n`, EXE)).toThrow(Sha256ParseError);
    expect(() => parseSha256Sums("", EXE)).toThrow(Sha256ParseError);
  });
  it("形式不正（63 桁・16 進でない・区切りなし）は失敗", () => {
    expect(() => parseSha256Sums(`${SHA.slice(1)} *${EXE}`, EXE)).toThrow(Sha256ParseError);
    expect(() => parseSha256Sums(`${"g".repeat(64)} *${EXE}`, EXE)).toThrow(Sha256ParseError);
    expect(() => parseSha256Sums(`${SHA}*${EXE}`, EXE)).toThrow(Sha256ParseError);
    expect(() => parseSha256Sums(`${SHA}${EXE}`, EXE)).toThrow(Sha256ParseError);
  });
});

describe("extractNotesSha256", () => {
  it("SHA-256 行の値を小文字で返す", () => {
    expect(extractNotesSha256(`本文\n\nSHA-256: \`${SHA.toUpperCase()}\`\n`)).toBe(SHA);
  });
  it("行が無い・桁が違うなら null", () => {
    expect(extractNotesSha256("なし")).toBeNull();
    expect(extractNotesSha256("SHA-256: `abc`")).toBeNull();
  });
});

describe("isSigned（SITE-D-25・29）", () => {
  const unsigned = `> ${MARKER}。`;
  const signedBody = "署名つきです。";
  it("文言あり × signedSince 未設定・より前・以上 → すべて false", () => {
    expect(isSigned(unsigned, "1.0.6", null, MARKER)).toBe(false);
    expect(isSigned(unsigned, "1.0.6", "1.1.0", MARKER)).toBe(false);
    expect(isSigned(unsigned, "1.1.0", "1.1.0", MARKER)).toBe(false);
  });
  it("文言なし × signedSince 未設定 → false（迷ったら未署名）", () => {
    expect(isSigned(signedBody, "1.1.0", null, MARKER)).toBe(false);
  });
  it("文言なし × signedSince より前 → false", () => {
    expect(isSigned(signedBody, "1.0.6", "1.1.0", MARKER)).toBe(false);
  });
  it("文言なし × signedSince 以上 → true", () => {
    expect(isSigned(signedBody, "1.1.0", "1.1.0", MARKER)).toBe(true);
    expect(isSigned(signedBody, "1.2.0", "1.1.0", MARKER)).toBe(true);
  });
});

describe("buildReleaseData", () => {
  it("fixture から最新安定版と一覧を作る", async () => {
    const data = await buildReleaseData(loadRaw(), sumsOk);
    expect(data.latest.version).toBe("1.0.6");
    expect(data.latest.installer.sha256).toBe(SHA);
    expect(data.latest.installer.name).toBe(EXE);
    expect(data.latest.installer.size).toBe(123810973);
    expect(data.latest.checksums.name).toBe("SHA256SUMS.txt");
    expect(data.latest.signed).toBe(false); // 現行 config は signedSince: null
    expect(data.latest.bodyHtml).not.toContain("<script");
    // draft は除き、prerelease は含む。新しい順
    expect(data.releases.map((r) => r.tag)).toEqual(["v1.1.0-beta.1", "v1.0.6", "v1.0.5"]);
    expect(data.releases[0]!.prerelease).toBe(true);
  });
  it("100 件までに切る", async () => {
    const base = loadRaw();
    const many: GhRelease[] = [];
    for (let i = 0; i < 120; i++) {
      many.push({ ...clone(base[3]!), tag_name: `v0.0.${i}`, published_at: new Date(2020, 0, 1 + i).toISOString() });
    }
    many.push(clone(base[2]!));
    const data = await buildReleaseData(many, sumsOk);
    expect(data.releases).toHaveLength(100);
  });

  it("安定版 0 件", async () => {
    await expect(buildReleaseData(loadRaw().filter((r) => r.prerelease || r.draft), sumsOk)).rejects.toThrow(
      "公開済みの安定版がありません",
    );
  });
  it("exe が無い", async () => {
    const raw = loadRaw();
    raw[2]!.assets = raw[2]!.assets!.filter((a) => a.name !== EXE);
    await expect(buildReleaseData(raw, sumsOk)).rejects.toThrow(`v1.0.6 に ${EXE} がありません`);
  });
  it("SHA256SUMS.txt が無い", async () => {
    const raw = loadRaw();
    raw[2]!.assets = raw[2]!.assets!.filter((a) => a.name !== "SHA256SUMS.txt");
    await expect(buildReleaseData(raw, sumsOk)).rejects.toThrow("v1.0.6 に SHA256SUMS.txt がありません");
  });
  it("SHA256SUMS に exe の行が無い・形式不正", async () => {
    await expect(buildReleaseData(loadRaw(), async () => `${SHA} *other.exe\n`)).rejects.toThrow(
      "v1.0.6 の SHA-256 を読めません",
    );
    await expect(buildReleaseData(loadRaw(), async () => `zz *${EXE}\n`)).rejects.toThrow(
      "v1.0.6 の SHA-256 を読めません",
    );
  });

  describe("SITE-D-32", () => {
    it("exe の URL が接頭辞で始まらないと失敗", async () => {
      const raw = loadRaw();
      const bad = `https://example.com/releases/download/v1.0.6/${EXE}`;
      raw[2]!.assets!.find((a) => a.name === EXE)!.browser_download_url = bad;
      await expect(buildReleaseData(raw, sumsOk)).rejects.toThrow(`ダウンロード先が想定と違います（${bad}）`);
    });
    it("SHA256SUMS.txt の URL が別の版のものだと失敗", async () => {
      const raw = loadRaw();
      const bad = "https://github.com/itiwoja/DC-Designer/releases/download/v1.0.5/SHA256SUMS.txt";
      raw[2]!.assets!.find((a) => a.name === "SHA256SUMS.txt")!.browser_download_url = bad;
      await expect(buildReleaseData(raw, sumsOk)).rejects.toThrow(`ダウンロード先が想定と違います（${bad}）`);
    });
    it("接頭辞の似た別リポジトリも失敗", async () => {
      const raw = loadRaw();
      raw[2]!.assets!.find((a) => a.name === EXE)!.browser_download_url =
        "https://github.com/itiwoja/DC-Designer-evil/releases/download/v1.0.6/" + EXE;
      await expect(buildReleaseData(raw, sumsOk)).rejects.toThrow("ダウンロード先が想定と違います");
    });
    it("SHA256SUMS の値とリリースノートが違うと失敗", async () => {
      await expect(buildReleaseData(loadRaw(), async () => `${"0".repeat(64)} *${EXE}\n`)).rejects.toThrow(
        "SHA-256 がリリースノートと一致しません",
      );
    });
    it("リリースノートに SHA-256 行が無いと失敗", async () => {
      const raw = loadRaw();
      raw[2]!.body = "本文だけ";
      await expect(buildReleaseData(raw, sumsOk)).rejects.toThrow("SHA-256 がリリースノートと一致しません");
    });
  });
});

describe("fetchReleasesFromApi（SITE-API-001）", () => {
  const ok = () => new Response(JSON.stringify([{ tag_name: "v1" }]), { status: 200 });
  const noSleep = vi.fn(async (_ms: number) => {});
  beforeEach(() => noSleep.mockClear());

  it("ヘッダーを付ける（token があれば Bearer）", async () => {
    const f = vi.fn(async () => ok());
    await fetchReleasesFromApi({ fetchImpl: f as unknown as typeof fetch, token: "tok123", sleep: noSleep });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/itiwoja/DC-Designer/releases?per_page=100");
    expect(init.headers).toEqual({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: "Bearer tok123",
    });
  });
  it("token が無ければ Authorization を付けない", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const f = vi.fn(async () => ok());
    await fetchReleasesFromApi({ fetchImpl: f as unknown as typeof fetch, sleep: noSleep });
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).not.toHaveProperty("Authorization");
    vi.unstubAllEnvs();
  });
  it("5xx は 1・2・4 秒あけて再試行し、成功すれば返す", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 502 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(ok());
    const r = await fetchReleasesFromApi({ fetchImpl: f as unknown as typeof fetch, sleep: noSleep, token: "t" });
    expect(r).toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(4);
    expect(noSleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000]);
  });
  it("5xx が続くと 3 回再試行して失敗", async () => {
    const f = vi.fn(async () => new Response("", { status: 500 }));
    await expect(
      fetchReleasesFromApi({ fetchImpl: f as unknown as typeof fetch, sleep: noSleep, token: "t" }),
    ).rejects.toThrow("GitHub API の取得に失敗しました（HTTP 500）");
    expect(f).toHaveBeenCalledTimes(4);
  });
  it.each([403, 404, 429, 401])("%i は再試行せずすぐ失敗", async (status) => {
    const f = vi.fn(async () => new Response("", { status }));
    await expect(
      fetchReleasesFromApi({ fetchImpl: f as unknown as typeof fetch, sleep: noSleep, token: "t" }),
    ).rejects.toThrow(`GitHub API の取得に失敗しました（HTTP ${status}）`);
    expect(f).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });
  it("エラー文に token を含めない", async () => {
    const f = vi.fn(async () => new Response("", { status: 403 }));
    const err = await fetchReleasesFromApi({
      fetchImpl: f as unknown as typeof fetch,
      sleep: noSleep,
      token: "SECRET-TOKEN",
    }).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain("SECRET-TOKEN");
  });
});

describe("fetchSha256SumsText（SITE-API-002）", () => {
  it("認証ヘッダーを付けず、転送に従う", async () => {
    vi.stubEnv("GITHUB_TOKEN", "SECRET-TOKEN");
    const f = vi.fn(async () => new Response("abc", { status: 200 }));
    await expect(fetchSha256SumsText("https://github.com/x/SHA256SUMS.txt", f as unknown as typeof fetch)).resolves.toBe(
      "abc",
    );
    const init = (f.mock.calls as unknown as [string, RequestInit | undefined][])[0]![1];
    expect(init?.redirect).toBe("follow");
    expect(JSON.stringify(init ?? {})).not.toMatch(/authorization|SECRET-TOKEN/i);
    vi.unstubAllEnvs();
  });
  it("2xx 以外は失敗", async () => {
    const f = vi.fn(async () => new Response("", { status: 404 }));
    await expect(fetchSha256SumsText("https://github.com/x", f as unknown as typeof fetch)).rejects.toThrow("HTTP 404");
  });
});

describe("getReleaseData（SITE_RELEASES_FIXTURE）", () => {
  beforeEach(() => resetReleaseCache());
  afterEach(() => {
    vi.unstubAllEnvs();
    resetReleaseCache();
  });
  it("fixture と .sums フォルダから読み、メモ化する", async () => {
    vi.stubEnv("SITE_RELEASES_FIXTURE", FIXTURE);
    const a = await getReleaseData();
    expect(a.latest.version).toBe("1.0.6");
    expect(a.latest.installer.sha256).toBe(SHA);
    expect(await getReleaseData()).toBe(a);
  });
});
