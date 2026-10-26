import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { acquireLease, leasePipePath } from "../server/lease";

const dir = mkdtempSync(join(tmpdir(), "dc-lease-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("acquireLease", () => {
  it("二重取得は waiting を1回呼んで timeout し、release 後は取れる", async () => {
    const pipe = join(dir, "a.sock");
    const first = await acquireLease(pipe, { timeoutMs: 1000 });
    expect(first.ok).toBe(true);
    const onWaiting = vi.fn();
    const second = await acquireLease(pipe, { timeoutMs: 600, onWaiting });
    expect(second).toEqual({ ok: false, reason: "timeout" });
    expect(onWaiting).toHaveBeenCalledTimes(1);
    if (first.ok) await first.release();
    const third = await acquireLease(pipe, { timeoutMs: 1000 });
    expect(third.ok).toBe(true);
    if (third.ok) await third.release();
  });

  it("待っている間に release されれば取れる", async () => {
    const pipe = join(dir, "b.sock");
    const first = await acquireLease(pipe, { timeoutMs: 1000 });
    const waiting = acquireLease(pipe, { timeoutMs: 3000 });
    setTimeout(() => { if (first.ok) void first.release(); }, 400);
    const second = await waiting;
    expect(second.ok).toBe(true);
    if (second.ok) await second.release();
  });

  it("作れない場所は denied", async () => {
    const r = await acquireLease(join(dir, "no", "such", "x.sock"), { timeoutMs: 500 });
    expect(r).toEqual({ ok: false, reason: "denied" });
  });
});

describe("leasePipePath", () => {
  it("userRoot と sid が同じなら同じ名前、違えば別の名前", () => {
    expect(leasePipePath("/a/b", "s1")).toBe(leasePipePath("/a/b/", "s1"));
    expect(leasePipePath("/a/b", "s1")).not.toBe(leasePipePath("/a/c", "s1"));
    expect(leasePipePath("/a/b", "s1")).not.toBe(leasePipePath("/a/b", "s2"));
  });
});
