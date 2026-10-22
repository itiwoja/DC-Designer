/**
 * 旧名（poster-gen:）で保存したブラウザの控え・設定を新しいキーへ引き継ぐ。
 * 新しいキーが既にあれば上書きしない。旧キーは退避として残す。
 * どのモジュールより先に評価されるよう、ここ（storage.ts の先頭）で実行する。
 */
const LEGACY_PREFIX = "poster-gen:";
const PREFIX = "dc-designer:";
try {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(LEGACY_PREFIX)) continue;
    const next = PREFIX + key.slice(LEGACY_PREFIX.length);
    if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key)!);
  }
} catch { /* 使えない環境では引き継がない */ }

/** 編集中のポスター（ブラウザ側の控え）。サーバーの成果物とは CURRENT_ID_KEY で結び付く */
export const STORAGE_KEY = "dc-designer:spec";
/** 編集中のポスターの成果物 ID（data/posters/<id>.json） */
export const CURRENT_ID_KEY = "dc-designer:current-id";

/** ブラウザの控えが CURRENT_ID_KEY の成果物へ保存済みなら "1"。無ければ未送信かもしれないので、開いたときにサーバーへ送り直す */
export const SYNCED_KEY = "dc-designer:spec-synced";
/** 新規作成中の成果物（{ token, id? }）。同じ作成操作を複数タブ・HMR の古いインスタンスで二重登録しないための目印 */
export const CREATING_KEY = "dc-designer:creating";

export const readCurrentId = () => { try { return localStorage.getItem(CURRENT_ID_KEY); } catch { return null; } };
export const writeCurrentId = (id: string | null) => {
  try { if (id) localStorage.setItem(CURRENT_ID_KEY, id); else localStorage.removeItem(CURRENT_ID_KEY); } catch { /* 無視 */ }
};

export const writeSynced = (synced: boolean) => {
  try { if (synced) localStorage.setItem(SYNCED_KEY, "1"); else localStorage.removeItem(SYNCED_KEY); } catch { /* 無視 */ }
};
export const readSynced = () => { try { return localStorage.getItem(SYNCED_KEY) === "1"; } catch { return false; } };

/** 設定などの読み書き（localStorage が使えない環境でも落ちない） */
export const readPref = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
export const writePref = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* 無視 */ } };

/**
 * ブラウザの控えに入れられなかったとき、エディタへ渡す「この成果物をサーバーから読み込んで開く」印（?open=<ID>）。
 * 読み込めるまでは控えの内容を信用せず、保存もしない
 */
export const readOpenRequest = (): string | null => {
  try { const id = new URLSearchParams(location.search).get("open"); return id && /^[\w-]+$/.test(id) ? id : null; } catch { return null; }
};
export const clearOpenRequest = () => {
  try {
    const u = new URL(location.href);
    u.searchParams.delete("open");
    history.replaceState(null, "", u);
  } catch { /* 無視 */ }
};
