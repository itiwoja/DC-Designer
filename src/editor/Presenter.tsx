import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PosterSpec } from "../schema";
import { Poster } from "../render/Poster";
import { hideGroup, playGroup, slideGroups } from "../render/animatePreview";
import { readPref, writePref } from "./storage";
import { PresenterView } from "./PresenterView";
import { Ico } from "./uiIcons";
import { TRANSITION_EASING, transitionKeyframes } from "../transition";
import { playSound, preloadSounds, specSounds } from "../sounds";
import { createBgmPlayer, nextClickBgm, preloadBgm } from "../bgm";

const SHOW_NOTES_KEY = "dc-designer:show-notes";

/** カーソルと操作バーを隠すまでの時間 */
const IDLE_MS = 2500;
/** ホイールで続けて進みすぎないよう、1 回進めたらこの間は受け付けない */
const WHEEL_GAP = 350;

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n", "N"]);
const PREV_KEYS = new Set(["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p", "P"]);

/**
 * スライドショー（PPTX エディターモードのスライド投影）。画面いっぱいに 1 枚ずつ映し、
 * クリック・→・Space などで PowerPoint と同じく「クリック時」のアニメーションを 1 つずつ進め、出し終えたら次のスライドへ。
 * 次のスライドに画面切り替えがあれば、前のスライドの上で動かして入れ、終わってから自動のアニメーションを始める（戻るときは切り替えない）。
 * BGM は並べた順に 1 曲ずつ流す。「クリック時」の BGM は「次へ」で 1 曲ずつ切り替え、流し終えてからアニメーション・次のスライドへ進む。
 * 「自動」の BGM は、1 曲目ならスライドに入ったとき、2 曲目からは前の曲が終わったときに流す。
 * 「次のスライドでも流す」BGM は先へ進んでも止めず、それ以外はスライドを離れると止める。
 * 戻ると直前のアニメーション（その前は直前の BGM の切り替え）を取り消し、前のスライドへは出し終えた状態で戻る。最後のスライドの次は終了の黒い画面。
 * T キーで台本（スライドのノート）を画面下に重ねて出せる（リハーサル用。映している画面にも出る）。
 * view を渡すと、そのウィンドウに発表者ビュー（今・次のスライド、台本、経過時間）を出し、どちらのウィンドウからでも操作できる。
 * 画面が複数あれば、スライドは発表者ビューと別の画面に全画面で映す（ブラウザが対応していて、許可されたとき）。
 * slides は開始時点の中身（投影中に編集は無いので固定）
 */
export function Presenter({ slides, start, view: viewWin, onExit }: { slides: PosterSpec[]; start: number; view?: Window | null; onExit: (at: number) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // i === slides.length は「スライドショーの最後です」の画面。atEnd は全アニメーションを出し終えた状態で入るか
  const [pos, setPos] = useState({ i: Math.min(Math.max(start, 0), slides.length - 1), atEnd: false, n: 0 });
  const spec = slides[pos.i] as PosterSpec | undefined;
  const groups = useMemo(() => (spec ? slideGroups(spec) : []), [spec]);
  /** このスライドで出し終えたまとまりの数 */
  const built = useRef(0);
  // 発表者ビューに出すための写し（built は再生の途中でも即座に読みたいので ref が正）
  const [builtN, setBuiltN] = useState(0);
  const setBuilt = (n: number) => { built.current = n; setBuiltN(n); };
  /** 発表者ビューのウィンドウ（閉じられたら null にしてスライドショーだけ続ける） */
  const [view, setView] = useState(viewWin && !viewWin.closed ? viewWin : null);
  useEffect(() => {
    if (!view) return;
    const onClose = () => setView(null);
    view.addEventListener("pagehide", onClose);
    return () => view.removeEventListener("pagehide", onClose);
  }, [view]);
  const playing = useRef<ReturnType<typeof playGroup> | null>(null);
  const [blank, setBlank] = useState<"black" | "white" | null>(null);
  const [idle, setIdle] = useState(false);
  const [showNotes, setShowNotes] = useState(() => readPref(SHOW_NOTES_KEY) === "1");
  const toggleNotes = () => setShowNotes((v) => { writePref(SHOW_NOTES_KEY, v ? "0" : "1"); return !v; });
  /** 数字を打ってから Enter でそのスライドへ */
  const [typed, setTyped] = useState("");
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });

  /** 画面切り替えで出ていくスライド（built はそのとき出し終えていたまとまりの数） */
  const [leaving, setLeaving] = useState<{ spec: PosterSpec; built: number } | null>(null);
  const incomingRef = useRef<HTMLDivElement>(null);
  const outgoingRef = useRef<HTMLDivElement>(null);
  const outSvgRef = useRef<SVGSVGElement>(null);
  /** 再生中の画面切り替え（finish で最後まで飛ばす） */
  const switching = useRef<{ finish: () => void; cancel: () => void } | null>(null);

  // 取り込んだ音声ファイルは先に読んでおき、最初に鳴らすときに遅れないようにする
  useEffect(() => preloadSounds(slides.flatMap(specSounds)), [slides]);

  const bgm = useMemo(createBgmPlayer, []);
  /** 流している BGM を始めたスライドの番号 */
  const bgmAt = useRef<number | null>(null);
  /** このスライドの BGM のうち、流し始めた（か飛ばした）曲の数 */
  const bgmStep = useRef(0);
  /** 流す・止めるたびに増やす（前の曲が終わったときの続きの曲を、その間に別の操作があれば流さない） */
  const bgmGen = useRef(0);
  const bgmList = spec?.bgm ?? [];
  useEffect(() => { preloadBgm(slides); return () => bgm.stop(); }, [slides, bgm]);
  const startBgm = (i: number) => {
    const b = bgmList[i];
    if (!b) return;
    const gen = ++bgmGen.current;
    bgmStep.current = i + 1;
    bgmAt.current = pos.i;
    bgm.play(b, () => {
      if (bgmGen.current === gen && bgmList[i + 1]?.start === "auto") startBgm(i + 1);
    });
  };
  const stopBgm = () => { bgmGen.current++; bgm.stop(); bgmAt.current = null; };

  const go = (i: number, atEnd = false) => {
    const to = Math.min(Math.max(i, 0), slides.length);
    switching.current?.cancel();
    // 先へ進むときだけ、入るスライドの切り替えを見せる
    setLeaving(to > pos.i && !atEnd && slides[to]?.transition && spec ? { spec, built: built.current } : null);
    setPos((p) => ({ i: to, atEnd, n: p.n + 1 }));
  };
  const exit = () => onExit(Math.min(pos.i, slides.length - 1));

  // スライドに入ったら、まだ出さない要素を隠す。最初のまとまりが自動なら（直前と同時・直前の後）すぐ再生する
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg || !spec) return;
    setBuilt(pos.atEnd ? groups.length : 0);
    syncBgm();
    groups.forEach((g, gi) => hideGroup(svg, g, gi >= built.current));
    const auto = !pos.atEnd && groups[0]?.auto;
    const t = leaving && spec.transition;
    if (t && incomingRef.current) {
      // 出ていくスライドは、出し終えていなかった要素を隠したまま見せる
      const out = outSvgRef.current;
      if (out) slideGroups(leaving.spec).forEach((g, gi) => hideGroup(out, g, gi >= leaving.built));
      const kf = transitionKeyframes(t);
      const opts = { duration: Math.max(1, t.duration), easing: TRANSITION_EASING, fill: "both" as const };
      const anims = [incomingRef.current.animate(kf.incoming, opts), ...(kf.outgoing && outgoingRef.current ? [outgoingRef.current.animate(kf.outgoing, opts)] : [])];
      const sound = t.sound ? playSound(t.sound) : null;
      let over = false;
      const end = (runAuto: boolean) => {
        if (over) return;
        over = true;
        switching.current = null;
        anims.forEach((a) => a.cancel());
        setLeaving(null);
        if (runAuto && auto) playNext();
      };
      switching.current = { finish: () => end(true), cancel: () => { sound?.stop(); end(false); } };
      Promise.all(anims.map((a) => a.finished)).then(() => end(true), () => undefined);
    } else if (auto) playNext();
    return () => { playing.current?.cancel(); playing.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos]);

  /** スライドに入ったとき: 前のスライドからの BGM を続けるか止め、このスライドの BGM を（自動なら）流す */
  function syncBgm() {
    const from = bgmAt.current;
    const keep = bgm.current() && from !== null && from <= pos.i && (from === pos.i || bgm.current()!.across);
    if (!keep) stopBgm();
    // 前のスライドの曲から続けて流す曲はもう無い（流し続ける曲はそのまま）
    bgmGen.current++;
    bgmStep.current = 0;
    // 出し終えた状態で戻ったら最後の曲を、そうでなければ 1 曲目が自動なら流す
    if (pos.atEnd) startBgm(bgmList.length - 1);
    else if (bgmList[0]?.start === "auto") startBgm(0);
  }
  // 最後の画面（スライドが無い）でも、続けない BGM は止める
  useEffect(() => { if (!spec) syncBgm(); }, [pos]); // eslint-disable-line react-hooks/exhaustive-deps

  const playNext = () => {
    const svg = svgRef.current;
    const g = groups[built.current];
    if (!svg || !spec || !g) return;
    setBuilt(built.current + 1);
    const p = playGroup(svg, spec, g);
    playing.current = p;
    p.done.then(() => { if (playing.current === p) playing.current = null; });
  };
  const next = () => {
    setBlank(null);
    // 切り替え・再生の途中なら、まず最後まで飛ばす
    if (switching.current) { switching.current.finish(); return; }
    if (playing.current) { playing.current.finish(); playing.current = null; return; }
    const nb = nextClickBgm(bgmList, bgmStep.current);
    if (nb >= 0) { startBgm(nb); return; }
    if (built.current < groups.length) { playNext(); return; }
    if (pos.i < slides.length) go(pos.i + 1);
    else exit();
  };
  const prev = () => {
    setBlank(null);
    if (switching.current) { switching.current.finish(); return; }
    playing.current?.cancel();
    playing.current = null;
    // 自動で始まるまとまりは取り消さない（スライドを出した時点で出ているもの）
    const keep = groups[0]?.auto ? 1 : 0;
    if (built.current > keep && svgRef.current) {
      setBuilt(built.current - 1);
      hideGroup(svgRef.current, groups[built.current], true);
      return;
    }
    // 直前に「次へ」で流した曲を取り消し、その前の曲に戻す
    const lastClick = bgmList.slice(0, bgmStep.current).map((b) => b.start).lastIndexOf("click");
    if (lastClick >= 0) {
      if (lastClick > 0) startBgm(lastClick - 1);
      else { if (bgmAt.current === pos.i) stopBgm(); bgmStep.current = 0; }
      return;
    }
    if (pos.i > 0) go(pos.i - 1, true);
  };

  // 全画面にする（できない環境でも画面いっぱいの重ね表示で続ける）。ブラウザの Esc で全画面を抜けたら終了
  useEffect(() => {
    const el = rootRef.current;
    el?.focus();
    let entered = false;
    const onChange = () => {
      if (document.fullscreenElement === el) entered = true;
      else if (entered) exitRef.current();
    };
    document.addEventListener("fullscreenchange", onChange);
    // 発表者ビューがあるときは、画面が複数なら今の画面ではない方（プロジェクターなど）に映す
    (viewWin ? otherScreen() : Promise.resolve(undefined))
      .then((screen) => el?.requestFullscreen?.(screen ? ({ screen } as FullscreenOptions) : undefined))
      .catch(() => el?.requestFullscreen?.().catch(() => {}));
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
    };
  }, []);
  const exitRef = useRef(exit);
  exitRef.current = exit;

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // しばらく動かさなければカーソルと操作バーを隠す
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wake = () => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
  };
  useEffect(() => { wake(); return () => clearTimeout(idleTimer.current); }, []);

  // エディタのショートカットより先に受け取る
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      const k = e.key;
      if (/^[0-9]$/.test(k)) { setTyped((t) => (t + k).slice(-3)); return; }
      if (k === "Enter" && typed) {
        const n = parseInt(typed, 10);
        setTyped("");
        if (n >= 1 && n <= slides.length) go(n - 1);
        return;
      }
      setTyped("");
      if (k === "Escape") return exit();
      if (k === "b" || k === "B" || k === ".") return setBlank((b) => (b === "black" ? null : "black"));
      if (k === "w" || k === "W" || k === ",") return setBlank((b) => (b === "white" ? null : "white"));
      if ((k === "t" || k === "T") && !view) return toggleNotes();
      if (k === "Home") return go(0);
      if (k === "End") return go(slides.length - 1);
      if (NEXT_KEYS.has(k)) return next();
      if (PREV_KEYS.has(k)) return prev();
    };
    window.addEventListener("keydown", onKey, true);
    view?.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      view?.removeEventListener("keydown", onKey, true);
    };
  });

  const lastWheel = useRef(0);
  const onWheel = (e: React.WheelEvent) => {
    if (!e.deltaY || e.timeStamp - lastWheel.current < WHEEL_GAP) return;
    lastWheel.current = e.timeStamp;
    (e.deltaY > 0 ? next : prev)();
  };

  const W = spec?.meta.width ?? 1, H = spec?.meta.height ?? 1;
  const k = Math.min(size.w / W, size.h / H);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <>
      <div
        className={"presenter" + (idle ? " idle" : "")}
        ref={rootRef}
        tabIndex={-1}
        role="dialog"
        aria-label="スライドショー"
        onPointerMove={wake}
        onClick={(e) => e.button === 0 && next()}
        onContextMenu={(e) => { e.preventDefault(); prev(); }}
        onWheel={onWheel}
      >
        {spec ? (
          <div className="presenter-slide" style={{ width: W * k, height: H * k }}>
            {leaving && (
              <div className="presenter-layer" ref={outgoingRef}>
                <Poster ref={outSvgRef} spec={leaving.spec} idPrefix="show-out-" />
              </div>
            )}
            <div className="presenter-layer" key={pos.i} ref={incomingRef}>
              <Poster ref={svgRef} spec={spec} idPrefix="show-" />
            </div>
          </div>
        ) : (
          <p className="presenter-end">スライドショーの最後です。クリックすると終了します</p>
        )}
        {blank && <div className={"presenter-blank " + blank} />}
        {typed && <div className="presenter-typed">スライド {typed} へ（Enter）</div>}
        {showNotes && !view && spec && !blank && (
          <div className="presenter-notes" onClick={stop} onContextMenu={stop} onWheel={stop}>
            {spec.notes?.trim() || <span className="presenter-notes-empty">このスライドには台本がありません</span>}
          </div>
        )}
        <div className="presenter-bar" onClick={stop} onContextMenu={stop} onPointerDown={stop}>
          <button onClick={prev} title="前へ（← / PageUp）" aria-label="前へ"><Ico name="chevronLeft" /></button>
          <span className="presenter-pos">{Math.min(pos.i + 1, slides.length)} / {slides.length}</span>
          <button onClick={next} title="次へ（クリック / → / Space）" aria-label="次へ"><Ico name="chevronRight" /></button>
          {!view && <button onClick={toggleNotes} className={showNotes ? "on" : undefined} title={showNotes ? "台本を隠す（T）" : "台本を表示（T）。映している画面にも出ます"} aria-label="台本を表示" aria-pressed={showNotes}><Ico name="notes" /></button>}
          <button onClick={exit} title="スライドショーを終了（Esc）" aria-label="スライドショーを終了"><Ico name="x" /></button>
        </div>
      </div>
      {/* 別ウィンドウだが React の木ではここにぶら下がるので、上のクリック（次へ）が拾わないよう外に置く */}
      {view && (
        <PresenterView
          win={view} slides={slides} index={pos.i} built={builtN} builds={groups.length} blank={blank}
          onNext={next} onPrev={prev} onGo={(i) => { setBlank(null); go(i); }}
          onBlank={(b) => setBlank((cur) => (cur === b ? null : b))} onExit={exit}
        />
      )}
    </>
  );
}

/**
 * 画面が複数あるとき、今のウィンドウが無い方の画面（Window Management API）。
 * 対応していない・許可されない・画面が 1 つなら undefined（今の画面で全画面にする）
 */
async function otherScreen(): Promise<Screen | undefined> {
  const w = window as Window & { getScreenDetails?: () => Promise<{ screens: Screen[]; currentScreen: Screen }> };
  if (!w.getScreenDetails || !(screen as Screen & { isExtended?: boolean }).isExtended) return undefined;
  const d = await w.getScreenDetails();
  return d.screens.find((s) => s !== d.currentScreen);
}
