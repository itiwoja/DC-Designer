import type { ReactNode, PointerEvent as RPointerEvent } from "react";
import type { ImageCrop, Layer } from "../schema";
import { cropRect, type cropTarget } from "../render/ImageBox";
import { HANDLES, HANDLE_CURSORS, unionBox, type Guide, type Handle } from "./canvas";

type Rect = { x: number; y: number; w: number; h: number };
export type CropState = { layer: Layer; info: NonNullable<ReturnType<typeof cropTarget>>; ratio?: number };

export const DEFAULT_CROP: ImageCrop = { scale: 1, x: 0, y: 0 };

/** レイヤーの枠（位置・回転）に合わせる transform */
const boxTransform = (l: Layer) => `translate(${l.x} ${l.y}) rotate(${l.rotation ?? 0} ${l.w / 2} ${l.h / 2})`;

/**
 * ポスターの上に重ねる編集用の SVG（ガイド・生成中・変更ハイライト・ホバー・選択枠・ハンドル・トリミング）。
 * px は画面 1px をポスター座標に換算した値（ハンドルなどを画面上で一定の大きさにする）
 */
export function CanvasOverlay(props: {
  width: number;
  height: number;
  px: number;
  layers: Layer[];
  guides: Guide[];
  generatingIds: Set<string>;
  flash: string[];
  hovered: Layer | null;
  selected: Layer | null;
  selection: Layer[];
  marquee: Rect | null;
  interacting: boolean;
  editing: boolean;
  crop: CropState | null;
  /** 印刷ガイド（A4 チェック）。端から margin（ポスター座標）内側の線 */
  printGuide?: { margin: number } | null;
  onRotateDown: (e: RPointerEvent) => void;
  onResizeDown: (e: RPointerEvent, handle: Handle) => void;
  children?: ReactNode;
}) {
  const { width: W, height: H, px, layers, selected, selection, crop, interacting } = props;
  const multi = selection.length > 1;
  return (
    <svg className="overlay" viewBox={`0 0 ${W} ${H}`}>
      {props.printGuide && (
        <g className="print-guide">
          <rect className="trim" width={W} height={H} />
          <rect className="safe" x={props.printGuide.margin} y={props.printGuide.margin} width={W - props.printGuide.margin * 2} height={H - props.printGuide.margin * 2} />
        </g>
      )}
      {props.guides.map((g, i) => g.axis === "x"
        ? <line key={i} className="guide" x1={g.pos} x2={g.pos} y1={0} y2={H} />
        : <line key={i} className="guide" y1={g.pos} y2={g.pos} x1={0} x2={W} />)}
      {layers.filter((l) => props.generatingIds.has(l.id)).map((l) => (
        <g key={`gen-${l.id}`} transform={boxTransform(l)} className="gen-mark">
          <rect width={l.w} height={l.h} />
          <text x={l.w / 2} y={l.h / 2} fontSize={13 * px} textAnchor="middle" dominantBaseline="middle">生成中…</text>
        </g>
      ))}
      {props.flash.map((id) => { const l = layers.find((x) => x.id === id); return l && <rect key={`f-${id}`} className="flash" transform={boxTransform(l)} width={l.w} height={l.h} />; })}
      {props.hovered && !selection.some((l) => l.id === props.hovered!.id) && !interacting && props.hovered.type !== "background" && (
        <rect className="hover-box" transform={boxTransform(props.hovered)} width={props.hovered.w} height={props.hovered.h} />
      )}
      {multi && <MultiSelection layers={selection} px={px} resizable={!interacting && !props.marquee && !props.editing && !crop} onResizeDown={props.onResizeDown} />}
      {props.marquee && <rect className="marquee" x={props.marquee.x} y={props.marquee.y} width={props.marquee.w} height={props.marquee.h} />}
      {crop && <CropFrame crop={crop} />}
      {selected && selected.type !== "background" && !crop && (
        <g transform={boxTransform(selected)}>
          <rect className={"sel-box" + (selected.locked ? " locked" : "") + (props.editing ? " editing" : "")} width={selected.w} height={selected.h} />
          {!selected.locked && !interacting && !props.editing && (
            <>
              <line className="rot-stem" x1={selected.w / 2} x2={selected.w / 2} y1={0} y2={-24 * px} />
              <circle className="handle rot" cx={selected.w / 2} cy={-24 * px} r={6 * px} onPointerDown={props.onRotateDown}>
                <title>ドラッグで回転（Shift で 15° 刻み）</title>
              </circle>
              {HANDLES.map((h) => (
                <rect
                  key={h.join()}
                  className="handle"
                  x={((h[0] + 1) / 2) * selected.w - 5 * px}
                  y={((h[1] + 1) / 2) * selected.h - 5 * px}
                  width={10 * px}
                  height={10 * px}
                  style={{ cursor: HANDLE_CURSORS[h.join()] }}
                  onPointerDown={(e) => props.onResizeDown(e, h)}
                />
              ))}
            </>
          )}
        </g>
      )}
      {props.children}
    </svg>
  );
}

function MultiSelection({ layers, px, resizable, onResizeDown }: { layers: Layer[]; px: number; resizable: boolean; onResizeDown: (e: RPointerEvent, handle: Handle) => void }) {
  const targets = layers.filter((l) => !l.locked && l.type !== "background");
  const b = unionBox(targets.length ? targets : layers);
  return <>
    {layers.map((l) => <rect key={`sel-${l.id}`} className={"sel-box member" + (l.locked ? " locked" : "")} transform={boxTransform(l)} width={l.w} height={l.h} />)}
    <rect className="sel-group" x={b.x} y={b.y} width={b.w} height={b.h} />
    {resizable && targets.length > 0 && HANDLES.map((h) => (
      <rect key={h.join()} className="handle" data-selection-resize={h.join()}
        x={b.x + (h[0] + 1) * b.w / 2 - 5 * px} y={b.y + (h[1] + 1) * b.h / 2 - 5 * px}
        width={10 * px} height={10 * px} style={{ cursor: HANDLE_CURSORS[h.join()] }}
        onPointerDown={(e) => onResizeDown(e, h)}>
        <title>{h[0] && h[1] ? "ドラッグで選択全体を拡大・縮小（縦横比を保持）" : "ドラッグで選択全体をこの向きに伸び縮み"}</title>
      </rect>
    ))}
  </>;
}

/** トリミング中の枠と、枠からはみ出して見えない部分のうっすら表示 */
function CropFrame({ crop: { layer: l, info, ratio } }: { crop: CropState }) {
  const r = cropRect(l.w, l.h, { ...(info.crop ?? DEFAULT_CROP), ...(ratio ? { ratio } : {}) }, info.fit);
  const frame = (props: { className?: string; fill?: string }) => info.ellipse
    ? <ellipse cx={l.w / 2} cy={l.h / 2} rx={l.w / 2} ry={l.h / 2} {...props} />
    : <rect width={l.w} height={l.h} rx={info.radius} {...props} />;
  return (
    <g transform={boxTransform(l)} className="crop-mode">
      <mask id="crop-ghost-mask" maskUnits="userSpaceOnUse" x={r.x} y={r.y} width={r.w} height={r.h}>
        <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="#fff" />
        {frame({ fill: "#000" })}
      </mask>
      <image className="crop-ghost" href={info.src} x={r.x} y={r.y} width={r.w} height={r.h} mask="url(#crop-ghost-mask)"
        preserveAspectRatio={info.fit === "contain" ? "xMidYMid meet" : "xMidYMid slice"} />
      <rect className="crop-extent" x={r.x} y={r.y} width={r.w} height={r.h} />
      {frame({ className: "crop-frame" })}
    </g>
  );
}

/** 要素の下に出す寸法・状態のラベル（HTML。scale はポスター → 画面の倍率） */
export function MeasureLabel({ box, scale, children }: { box: Rect; scale: number; children: ReactNode }) {
  return <div className="measure" style={{ left: (box.x + box.w / 2) * scale, top: (box.y + box.h) * scale + 10 }}>{children}</div>;
}
