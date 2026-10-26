/**
 * 通常終了の調停（EXE-FR-006）。保存準備 → worker の書込 drain → 正常終了の exit 確認 を順に行い、
 * 途中で失敗したら閉じずに分類を出して編集へ戻す。electron には依存せず、窓・ダイアログは deps で受け取る
 */
import type { PrepareCloseResult } from "./bridge";
import { STOP_TIMEOUT_MS } from "./protocol";
import type { Runtime } from "./runtime";

export const PREPARE_TIMEOUT_MS = 30_000;
const RETRY_WAIT_MS = 2_000;

export type CloseDeps = {
  runtime: Pick<Runtime, "snapshot" | "beginClosing" | "drain" | "resume" | "shutdown" | "waitWorkerExit" | "forceStop">;
  /** 窓へ保存準備を依頼する（送れなければ false） */
  sendPrepare: (requestId: string) => boolean;
  /** ボタンの添字を返す。先頭が初期ボタン（安全側） */
  choose: (o: { message: string; detail: string; buttons: string[] }) => Promise<number>;
  /** 窓を破棄して app を終了する */
  finalize: () => void;
  newId: () => string;
  sleep?: (ms: number) => Promise<void>;
  prepareTimeoutMs?: number;
};

type Outcome =
  | { kind: "done" }
  | { kind: "busy" }
  | { kind: "fail"; reason: string }
  | { kind: "lost" };

const BACK = "編集へ戻る";

export function createCloseCoordinator(deps: CloseDeps) {
  const { runtime, choose } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let running = false;
  let pending: { id: string; resolve: (r: PrepareCloseResult | null) => void } | null = null;

  /** 窓からの保存結果。要求 ID が違うものは古い応答として無視する */
  function complete(r: PrepareCloseResult): void {
    if (pending && r.requestId === pending.id) pending.resolve(r);
  }

  function waitPrepare(id: string): Promise<PrepareCloseResult | null> {
    return new Promise((resolve) => {
      const t = setTimeout(() => finish(null), deps.prepareTimeoutMs ?? PREPARE_TIMEOUT_MS);
      const finish = (r: PrepareCloseResult | null) => { clearTimeout(t); pending = null; resolve(r); };
      pending = { id, resolve: finish };
      if (!deps.sendPrepare(id)) finish(null);
    });
  }

  /** 保存後に worker が止まらないとき：待つ／停止して閉じる */
  async function waitStop(): Promise<boolean> {
    for (;;) {
      const i = await choose({
        message: "終了処理に時間がかかっています",
        detail: "保存は完了しています。内部処理の停止を待つか、停止して閉じるかを選んでください。",
        buttons: ["待つ", "停止して閉じる"],
      });
      if (i === 0) {
        if (await runtime.waitWorkerExit(STOP_TIMEOUT_MS)) return true;
        continue;
      }
      if (await runtime.forceStop()) return true;
      await choose({ message: "停止を確認できません", detail: "内部処理の停止を確認できないため、まだ閉じられません。", buttons: ["OK"] });
    }
  }

  async function attempt(id: string): Promise<Outcome> {
    const p = await waitPrepare(id);
    if (!p) return { kind: "fail", reason: "保存の準備が時間内に完了しませんでした。" };
    if (!p.allSaved) return { kind: "fail", reason: "保存できていない内容があります。" };
    if (p.busy) return { kind: "busy" };
    const d = await runtime.drain(id, STOP_TIMEOUT_MS);
    if (!d) {
      return runtime.snapshot().state === "failed"
        ? { kind: "lost" }
        : { kind: "fail", reason: "書き込みの完了を確認できませんでした。" };
    }
    if (d.busy) return { kind: "busy" };
    if (await runtime.shutdown(STOP_TIMEOUT_MS)) return { kind: "done" };
    return (await waitStop()) ? { kind: "done" } : { kind: "fail", reason: "内部処理の停止を確認できませんでした。" };
  }

  async function backToEdit(id: string): Promise<void> {
    await runtime.resume(id);
  }

  async function run(): Promise<void> {
    const state = runtime.snapshot().state;
    if (state === "closing") return;
    if (state !== "ready") {
      // 起動中は保存するものがない。停止して閉じる。failed は保存できない旨を確認する
      if (state === "failed") {
        const i = await choose({
          message: "編集内容を保存できません",
          detail: "内部処理が停止しているため、変更を保存できません。このまま閉じると、保存されていない変更は失われます。",
          buttons: [BACK, "保存せず閉じる"],
        });
        if (i !== 1) return;
      }
      await runtime.forceStop();
      deps.finalize();
      return;
    }
    runtime.beginClosing();
    for (;;) {
      const id = deps.newId();
      const r = await attempt(id);
      if (r.kind === "done") return deps.finalize();
      if (r.kind === "lost") {
        const i = await choose({
          message: "保存を完了できませんでした",
          detail: "内部処理が停止したため、保存を確認できません。このまま閉じると、保存されていない変更は失われます。",
          buttons: [BACK, "保存せず閉じる"],
        });
        if (i === 1) { await runtime.forceStop(); return deps.finalize(); }
        return;
      }
      if (r.kind === "busy") {
        const i = await choose({
          message: "処理が実行中です",
          detail: "生成や書き出しなどが終わるまで閉じられません。",
          buttons: [BACK, "処理の完了を待つ"],
        });
        if (i === 1) { await sleep(RETRY_WAIT_MS); continue; }
        return backToEdit(id);
      }
      await choose({ message: "閉じる操作を中止しました", detail: r.reason, buttons: [BACK] });
      return backToEdit(id);
    }
  }

  /** 窓の close から呼ぶ。実行中の再入は無視する */
  async function requestClose(): Promise<void> {
    if (running) return;
    running = true;
    try { await run(); } finally { running = false; }
  }

  return { requestClose, complete };
}
