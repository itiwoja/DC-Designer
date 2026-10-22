import { useEffect, useMemo, useState } from "react";
import type { Layer, PosterSpec } from "../schema";
import { cropTarget } from "../render/ImageBox";
import { Menu } from "./ui";
import { Ico } from "./uiIcons";
import { a4Fit, a4Issues, exportPixels, PRINT_DPI, SAFE_MARGIN_MM, type A4Issue } from "./a4";

/** 画像の src → 本来の画素数。読み込めたものだけ入る */
function useImageSizes(layers: Layer[]) {
  const srcs = useMemo(() => [...new Set(layers.map((l) => cropTarget(l)?.src).filter((s): s is string => !!s))], [layers]);
  const [sizes, setSizes] = useState(() => new Map<string, { w: number; h: number }>());
  useEffect(() => {
    let alive = true;
    for (const src of srcs) {
      if (sizes.has(src)) continue;
      const img = new Image();
      img.onload = () => alive && setSizes((m) => new Map(m).set(src, { w: img.naturalWidth, h: img.naturalHeight }));
      img.src = src;
    }
    return () => { alive = false; };
  }, [srcs]); // eslint-disable-line react-hooks/exhaustive-deps
  return sizes;
}

const fmt = (mm: number) => (Math.round(mm * 10) / 10).toString();

type Props = {
  spec: PosterSpec;
  guide: boolean;
  onGuide: (on: boolean) => void;
  onFix: () => void;
  onSelect: (id: string) => void;
  onPrint: () => void;
  disabled?: boolean;
};

/**
 * A4 チェック（ポスターモードの右上のボタン）。
 * 用紙が A4 か・書き出す PNG の画素数と解像度・印刷で困るレイヤーを一覧にし、
 * A4 にそろえる・印刷ガイドを出す・A4 で印刷プレビューする操作を置く
 */
export function A4Check(props: Props) {
  const { spec } = props;
  const fit = a4Fit(spec.meta.width, spec.meta.height);
  // ボタンの印は画像の解像度を除いて決める（画像は開いたときに読み込んで測る）
  const issues = useMemo(() => a4Issues(spec), [spec]);
  const state = !fit.ok || issues.some((i) => i.level === "error") ? "error" : issues.length ? "warn" : "ok";
  return (
    <Menu trigger={({ open, toggle }) => (
      <button
        className={"icon-btn a4-btn " + state} aria-haspopup="dialog" aria-expanded={open} onClick={toggle} aria-label="A4 チェック"
        title={state === "ok" ? "A4 チェック: 問題ありません" : `A4 チェック: ${!fit.ok ? "A4 の大きさではありません" : `${issues.length} 件の注意があります`}`}
      >
        <Ico name="ruler" />
        {state !== "ok" && <span className="a4-dot" aria-hidden />}
      </button>
    )}>
      {(close) => <A4Panel {...props} close={close} />}
    </Menu>
  );
}

function A4Panel(props: Props & { close: () => void }) {
  const { spec, close } = props;
  const W = spec.meta.width, H = spec.meta.height;
  const fit = a4Fit(W, H);
  const out = exportPixels(W, H);
  const sizes = useImageSizes(spec.layers);
  const issues = useMemo(() => a4Issues(spec, sizes), [spec, sizes]);
  const errors = issues.filter((i) => i.level === "error").length;
  const orient = fit.orientation === "portrait" ? "縦" : "横";
  return (
    <div className="menu-list a4-check" role="dialog" aria-label="A4 チェック">
      <h3>A4 チェック</h3>
      <dl className="a4-rows">
        <div className={fit.ok ? "ok" : "error"}>
          <dt><Ico name={fit.ok ? "check" : "alert"} size={14} /> 用紙</dt>
          <dd>
            {fit.ok
              ? <>A4 {orient}（{fit.page.w}×{fit.page.h}mm）</>
              : <>A4 ではありません。幅を A4 にすると {fmt(fit.page.w)}×{fmt(fit.heightMm)}mm（A4 は {fit.page.w}×{fit.page.h}mm）</>}
            <small>キャンバス {W}×{H}・縦横比 1:{fit.ratio.toFixed(3)}（A4 は 1:1.414）</small>
            {!fit.ok && <button className="small" onClick={props.onFix} disabled={props.disabled}>A4 {orient}にそろえる</button>}
          </dd>
        </div>
        <div className={fit.ok ? "ok" : "warn"}>
          <dt><Ico name={fit.ok ? "check" : "alert"} size={14} /> 書き出し</dt>
          <dd>
            PNG {out.w}×{out.h}px・{PRINT_DPI}dpi
            <small>{fit.ok ? `印刷すると ${fit.page.w}×${fit.page.h}mm になります` : `印刷すると ${fmt(fit.page.w)}×${fmt((out.h / PRINT_DPI) * 25.4)}mm になり、A4 に合いません`}</small>
          </dd>
        </div>
        <div className={errors ? "error" : issues.length ? "warn" : "ok"}>
          <dt><Ico name={issues.length ? "alert" : "check"} size={14} /> 印刷</dt>
          <dd>
            {issues.length ? `${issues.length} 件の注意（クリックで選択）` : "切れる・読みにくい・粗い要素はありません"}
            <small>文字と部品は端から {SAFE_MARGIN_MM}mm 内側に、文字は 7pt 以上、画像は 150dpi 以上か見ています</small>
          </dd>
        </div>
      </dl>
      {issues.length > 0 && (
        <ul className="a4-issues">
          {issues.map((i: A4Issue) => (
            <li key={`${i.kind}-${i.layerId}`} className={i.level}>
              <button onClick={() => { props.onSelect(i.layerId); close(); }}>
                <strong>{i.name}</strong><span>{i.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="a4-toggle">
        <input type="checkbox" checked={props.guide} onChange={(e) => props.onGuide(e.target.checked)} />
        キャンバスに印刷ガイド（端 {SAFE_MARGIN_MM}mm の線）を出す
      </label>
      <button className="a4-print" onClick={() => { props.onPrint(); close(); }} disabled={props.disabled}>
        <Ico name="printer" /> A4 {orient}（{fit.page.w}×{fit.page.h}mm）で印刷プレビュー
      </button>
    </div>
  );
}
