import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { TextLayerT } from "../schema";
import { resolveColor, resolveFont, type Theme } from "../themes";
import { paintRange, rangeColor, withText } from "../textRuns";

/** SVG の font-weight 属性と同じく、範囲外の値は通常の太さとして扱う */
const cssWeight = (w: number | undefined) => {
  const v = w ?? 700;
  return v >= 1 && v <= 1000 ? v : 400;
};

/**
 * キャンバス上でテキストを直接編集する（Illustrator のテキスト編集モード相当）。
 * 描画はあくまで SVG 側に任せ、その上に文字色を透明にした textarea を重ねて
 * キャレットと選択範囲だけを見せる。overlay の <svg> 内（ポスター座標系）に置く。
 */
export function TextEditor({ layer, theme, svg, at, px, onChange, onDone }: {
  layer: TextLayerT;
  theme: Theme;
  svg: SVGSVGElement | null;
  /** ダブルクリックした位置（画面座標）。そこにキャレットを置く。未指定なら全選択 */
  at?: { x: number; y: number };
  /** 画面 1px をポスター座標に換算した値（カラーパレットを画面上で一定の大きさにする） */
  px: number;
  onChange: (patch: Partial<TextLayerT>) => void;
  onDone: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  // 選んでいる文字の範囲。文字を選んでいる間だけ、右上にカラーパレットを出す
  const [sel, setSel] = useState({ start: 0, end: 0 });
  const syncSel = () => {
    const ta = ref.current;
    if (ta && document.activeElement === ta) setSel({ start: ta.selectionStart, end: ta.selectionEnd });
  };
  useEffect(() => {
    document.addEventListener("selectionchange", syncSel);
    return () => document.removeEventListener("selectionchange", syncSel);
  }, []);
  // TextBlock の縮小（fit="shrink"）・斜体変形をそのまま写す
  const [inner, setInner] = useState<{ transform?: string; scale: number }>({ scale: 1 });
  useLayoutEffect(() => {
    const g = svg?.querySelector(`#layer-${CSS.escape(layer.id)} [data-text-block]`);
    if (!g) return;
    const read = () => setInner({ transform: g.getAttribute("transform") ?? undefined, scale: Number(g.getAttribute("data-fit-scale")) || 1 });
    read();
    const mo = new MutationObserver(read);
    mo.observe(g, { attributes: true, attributeFilter: ["transform", "data-fit-scale"] });
    return () => mo.disconnect();
  }, [svg, layer.id]);

  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.focus({ preventScroll: true });
    const pos = at && (document as any).caretPositionFromPoint?.(at.x, at.y);
    if (pos && pos.offsetNode === ta) ta.setSelectionRange(pos.offset, pos.offset);
    else ta.select();
    syncSel();
    // 外側を押したら編集を終える（押した先のレイヤー選択などはそのまま効かせる）
    const outside = (e: PointerEvent) => { if (e.target !== ta && !paletteRef.current?.contains(e.target as Node)) onDone(); };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const size = layer.size ?? 32;
  const lh = layer.lineHeight ?? 1.25;
  const fontFamily = resolveFont(layer.font, theme, cssWeight(layer.weight));
  const fontWeight = cssWeight(layer.weight);
  // SVG は 1 行目のベースラインを size*0.88 に置く。CSS の行ボックスでのベースライン位置との差だけずらす
  const offset = (() => {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return 0;
    ctx.font = `${fontWeight} ${size}px ${fontFamily}`;
    const m = ctx.measureText("あA");
    const asc = m.fontBoundingBoxAscent ?? size * 0.88, desc = m.fontBoundingBoxDescent ?? size * 0.12;
    return size * 0.88 - ((size * lh - (asc + desc)) / 2 + asc);
  })();

  const w = layer.w / inner.scale, h = layer.h / inner.scale;
  const hasSel = sel.end > sel.start && sel.end <= layer.text.length;
  const paint = (color: string | null) => {
    const runs = paintRange(layer.colorRuns, layer.text, sel.start, sel.end, color);
    onChange({ colorRuns: runs.length ? runs : undefined });
  };
  // 回転していても枠の右上（画面上の見た目の右上）に出す
  const rad = ((layer.rotation ?? 0) * Math.PI) / 180;
  const ex = Math.abs((layer.w / 2) * Math.cos(rad)) + Math.abs((layer.h / 2) * Math.sin(rad));
  const ey = Math.abs((layer.w / 2) * Math.sin(rad)) + Math.abs((layer.h / 2) * Math.cos(rad));
  const corner = { x: layer.x + layer.w / 2 + ex, y: layer.y + layer.h / 2 - ey };
  return (<>
    <g transform={`translate(${layer.x} ${layer.y}) rotate(${layer.rotation ?? 0} ${layer.w / 2} ${layer.h / 2})`}>
      <g transform={inner.transform}>
        {/* 行が枠からはみ出しても打てるよう、表示領域は広めにとる */}
        <foreignObject x={0} y={offset} width={w} height={Math.max(h, size * lh * (layer.text.split("\n").length + 1))} style={{ overflow: "visible" }}>
          <textarea
            ref={ref}
            className="text-edit"
            value={layer.text}
            spellCheck={false}
            onChange={(e) => { onChange(withText(layer, e.target.value)); syncSel(); }}
            onSelect={syncSel}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Escape" || ((e.ctrlKey || e.metaKey) && e.key === "Enter")) { e.preventDefault(); onDone(); }
            }}
            style={{
              fontFamily, fontSize: size, fontWeight, lineHeight: `${size * lh}px`,
              letterSpacing: layer.letterSpacing ? `${layer.letterSpacing}em` : undefined,
              textAlign: layer.align ?? "left",
            }}
          />
        </foreignObject>
      </g>
    </g>
    {hasSel && (
      // 中身は画面の px で組み、ポスター座標の縮尺を打ち消して一定の大きさで出す（右下を枠の右上に合わせる）
      <foreignObject x={corner.x - PALETTE_BOX.w * px} y={corner.y - (PALETTE_BOX.h + 8) * px} width={PALETTE_BOX.w * px} height={PALETTE_BOX.h * px} style={{ overflow: "visible" }}>
        <div className="text-palette-box" style={{ width: PALETTE_BOX.w, height: PALETTE_BOX.h, transform: `scale(${px})` }}>
          <ColorPalette
            ref={paletteRef}
            theme={theme}
            current={rangeColor(layer.colorRuns, layer.text, sel.start, sel.end)}
            onPick={paint}
            onPickerClosed={() => { ref.current?.focus({ preventScroll: true }); ref.current?.setSelectionRange(sel.start, sel.end); }}
          />
        </div>
      </foreignObject>
    )}
  </>);
}

/** パレットを置く領域（画面 px）。パレットはこの右下に寄せる */
const PALETTE_BOX = { w: 320, h: 120 };

/** パレットに並べる色。テーマの色はトークンのまま入れ、テーマを切り替えると一緒に変わるようにする */
const SWATCHES = ["$ink", "$primary", "$secondary", "$accent", "$highlight", "$inkInverse", "#e5383b", "#000000"];

const ColorPalette = forwardRef<HTMLDivElement, {
  theme: Theme;
  /** 選択範囲の今の色（全体の色のままなら null、混ざっていれば undefined） */
  current: string | null | undefined;
  onPick: (color: string | null) => void;
  onPickerClosed: () => void;
}>(function ColorPalette({ theme, current, onPick, onPickerClosed }, ref) {
  // 同じ色に解決されるものは 1 つにまとめる
  const seen = new Set<string>();
  const swatches = SWATCHES.filter((c) => {
    const v = resolveColor(c, theme).toLowerCase();
    if (seen.has(v)) return false;
    seen.add(v);
    return true;
  });
  const resolved = current ? resolveColor(current, theme) : undefined;
  // 色の選択ダイアログを閉じたら（change は確定時だけ届く）テキストの編集に戻す
  const pickerRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = pickerRef.current;
    el?.addEventListener("change", onPickerClosed);
    return () => el?.removeEventListener("change", onPickerClosed);
  }, [onPickerClosed]);
  // ボタンを押してもテキストのフォーカス（選択範囲）を外さない
  const keep = (e: ReactPointerEvent | ReactMouseEvent) => { e.preventDefault(); e.stopPropagation(); };
  return (
    <div className="text-palette" ref={ref} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {swatches.map((c) => (
        <button
          key={c} type="button" className={"swatch" + (current === c ? " on" : "")} style={{ background: resolveColor(c, theme) }}
          title={c.startsWith("$") ? `テーマの色 ${c}` : c}
          onPointerDown={keep} onMouseDown={keep} onClick={() => onPick(c)}
        />
      ))}
      <label className="swatch custom" title="ほかの色を選ぶ" style={resolved && !swatches.includes(current!) ? { background: resolved } : undefined}>
        <input
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(resolved ?? "") ? resolved : "#e5383b"}
          ref={pickerRef}
          onChange={(e) => onPick(e.target.value)}
        />
      </label>
      <button type="button" className="swatch clear" title="部分色を外す（全体の色に戻す）" onPointerDown={keep} onMouseDown={keep} onClick={() => onPick(null)} />
    </div>
  );
});
