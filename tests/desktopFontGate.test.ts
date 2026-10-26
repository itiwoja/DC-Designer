import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopResult } from "../desktop/bridge";
import { consentDialogOptions, createFontGate, type FontFace, installDialogOptions, INSTALL_WINDOW_MS } from "../desktop/fontGate";
import { DESKTOP_OPERATIONS, matchDesktopOperation, resolveDesktopRequest } from "../desktop/operations";
import { FONT_BY_FAMILY, installWeights } from "../src/fonts";

const sha = (n: number) => String(n).repeat(64).slice(0, 64);
let dir: string;
let consentFile: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "fontgate-")); consentFile = path.join(dir, "fonts", "consent.json"); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function setup(over: { consent?: boolean; install?: boolean; acquire?: (body: any) => DesktopResult } = {}) {
  const calls: { path: string; body: any }[] = [];
  let t = 1000;
  const request = vi.fn(async (_op, p: string, body: any): Promise<DesktopResult> => {
    calls.push({ path: p, body });
    if (p === "/api/fonts/acquire") {
      return over.acquire?.(body) ?? { ok: true, data: { faces: body.faces.map((f: any, i: number) => ({ ...f, sha256: sha(i + 1), byteLength: 1, fromCache: false })), failed: [] } };
    }
    return { ok: true, data: { p } };
  });
  const confirmConsent = vi.fn(async () => over.consent ?? true);
  const confirmInstall = vi.fn(async (_faces: FontFace[]) => over.install ?? true);
  const gate = createFontGate({ consentFile, request, confirmConsent, confirmInstall, now: () => t });
  const advance = (ms: number) => { t += ms; };
  return { gate, calls, request, confirmConsent, confirmInstall, advance };
}

const resolve = (operation: string, body: unknown) => {
  const r = resolveDesktopRequest({ operation, body });
  if (!r) throw new Error("resolve");
  return r;
};

describe("fonts.files / fonts.embed", () => {
  const body = { faces: [{ family: "Noto Sans JP", weight: 400 }] };
  it("未許可なら確認を出し、許可で中継して consent.json を作る", async () => {
    const s = setup();
    expect(s.gate.hasConsent()).toBe(false);
    const res = await s.gate.handle("fonts.files", resolve("fonts.files", body));
    expect(res).toEqual({ ok: true, data: { p: "/api/fonts/files" } });
    expect(s.confirmConsent).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(consentFile, "utf8"))).toEqual({ version: 1, grantedAt: 1000 });
    await s.gate.handle("fonts.embed", resolve("fonts.embed", { fonts: [{ family: "Noto Sans JP", bold: false }] }));
    expect(s.confirmConsent).toHaveBeenCalledTimes(1);
    expect(s.calls.map((c) => c.path)).toEqual(["/api/fonts/files", "/api/fonts/embed"]);
  });
  it("同時に2要求が来ても確認は1回", async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.gate.handle("fonts.files", resolve("fonts.files", body)), s.gate.handle("fonts.files", resolve("fonts.files", body))]);
    expect(a.ok && b.ok).toBe(true);
    expect(s.confirmConsent).toHaveBeenCalledTimes(1);
    expect(s.request).toHaveBeenCalledTimes(2);
  });
  it("拒否では中継せず保存もしない。次回また聞く", async () => {
    const s = setup({ consent: false });
    const res = await s.gate.handle("fonts.files", resolve("fonts.files", body));
    expect(res).toMatchObject({ ok: false, code: "FONT_CONSENT_DENIED" });
    expect(s.request).not.toHaveBeenCalled();
    expect(fs.existsSync(consentFile)).toBe(false);
    await s.gate.handle("fonts.files", resolve("fonts.files", body));
    expect(s.confirmConsent).toHaveBeenCalledTimes(2);
  });
  it("revoke で consent.json が消え、再確認する。壊れたファイルは未許可", async () => {
    const s = setup();
    await s.gate.handle("fonts.files", resolve("fonts.files", body));
    s.gate.revokeConsent();
    expect(s.gate.hasConsent()).toBe(false);
    await s.gate.handle("fonts.files", resolve("fonts.files", body));
    expect(s.confirmConsent).toHaveBeenCalledTimes(2);
    fs.writeFileSync(consentFile, "{broken");
    expect(s.gate.hasConsent()).toBe(false);
    s.gate.revokeConsent();
  });
  it("handles は対象の操作だけ", () => {
    const g = setup().gate;
    expect(["fonts.files", "fonts.embed", "fonts.install"].every(g.handles)).toBe(true);
    expect(g.handles("fonts.status")).toBe(false);
  });
});

describe("fonts.install", () => {
  const families = ["Noto Sans JP", "Zen Maru Gothic"];
  const faces = () => families.flatMap((family) => installWeights(FONT_BY_FAMILY.get(family)!).map((weight) => ({ family, weight })));

  it("acquire → confirmInstall → install(expect) の順", async () => {
    const s = setup();
    const res = await s.gate.handle("fonts.install", resolve("fonts.install", { families }));
    expect(res.ok).toBe(true);
    expect(s.calls.map((c) => c.path)).toEqual(["/api/fonts/acquire", "/api/fonts/install"]);
    expect(s.calls[0].body.faces).toEqual(faces());
    expect(s.confirmInstall).toHaveBeenCalledTimes(1);
    const sent = s.calls[1].body;
    expect(sent.families).toEqual(families);
    expect(sent.expect).toEqual(s.confirmInstall.mock.calls[0][0]);
    expect(sent.expect.every((e: any) => /^[0-9a-f]{64}$/.test(e.sha256))).toBe(true);
  });
  it("拒否なら install を呼ばず declined を返す", async () => {
    const s = setup({ install: false });
    const res = await s.gate.handle("fonts.install", resolve("fonts.install", { families }));
    expect(res).toEqual({ ok: true, data: { target: "windows", installed: [], already: [], osInstallState: "declined" } });
    expect(s.calls.map((c) => c.path)).toEqual(["/api/fonts/acquire"]);
  });
  it("acquire の failed で止まる（確認も出さない）", async () => {
    const s = setup({ acquire: () => ({ ok: true, data: { faces: [], failed: [{ family: "Noto Sans JP", weight: 400, code: "X" }] } }) });
    const res = await s.gate.handle("fonts.install", resolve("fonts.install", { families }));
    expect(res.ok).toBe(false);
    expect(s.confirmInstall).not.toHaveBeenCalled();
    expect(s.calls).toHaveLength(1);
  });
  it("acquire の応答に face が足りなければ止まる", async () => {
    const s = setup({ acquire: () => ({ ok: true, data: { faces: [{ family: "Noto Sans JP", weight: 400, sha256: sha(1) }], failed: [] } }) });
    expect((await s.gate.handle("fonts.install", resolve("fonts.install", { families }))).ok).toBe(false);
    expect(s.confirmInstall).not.toHaveBeenCalled();
  });
  it("未許可で拒否なら acquire もしない", async () => {
    const s = setup({ consent: false });
    expect(await s.gate.handle("fonts.install", resolve("fonts.install", { families }))).toMatchObject({ code: "FONT_CONSENT_DENIED" });
    expect(s.request).not.toHaveBeenCalled();
  });
  it("renderer が expect 等を渡すと拒否する", async () => {
    const s = setup();
    const res = await s.gate.handle("fonts.install", resolve("fonts.install", { families, expect: [{ family: "Noto Sans JP", weight: 400, sha256: sha(9) }] }));
    expect(res).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    expect(s.request).not.toHaveBeenCalled();
  });
  it("カタログ外・形の不正・多すぎる families は INVALID_ARGUMENT", async () => {
    const s = setup();
    for (const body of [{ families: ["Comic Evil"] }, { families: [] }, { families: "Noto Sans JP" }, { families: [1] }, { families: ["Noto Sans JP", "Noto Sans JP"] }, {}, { families: Array(17).fill("Noto Sans JP") }]) {
      expect(await s.gate.handle("fonts.install", resolve("fonts.install", body))).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    }
    expect(s.request).not.toHaveBeenCalled();
  });
  it("確認から5分を過ぎたら install を送らない", async () => {
    const s = setup();
    s.confirmInstall.mockImplementation(async () => { s.advance(INSTALL_WINDOW_MS + 1); return true; });
    expect(await s.gate.handle("fonts.install", resolve("fonts.install", { families }))).toMatchObject({ code: "FONT_CONFIRM_EXPIRED" });
    expect(s.calls.map((c) => c.path)).toEqual(["/api/fonts/acquire"]);
  });
});

describe("操作表とダイアログ", () => {
  it("開発版の画面の要求が fonts.* に対応付く。fonts.acquire は表に無い", () => {
    expect(matchDesktopOperation("POST", "/api/fonts/install")).toMatchObject({ operation: "fonts.install" });
    expect(matchDesktopOperation("POST", "/api/fonts/files")).toMatchObject({ operation: "fonts.files" });
    expect(matchDesktopOperation("POST", "/api/fonts/embed")).toMatchObject({ operation: "fonts.embed" });
    expect(matchDesktopOperation("POST", "/api/fonts/acquire")).toBeNull();
    expect(Object.keys(DESKTOP_OPERATIONS)).not.toContain("fonts.acquire");
    expect(DESKTOP_OPERATIONS["fonts.install"].maxBody).toBe(64 * 1024);
  });
  it("ダイアログの既定・Esc は拒否側", () => {
    for (const o of [consentDialogOptions(), installDialogOptions([{ family: "Noto Sans JP", weight: 400, sha256: sha(1) }])]) {
      expect(o).toMatchObject({ defaultId: 0, cancelId: 0, noLink: true });
    }
    expect(installDialogOptions([{ family: "Noto Sans JP", weight: 700, sha256: sha(1) }]).detail).toContain("Noto Sans JP（700）");
  });
});
