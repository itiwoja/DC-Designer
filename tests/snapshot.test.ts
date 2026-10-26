import { describe, expect, it, vi } from "vitest";
import { createSnapshotStore } from "../src/render/snapshot";
import type { PosterSpec } from "../src/schema";

const spec = (n: number) => ({ meta: { width: 100, height: 100, title: `s${n}` }, layers: [] }) as unknown as PosterSpec;

function setup(opts?: { concurrency?: number; idleMax?: number }) {
  const resolvers: (() => void)[] = [];
  let active = 0, maxActive = 0, urls = 0;
  const make = vi.fn(() => {
    active++; maxActive = Math.max(maxActive, active);
    return new Promise<Blob>((res) => resolvers.push(() => { active--; res(new Blob(["x"])); }));
  });
  const revokeUrl = vi.fn();
  const store = createSnapshotStore({ make, createUrl: () => `blob:${++urls}`, revokeUrl }, opts);
  const flush = async () => { while (resolvers.length) { resolvers.shift()!(); await new Promise((r) => setTimeout(r, 0)); } };
  return { store, make, revokeUrl, flush, maxActive: () => maxActive };
}

describe("snapshot store", () => {
  it("同じ内容の spec は 1 回だけ作る", async () => {
    const t = setup();
    const a = t.store.acquire(spec(1)), b = t.store.acquire(JSON.parse(JSON.stringify(spec(1))));
    await t.flush();
    expect(await a.promise).toBe(await b.promise);
    expect(t.make).toHaveBeenCalledTimes(1);
  });

  it("同時に作る数は concurrency まで", async () => {
    const t = setup({ concurrency: 2 });
    const hs = [1, 2, 3, 4, 5].map((n) => t.store.acquire(spec(n)));
    await t.flush();
    await Promise.all(hs.map((h) => h.promise));
    expect(t.maxActive()).toBe(2);
    expect(t.make).toHaveBeenCalledTimes(5);
  });

  it("始まる前に返された仕事は作らない", async () => {
    const t = setup({ concurrency: 1 });
    const a = t.store.acquire(spec(1)), b = t.store.acquire(spec(2));
    b.promise.catch(() => {});
    b.release();
    await t.flush();
    await a.promise;
    expect(t.make).toHaveBeenCalledTimes(1);
  });

  it("誰も借りていない結果は idleMax を超えた分から revoke する", async () => {
    const t = setup({ idleMax: 1 });
    const a = t.store.acquire(spec(1)), b = t.store.acquire(spec(2));
    await t.flush();
    const ua = await a.promise;
    await b.promise;
    a.release();
    expect(t.revokeUrl).not.toHaveBeenCalled();
    b.release();
    expect(t.revokeUrl).toHaveBeenCalledWith(ua);
    expect(t.store.size()).toBe(1);
  });

  it("返した後でも idle の間は使い回せる", async () => {
    const t = setup();
    const a = t.store.acquire(spec(1));
    await t.flush();
    const u = await a.promise;
    a.release();
    const b = t.store.acquire(spec(1));
    expect(await b.promise).toBe(u);
    expect(t.make).toHaveBeenCalledTimes(1);
  });

  it("失敗した結果は残さず、次は作り直す", async () => {
    const t = setup();
    t.make.mockImplementationOnce(() => Promise.reject(new Error("x")));
    const a = t.store.acquire(spec(1));
    await expect(a.promise).rejects.toThrow();
    const b = t.store.acquire(spec(1));
    await t.flush();
    await b.promise;
    expect(t.make).toHaveBeenCalledTimes(2);
  });
});
