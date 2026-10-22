import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PosterSpec } from "../schema";
import { Poster } from "../render/Poster";
import { hideGroup, slideGroups } from "../render/animatePreview";
import { readPref, writePref } from "./storage";
import { Ico } from "./uiIcons";

const NOTES_SIZE_KEY = "dc-designer:presenter-notes-size";
const NOTES_SIZES = [16, 18, 20, 24, 28, 34, 40];

/**
 * 発表者ビューのウィンドウを開く。ユーザーの操作（クリック・キー）の中で同期的に呼ぶこと（ポップアップを止められないように）。
 * 中身は呼び出し元の React から createPortal で描くので、スタイル（あとから足されるフォントの link も）をこのウィンドウへ写す。
 * 開けなければ null
 */
export function openPresenterWindow(): Window | null {
  const w = Math.min(1280, screen.availWidth), h = Math.min(800, screen.availHeight);
  const left = (screen as Screen & { availLeft?: number }).availLeft ?? 0, top = (screen as Screen & { availTop?: number }).availTop ?? 0;
  const win = window.open("", "dc-designer-presenter", `popup,width=${w},height=${h},left=${left + (screen.availWidth - w) / 2},top=${top + (screen.availHeight - h) / 2}`);
  if (!win) return null;
  const doc = win.document;
  doc.title = "発表者ビュー";
  doc.documentElement.lang = "ja";
  doc.head.replaceChildren();
  doc.body.replaceChildren();
  doc.body.className = "pview-body";
  const copy = (n: Node) => {
    if (n instanceof HTMLStyleElement) {
      const s = doc.createElement("style");
      s.textContent = n.textContent;
      return s;
    }
    if (n instanceof HTMLLinkElement && n.rel === "stylesheet") {
      const l = doc.createElement("link");
      l.rel = "stylesheet";
      l.href = n.href; // 絶対 URL にして写す
      return l;
    }
    return null;
  };
  for (const n of document.head.childNodes) { const c = copy(n); if (c) doc.head.appendChild(c); }
  // 開いている間に読み込まれたフォント・開発中のスタイルの更新も写す
  const mo = new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) { const c = copy(n); if (c) doc.head.appendChild(c); }
  });
  mo.observe(document.head, { childList: true });
  win.addEventListener("pagehide", () => mo.disconnect());
  win.focus();
  return win;
}

/** 経過時間 "12:05" / "1:02:03" */
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

/** 枠いっぱいに縦横比を保って置いたスライド。built を渡すと、まだ出していない動きの要素を隠す */
function SlideBox({ spec, built, idPrefix }: { spec: PosterSpec; built?: number; idPrefix: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const groups = useMemo(() => slideGroups(spec), [spec]);
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    groups.forEach((g, gi) => hideGroup(svg, g, built !== undefined && gi >= built));
  }, [groups, built]);
  const { width: W, height: H } = spec.meta;
  return (
    <div className="pview-fit">
      <div className="pview-slide" style={{ width: `min(100cqw, calc(100cqh * ${W / H}))` }}>
        <Poster ref={svgRef} spec={spec} idPrefix={idPrefix} />
      </div>
    </div>
  );
}

/**
 * 発表者ビュー（別ウィンドウ）。今のスライド（出し終えた動きまで）・次のスライド・台本・経過時間を出し、操作もここからできる。
 * 投影の状態はスライドショー（Presenter）が持ち、ここは表示と操作の受け口だけ
 */
export function PresenterView({
  win, slides, index, built, builds, blank, onNext, onPrev, onGo, onBlank, onExit,
}: {
  win: Window;
  slides: PosterSpec[];
  /** 映しているスライド（slides.length なら最後の黒い画面） */
  index: number;
  /** このスライドで出し終えた動きのまとまりの数と、全体の数 */
  built: number;
  builds: number;
  blank: "black" | "white" | null;
  onNext: () => void;
  onPrev: () => void;
  onGo: (i: number) => void;
  onBlank: (b: "black" | "white") => void;
  onExit: () => void;
}) {
  const spec = slides[index] as PosterSpec | undefined;
  const next = slides[index + 1] as PosterSpec | undefined;
  // 経過時間（一時停止・リセットできる）と現在時刻
  const [now, setNow] = useState(() => Date.now());
  const [timer, setTimer] = useState({ base: 0, since: Date.now() as number | null });
  const elapsed = timer.base + (timer.since ? now - timer.since : 0);
  const pause = () => setTimer((t) => (t.since ? { base: t.base + Date.now() - t.since, since: null } : { base: t.base, since: Date.now() }));
  const resetTimer = () => setTimer((t) => ({ base: 0, since: t.since ? Date.now() : null }));
  useEffect(() => {
    const id = win.setInterval(() => setNow(Date.now()), 500);
    return () => win.clearInterval(id);
  }, [win]);
  const [size, setSize] = useState(() => {
    const v = Number(readPref(NOTES_SIZE_KEY));
    return NOTES_SIZES.includes(v) ? v : 24;
  });
  const zoomNotes = (d: -1 | 1) => {
    const v = NOTES_SIZES[Math.min(Math.max(NOTES_SIZES.indexOf(size) + d, 0), NOTES_SIZES.length - 1)];
    setSize(v);
    writePref(NOTES_SIZE_KEY, String(v));
  };
  // スライドが変わったら台本を先頭から
  const notesRef = useRef<HTMLDivElement>(null);
  useEffect(() => { notesRef.current?.scrollTo(0, 0); }, [index]);

  const remaining = builds - built;
  const time = new Date(now).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  return createPortal(
    <div className="pview" role="application" aria-label="発表者ビュー">
      <header className="pview-top">
        <div className="pview-timer" aria-label="経過時間">
          <span className={"pview-elapsed" + (timer.since ? "" : " paused")}>{clock(elapsed)}</span>
          <button onClick={pause} title={timer.since ? "タイマーを一時停止" : "タイマーを再開"} aria-label={timer.since ? "一時停止" : "再開"}>
            {timer.since ? <span className="pview-pause" aria-hidden /> : <Ico name="play" size={14} />}
          </button>
          <button onClick={resetTimer} title="タイマーを 0 に戻す" aria-label="タイマーをリセット"><Ico name="retry" size={14} /></button>
        </div>
        <span className="pview-clock">{time}</span>
        <span className="spacer" />
        <span className="pview-hint">クリック・→・Space で次へ ／ ← で前へ ／ 番号＋Enter で移動 ／ B・W で黒・白画面 ／ Esc で終了</span>
      </header>

      <main className="pview-main">
        <section className="pview-current">
          <div className="pview-label">
            {spec ? <>スライド {index + 1} / {slides.length}{builds > 0 && <span className="pview-builds">動き {built} / {builds}</span>}</> : "スライドショーの最後"}
            {blank && <span className="pview-blank-badge">{blank === "black" ? "黒い画面を表示中" : "白い画面を表示中"}</span>}
          </div>
          <div className="pview-stage" onClick={onNext} title="クリックで次へ">
            {spec ? <SlideBox key={index} spec={spec} built={built} idPrefix="pv-cur-" /> : <div className="pview-end">クリックすると終了します</div>}
          </div>
        </section>

        <aside className="pview-side">
          <div className="pview-label">
            {remaining > 0 ? <>次: このスライドの動き（あと {remaining} 回）</> : next ? <>次: スライド {index + 2}</> : spec ? "次: 終了" : ""}
          </div>
          <div className="pview-next">
            {next ? <SlideBox key={index + 1} spec={next} idPrefix="pv-next-" /> : <div className="pview-end">{spec ? "最後のスライドです" : ""}</div>}
          </div>
          <div className="pview-label pview-notes-head">
            台本
            <span className="spacer" />
            <button onClick={() => zoomNotes(-1)} disabled={size <= NOTES_SIZES[0]} title="台本の文字を小さく" aria-label="台本の文字を小さく"><Ico name="minus" size={14} /></button>
            <button onClick={() => zoomNotes(1)} disabled={size >= NOTES_SIZES[NOTES_SIZES.length - 1]} title="台本の文字を大きく" aria-label="台本の文字を大きく"><Ico name="plus" size={14} /></button>
          </div>
          <div className="pview-notes" ref={notesRef} style={{ fontSize: size }}>
            {spec?.notes?.trim() || <span className="pview-muted">{spec ? "このスライドには台本がありません" : ""}</span>}
          </div>
        </aside>
      </main>

      <footer className="pview-bar">
        <button onClick={onPrev} disabled={index === 0 && built === 0} title="前へ（←）"><Ico name="chevronLeft" /> 前へ</button>
        <button className="pview-primary" onClick={onNext} title="次へ（クリック・→・Space）">次へ <Ico name="chevronRight" /></button>
        <select value={Math.min(index, slides.length - 1)} onChange={(e) => onGo(Number(e.target.value))} aria-label="スライドへ移動" title="スライドへ移動">
          {slides.map((s, i) => <option key={i} value={i}>{i + 1}. {s.meta.title}</option>)}
        </select>
        <span className="spacer" />
        <button onClick={() => onBlank("black")} aria-pressed={blank === "black"} title="黒い画面（B）">黒い画面</button>
        <button onClick={() => onBlank("white")} aria-pressed={blank === "white"} title="白い画面（W）">白い画面</button>
        <button className="pview-danger" onClick={onExit} title="スライドショーを終了（Esc）"><Ico name="x" /> 終了</button>
      </footer>
    </div>,
    win.document.body,
  );
}
