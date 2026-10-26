import { useEffect, useRef, useState } from "react";
import { api, AUTH_CHANNEL, AUTH_STARTED_EVENT, type Status } from "./api";
import { modeEditorUrl, readModeParam } from "./mode";
import { DESKTOP_ACCOUNT_CHANGED } from "./accountView";
import { EDITOR_URL } from "./nav";
import { readPref, writePref } from "./storage";
import type { Notice } from "./Toasts";

const WELCOMED_KEY = "dc-designer:chatgpt-welcomed:";
const WATCH_INTERVAL = 1500;
const WATCH_TIMEOUT = 10 * 60_000;

/**
 * サインイン用タブを開いたら、サインインが済むまでサーバーの状態を見張る。
 * 別タブからの結果（BroadcastChannel）が届かないとき（別のブラウザで開いた、タブが閉じられなかった、など）も、
 * 元のタブを更新しなくても画面が進むようにする。結果が届いたら見張りをやめる
 */
export function useSignInWatch(onSignedIn: (st: Status) => void) {
  const cb = useRef(onSignedIn);
  cb.current = onSignedIn;
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let until = 0;
    let before: string | undefined;
    const stop = () => { clearInterval(timer); timer = undefined; };
    const tick = async () => {
      if (Date.now() > until) return stop();
      const st = await api.status().catch(() => null);
      if (!st || !timer) return;
      const key = JSON.stringify(st.chatgpt);
      if (before === undefined) { before = key; return; }
      if (key !== before && st.chatgpt.signedIn) { stop(); cb.current(st); }
    };
    const start = () => {
      stop();
      before = undefined;
      until = Date.now() + WATCH_TIMEOUT;
      timer = setInterval(tick, WATCH_INTERVAL);
      tick();
    };
    const ch = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(AUTH_CHANNEL) : null;
    ch?.addEventListener("message", stop);
    window.addEventListener(AUTH_STARTED_EVENT, start);
    return () => { stop(); ch?.close(); window.removeEventListener(AUTH_STARTED_EVENT, start); };
  }, []);
}

/**
 * Sign in with ChatGPT の結果の受け取り・初回の案内・サインアウト。
 * 結果は ?chatgpt=... / ?chatgpt_error=... で戻ってくる。
 * 別タブ（?popup=1）で戻ってきたら結果を元のタブへ渡して閉じる。閉じられなかったときはこのタブで処理する
 */
export function useChatGPTAuth({ status, setStatus, refreshStatus, notify }: {
  status: Status | null;
  setStatus: (s: Status) => void;
  refreshStatus: () => void;
  notify: (n: Omit<Notice, "id">) => void;
}) {
  const [welcome, setWelcome] = useState(false);
  const gpt = status?.chatgpt;
  // 別タブからの結果と状態の見張りの両方で同じサインインを知らせないように、最後に知らせた状態を覚えておく
  const announced = useRef<string>(undefined);

  const announce = (st: Status) => {
    setStatus(st);
    const key = JSON.stringify(st.chatgpt);
    if (announced.current === key) return;
    announced.current = key;
    if (!st.chatgpt.signedIn) return;
    if (!st.chatgpt.planEnabled) { notify({ kind: "info", text: "サインインしました。ただしこのアカウントでは ChatGPT プランを他のアプリで使えないため、AI 機能は使えません" }); return; }
    // 「ChatGPT プランを使用中」の案内は初回サインイン時だけ出す
    if (!readPref(WELCOMED_KEY + st.chatgpt.subject)) setWelcome(true);
    else notify({ kind: "success", text: "ChatGPT でサインインしました" });
  };
  // 成否だけを見て、中身（プランを使えるか）はサーバーの状態から判断する
  const handleAuthResult = (error: string | null) => {
    if (error) { notify({ kind: "error", text: `ChatGPT でサインインできませんでした: ${error}` }); return; }
    api.status().then(announce).catch(() => {});
  };
  useSignInWatch(announce);
  useEffect(() => {
    const ch = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(AUTH_CHANNEL) : null;
    ch?.addEventListener("message", (e: MessageEvent<{ result: string | null; error: string | null }>) => handleAuthResult(e.data.error));
    const q = new URLSearchParams(location.search);
    const result = q.get("chatgpt"), error = q.get("chatgpt_error");
    if (result || error) {
      const mode = readModeParam();
      history.replaceState(null, "", mode ? modeEditorUrl(mode) : EDITOR_URL);
      if (q.get("popup") === "1" && ch) {
        ch.postMessage({ result, error });
        window.close();
        setTimeout(() => handleAuthResult(error), 300);
      } else handleAuthResult(error);
    }
    return () => ch?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 製品版：画面内のサインイン操作が終わったら状態を取り直す
  useEffect(() => {
    const onChanged = () => { api.status().then(setStatus).catch(() => {}); };
    window.addEventListener(DESKTOP_ACCOUNT_CHANGED, onChanged);
    return () => window.removeEventListener(DESKTOP_ACCOUNT_CHANGED, onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeWelcome = () => {
    if (gpt?.signedIn) writePref(WELCOMED_KEY + gpt.subject, "1");
    setWelcome(false);
  };
  const signOut = async () => {
    announced.current = undefined;
    try { await api.chatgptLogout(); notify({ kind: "info", text: "ChatGPT からサインアウトしました" }); }
    catch (e: any) { notify({ kind: "error", text: e?.message ?? String(e) }); }
    refreshStatus();
  };

  return { welcome, closeWelcome, signOut };
}
