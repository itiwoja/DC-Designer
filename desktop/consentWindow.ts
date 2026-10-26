/**
 * AI 送信確認窓（EXE-SCR-002）。編集窓とは別の BrowserWindow・別 preload・別 partition。
 * 承認は、この窓の webContents のメインフレームからの IPC だけを broker へ渡す
 */
import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type Session } from "electron";
import path from "node:path";
import type { AiConsentBroker, AiOutcome, ConsentView, ConsentWindowHandle } from "./aiConsent";

/** 永続しない partition（"persist:" を付けない）。main.ts で lockdownConsentSession を呼ぶ */
export const CONSENT_PARTITION = "dc-designer-consent";

/** script を禁止した最小 HTML。表示の DOM は consentPreload が組み立てる */
export const CONSENT_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>AI へ送信する内容の確認</title>
<style>
:root{color-scheme:light dark;font-family:"Yu Gothic UI","Meiryo",system-ui,sans-serif}
body{margin:0;padding:16px 20px 96px;line-height:1.6}
h1{font-size:1.25rem;margin:0 0 4px} h2{font-size:1rem;margin:16px 0 4px} h3{font-size:.9rem;margin:8px 0 2px}
dl{display:grid;grid-template-columns:7em 1fr;gap:2px 8px;margin:0} dt{font-weight:600} dd{margin:0;word-break:break-all}
pre{white-space:pre-wrap;word-break:break-word;max-height:16em;overflow:auto;border:1px solid #8886;border-radius:6px;padding:8px;margin:0}
figure{margin:8px 0} img{max-width:100%;max-height:260px;border:1px solid #8886;display:block}
figcaption{font-size:.8rem}
.bar{position:fixed;left:0;right:0;bottom:0;display:flex;gap:12px;justify-content:flex-end;padding:12px 20px;background:Canvas;border-top:1px solid #8886}
button{font:inherit;padding:8px 16px;border-radius:6px;border:1px solid #888;cursor:pointer} button:disabled{opacity:.5;cursor:default}
button:focus-visible{outline:3px solid #2a6df4;outline-offset:2px}
.primary{background:#1f5fd6;color:#fff;border-color:#1f5fd6}.secondary{background:ButtonFace;color:ButtonText}
.status,.remain{margin:8px 0 0}
</style></head><body><main id="root"><p>読み込み中…</p></main></body></html>`;

export const CONSENT_CHANNELS = { getView: "consent:get-view", decide: "consent:decide", close: "consent:close", outcome: "consent:outcome" } as const;

/** 確認窓の partition を締める。許可するのは画像プレビューの data: だけ（外部読込・権限要求は拒否） */
export function lockdownConsentSession(ses: Session): void {
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith("data:") }));
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
}

export type ConsentWindowHostDeps = {
  appRoot: string;
  /** 編集窓（あれば確認窓を子のモーダルにする） */
  getParent: () => BrowserWindow | null;
  broker: () => AiConsentBroker;
};

/** openWindow（broker に注入）と IPC 登録。registerIpc は起動時に1回だけ呼ぶ */
export function createConsentWindowHost(deps: ConsentWindowHostDeps) {
  const views = new Map<number, ConsentView>(); // webContents.id → 表示内容

  /** 確認窓のメインフレームからの IPC だけ通す */
  const fromConsentMainFrame = (e: IpcMainEvent | IpcMainInvokeEvent): ConsentView | null => {
    const v = views.get(e.sender.id);
    if (!v || e.senderFrame !== e.sender.mainFrame) return null;
    return v;
  };

  function openWindow(view: ConsentView): ConsentWindowHandle {
    const parent = deps.getParent();
    const win = new BrowserWindow({
      width: 760, height: 720, minWidth: 520, minHeight: 480, show: false, autoHideMenuBar: true,
      title: "AI へ送信する内容の確認", minimizable: false, maximizable: false,
      ...(parent && !parent.isDestroyed() ? { parent, modal: true } : {}),
      webPreferences: {
        partition: CONSENT_PARTITION,
        preload: path.join(deps.appRoot, "build", "desktop", "consentPreload.cjs"),
        sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false,
      },
    });
    const wc = win.webContents;
    const id = wc.id;
    views.set(id, view);
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("will-navigate", (e) => e.preventDefault());
    wc.on("will-redirect", (e) => e.preventDefault());
    wc.on("before-input-event", (e, input) => {
      if (input.type === "keyDown" && input.key === "Escape") { e.preventDefault(); deps.broker().windowClosed(view.requestId); }
    });
    // 閉じる＝拒否（承認済みなら何も起きない）
    win.on("closed", () => { views.delete(id); deps.broker().windowClosed(view.requestId); });
    win.once("ready-to-show", () => { win.show(); win.focus(); });
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(CONSENT_HTML)}`);
    return {
      senderId: id,
      close: () => { if (!win.isDestroyed()) win.close(); },
      showOutcome: (o: "sending" | AiOutcome) => { if (!win.isDestroyed()) wc.send(CONSENT_CHANNELS.outcome, o); },
    };
  }

  function registerIpc(): void {
    ipcMain.handle(CONSENT_CHANNELS.getView, (e) => fromConsentMainFrame(e));
    ipcMain.on(CONSENT_CHANNELS.decide, (e, msg: unknown) => {
      if (!fromConsentMainFrame(e) || !msg || typeof msg !== "object") return;
      const m = msg as Record<string, unknown>;
      deps.broker().decide(e.sender.id, { requestId: m.requestId, payloadHash: m.payloadHash, decision: m.decision });
    });
    ipcMain.on(CONSENT_CHANNELS.close, (e) => {
      if (fromConsentMainFrame(e)) BrowserWindow.fromWebContents(e.sender)?.close();
    });
  }

  return { openWindow, registerIpc };
}
