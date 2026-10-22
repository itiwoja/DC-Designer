import { useCallback, useEffect, useRef, useState } from "react";
import type { PosterSpec } from "../schema";
import { api, isNotFound } from "./api";
import { clearOpenRequest, CREATING_KEY, readCurrentId, readOpenRequest, readSynced, STORAGE_KEY, writeCurrentId, writeSynced } from "./storage";

const hadSavedSpec = () => { try { return !!localStorage.getItem(STORAGE_KEY); } catch { return false; } };

type Creating = { token: string; id?: string };
const readCreating = (): Creating | null => { try { return JSON.parse(localStorage.getItem(CREATING_KEY) ?? "null"); } catch { return null; } };
const writeCreating = (c: Creating) => { try { localStorage.setItem(CREATING_KEY, JSON.stringify(c)); } catch { /* 無視 */ } };
const newToken = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
/**
 * ID の無い控えを開いたときの作成の目印。まだ誰も作っていない作成があればそれを引き継ぎ（同時に開いた複数タブ・HMR）、
 * 無ければ新しく始めて、後から開くタブに引き継がせる
 */
const joinCreating = () => {
  const c = readCreating();
  if (c && !c.id) return c.token;
  const token = newToken();
  writeCreating({ token });
  return token;
};

/** 今のスライド（ポスター）を保存できず、切り替え・新規作成を止めたときのエラー */
export const SAVE_FAILED = "今のポスターを保存できなかったため中止しました。API サーバーが起動しているか確認してください（編集内容はこの画面とブラウザに残っています）";

/**
 * 編集中の spec をブラウザ（控え）と成果物（サーバー）へ自動保存する。
 * サーバーへの保存は saveChain で直列化し、作成中に次の保存が走って二重に作られないようにする。
 * apiUp: API サーバーは Vite より起動が遅いので、応答するまでサーバー保存を始めない
 */
export function useAutoSave(spec: PosterSpec, setSpec: (s: PosterSpec) => void, apiUp: boolean, resetSpec?: (s: PosterSpec) => void) {
  // ブラウザの控えに入れられず ?open=<ID> で開いたとき: ID の内容をサーバーから読み込むまで、控えの内容は保存せず別の成果物へも送らない
  const [openId] = useState(readOpenRequest);
  const loadingRef = useRef(!!openId);
  const [opening, setOpening] = useState<"loading" | "error" | null>(openId ? "loading" : null);
  // ---------- ブラウザの控え ----------
  const [browserSave, setBrowserSave] = useState<"saved" | "error">("saved");
  useEffect(() => {
    if (loadingRef.current) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(spec)); setBrowserSave("saved"); }
    catch { setBrowserSave("error"); }
    // 控え・ID・保存済みの印は全タブ共有なので、同じタブの組で書く（別タブが開いた成果物の ID に、この控えを送り直さない）
    writeCurrentId(posterIdRef.current);
    writeSynced(!!posterIdRef.current && spec === lastSaved.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);

  // ---------- 成果物（サーバー） ----------
  const specRef = useRef(spec);
  specRef.current = spec;
  const [initialId] = useState(() => openId ?? readCurrentId());
  const posterIdRef = useRef<string | null>(initialId);
  // ID があっても、控えが成果物へ保存済みと確かめられなければ送り直す。
  // ID が無いのにブラウザに作業中の spec がある（成果物管理より前のデータ・作成前に閉じた新規）なら、最初に成果物として登録する
  const [initialSaved] = useState(() => (openId ? spec : initialId ? (readSynced() ? spec : null) : hadSavedSpec() ? null : spec));
  // 新規作成の目印（ID が無いときだけ使う）
  const [initialToken] = useState(() => (initialId ? newToken() : joinCreating()));
  const createToken = useRef(initialToken);
  /** この画面が作成した成果物（「元に戻す」で消してよいのはこれだけ） */
  const created = useRef<Creating | null>(null);
  const lastSaved = useRef<PosterSpec | null>(initialSaved);
  const saveChain = useRef<Promise<boolean>>(Promise.resolve(true));
  const [serverSave, setServerSave] = useState<"saved" | "saving" | "error">("saved");
  // 開いている成果物の ID（デッキを引くため state にも持つ）
  const [posterId, setPosterIdState] = useState<string | null>(initialId);
  const setPosterId = (id: string | null) => { posterIdRef.current = id; writeCurrentId(id); setPosterIdState(id); };

  /**
   * まだ ID が無い spec を成果物として登録する。複数タブ（や HMR で残った古いインスタンス）が同時に作成して
   * 二重登録にならないよう、タブ間ロックの中で「同じ作成操作で他のタブが先に作っていないか」を確かめてから作る。
   * 別のタブが開いた成果物（共有の CURRENT_ID_KEY）は同じ作成操作のものとは限らないので採用しない
   */
  const createOrAdopt = async (s: PosterSpec) => {
    const token = createToken.current;
    const create = async () => {
      const other = readCreating();
      if (other?.token === token && other.id) { await api.savePoster(other.id, s); return other.id; }
      const id = (await api.createPoster(s)).id;
      writeCreating({ token, id });
      return id;
    };
    const id: string = navigator.locks ? await navigator.locks.request("dc-designer:create-poster", create) : await create();
    created.current = { token, id };
    setPosterId(id);
  };

  // ---------- 開いていないスライドの保存 ----------
  // デッキの全スライドは手元に持ち、切り替えはサーバーを待たない。切り替えで離れたスライド・フォントの一括適用などで
  // 書き換えた別スライドは、ここに最新の内容を置いて裏で保存する（saveChain に並べるので開いているスライドの保存と混ざらない）
  /** 成果物 ID → サーバーに保存済みと分かっている内容（同じ内容を送り直さない・スライドに戻ったときの保存済みの基準） */
  const savedOf = useRef(new Map<string, PosterSpec>());
  /** 成果物 ID → まだ保存できていない、開いていないスライドの最新の内容 */
  const unsaved = useRef(new Map<string, PosterSpec>());
  const [otherSave, setOtherSave] = useState<"saved" | "saving" | "error">("saved");

  /** 開いていないスライド id の内容 s を裏で保存する。失敗したら 5 秒後に送り直す */
  const saveOther = useCallback((id: string, s: PosterSpec) => {
    if (savedOf.current.get(id) === s) { unsaved.current.delete(id); return; }
    unsaved.current.set(id, s);
    setOtherSave("saving");
    saveChain.current = saveChain.current.then(async () => {
      const latest = unsaved.current.get(id);
      // 先に保存できた・そのスライドを開き直した（開いているスライドとして保存する）・削除した
      if (latest !== s) return true;
      try {
        if (savedOf.current.get(id) !== s) await api.savePoster(id, s);
        savedOf.current.set(id, s);
        if (unsaved.current.get(id) === s) unsaved.current.delete(id);
      } catch (e) {
        // 削除済みのスライドは作り直さない
        if (isNotFound(e)) unsaved.current.delete(id);
        else {
          setOtherSave("error");
          setTimeout(() => { const l = unsaved.current.get(id); if (l) saveOther(id, l); }, 5000);
          return true;
        }
      }
      if (!unsaved.current.size) setOtherSave("saved");
      return true;
    });
  }, []);

  /** サーバーから読み込んだ内容を、保存済みのものとして覚える（デッキの全スライドを開いたとき） */
  const markSaved = useCallback((id: string, s: PosterSpec) => { savedOf.current.set(id, s); }, []);
  /** 削除したスライドの保存待ちを捨てる */
  const forget = useCallback((id: string) => {
    unsaved.current.delete(id);
    savedOf.current.delete(id);
    if (!unsaved.current.size) setOtherSave("saved");
  }, []);

  /**
   * 開いているスライドを id（内容 next）に切り替える。サーバーは待たず、今のスライドの未保存の編集は裏で保存する。
   * 切り替えた直後の保存が新しいスライドの ID に古い内容を送らないよう、ID と内容の ref はここで同時に差し替える
   */
  const openGen = useRef(0);
  const switchTo = (id: string, next: PosterSpec) => {
    openGen.current++;
    const prevId = posterIdRef.current, prev = specRef.current;
    if (prevId && prevId !== id) {
      // 保存済みならその内容を基準として覚え（戻ったときに送り直さない）、未保存なら裏で保存する
      if (prev === lastSaved.current) savedOf.current.set(prevId, prev);
      else saveOther(prevId, prev);
    }
    unsaved.current.delete(id);
    if (!unsaved.current.size) setOtherSave("saved");
    setPosterId(id);
    specRef.current = next;
    lastSaved.current = savedOf.current.get(id) ?? next;
    setServerSave(next === lastSaved.current ? "saved" : "saving");
  };

  /**
   * force: 変更が無くても、まだ成果物になっていなければ作成する（保存ボタン）。
   * 今の内容が成果物に保存済みになれば true、保存に失敗したら false（切り替えの前に確かめる）
   */
  const flushSave = useCallback((force = false): Promise<boolean> => {
    saveChain.current = saveChain.current.then(async () => {
      // 開く成果物の内容を読み込むまでは、手元の内容を保存しない
      if (loadingRef.current) return false;
      const s = specRef.current;
      // 保存済みの内容と同じなら何もしない（保存ボタンや Undo で戻した場合も表示は「保存済み」に戻す）
      if (s === lastSaved.current && (posterIdRef.current || !force)) {
        setServerSave("saved");
        if (posterIdRef.current) writeSynced(true);
        return true;
      }
      // 保存中に別のスライドへ切り替えたかを見分ける
      const gen = openGen.current;
      const switched = () => openGen.current !== gen;
      try {
        const id = posterIdRef.current;
        if (id) {
          try { await api.savePoster(id, s); savedOf.current.set(id, s); }
          catch (e) {
            // 成果物管理で削除されていたら新しく作り直す（もう別のスライドを開いていれば、そのスライドの ID を消さない）
            if (!isNotFound(e)) throw e;
            if (switched()) return true;
            setPosterId(null);
            createToken.current = newToken();
            await createOrAdopt(s);
          }
        } else await createOrAdopt(s);
        // 保存中に別のスライドへ切り替えていたら、開いているスライドの保存済みの基準は変えない
        if (switched()) return true;
        lastSaved.current = s;
        if (specRef.current === s) { setServerSave("saved"); writeSynced(true); }
        // 保存中に Undo などで保存前の内容へ戻した場合、自動保存の effect は再実行されないのでここで追いかける
        else setTimeout(() => flushSave(), 800);
        return true;
      } catch {
        setServerSave("error");
        setTimeout(() => { if (specRef.current !== lastSaved.current) flushSave(); }, 5000);
        return false;
      }
    });
    return saveChain.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** ?open の成果物をサーバーから読み込み、内容と ID を一組にして開く。読み込めたら true */
  const loadOpened = useCallback(async () => {
    if (!openId || !loadingRef.current) return true;
    try {
      const p = await api.poster(openId);
      if (!loadingRef.current) return true;
      savedOf.current.set(openId, p.spec);
      lastSaved.current = p.spec;
      specRef.current = p.spec;
      loadingRef.current = false;
      setOpening(null);
      clearOpenRequest();
      setServerSave("saved");
      resetSpec?.(p.spec);
      return true;
    } catch {
      setOpening("error");
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, resetSpec]);

  useEffect(() => {
    if (!openId || !apiUp || opening === null) return;
    let t: ReturnType<typeof setTimeout>;
    const run = () => { loadOpened().then((ok) => { if (!ok) t = setTimeout(run, 5000); }); };
    run();
    return () => clearTimeout(t);
  }, [openId, apiUp, opening === null, loadOpened]);

  /** 開いているスライドと、裏で保存中の別スライドをすべて保存し終えたら true（別の画面へ移る前に確かめる） */
  const flushAll = async () => (await flushSave()) && !unsaved.current.size;

  useEffect(() => {
    if (spec === lastSaved.current) { setServerSave("saved"); return; }
    setServerSave("saving");
    if (!apiUp) return;
    const t = setTimeout(() => flushSave(), 800);
    return () => clearTimeout(t);
  }, [spec, flushSave, apiUp]);

  // 保存待ちのままタブを閉じたときも取りこぼさない
  useEffect(() => {
    const onUnload = () => {
      const send = (id: string, s: PosterSpec) =>
        fetch(`/api/posters/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spec: s }), keepalive: true });
      const id = posterIdRef.current;
      if (id && specRef.current !== lastSaved.current) send(id, specRef.current);
      for (const [other, s] of unsaved.current) send(other, s);
    };
    window.addEventListener("pagehide", onUnload);
    return () => window.removeEventListener("pagehide", onUnload);
  }, []);

  /** 保存ボタン / Ctrl+S: 自動保存の待ち時間を飛ばしてすぐ保存する。成果物に保存できたら true */
  // 自動保存の待ち中（serverSave === "saving"）も押せるよう、ボタンの無効化は保存ボタン自身の処理中だけにする
  const [savingNow, setSavingNow] = useState(false);
  const saveNow = async () => {
    setSavingNow(true);
    setServerSave("saving");
    // 裏での保存に失敗して待っているスライドも、すぐ送り直す
    for (const [id, s] of [...unsaved.current]) saveOther(id, s);
    await flushSave(true).finally(() => setSavingNow(false));
    return !!posterIdRef.current && specRef.current === lastSaved.current && !unsaved.current.size;
  };

  /** 別の成果物へ切り替える前に、今の内容（裏で保存中のスライドも）を保存する。保存できなければ SAVE_FAILED で止める（切り替えると編集内容を失うため） */
  const saveBeforeSwitch = async () => {
    if (!await flushAll()) throw new Error(SAVE_FAILED);
  };

  /** これ以降の編集を別の成果物として保存する（AI で新規作成・JSON 読み込み）。戻り値は元の成果物に戻す関数 */
  const startNewPoster = async () => {
    await saveBeforeSwitch();
    const prevId = posterIdRef.current;
    const token = newToken();
    createToken.current = token;
    writeCreating({ token });
    setPosterId(null);
    lastSaved.current = null;
    writeSynced(false);
    return (before: PosterSpec) => {
      saveChain.current = saveChain.current.then(async () => {
        // この新規作成で作った成果物を開いたままのときだけ消す（別の成果物を消さない）
        const mine = created.current;
        if (mine?.token === token && mine.id === posterIdRef.current && mine.id !== prevId) await api.deletePoster(mine.id).catch(() => {});
        setPosterId(prevId);
        lastSaved.current = before;
        if (specRef.current === before) { setServerSave("saved"); writeSynced(!!prevId); }
        return true;
      });
      setSpec(before);
    };
  };

  /** サーバーから読み込んだ成果物を、保存済みのものとして開く（デッキの外の成果物を開き直すとき） */
  const adopt = (id: string, saved: PosterSpec) => {
    savedOf.current.set(id, saved);
    switchTo(id, saved);
  };

  // 開いているスライドと裏で保存中のスライドをまとめた表示
  const overall = serverSave === "error" || otherSave === "error" ? "error" : serverSave === "saving" || otherSave === "saving" ? "saving" : "saved";
  return {
    browserSave, opening, loadOpened, serverSave: overall, savingNow, posterId, posterIdRef, specRef, flushSave, flushAll, saveNow, saveBeforeSwitch, startNewPoster, adopt,
    switchTo, saveOther, markSaved, forget,
  };
}
