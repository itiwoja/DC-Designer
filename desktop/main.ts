/**
 * Windows 版 Electron の main（段階1）。
 * 固定 origin の app://dc-designer で同梱の画面を出し、API は utilityProcess の worker に任せる。
 * 外部通信はこのセッションで止める
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, safeStorage, session, shell, utilityProcess,
  type IpcMainInvokeEvent, type MenuItemConstructorOptions,
} from "electron";
import {
  APP_ORIGIN_URL, APP_SCHEME, buildCsp, inlineScriptHashes, isAllowedRequestUrl, isAppUrl,
  isExternalHttpsUrl, resolveAppTarget, targetFilePath,
} from "./appProtocol";
import { IPC, type DesktopResult, type PrepareCloseResult } from "./bridge";
import { createCloseCoordinator } from "./close";
import { resolveDesktopRequest } from "./operations";
import { USER_ROOT_DIRS } from "./protocol";
import { buildWorkerEnv, createRuntime, type WorkerChild } from "./runtime";
import { createSecretStore, type SecretResult } from "./secrets";

const PARTITION = "persist:dc-designer";

// ---- ready 前の準備 ----

const localAppData = process.env.LOCALAPPDATA || path.join(app.getPath("home"), "AppData", "Local");
const userRoot = path.join(localAppData, "DC-Designer");
for (const d of USER_ROOT_DIRS) mkdirSync(path.join(userRoot, d), { recursive: true });
mkdirSync(path.join(userRoot, "assets", "generated"), { recursive: true });

app.setAppUserModelId("io.github.itiwoja.dcdesigner");
app.setPath("userData", path.join(userRoot, "browser"));
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let editorWindow: BrowserWindow | null = null;
let closeApproved = false;

const appRoot = app.getAppPath();
const roots = {
  dist: path.join(appRoot, "dist"),
  pdfAssets: path.join(appRoot, "build", "pdf-assets"),
  generated: path.join(userRoot, "assets", "generated"),
};

const sendToEditor = (channel: string, payload: unknown): boolean => {
  const w = editorWindow;
  if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return false;
  w.webContents.send(channel, payload);
  return true;
};

// 資格情報は main だけが持つ（safeStorage の呼び出しは app ready 後に初めて行われる）
const secrets = createSecretStore({ dir: path.join(userRoot, "secrets"), crypto: safeStorage });

const runtime = createRuntime({
  secrets,
  appVersion: app.getVersion(),
  onState: (s) => { sendToEditor(IPC.stateChanged, s); },
  fork: () =>
    // worker.mjs は asar の外（app.asar.unpacked）に置いている（electron-builder.yml の asarUnpack）
    utilityProcess.fork(path.join(appRoot, "build", "desktop", "worker.mjs").replace(/app\.asar(?=[\\/])/, "app.asar.unpacked"), [], {
      serviceName: "DC-Designer API",
      env: buildWorkerEnv(userRoot, process.env),
      stdio: "ignore",
    }) as unknown as WorkerChild,
});

// ---- app:// の配信 ----

const baseHeaders = (type: string, csp: string): Record<string, string> => ({
  "content-type": type,
  "content-security-policy": csp,
  "x-content-type-options": "nosniff",
});

async function handleApp(request: Request): Promise<Response> {
  const csp = buildCsp();
  const notFound = () => new Response("Not Found", { status: 404, headers: baseHeaders("text/plain; charset=utf-8", csp) });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: baseHeaders("text/plain; charset=utf-8", csp) });
  }
  const target = resolveAppTarget(request.url);
  const file = target && targetFilePath(target, roots);
  if (!target || !file) return notFound();
  try {
    if (!(await stat(file)).isFile()) return notFound();
  } catch {
    return notFound();
  }
  const fileUrl = pathToFileURL(file).toString();
  // index.html は inline script（テーマ決定）のハッシュだけ CSP に足す
  if (target.kind === "dist" && target.segments.length === 1 && target.segments[0] === "index.html") {
    const res = await net.fetch(fileUrl, { bypassCustomProtocolHandlers: true });
    const html = await res.text();
    return new Response(html, { status: 200, headers: baseHeaders(target.type, buildCsp(inlineScriptHashes(html))) });
  }
  const range = request.headers.get("range");
  const res = await net.fetch(fileUrl, { bypassCustomProtocolHandlers: true, ...(range ? { headers: { range } } : {}) });
  const headers = baseHeaders(target.type, csp);
  for (const k of ["content-length", "content-range", "accept-ranges"]) {
    const v = res.headers.get(k);
    if (v) headers[k] = v;
  }
  return new Response(res.body, { status: res.status, headers });
}

// ---- IPC ----

/** 登録済みの編集窓のメインフレーム（app://dc-designer）からの呼び出しだけを通す */
function isTrusted(e: IpcMainInvokeEvent): boolean {
  const w = editorWindow;
  if (!w || w.isDestroyed() || e.sender !== w.webContents) return false;
  const f = e.senderFrame;
  return !!f && f === e.sender.mainFrame && isAppUrl(f.url);
}

const failResult = (code: string, error: string): DesktopResult => ({ ok: false, error, code });

/** 画面へ返す資格情報の結果（値は含めない）。変わった状態は worker のキャッシュへも伝える */
function secretResult(r: SecretResult): DesktopResult {
  if (!r.ok) return failResult(r.code ?? "INTERNAL", "資格情報を保存できませんでした");
  if (r.secretRef) runtime.notifySecretChanged(r.secretRef, r.state);
  return { ok: true, data: { secretRef: r.secretRef, state: r.state } };
}

function registerIpc(): void {
  ipcMain.handle(IPC.request, async (e, req: unknown): Promise<DesktopResult> => {
    if (!isTrusted(e)) return failResult("UNAUTHORIZED_CONTEXT", "この画面からは実行できません");
    const r = resolveDesktopRequest(req);
    if (!r) return failResult("INVALID_ARGUMENT", "要求の形式が正しくありません");
    return runtime.request(r.op, r.path, r.body);
  });
  ipcMain.handle(IPC.getState, (e) => {
    if (!isTrusted(e)) throw new Error("UNAUTHORIZED_CONTEXT");
    return runtime.snapshot();
  });
  ipcMain.handle(IPC.retryStart, (e) => {
    if (!isTrusted(e)) throw new Error("UNAUTHORIZED_CONTEXT");
    return runtime.retryStart();
  });
  // 資格情報：値は返さない（状態だけ）。引数の検証はストアが行う
  ipcMain.handle(IPC.secretsStatus, (e): DesktopResult => {
    if (!isTrusted(e)) return failResult("UNAUTHORIZED_CONTEXT", "この画面からは実行できません");
    return { ok: true, data: secrets.status() };
  });
  ipcMain.handle(IPC.secretsSet, (e, providerId: unknown, kind: unknown, value: unknown): DesktopResult => {
    if (!isTrusted(e)) return failResult("UNAUTHORIZED_CONTEXT", "この画面からは実行できません");
    return secretResult(secrets.set(providerId, kind, value));
  });
  ipcMain.handle(IPC.secretsRemove, (e, secretRef: unknown): DesktopResult => {
    if (!isTrusted(e)) return failResult("UNAUTHORIZED_CONTEXT", "この画面からは実行できません");
    return secretResult(secrets.remove(secretRef));
  });
  ipcMain.handle(IPC.completeClose, (e, r: unknown) => {
    if (!isTrusted(e) || !r || typeof r !== "object") return;
    const { requestId, allSaved, busy } = r as Partial<PrepareCloseResult>;
    if (typeof requestId !== "string" || typeof allSaved !== "boolean" || typeof busy !== "boolean") return;
    closer.complete({ requestId, allSaved, busy });
  });
}

// ---- 終了の調停 ----

const closer = createCloseCoordinator({
  runtime,
  newId: randomUUID,
  sendPrepare: (requestId) => sendToEditor(IPC.prepareClose, { requestId }),
  choose: async ({ message, detail, buttons }) => {
    const opts = { type: "warning" as const, title: "DC-Designer", message, detail, buttons, defaultId: 0, cancelId: 0, noLink: true };
    const w = editorWindow;
    const r = w && !w.isDestroyed() ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
    return r.response;
  },
  finalize: () => {
    closeApproved = true;
    if (editorWindow && !editorWindow.isDestroyed()) editorWindow.destroy();
    app.quit();
  },
});

// ---- 窓 ----

function buildMenu(): void {
  const edit: MenuItemConstructorOptions = {
    label: "編集",
    submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }],
  };
  const menu: MenuItemConstructorOptions[] = [edit];
  if (!app.isPackaged) menu.push({ label: "開発", submenu: [{ role: "toggleDevTools" }, { role: "reload" }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 640, show: false, autoHideMenuBar: true,
    title: "DC-Designer",
    webPreferences: {
      partition: PARTITION,
      preload: path.join(appRoot, "build", "desktop", "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.on("close", (e) => {
    if (closeApproved) return;
    e.preventDefault();
    void closer.requestClose();
  });
  win.on("closed", () => { if (editorWindow === win) editorWindow = null; });
  return win;
}

/** 全 webContents に共通の遷移制限 */
function hardenContents(): void {
  app.on("web-contents-created", (_e, contents) => {
    contents.on("will-attach-webview", (e) => e.preventDefault());
    if (contents.getType() !== "window") return;
    contents.setWindowOpenHandler(({ url }) => {
      if (isExternalHttpsUrl(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    const guard = (e: { preventDefault(): void }, url: string) => { if (!isAppUrl(url)) e.preventDefault(); };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
  });
}

function lockdownSession(): Electron.Session {
  const ses = session.fromPartition(PARTITION);
  ses.protocol.handle(APP_SCHEME, handleApp);
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !isAllowedRequestUrl(details.url) }));
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  return ses;
}

// ---- 起動 ----

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  hardenContents();
  app.on("second-instance", () => {
    const w = editorWindow;
    if (!w || w.isDestroyed()) return;
    if (w.isMinimized()) w.restore();
    w.focus();
  });
  app.on("before-quit", (e) => {
    if (closeApproved || !editorWindow || editorWindow.isDestroyed()) return;
    e.preventDefault();
    editorWindow.close();
  });
  app.on("will-quit", () => { if (runtime.hasLiveWorker()) void runtime.forceStop(); });
  app.on("window-all-closed", () => app.quit());

  void app.whenReady().then(() => {
    lockdownSession();
    registerIpc();
    buildMenu();
    runtime.start();
    editorWindow = createWindow();
    void editorWindow.loadURL(APP_ORIGIN_URL).catch(() => {});
  });
}

