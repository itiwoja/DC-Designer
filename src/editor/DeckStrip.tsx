import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import type { PosterSpec } from "../schema";
import type { Deck } from "./api";
import { SpecFrame } from "./ui";
import { Ico } from "./uiIcons";
import { nextSlideSelection } from "./slideSelection";

/**
 * PPTX エディターモードのスライド一覧（キャンバス下の帯）。
 * 全スライドの中身は手元にあるので、サムネイルもサーバーを介さずその中身を描く（開いているスライドは編集中の内容）
 */
export function DeckStrip({
  deck, slides, currentSpec, open, currentId, width, height, thumbHeight, disabled, selectedIds, onSelect, onOpen, onAdd, onDuplicate, onRemove, onMove, onReorder, onExport, onFonts, onToggle, onPresent, onPresentView,
}: {
  deck: Deck;
  /** スライド ID → 中身（開いているスライドの分は currentSpec を使う） */
  slides: ReadonlyMap<string, PosterSpec>;
  currentSpec: PosterSpec;
  /** false なら見出しだけの細い帯に畳む */
  open: boolean;
  currentId: string | null;
  width: number;
  height: number;
  /** サムネイルの高さ（帯の高さに合わせて変わる） */
  thumbHeight: number;
  disabled: boolean;
  /** 複数選択中のスライド id（空 = 複数選択なし。Ctrl/⌘ ＋クリックや Shift ＋クリックで変わる） */
  selectedIds: readonly string[];
  onSelect: (ids: string[]) => void;
  onOpen: (id: string) => void;
  onAdd: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  /** ドラッグ＆ドロップでスライド id を to 番目の隙間（0 = 先頭、slides.length = 末尾）へ動かす */
  onReorder: (id: string, to: number) => void;
  onExport: () => void;
  onFonts: () => void;
  onToggle: (open: boolean) => void;
  /** 1 枚目からスライドショーを始める */
  onPresent: () => void;
  /** 今のスライドから、発表者ビュー付きでスライドショーを始める */
  onPresentView: () => void;
}) {
  const index = deck.slides.findIndex((s) => s.id === currentId);
  const unit = "スライド";
  const listRef = useRef<HTMLOListElement>(null);
  const multi = selectedIds.length >= 2;
  // Shift ＋クリックの範囲選択の起点
  const anchorRef = useRef<string | null>(null);
  const clickSlide = (id: string, e: MouseEvent) => {
    if (disabled) return;
    const r = nextSlideSelection(deck.slides.map((s) => s.id), selectedIds, currentId, anchorRef.current, id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
    anchorRef.current = r.anchor;
    if (r.selected.length !== selectedIds.length || r.selected.some((x, i) => x !== selectedIds[i])) onSelect(r.selected);
    if (r.open && r.open !== currentId) onOpen(r.open);
  };
  // 開いているスライドが見える位置まで一覧を横にスクロールする。
  // scrollIntoView は overflow: hidden の親（帯やキャンバスの枠）まで縦に動かして見出しが隠れることがあるので、一覧だけを動かす
  useEffect(() => {
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>('[aria-current="true"]')?.closest("li");
    if (!list || !item) return;
    const l = list.getBoundingClientRect(), r = item.getBoundingClientRect();
    const pad = 10;
    if (r.left < l.left + pad) list.scrollLeft -= l.left + pad - r.left;
    else if (r.right > l.right - pad) list.scrollLeft += r.right - (l.right - pad);
  }, [currentId]);
  // サムネイルの高さは一覧の実際の高さから決める（見出しの高さはフォントや比率の選択欄で変わり、横スクロールバーの太さも環境で違うため、
  // 固定の差し引きだとはみ出して一覧が縦にずれることがある）。スクロールバーは出ていなくても出たときの太さを常に差し引き、出入りで大きさが揺れないようにする
  const [fitH, setFitH] = useState<number | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const cs = getComputedStyle(list);
      const bar = list.scrollWidth > list.clientWidth ? list.offsetHeight - list.clientHeight : scrollbarThickness();
      const h = Math.floor(list.offsetHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - bar);
      if (h > 0) setFitH(h);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => ro.disconnect();
  }, []);
  // ドラッグ中のスライドと、落とす位置（スライドの間の隙間の番号）
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  /** ポインターの x 座標から、どの隙間に落とすかを求める（各サムネイルの中央より左なら前、右なら後ろ） */
  const gapAt = (x: number) => {
    const items = listRef.current?.querySelectorAll<HTMLElement>(":scope > li") ?? [];
    let gap = 0;
    items.forEach((li, i) => {
      const r = li.getBoundingClientRect();
      if (x > r.left + r.width / 2) gap = i + 1;
    });
    return gap;
  };
  const endDrag = () => { setDragId(null); setDropAt(null); };
  const onDragOver = (e: DragEvent) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const from = deck.slides.findIndex((s) => s.id === dragId);
    const gap = gapAt(e.clientX);
    // 元の位置のすぐ前後は動かないので印を出さない
    setDropAt(gap === from || gap === from + 1 ? null : gap);
  };
  const onDrop = (e: DragEvent) => {
    if (!dragId) return;
    e.preventDefault();
    if (dropAt !== null) onReorder(dragId, dropAt);
    endDrag();
  };
  // 畳んでいる間（一覧の高さが 0 に近い）や測る前は、親から渡された目安を使う
  const thumbH = open && fitH ? Math.min(thumbHeight, fitH) : thumbHeight;
  const thumbW = Math.round((thumbH * width) / height);
  return (
    <div className={"deck-strip" + (open ? "" : " collapsed")} role="region" aria-label={`${unit}一覧`}>
      <div className="deck-head">
        <strong title={deck.name}><Ico name="slides" size={14} /> {deck.name}</strong>
        {/* 複数選択中は位置の代わりに選択枚数を出す（帯の幅が狭いとき右端のボタンが切れないように） */}
        {multi
          ? <span className="deck-sel-count" role="status">{selectedIds.length} 枚選択中</span>
          : <span className="deck-pos">{index >= 0 ? `${index + 1} / ${deck.slides.length}` : `${deck.slides.length} 枚`}</span>}
        <span className="spacer" />
        <div className="deck-actions" inert={!open}>
        <div className="btn-group">
          <button onClick={() => onMove(-1)} disabled={disabled || index <= 0} title={`この${unit}を前へ`} aria-label="前へ移動"><Ico name="chevronLeft" size={14} /></button>
          <button onClick={() => onMove(1)} disabled={disabled || index < 0 || index >= deck.slides.length - 1} title={`この${unit}を後ろへ`} aria-label="後ろへ移動"><Ico name="chevronRight" size={14} /></button>
        </div>
        <button onClick={onAdd} disabled={disabled} title={`この${unit}の後ろに白紙の${unit}を追加`}><Ico name="plus" size={14} /> 追加</button>
        <button onClick={onDuplicate} disabled={disabled || index < 0} title={`この${unit}を複製`}><Ico name="copy" size={14} /> 複製</button>
        <button onClick={onRemove} disabled={disabled || (multi ? selectedIds.length >= deck.slides.length : index < 0 || deck.slides.length <= 1)} title={multi ? `選択した${selectedIds.length}枚を削除` : `この${unit}を削除`} aria-label={multi ? `選択した${selectedIds.length}枚を削除` : `この${unit}を削除`}><Ico name="trash" size={14} /></button>
        <button onClick={onFonts} disabled={disabled} title={`雰囲気に合うフォントを ChatGPT に提案してもらい、全${unit}に適用する`}><Ico name="type" size={14} /> フォント</button>
        <button onClick={onPresent} title="1 枚目から画面いっぱいに投影（F5。Shift+F5 で今のスライドから）"><Ico name="monitor" size={14} /> 投影</button>
        <button onClick={onPresentView} title="今のスライドから、別ウィンドウの発表者ビュー（台本・次のスライド・経過時間）付きで投影（Alt+F5）"><Ico name="notes" size={14} /> 発表者ビュー</button>
        <button className="primary" onClick={onExport} disabled={disabled} title="全スライドを 1 つの PowerPoint に書き出す">PPTX で書き出し</button>
        </div>
        <button className="icon" onClick={() => onToggle(!open)} title={open ? `${unit}一覧を畳む` : `${unit}一覧を開く`} aria-label={open ? `${unit}一覧を畳む` : `${unit}一覧を開く`} aria-expanded={open}><Ico name={open ? "chevronDown" : "chevronUp"} size={14} /></button>
      </div>
      <ol
        className={"deck-list" + (dragId ? " dragging" : "")} ref={listRef} inert={!open}
        role="listbox" aria-label={`${unit}一覧`} aria-multiselectable="true"
        onKeyDown={(e) => { if (e.key === "Escape" && selectedIds.length > 0 && !disabled) { e.stopPropagation(); onSelect([]); } }}
        onDragOver={onDragOver}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null); }}
        onDrop={onDrop}
      >
        {deck.slides.map((s, i) => {
          const picked = multi && selectedIds.includes(s.id);
          const sp = s.id === currentId ? currentSpec : slides.get(s.id);
          return (
          <li
            key={s.id}
            draggable={!disabled && deck.slides.length > 1}
            role="presentation"
            className={[
              picked ? "selected" : "",
              s.id === dragId ? "drag-source" : "",
              dropAt === i ? "drop-before" : "",
              dropAt === i + 1 && i === deck.slides.length - 1 ? "drop-after" : "",
            ].filter(Boolean).join(" ") || undefined}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", s.id);
              setDragId(s.id);
            }}
            onDragEnd={endDrag}
          >
            <button
              className="deck-thumb"
              role="option"
              aria-selected={picked || (!multi && s.id === currentId)}
              aria-current={s.id === currentId}
              disabled={disabled && s.id !== currentId}
              onClick={(e) => clickSlide(s.id, e)}
              title={sp?.meta.title ?? s.title}
              style={{ width: thumbW, height: thumbH }}
            >
              {sp && <SpecFrame spec={sp} style={{ width, height, transform: `scale(${thumbH / height})` }} />}
            </button>
            <span className="deck-num">{i + 1}</span>
            {picked && <span className="deck-check" aria-hidden="true">✓</span>}
          </li>
          );
        })}
      </ol>
    </div>
  );
}

/** 横スクロールバーの太さ（オーバーレイ型なら 0）。一度だけ測る */
let barCache: number | undefined;
function scrollbarThickness() {
  if (barCache !== undefined) return barCache;
  const el = document.createElement("div");
  el.className = "deck-list";
  Object.assign(el.style, { position: "absolute", top: "-9999px", width: "100px", height: "100px", overflowX: "scroll", padding: "0" });
  document.body.appendChild(el);
  barCache = el.offsetHeight - el.clientHeight;
  el.remove();
  return barCache;
}
