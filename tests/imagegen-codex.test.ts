import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import type { AssetRequest } from "../src/schema";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

// 環境変数は server/imagegen.ts を読み込む前に設定する（GENERATED_DIR と CODEX_HOME は読み込み時に固定される）
const root = mkdtempSync(join(tmpdir(), "imagegen-codex-test-"));
const CODEX_HOME = join(root, "codex-home");
const GEN_DIR = join(CODEX_HOME, "generated_images");
process.env.GENERATED_DIR = join(root, "generated");
process.env.CODEX_HOME = CODEX_HOME;
process.env.IMAGE_PROVIDER = "codex";
// 実時間で小さい値。成功パスを誤ってタイムアウトさせないよう、タイムアウトは余裕を持たせる
process.env.CODEX_TIMEOUT_MS = "100";
process.env.CODEX_KILL_GRACE_MS = "30";
process.env.CODEX_DEADLINE_MS = "900000";

type ImagegenModule = typeof import("../server/imagegen");
let imagegen: ImagegenModule;
const spawnMock = vi.mocked(spawn);

// /mnt/c 上では読み込みに 10 秒を超えることがあるので、フックの時間は余裕を持たせる
beforeAll(async () => {
  imagegen = await import("../server/imagegen");
}, 60_000);
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---- 偽の子プロセス ----

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  pid: undefined;
  kill: ReturnType<typeof vi.fn>;
}

/** 子プロセスの振る舞い。run は spawn 直後に呼ばれ、onKill は kill() のたびに呼ばれる */
interface Script {
  run?: (child: FakeChild) => void;
  onKill?: (child: FakeChild, sig: string) => void;
}

/** 順番に使う振る舞いの待ち行列。尽きたら close しない子（hang）になる */
let scripts: Script[] = [];
/** spawn された子プロセス（spawn 順） */
let children: FakeChild[] = [];
/** spawn と kill の発生順（キューの直列化を確認するため） */
let events: string[] = [];

const later = (fn: () => void) => setTimeout(fn, 5);

/** close しない（タイムアウト / キャンセルでしか終わらない）子 */
const hang = (): Script => ({});

/** PNG を CODEX_HOME/generated_images に書いてから終了する子 */
let pngSeq = 0;
const writesPng = (opts: { code?: number; stdout?: string; stderr?: string; png?: boolean } = {}): Script => ({
  run: (child) => later(() => {
    if (opts.png) {
      mkdirSync(GEN_DIR, { recursive: true });
      writeFileSync(join(GEN_DIR, `img-${++pngSeq}.png`), Buffer.from("89504e470d0a1a0a", "hex"));
    }
    if (opts.stdout) child.stdout.write(opts.stdout);
    if (opts.stderr) child.stderr.write(opts.stderr);
    later(() => child.emit("close", opts.code ?? 0, null));
  }),
});

/** 成功して PNG を書く子（exit 0） */
const succeeds = (stdout = "done"): Script => writesPng({ png: true, stdout });

/** 指定の exit code と stderr で終わる子（PNG は書かない） */
const exitsWith = (code: number, stderr = "", stdout = ""): Script => writesPng({ code, stderr, stdout });

/** spawn が error を emit する子 */
const failsToSpawn = (err: Error): Script => ({ run: (child) => later(() => child.emit("error", err)) });

/** SIGTERM を受けたら終了する子（SIGKILL は不要になる） */
const exitsOnTerm: Script = {
  onKill: (child, sig) => {
    if (sig === "SIGTERM") later(() => child.emit("close", null, sig));
  },
};

function makeChild(script: Script): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  child.kill = vi.fn((sig: string = "SIGTERM") => {
    events.push(`kill:${sig}#${children.indexOf(child) + 1}`);
    script.onKill?.(child, sig);
    return true;
  });
  return child;
}

beforeEach(() => {
  scripts = [];
  children = [];
  events = [];
  spawnMock.mockReset();
  spawnMock.mockImplementation((() => {
    const next = scripts.shift() ?? hang();
    const child = makeChild(next);
    children.push(child);
    events.push(`spawn#${children.length}`);
    next.run?.(child);
    return child as unknown as ReturnType<typeof spawn>;
  }) as unknown as typeof spawn);
  rmSync(GEN_DIR, { recursive: true, force: true });
  process.env.CODEX_TIMEOUT_MS = "100";
  process.env.CODEX_KILL_GRACE_MS = "30";
  process.env.CODEX_DEADLINE_MS = "900000";
});

// ---- テスト用の補助 ----

let seq = 0;
/** キャッシュに当たらないよう、テストごとに違うプロンプトのアセットを作る */
const asset = (tag: string): AssetRequest => ({ prompt: `${tag} #${++seq}`, transparent: false, aspect: "square" });

/** 子プロセス 1 件分の振る舞いを予約する（spawn 順に消費される） */
const queue = (...s: Script[]) => { scripts.push(...s); };

const gen = (a: AssetRequest, signal?: AbortSignal) => imagegen.generateAsset(a, {}, "codex", signal);

// ---- テスト ----

describe("Codex 画像生成: タイムアウトと停止処理", () => {
  it("1. close が来ない子はタイムアウトで SIGTERM、猶予後に SIGKILL して timeout で確定する", async () => {
    queue(hang());
    const p = gen(asset("hang"));
    await expect(p).rejects.toMatchObject({ code: "timeout" });
    expect(children).toHaveLength(1);
    expect(children[0].kill.mock.calls.map(([sig]) => sig)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("1b. SIGTERM で close が来れば、その時点で timeout を返し SIGKILL は送らない", async () => {
    queue(exitsOnTerm);
    const p = gen(asset("term"));
    await expect(p).rejects.toMatchObject({ code: "timeout" });
    expect(children[0].kill.mock.calls.map(([sig]) => sig)).toEqual(["SIGTERM"]);
  });

  it("2. 1 件目が詰まっても、1 件目の確定後に 2 件目が spawn されて成功する", async () => {
    queue(hang(), succeeds("second ok"));
    const p1 = gen(asset("first"));
    const p2 = gen(asset("second"));
    await expect(p1).rejects.toMatchObject({ code: "timeout" });
    const r2 = await p2;
    expect(r2.src).toMatch(/\.png$/);
    expect(r2.provider).toBe("codex");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    // 2 件目の spawn は 1 件目の SIGKILL より後（直列化されている）
    expect(events.indexOf("spawn#2")).toBeGreaterThan(events.indexOf("kill:SIGKILL#1"));
  });
});

describe("Codex 画像生成: キャンセル", () => {
  it("3. キュー待ち中の abort は即 canceled で返り、先頭が終わっても 2 件目は spawn されない", async () => {
    queue(hang());
    const ac = new AbortController();
    const p1 = gen(asset("head"));
    const p2 = gen(asset("queued"), ac.signal);
    ac.abort();
    await expect(p2).rejects.toMatchObject({ code: "canceled" });
    await expect(p1).rejects.toMatchObject({ code: "timeout" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("4. 実行中の abort は子に SIGTERM を送り、canceled で返る", async () => {
    queue(hang());
    const ac = new AbortController();
    const p = gen(asset("running"), ac.signal);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "canceled" });
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("5. 既に abort 済みの signal では spawn されない", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(gen(asset("pre-aborted"), ac.signal)).rejects.toMatchObject({ code: "canceled" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("9. キュー待ちが CODEX_DEADLINE_MS を超えると deadline で返り、2 件目は spawn されない", async () => {
    queue(hang());
    // 1 件目は長い期限で作る（期限は呼び出し時に読まれる）
    const p1 = gen(asset("deadline-head"));
    process.env.CODEX_DEADLINE_MS = "60";
    const p2 = gen(asset("deadline-queued"));
    await expect(p2).rejects.toMatchObject({ code: "deadline" });
    await expect(p1).rejects.toMatchObject({ code: "timeout" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe("Codex 画像生成: 終了結果の分類", () => {
  it("6a. exit 0 で stdout に IMAGE_GEN_UNAVAILABLE があれば unavailable", async () => {
    queue(exitsWith(0, "", "IMAGE_GEN_UNAVAILABLE"));
    await expect(gen(asset("unavailable"))).rejects.toMatchObject({ code: "unavailable" });
  });

  it("6b. exit 0 で画像が無く IMAGE_GEN_UNAVAILABLE もなければ no_image（探索先と stdout を含む）", async () => {
    queue(exitsWith(0, "", "I could not draw it"));
    const err = await gen(asset("no-image")).catch((e) => e);
    expect(err).toMatchObject({ code: "no_image" });
    expect(String(err.message)).toContain("generated_images");
    expect(String(err.message)).toContain("I could not draw it");
  });

  it("7. exit 1 で stderr に Not logged in があれば auth", async () => {
    queue(exitsWith(1, "Not logged in"));
    const err = await gen(asset("auth")).catch((e) => e);
    expect(err).toMatchObject({ code: "auth" });
    expect(String(err.message)).toContain("codex login");
  });

  it("7b. exit 1 でそれ以外の stderr なら exit（stderr を含む）", async () => {
    queue(exitsWith(1, "something broke"));
    const err = await gen(asset("exit-code")).catch((e) => e);
    expect(err).toMatchObject({ code: "exit" });
    expect(String(err.message)).toContain("something broke");
  });

  it("8. spawn が error を emit したら spawn", async () => {
    queue(failsToSpawn(new Error("spawn codex ENOENT")));
    const err = await gen(asset("spawn-error")).catch((e) => e);
    expect(err).toMatchObject({ code: "spawn" });
    expect(String(err.message)).toContain("CODEX_BIN");
  });
});
