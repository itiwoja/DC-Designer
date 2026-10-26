/**
 * API worker（utilityProcess）の起動・監視と、画面からの要求の中継（EXE-FR-002）。
 * electron の値は import しない（fork は main から渡す）ので vitest で確かめられる
 */
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import type { DesktopProgress, DesktopResult, RuntimeError, RuntimeSnapshot, RuntimeState } from "./bridge";
import type { DesktopOperation } from "./operations";
import type { AiConsentDecision, AiOutcome } from "./aiConsent";
import { secretRefOf, type SecretStore } from "./secrets";
import {
  API_PROTOCOL_VERSION, DESKTOP_ORIGIN, DESKTOP_TOKEN_HEADER, LEASE_TIMEOUT_MS, STARTUP_TIMEOUT_MS,
  WORKER_ENV_ALLOWLIST, type DesktopHealth, type MainToWorker, type SecretState, type WorkerToMain,
} from "./protocol";

// ---- 状態遷移（純粋関数） ----

export type RuntimeModel = { state: RuntimeState; error?: RuntimeError };
export type RuntimeEvent =
  | { type: "start" }
  | { type: "lease-waiting" }
  | { type: "ready" }
  | { type: "fail"; error: RuntimeError }
  | { type: "closing" }
  | { type: "resume" };

export const initialRuntimeModel: RuntimeModel = { state: "starting" };

export function reduceRuntime(m: RuntimeModel, e: RuntimeEvent): RuntimeModel {
  const s = m.state;
  switch (e.type) {
    case "start": return s === "failed" ? { state: "starting" } : m;
    case "lease-waiting": return s === "starting" ? { state: "waiting-lease" } : m;
    case "ready": return s === "starting" || s === "waiting-lease" ? { state: "ready" } : m;
    // 最初の失敗を残す（failed の上書き・古い通知で変えない）
    case "fail": return s === "failed" ? m : { state: "failed", error: e.error };
    case "closing": return s === "ready" ? { state: "closing" } : m;
    case "resume": return s === "closing" ? { state: "ready" } : m;
  }
}

// ---- worker に渡す環境変数 ----

/** 許可リストの値＋保存先。開発者の API キー・NODE_OPTIONS 等は渡さない */
export function buildWorkerEnv(userRoot: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of WORKER_ENV_ALLOWLIST) {
    const v = env[k] ?? env[k.toUpperCase()];
    if (typeof v === "string") out[k] = v;
  }
  out.DATA_DIR = path.join(userRoot, "workspace");
  out.GENERATED_DIR = path.join(userRoot, "assets", "generated");
  out.DC_DESIGNER_CONFIG_DIR = path.join(userRoot, "secrets");
  out.FONT_CACHE_DIR = path.join(userRoot, "fonts", "cache");
  out.DC_DESIGNER_DESKTOP = "1";
  out.DC_DESIGNER_USER_ROOT = userRoot;
  return out;
}

// ---- NDJSON（stream の操作） ----

/** progress・error 行の上限。result 行は op.maxBody の2倍まで（要求と同程度の画像・JSON を返しうるため。base64 化の余裕を見る） */
const STREAM_SMALL_LINE_MAX = 64 * 1024;
/** 全体の上限＝result 行の上限＋progress 行の余裕（進み具合は小さい行が数百本程度） */
const STREAM_EXTRA_MAX = 4 * 1024 * 1024;

const ABORTED: DesktopResult = { ok: false, error: "中断しました", code: "ABORTED" };
const CUT_OFF: DesktopResult = { ok: false, error: "応答が途中で切れました", code: "WORKER_LOST" };
const BAD_STREAM: DesktopResult = { ok: false, error: "応答の形式が正しくありません", code: "WORKER_LOST" };

/** worker の Progress を検証して、決まった項目だけ残す。形が違えば null */
function sanitizeProgress(v: unknown): DesktopProgress | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.phase !== "thinking" && o.phase !== "writing") return null;
  if (typeof o.attempt !== "number" || !Number.isInteger(o.attempt)) return null;
  return {
    phase: o.phase,
    attempt: o.attempt,
    ...(typeof o.chars === "number" && Number.isFinite(o.chars) ? { chars: o.chars } : {}),
    ...(typeof o.items === "number" && Number.isFinite(o.items) ? { items: o.items } : {}),
  };
}

/** NDJSON の本文を逐次読み、result / error で終わる。途中の progress は onProgress へ */
async function readNdjson(
  body: ReadableStream<Uint8Array>, resultMax: number, signal: AbortSignal | undefined, onProgress: ((p: DesktopProgress) => void) | undefined,
): Promise<DesktopResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let total = 0;
  const finish = async (r: DesktopResult): Promise<DesktopResult> => { await reader.cancel().catch(() => {}); return r; };
  const handle = (text: string): DesktopResult | null => {
    let msg: unknown;
    try { msg = JSON.parse(text); } catch { return BAD_STREAM; }
    if (!msg || typeof msg !== "object") return BAD_STREAM;
    const o = msg as Record<string, unknown>;
    if ("result" in o) return { ok: true, data: o.result };
    if (text.length > STREAM_SMALL_LINE_MAX) return BAD_STREAM;
    if (o.progress !== undefined) {
      const p = sanitizeProgress(o.progress);
      if (p) onProgress?.(p);
      return null;
    }
    if (o.error !== undefined) {
      return {
        ok: false,
        error: typeof o.error === "string" ? o.error.slice(0, 500) : "要求に失敗しました",
        ...(typeof o.code === "string" ? { code: o.code } : {}),
        ...(typeof o.status === "number" ? { status: o.status } : {}),
      };
    }
    return null;
  };
  for (;;) {
    if (signal?.aborted) return finish(ABORTED);
    const { value, done } = await reader.read();
    if (signal?.aborted) return finish(ABORTED);
    if (value) {
      total += value.byteLength;
      if (total > resultMax + STREAM_EXTRA_MAX) return finish(BAD_STREAM);
      buf += decoder.decode(value, { stream: true });
    }
    if (done) buf += decoder.decode();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0 || (done && buf.length > 0)) {
      const end = nl >= 0 ? nl : buf.length;
      const text = buf.slice(0, end).trim();
      buf = buf.slice(end + 1);
      if (!text) continue;
      const r = handle(text);
      if (r) return finish(r);
    }
    if (buf.length > resultMax) return finish(BAD_STREAM);
    if (done) return CUT_OFF;
  }
}

// ---- 実行 ----

export interface WorkerChild {
  postMessage(m: MainToWorker): void;
  on(event: "message", cb: (m: unknown) => void): unknown;
  on(event: "exit", cb: (code: number) => void): unknown;
  kill(): boolean;
}

export type RuntimeDeps = {
  fork: () => WorkerChild;
  appVersion: string;
  onState: (s: RuntimeSnapshot) => void;
  fetchImpl?: typeof fetch;
  /** 資格情報ストア（main が持つ）。worker の secret-* 要求に応える */
  secrets?: SecretStore;
  /** AI 送信確認（main の broker）。payload は検証前の値なので broker 側で verifyAiPayload する。無ければ invalid を返す */
  onAiConsent?: (requestId: string, payload: unknown) => Promise<AiConsentDecision>;
  onAiOutcome?: (requestId: string, outcome: AiOutcome) => void;
  /** worker が終了した（保留中の依頼を破棄する） */
  onAiWorkerLost?: () => void;
};

type Instance = {
  child: WorkerChild;
  token: string;
  instanceId: string;
  port?: number;
  exited: boolean;
  expectExit: boolean;
  timer?: ReturnType<typeof setTimeout>;
  exitWaiters: (() => void)[];
  waiters: Set<{ pred: (m: WorkerToMain) => boolean; resolve: (m: WorkerToMain | null) => void }>;
};

const HEALTH_TIMEOUT_MS = 5_000;
const KILL_WAIT_MS = 10_000;
const RESUME_TIMEOUT_MS = 10_000;

export type Runtime = ReturnType<typeof createRuntime>;

export function createRuntime(deps: RuntimeDeps) {
  const doFetch = deps.fetchImpl ?? fetch;
  let model: RuntimeModel = initialRuntimeModel;
  let cur: Instance | null = null;
  let retrying = false;

  const snapshot = (): RuntimeSnapshot => ({
    state: model.state, appVersion: deps.appVersion, ...(model.error ? { error: model.error } : {}),
  });

  function dispatch(e: RuntimeEvent): void {
    const next = reduceRuntime(model, e);
    if (next === model) return;
    model = next;
    deps.onState(snapshot());
  }

  const alive = (i: Instance | null): i is Instance => !!i && !i.exited;

  function settle(inst: Instance): void {
    if (inst.timer) clearTimeout(inst.timer);
    inst.timer = undefined;
  }

  function fail(inst: Instance, error: RuntimeError): void {
    if (inst !== cur) return;
    settle(inst);
    dispatch({ type: "fail", error });
    if (!inst.exited) inst.child.kill();
  }

  function onExit(inst: Instance): void {
    inst.exited = true;
    settle(inst);
    for (const w of inst.exitWaiters.splice(0)) w();
    for (const w of [...inst.waiters]) w.resolve(null);
    inst.waiters.clear();
    if (inst === cur) deps.onAiWorkerLost?.();
    if (inst === cur && !inst.expectExit) dispatch({ type: "fail", error: "WORKER_LOST" });
  }

  function waitExit(inst: Instance, ms: number): Promise<boolean> {
    if (inst.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      inst.exitWaiters.push(() => { clearTimeout(t); resolve(true); });
    });
  }

  /** 条件に合う worker からの通知を待つ。期限切れ・exit なら null */
  function waitMessage(inst: Instance, pred: (m: WorkerToMain) => boolean, ms: number): Promise<WorkerToMain | null> {
    if (inst.exited) return Promise.resolve(null);
    return new Promise((resolve) => {
      const w = {
        pred,
        resolve: (m: WorkerToMain | null) => { clearTimeout(t); inst.waiters.delete(w); resolve(m); },
      };
      const t = setTimeout(() => w.resolve(null), ms);
      inst.waiters.add(w);
    });
  }

  async function verifyReady(inst: Instance, msg: Extract<WorkerToMain, { type: "ready" }>): Promise<void> {
    const portOk = Number.isInteger(msg.port) && msg.port > 0 && msg.port < 65536;
    if (!portOk || msg.instanceId !== inst.instanceId) return fail(inst, "STARTUP_FAILED");
    if (msg.apiProtocolVersion !== API_PROTOCOL_VERSION || msg.appVersion !== deps.appVersion) return fail(inst, "VERSION_MISMATCH");
    try {
      const res = await doFetch(`http://127.0.0.1:${msg.port}/api/desktop/health`, {
        headers: { [DESKTOP_TOKEN_HEADER]: inst.token, origin: DESKTOP_ORIGIN },
        redirect: "error",
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (!res.ok) return fail(inst, "STARTUP_FAILED");
      const h = (await res.json()) as Partial<DesktopHealth>;
      if (h.instanceId !== inst.instanceId || h.ready !== true) return fail(inst, "STARTUP_FAILED");
      if (h.apiProtocolVersion !== API_PROTOCOL_VERSION || h.appVersion !== deps.appVersion) return fail(inst, "VERSION_MISMATCH");
    } catch {
      return fail(inst, "STARTUP_FAILED");
    }
    // 検証中に失敗・停止していたら ready へ戻さない
    if (inst !== cur || inst.exited || (model.state !== "starting" && model.state !== "waiting-lease")) return;
    inst.port = msg.port;
    settle(inst);
    dispatch({ type: "ready" });
  }

  /** worker の資格情報要求に答える。形が不正なら何もしない */
  function onSecretMessage(inst: Instance, m: Record<string, unknown>): void {
    const { requestId, providerId, kind } = m;
    if (!deps.secrets || typeof requestId !== "string" || !requestId || requestId.length > 100) return;
    if (typeof providerId !== "string" || typeof kind !== "string") return;
    // worker が書き換えてよいのはサインインで更新される ChatGPT の資格情報だけ（API キーは画面の設定からだけ）
    if (m.type !== "secret-get" && !(providerId === "chatgpt" && kind === "oauth")) return;
    let r;
    if (m.type === "secret-get") r = deps.secrets.get(providerId, kind);
    else if (m.type === "secret-set") {
      if (typeof m.value !== "string") return;
      r = deps.secrets.set(providerId, kind, m.value);
    } else r = deps.secrets.remove(secretRefOf(providerId, kind));
    if (inst.exited) return;
    inst.child.postMessage({
      type: "secret-result", requestId, ok: r.ok, state: r.state,
      ...(m.type === "secret-get" && r.value !== undefined ? { value: r.value } : {}),
      ...(r.code ? { code: r.code } : {}),
    });
  }

  /** worker の AI 送信確認依頼。決定は確認窓で本人が出したものだけ。形が不正・未配線なら invalid */
  async function onAiConsentMessage(inst: Instance, m: Record<string, unknown>): Promise<void> {
    const { requestId } = m;
    if (typeof requestId !== "string" || !requestId || requestId.length > 100) return;
    let decision: AiConsentDecision = { decision: "invalid" };
    if (deps.onAiConsent) {
      try { decision = await deps.onAiConsent(requestId, m.payload); } catch { decision = { decision: "invalid" }; }
    }
    // 返事を待つ間に worker が替わった・落ちたなら届けない
    if (inst.exited || inst !== cur) return;
    inst.child.postMessage({
      type: "ai-consent-result", requestId, decision: decision.decision,
      ...(decision.decision === "approve" && decision.payloadHash ? { payloadHash: decision.payloadHash } : {}),
    });
  }

  /** 画面側の設定で状態が変わったことを worker の状態キャッシュへ伝える（値は送らない） */
  function notifySecretChanged(secretRef: string, state: Extract<MainToWorker, { type: "secret-changed" }>["state"]): void {
    if (alive(cur)) cur.child.postMessage({ type: "secret-changed", secretRef, state });
  }

  function onMessage(inst: Instance, raw: unknown): void {
    if (inst !== cur || !raw || typeof raw !== "object" || typeof (raw as { type?: unknown }).type !== "string") return;
    const type = (raw as { type: string }).type;
    if (type === "secret-get" || type === "secret-set" || type === "secret-remove") return onSecretMessage(inst, raw as Record<string, unknown>);
    if (type === "ai-consent") return void onAiConsentMessage(inst, raw as Record<string, unknown>);
    if (type === "ai-outcome") {
      const { requestId, outcome } = raw as Record<string, unknown>;
      if (typeof requestId === "string" && (outcome === "completed" || outcome === "failed" || outcome === "outcomeUnknown")) deps.onAiOutcome?.(requestId, outcome);
      return;
    }
    const msg = raw as WorkerToMain;
    for (const w of [...inst.waiters]) if (w.pred(msg)) w.resolve(msg);
    if (model.state !== "starting" && model.state !== "waiting-lease") return;
    switch (msg.type) {
      case "lease-waiting":
        dispatch({ type: "lease-waiting" });
        // 待機中は worker 側の lease 期限に任せ、main は少し余裕を持った保険の期限だけ置く
        settle(inst);
        inst.timer = setTimeout(() => fail(inst, "LEASE_TIMEOUT"), LEASE_TIMEOUT_MS + 5_000);
        break;
      case "lease-failed":
        fail(inst, msg.reason === "timeout" ? "LEASE_TIMEOUT" : "LEASE_DENIED");
        break;
      case "fatal":
        fail(inst, "STARTUP_FAILED");
        break;
      case "ready":
        void verifyReady(inst, msg);
        break;
    }
  }

  const secretStates = (): Record<string, SecretState> =>
    Object.fromEntries((deps.secrets?.status() ?? []).map((e) => [e.secretRef, e.state]));

  function start(): void {
    if (alive(cur)) return;
    dispatch({ type: "start" });
    const token = randomBytes(32).toString("hex");
    const instanceId = randomUUID();
    let child: WorkerChild;
    try {
      child = deps.fork();
    } catch {
      model = { state: "failed", error: "STARTUP_FAILED" };
      deps.onState(snapshot());
      return;
    }
    const inst: Instance = { child, token, instanceId, exited: false, expectExit: false, exitWaiters: [], waiters: new Set() };
    cur = inst;
    child.on("message", (m) => onMessage(inst, m));
    child.on("exit", () => onExit(inst));
    inst.timer = setTimeout(() => fail(inst, "STARTUP_FAILED"), STARTUP_TIMEOUT_MS);
    child.postMessage({ type: "init", token, instanceId, appVersion: deps.appVersion, secretStates: secretStates() });
  }

  /** 前の worker の exit を確認できたときだけ新しい個体を起動する */
  async function retryStart(): Promise<RuntimeSnapshot> {
    if (model.state !== "failed" || retrying) return snapshot();
    retrying = true;
    try {
      const prev = cur;
      if (alive(prev)) {
        prev.expectExit = true;
        prev.child.kill();
        if (!(await waitExit(prev, KILL_WAIT_MS))) return snapshot();
      }
      start();
    } finally {
      retrying = false;
    }
    return snapshot();
  }

  async function request(
    op: DesktopOperation, p: string, body: unknown,
    opts: { signal?: AbortSignal; onProgress?: (p: DesktopProgress) => void } = {},
  ): Promise<DesktopResult> {
    const { signal, onProgress } = opts;
    if (signal?.aborted) return ABORTED;
    const inst = cur;
    if (model.state !== "ready" || !alive(inst) || !inst.port) return { ok: false, error: "APIの準備ができていません", code: "INVALID_STATE" };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined && (op.maxBody === undefined || Buffer.byteLength(payload) > op.maxBody)) {
      return { ok: false, error: "要求が大きすぎます", code: "INVALID_ARGUMENT" };
    }
    try {
      const res = await doFetch(`http://127.0.0.1:${inst.port}${p}`, {
        method: op.method,
        headers: { "content-type": "application/json", [DESKTOP_TOKEN_HEADER]: inst.token, origin: DESKTOP_ORIGIN },
        body: payload,
        redirect: "error",
        signal,
      });
      if (op.stream && res.ok && res.body) return await readNdjson(res.body, (op.maxBody ?? 0) * 2, signal, onProgress);
      const text = await res.text();
      let json: unknown = null;
      if (text) { try { json = JSON.parse(text); } catch { json = text; } }
      if (res.ok) return { ok: true, data: json };
      const o = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
      return {
        ok: false,
        error: typeof o.error === "string" ? o.error.slice(0, 500) : "要求に失敗しました",
        ...(typeof o.code === "string" ? { code: o.code } : {}),
        status: res.status,
      };
    } catch {
      if (signal?.aborted) return ABORTED;
      return { ok: false, error: "APIへ接続できませんでした", code: "WORKER_LOST" };
    }
  }

  // ---- 終了の調停から使う ----

  /** 受付を止める（状態を closing にする）。ready でなければ false */
  function beginClosing(): boolean {
    dispatch({ type: "closing" });
    return model.state === "closing";
  }

  async function drain(requestId: string, ms: number): Promise<{ busy: boolean } | null> {
    const inst = cur;
    if (!alive(inst)) return null;
    const wait = waitMessage(inst, (m) => m.type === "drained" && m.requestId === requestId, ms);
    inst.child.postMessage({ type: "drain", requestId });
    const r = await wait;
    return r && r.type === "drained" ? { busy: r.busy } : null;
  }

  /** drain を取り消して ready に戻す。worker が応えなければ failed にする */
  async function resume(requestId: string): Promise<boolean> {
    const inst = cur;
    if (!alive(inst)) return false;
    const wait = waitMessage(inst, (m) => m.type === "resumed" && m.requestId === requestId, RESUME_TIMEOUT_MS);
    inst.child.postMessage({ type: "resume", requestId });
    if (!(await wait)) {
      fail(inst, "WORKER_LOST");
      return false;
    }
    dispatch({ type: "resume" });
    return true;
  }

  /** 正常終了を要求して exit を待つ */
  function shutdown(ms: number): Promise<boolean> {
    const inst = cur;
    if (!inst) return Promise.resolve(true);
    inst.expectExit = true;
    if (!inst.exited) inst.child.postMessage({ type: "shutdown" });
    return waitExit(inst, ms);
  }

  /** 引き続き exit を待つ（shutdown 後に時間切れで「待つ」を選んだとき） */
  function waitWorkerExit(ms: number): Promise<boolean> {
    return cur ? waitExit(cur, ms) : Promise.resolve(true);
  }

  /** 強制停止して exit を確認する */
  function forceStop(ms = KILL_WAIT_MS): Promise<boolean> {
    const inst = cur;
    if (!inst) return Promise.resolve(true);
    inst.expectExit = true;
    settle(inst);
    if (!inst.exited) inst.child.kill();
    return waitExit(inst, ms);
  }

  return {
    start, retryStart, request, snapshot, notifySecretChanged, beginClosing, drain, resume, shutdown, waitWorkerExit, forceStop,
    hasLiveWorker: () => alive(cur),
  };
}
