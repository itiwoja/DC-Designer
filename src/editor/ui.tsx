/** 画面（ホーム・エディタ・成果物）で共通の小さな部品 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { THEME_LABELS, THEME_ORDER, useTheme } from "../theme";
import { Ico } from "./uiIcons";
import type { PosterSpec } from "../schema";
import { snapshots } from "../render/snapshot";
import { api } from "./api";

/**
 * ボタンで開閉するメニュー。外側のクリック・Esc で閉じる（Esc は preventDefault して、ほかのショートカットには使わせない）。
 * 開いたら中の最初の操作（data-autofocus か aria-current が付いたものがあればそれ）へフォーカスを移し、
 * 閉じたら開いたボタンへ戻す（外側クリックで閉じたときは、クリックした先を優先して戻さない）。
 * レイヤー側で stopPropagation されるため、ポインタ・キーは capture で拾う。
 * fixed を付けると .menu-list を画面基準（position: fixed）で置き直し、親の overflow: hidden で切れず、画面の端からもはみ出さない
 * （CSS で決めた上下・左右の向きはそのまま使う。transform や backdrop-filter の付いた親の中では使わない）
 */
export function Menu({ className, fixed, trigger, children }: {
  className?: string;
  fixed?: boolean;
  trigger: (m: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const skipRestore = useRef(false);
  useEffect(() => {
    const box = ref.current;
    if (open) {
      skipRestore.current = false;
      const list = box?.querySelector<HTMLElement>(":scope > .menu-list");
      const target = list?.querySelector<HTMLElement>("[data-autofocus], [aria-current='true'], button:not(:disabled), a[href], input:not(:disabled)");
      target?.focus({ preventScroll: true });
    } else if (wasOpen.current && !skipRestore.current) {
      // 閉じたあとフォーカスが消えた（中から外れて body に落ちた）ときだけ、開いたボタンへ戻す
      const a = document.activeElement;
      if (!a || a === document.body || box?.contains(a)) (box?.firstElementChild as HTMLElement | null)?.focus?.();
    }
    wasOpen.current = open;
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !fixed) return;
    const place = () => {
      const box = ref.current, list = box?.querySelector<HTMLElement>(":scope > .menu-list");
      if (!box || !list) return;
      Object.assign(list.style, { position: "", top: "", left: "", right: "", bottom: "", maxWidth: "" });
      const b = box.getBoundingClientRect(), l = list.getBoundingClientRect();
      const up = l.top < b.top, alignLeft = Math.abs(l.left - b.left) < 1;
      const m = 8, vw = window.innerWidth, vh = window.innerHeight;
      const w = Math.min(l.width, vw - m * 2);
      const left = Math.max(m, Math.min(alignLeft ? b.left : b.right - w, vw - w - m));
      const top = up ? Math.max(m, b.top - 6 - l.height) : Math.min(b.bottom + 6, Math.max(m, vh - l.height - m));
      Object.assign(list.style, { position: "fixed", top: `${top}px`, left: `${left}px`, right: "auto", bottom: "auto", maxWidth: `${vw - m * 2}px` });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, fixed]);
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) { skipRestore.current = true; setOpen(false); } };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); } };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("pointerdown", onPointer, true); window.removeEventListener("keydown", onKey, true); };
  }, [open]);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className={"menu" + (className ? ` ${className}` : "")} ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && children(close)}
    </div>
  );
}

/** 画面の明るさの切り替え。ボタンには今見えている明るさ（太陽/月）を出し、選択肢は文字付きのメニューで選ばせる */
export function ThemeMenu() {
  const ui = useTheme();
  const label = `画面の明るさ: ${THEME_LABELS[ui.pref].label}`;
  return (
    <Menu trigger={({ open, toggle }) => (
      <button className="icon-btn" aria-haspopup="menu" aria-expanded={open} onClick={toggle} title={label} aria-label={label}><Ico name={THEME_LABELS[ui.resolved].icon} /></button>
    )}>
      {(close) => (
        <div className="menu-list" role="menu">
          {THEME_ORDER.map((t) => (
            <button key={t} role="menuitemradio" aria-checked={ui.pref === t} onClick={() => { ui.setPref(t); close(); }}>
              <Ico name={THEME_LABELS[t].icon} /> {THEME_LABELS[t].label}{ui.pref === t && <small><Ico name="check" size={14} /></small>}
            </button>
          ))}
        </div>
      )}
    </Menu>
  );
}

/** 画像などの描画が済むまで重ねる、読み込み中のぐるぐる（すぐ済むときはちらつかないよう少し遅れて出る） */
export function RenderLoading() {
  return <span className="render-loading" role="status" aria-label="読み込み中"><span className="spinner" aria-hidden /></span>;
}

/**
 * spec の snapshot（画像化したプレビュー）の Blob URL を返す。作れるまでは null。
 * 編集中は spec が細かく変わるので、最初の 1 枚のあとは少し落ち着いてから作り直す（それまでは前の絵を出す）
 */
function useSnapshot(spec: PosterSpec | null): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false });
  // 表示中の絵は、次の絵が出来るまで借りたままにする（先に返すと Blob URL が revoke され得る）
  const shown = useRef<ReturnType<typeof snapshots.acquire> | null>(null);
  useEffect(() => () => shown.current?.release(), []);
  useEffect(() => {
    if (!spec) return;
    let handle: ReturnType<typeof snapshots.acquire> | undefined;
    let alive = true;
    const start = () => {
      const h = (handle = snapshots.acquire(spec));
      h.promise.then(
        (url) => {
          if (!alive) return;
          if (shown.current !== h) { shown.current?.release(); shown.current = h; }
          handle = undefined;
          setState({ url, failed: false });
        },
        () => { if (alive) setState((s) => ({ url: s.url, failed: !s.url })); },
      );
    };
    const t = shown.current ? setTimeout(start, 300) : undefined;
    if (!t) start();
    return () => { alive = false; clearTimeout(t); handle?.release(); };
  }, [spec]);
  return state;
}

function Snapshot({ spec, style, failed: loadFailed }: { spec: PosterSpec | null; style?: CSSProperties; failed?: boolean }) {
  const snap = useSnapshot(spec);
  const url = snap.url;
  const failed = snap.failed || !!loadFailed;
  return (
    <>
      {url && <img className="snap" src={url} alt="" draggable={false} aria-hidden style={style} />}
      {!url && !failed && <RenderLoading />}
    </>
  );
}

/** 手元の spec のサムネイル（サーバーを介さないので未保存の編集もすぐ映る） */
export function SpecFrame({ spec, style }: { spec: PosterSpec; style?: CSSProperties }) {
  return <Snapshot spec={spec} style={style} />;
}

/** 保存済みの成果物のサムネイル（updatedAt が変わると読み直す） */
export function PosterFrame({ poster, style }: { poster: { id: string; updatedAt: string }; style?: CSSProperties }) {
  const [spec, setSpec] = useState<PosterSpec | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    api.poster(poster.id).then((p) => { if (alive) setSpec(p.spec); }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [poster.id, poster.updatedAt]);
  return <Snapshot spec={spec} style={style} failed={failed && !spec} />;
}

/**
 * API サーバーから読み込む。サーバーは Vite より起動が遅く tsx watch で再起動もするため、
 * 成功するまで間隔を延ばしながら再試行し、タブに戻ったときにも読み直す。戻り値はすぐ読み直す関数
 */
export function useLoadWithRetry(load: () => Promise<void>, onError?: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const alive = useRef(true);
  const attempt = useCallback((delay = 1000) => {
    clearTimeout(timer.current);
    load().catch(() => {
      if (!alive.current) return;
      onError?.();
      timer.current = setTimeout(() => attempt(Math.min(delay * 2, 10000)), delay);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);
  useEffect(() => {
    alive.current = true;
    attempt();
    // 別タブから戻ってきたら取り直す（タブの切り替えでは focus が来ないことがあるので visibilitychange も見る）
    const onFocus = () => attempt();
    const onVisible = () => { if (document.visibilityState === "visible") attempt(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [attempt]);
  return useCallback(() => attempt(), [attempt]);
}

export type ConfirmOptions = { title: string; message?: string; ok: string; danger?: boolean };
/** askChoice() の選択肢。最後のものが既定（Enter・最初のフォーカス） */
export type ChoiceOptions<T extends string> = { title: string; message?: string; choices: { value: T; label: string }[] };
type ConfirmRequest = { title: string; message?: string; danger?: boolean; choices: { value: string; label: string }[]; resolve: (v: string | null) => void };
let showConfirm: ((o: Omit<ConfirmRequest, "resolve">) => Promise<string | null>) | null = null;

/** ブラウザ標準の confirm() の代わり。画面に <ConfirmHost /> が 1 つあること */
export function ask(o: ConfirmOptions): Promise<boolean> {
  return showConfirm ? showConfirm({ ...o, choices: [{ value: "ok", label: o.ok }] }).then((v) => v === "ok") : Promise.resolve(false);
}

/** キャンセルのほかに、いくつかの選択肢から 1 つ選ばせる（キャンセルなら null） */
export function askChoice<T extends string>(o: ChoiceOptions<T>): Promise<T | null> {
  return showConfirm ? (showConfirm(o) as Promise<T | null>) : Promise.resolve(null);
}

/** ask()・askChoice() の確認ダイアログを出す場所。Esc・外側クリックでキャンセル、Enter で既定の選択肢。開いている間はほかのショートカットに使わせない */
export function ConfirmHost() {
  const [req, setReq] = useState<ConfirmRequest | null>(null);
  useEffect(() => {
    showConfirm = (o) => new Promise((resolve) => setReq({ ...o, resolve }));
    return () => { showConfirm = null; };
  }, []);
  const answer = useCallback((v: string | null) => setReq((r) => { r?.resolve(v); return null; }), []);
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      // フォーカス中のボタンを Tab・Enter・Space で操作するのはそのまま通す
      const onButton = e.target instanceof HTMLButtonElement;
      if (["Tab", "Enter", " "].includes(e.key) && onButton) return;
      if (e.key === "Escape") answer(null);
      else if (e.key === "Enter") answer(req.choices[req.choices.length - 1].value);
      e.stopPropagation();
      if (e.key !== "Tab") e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [req, answer]);
  if (!req) return null;
  const last = req.choices.length - 1;
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && answer(null)}>
      <div className="modal confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby={req.message ? "confirm-message" : undefined}>
        <h2 id="confirm-title">{req.title}</h2>
        {req.message && <p id="confirm-message">{req.message}</p>}
        <div className="row end">
          <button onClick={() => answer(null)}>キャンセル</button>
          {req.choices.map((c, i) => (
            <button key={c.value} className={i === last ? "primary" + (req.danger ? " danger" : "") : undefined} autoFocus={i === last} onClick={() => answer(c.value)}>{c.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
