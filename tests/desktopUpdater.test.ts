import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateSnapshot } from "../desktop/bridge";
import { CHECK_LOCK_MAX_MS, CHECK_TIMEOUT_MS, createUpdateManager, MANUAL_CHECK_INTERVAL_MS, NOTES_MAX_CHARS, notesToText, type UpdaterLike } from "../desktop/updater";

afterEach(() => { vi.useRealTimers(); });

type Progress = { transferred: number; total: number; percent: number };

function setup(opts: { check?: UpdaterLike["checkForUpdates"]; download?: UpdaterLike["downloadUpdate"]; restart?: () => Promise<void> } = {}) {
  let onProgress: (p: Progress) => void = () => {};
  let t = 1_000_000;
  const states: UpdateSnapshot[] = [];
  const updater: UpdaterLike = {
    checkForUpdates: opts.check ?? vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.3", releaseNotes: "<p>修正</p>" } })),
    downloadUpdate: opts.download ?? vi.fn(async () => []),
    on: (_e, cb) => { onProgress = cb; },
  };
  const restartToInstall = vi.fn(opts.restart ?? (async () => {}));
  const m = createUpdateManager({ updater, currentVersion: "1.0.2", onState: (s) => states.push(s), restartToInstall, now: () => t });
  return { m, updater, states, restartToInstall, progress: (p: Progress) => onProgress(p), advance: (ms: number) => { t += ms; } };
}

describe("更新の確認", () => {
  it("新しい正式版があれば available にして案内を出す", async () => {
    const { m } = setup();
    const s = await m.check({ manual: false });
    expect(s).toMatchObject({ state: "available", latestVersion: "1.0.3", releaseNotes: "修正", prompt: { kind: "available" } });
    expect(s.checkedAt).toBeTruthy();
  });

  it("自動確認では最新版・確認失敗を案内しない。手動確認では結果を案内する", async () => {
    const latest = setup({ check: async () => ({ isUpdateAvailable: false, updateInfo: { version: "1.0.2" } }) });
    expect((await latest.m.check({ manual: false })).prompt).toBeUndefined();
    expect(latest.m.snapshot().state).toBe("upToDate");
    expect((await latest.m.check({ manual: true })).prompt?.kind).toBe("upToDate");

    const offline = setup({ check: async () => { throw new Error("net::ERR_INTERNET_DISCONNECTED"); } });
    const s = await offline.m.check({ manual: false });
    expect(s.state).toBe("error");
    expect(s.prompt).toBeUndefined();
    expect(s.error?.stage).toBe("check");
    expect((await offline.m.check({ manual: true })).prompt?.kind).toBe("error");
  });

  it("確認が期限を過ぎたら error。遅れて届いた結果で状態を上書きしない", async () => {
    vi.useFakeTimers();
    let resolve!: (v: Awaited<ReturnType<UpdaterLike["checkForUpdates"]>>) => void;
    const { m } = setup({ check: () => new Promise((r) => { resolve = r; }) });
    const p = m.check({ manual: false });
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    expect((await p).state).toBe("error");
    resolve({ isUpdateAvailable: true, updateInfo: { version: "1.0.3" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(m.snapshot().state).toBe("error");
    expect(m.snapshot().prompt).toBeUndefined();
  });

  it("期限切れの問い合わせが返るまでは次の確認を重ねず、返らなければ上限後に受け付ける", async () => {
    vi.useFakeTimers();
    const check = vi.fn(() => new Promise<null>(() => {}));
    const { m, advance } = setup({ check });
    const p = m.check({ manual: false });
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    await p;
    advance(MANUAL_CHECK_INTERVAL_MS);
    void m.check({ manual: true });
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_LOCK_MAX_MS);
    void m.check({ manual: true });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("手動確認を30秒以内に繰り返しても通信せず、今の結果を案内する", async () => {
    const check = vi.fn(async () => ({ isUpdateAvailable: false, updateInfo: { version: "1.0.2" } }));
    const { m, advance } = setup({ check });
    await m.check({ manual: true });
    await m.check({ manual: true });
    expect(check).toHaveBeenCalledTimes(1);
    expect(m.snapshot().prompt?.kind).toBe("upToDate");
    advance(MANUAL_CHECK_INTERVAL_MS);
    await m.check({ manual: true });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("確認中の再確認は重ねない", async () => {
    let resolve!: () => void;
    const check = vi.fn(() => new Promise<null>((r) => { resolve = () => r(null); }));
    const { m } = setup({ check });
    const p = m.check({ manual: false });
    await m.check({ manual: true });
    expect(check).toHaveBeenCalledTimes(1);
    resolve();
    await p;
  });
});

describe("案内への答え", () => {
  it("今の案内の ID と一致するときだけ閉じる", async () => {
    const { m } = setup();
    const id = (await m.check({ manual: false })).prompt!.id;
    expect(m.respond("stale", "later").prompt?.id).toBe(id);
    expect(m.respond(id, "install-now").prompt?.id).toBe(id);
    expect(m.respond(id, "later").prompt).toBeUndefined();
    // 保留しても状態は残り、手動確認で案内し直せる
    expect(m.snapshot().state).toBe("available");
  });
});

describe("取得と適用", () => {
  it("案内した版だけ取得する。進み具合は4回/秒まで", async () => {
    let finish!: () => void;
    const download = vi.fn(() => new Promise<unknown>((r) => { finish = () => r([]); }));
    const { m, progress, states, advance } = setup({ download });
    await m.check({ manual: false });
    expect((await m.download("9.9.9")).state).toBe("available");
    expect(download).not.toHaveBeenCalled();

    const p = m.download("1.0.3");
    expect(m.snapshot()).toMatchObject({ state: "downloading", prompt: { kind: "progress" } });
    const before = states.length;
    progress({ transferred: 1, total: 100, percent: 1 });
    progress({ transferred: 2, total: 100, percent: 2 });
    expect(states.length - before).toBe(1);
    advance(300);
    progress({ transferred: 50, total: 100, percent: 50 });
    expect(m.snapshot().progress?.percent).toBe(50);
    finish();
    expect(await p).toMatchObject({ state: "downloaded", prompt: { kind: "downloaded" } });
  });

  it("取得に失敗したら available に戻し、再試行できる案内を出す", async () => {
    const download = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce([]);
    const { m } = setup({ download });
    await m.check({ manual: false });
    expect(await m.download("1.0.3")).toMatchObject({ state: "available", error: { stage: "download" }, prompt: { kind: "error" } });
    expect((await m.download("1.0.3")).state).toBe("downloaded");
  });

  it("取得前・別の版では再起動しない", async () => {
    const { m, restartToInstall } = setup();
    await m.check({ manual: false });
    await m.install("1.0.3");
    await m.download("1.0.3");
    await m.install("1.0.4");
    expect(restartToInstall).not.toHaveBeenCalled();
  });

  it("保存できず再起動を中止したら downloaded に戻す", async () => {
    const { m, restartToInstall } = setup();
    await m.check({ manual: false });
    await m.download("1.0.3");
    const s = await m.install("1.0.3");
    expect(restartToInstall).toHaveBeenCalledTimes(1);
    expect(s.state).toBe("downloaded");
    expect(s.prompt).toBeUndefined();
  });

  it("再起動の準備中は案内を閉じられない", async () => {
    let release!: () => void;
    const { m } = setup({ restart: () => new Promise<void>((r) => { release = r; }) });
    await m.check({ manual: false });
    await m.download("1.0.3");
    const p = m.install("1.0.3");
    const id = m.snapshot().prompt!.id;
    expect(m.snapshot().prompt?.kind).toBe("restarting");
    expect(m.respond(id, "later").prompt?.id).toBe(id);
    release();
    await p;
  });

  it("取得中・取得済みで手動確認すると、その案内を出し直す", async () => {
    const { m } = setup();
    await m.check({ manual: false });
    await m.download("1.0.3");
    m.respond(m.snapshot().prompt!.id, "later");
    expect((await m.check({ manual: true })).prompt?.kind).toBe("downloaded");
  });
});

describe("notesToText", () => {
  it("HTML をプレーンテキストにし、2,000 文字で切る", () => {
    expect(notesToText("<h2>主な変更</h2><ul><li>A &amp; B</li><li><a href=\"x\">C</a></li></ul><script>alert(1)</script>")).toBe("主な変更\n・A & B\n・C\nalert(1)");
    expect(notesToText([{ version: "1.0.3", note: "<p>x</p>" }])).toBe("x");
    expect(notesToText(null)).toBeUndefined();
    const long = notesToText("あ".repeat(NOTES_MAX_CHARS + 10))!;
    expect(long.length).toBe(NOTES_MAX_CHARS + 1);
  });
});
