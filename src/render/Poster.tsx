import { forwardRef, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import type { Layer, PosterSpec } from "../schema";
import { resolveColor, resolveTheme, type Theme } from "../themes";
import { RENDERERS } from "../components";
import { TextBlock } from "./TextBlock";
import { ImageBox } from "./ImageBox";
import { blobPath, paintToSvg } from "./paint";

export interface PosterProps {
  spec: PosterSpec;
  /** レイヤー上で pointerdown されたとき（エディタ用） */
  onLayerPointerDown?: (e: RPointerEvent, layer: Layer) => void;
  /** 書き出し時などに特定レイヤーだけ描画したい場合 */
  only?: string;
  /**
   * SVG の定義（グラデーション・影・切り抜きなど）の id の前に付ける文字列。
   * 同じページに別の Poster（エディタのキャンバスなど）があると url(#id) がそちらを指してしまうので、2 つ目以降の描画では付ける
   */
  idPrefix?: string;
}

function renderLayerBody(layer: Layer, theme: Theme, spec: PosterSpec, props: PosterProps): ReactNode {
  const { w, h } = layer;
  const id = (props.idPrefix ?? "") + layer.id;
  switch (layer.type) {
    case "background": {
      const { fill, def } = paintToSvg(layer.fill, theme, `${id}-bg`);
      return (
        <>
          <defs>{def}</defs>
          <rect width={spec.meta.width} height={spec.meta.height} fill={fill} />
        </>
      );
    }
    case "shape": {
      const { fill, def } = paintToSvg(layer.fill, theme, `${id}-f`);
      const stroke = layer.stroke ? resolveColor(layer.stroke, theme) : undefined;
      const sp = { fill, stroke, strokeWidth: layer.strokeWidth, fillRule: layer.fillRule, filter: layer.blur ? `url(#${id}-blur)` : undefined };
      let el: ReactNode;
      if (layer.shape === "rect") el = <rect width={w} height={h} rx={layer.radius} {...sp} />;
      else if (layer.shape === "ellipse") el = <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} {...sp} />;
      else if (layer.shape === "blob") el = <path d={blobPath(w, h, layer.seed ?? 1)} {...sp} />;
      else
        el = (
          <g transform={`scale(${w} ${h})`}>
            <path d={layer.d ?? ""} {...sp} vectorEffect="non-scaling-stroke" />
          </g>
        );
      return (
        <>
          <defs>
            {def}
            {layer.blur ? (
              <filter id={`${id}-blur`} x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation={layer.blur} />
              </filter>
            ) : null}
          </defs>
          {el}
        </>
      );
    }
    case "text":
      return (
        <TextBlock
          id={id} text={layer.text} w={w} h={h} theme={theme} font={layer.font} size={layer.size} weight={layer.weight}
          lineHeight={layer.lineHeight} letterSpacing={layer.letterSpacing} align={layer.align} fill={layer.fill}
          colorRuns={layer.colorRuns} outlines={layer.outlines} skewX={layer.skewX} fit={layer.fit}
        />
      );
    case "image":
      return <ImageBox id={id} src={layer.src} asset={layer.asset} w={w} h={h} fit={layer.fit} crop={layer.crop} radius={layer.radius} blur={layer.blur} />;
    case "component": {
      const r = RENDERERS[layer.component];
      if (!r) return <rect width={w} height={h} fill="none" stroke="red" strokeDasharray="6 4" />;
      return r(layer.props ?? {}, { id, w, h, theme });
    }
    case "group":
      return layer.children.map((c) => <LayerView key={c.id} layer={c} theme={theme} spec={spec} props={props} />);
  }
}

function LayerView({ layer, theme, spec, props }: { layer: Layer; theme: Theme; spec: PosterSpec; props: PosterProps }) {
  if (layer.visible === false) return null;
  if (layer.themes && !layer.themes.includes(spec.theme)) return null;
  const isBg = layer.type === "background";
  const x = isBg ? 0 : layer.x;
  const y = isBg ? 0 : layer.y;
  const transform = `translate(${x} ${y})${layer.rotation ? ` rotate(${layer.rotation} ${layer.w / 2} ${layer.h / 2})` : ""}`;
  const sh = layer.shadow;
  const shadowId = `${props.idPrefix ?? ""}${layer.id}-shadow`;
  return (
    <g
      id={`${props.idPrefix ?? ""}layer-${layer.id}`}
      data-layer-id={layer.id}
      data-layer-name={layer.name ?? layer.id}
      data-locked={layer.locked ? "true" : undefined}
      transform={transform}
      opacity={layer.opacity}
      style={layer.blend ? { mixBlendMode: layer.blend as any } : undefined}
      filter={sh ? `url(#${shadowId})` : undefined}
      onPointerDown={props.onLayerPointerDown ? (e) => props.onLayerPointerDown!(e, layer) : undefined}
    >
      {sh && (
        <defs>
          <filter id={shadowId} x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx={sh.dx ?? 0} dy={sh.dy ?? 4} stdDeviation={sh.blur ?? 6} floodColor={resolveColor(sh.color ?? "rgba(0,0,0,0.35)", theme)} />
          </filter>
        </defs>
      )}
      {/* 文字は字形にしか当たり判定がないため、エディタでは枠全体で掴めるようにする（書き出しでは除去） */}
      {props.onLayerPointerDown && layer.type === "text" && (
        <rect width={layer.w} height={layer.h} fill="none" pointerEvents="all" data-editor-only="true" />
      )}
      {renderLayerBody(layer, theme, spec, props)}
    </g>
  );
}

export const Poster = forwardRef<SVGSVGElement, PosterProps>(function Poster(props, ref) {
  const { spec, only } = props;
  const theme = resolveTheme(spec.theme, spec.themeOverride);
  const { width, height } = spec.meta;
  const layers = only ? spec.layers.filter((l) => l.id === only) : spec.layers;
  const clipId = `${props.idPrefix ?? ""}poster-clip`;
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      xmlnsXlink="http://www.w3.org/1999/xlink"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      style={{ display: "block", width: "100%", height: "auto" }}
    >
      <clipPath id={clipId}>
        <rect width={width} height={height} />
      </clipPath>
      <g data-poster-layers="" clipPath={`url(#${clipId})`}>
        {layers.map((l) => (
          <LayerView key={l.id} layer={l} theme={theme} spec={spec} props={props} />
        ))}
      </g>
    </svg>
  );
});
