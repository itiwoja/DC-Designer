import { useState } from "react";
import type { Layer, PosterSpec } from "../schema";
import { findPendingAssets } from "../schema";
import { CATALOG, CATALOG_BY_NAME } from "../components/catalog";
import { Ico } from "./uiIcons";

export const TYPE_LABEL: Record<Layer["type"], string> = {
  background: "背景", shape: "図形", text: "テキスト", image: "画像", component: "パーツ", group: "グループ",
};
const TYPE_GLYPH: Record<Layer["type"], string> = {
  background: "▦", shape: "◆", text: "T", image: "▣", component: "❖", group: "⧉",
};

interface Props {
  spec: PosterSpec;
  selectedIds: string[];
  hovered: string | null;
  generatingIds: Set<string>;
  /** additive: Shift / Ctrl+クリックで選択に足す・外す */
  onSelect: (id: string, additive: boolean) => void;
  onHover: (id: string | null) => void;
  onUpdate: (id: string, patch: Partial<Layer>) => void;
  /** id のレイヤーを target の前面(above=true)/背面に移動 */
  onMoveTo: (id: string, targetId: string, above: boolean) => void;
  onAddText: () => void;
  onAddImage: () => void;
  onAddComponent: (name: string) => void;
  /** PPTX モード: レイヤー id → アニメーションの再生順 */
  animOrder?: Map<string, number>;
}

export function LayersPanel({ spec, selectedIds, hovered, generatingIds, onSelect, onHover, onUpdate, onMoveTo, onAddText, onAddImage, onAddComponent, animOrder }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; above: boolean } | null>(null);

  return (
    <section className="panel grow">
      <h3><Ico name="layers" /> レイヤー <span className="count">{spec.layers.length}</span></h3>
      <div className="add-row">
        <button onClick={onAddText}><Ico name="type" size={14} /> 文字</button>
        <button onClick={onAddImage}><Ico name="image" size={14} /> 画像</button>
        <select value="" onChange={(e) => e.target.value && onAddComponent(e.target.value)} aria-label="パーツを追加">
          <option value="">＋パーツ…</option>
          {CATALOG.map((c) => <option key={c.name} value={c.name}>{c.label}</option>)}
        </select>
      </div>
      <ul className="layers" role="listbox" aria-label="レイヤー一覧（上が前面）" aria-multiselectable onPointerLeave={() => onHover(null)}>
        {[...spec.layers].reverse().map((l) => {
          const isPending = findPendingAssets({ ...spec, layers: [l] }).length > 0;
          const isGen = generatingIds.has(l.id);
          const themeHidden = !!l.themes && !l.themes.includes(spec.theme);
          const hidden = l.visible === false || themeHidden;
          const isSel = selectedIds.includes(l.id);
          const cls = [
            isSel && "sel", l.id === hovered && !isSel && "hover", hidden && "hidden",
            dragId === l.id && "dragging", drop?.id === l.id && (drop.above ? "drop-above" : "drop-below"),
          ].filter(Boolean).join(" ");
          const label = l.name ?? l.id;
          return (
            <li
              key={l.id}
              role="option"
              aria-selected={isSel}
              className={cls}
              draggable={renaming !== l.id}
              onClick={(e) => onSelect(l.id, e.shiftKey || e.ctrlKey || e.metaKey)}
              onPointerEnter={() => onHover(l.id)}
              onDragStart={(e) => { setDragId(l.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", l.id); }}
              onDragOver={(e) => {
                if (!dragId || dragId === l.id) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                setDrop({ id: l.id, above: e.clientY < r.top + r.height / 2 });
              }}
              onDragLeave={() => setDrop((d) => (d?.id === l.id ? null : d))}
              onDrop={(e) => { e.preventDefault(); if (dragId && drop) onMoveTo(dragId, drop.id, drop.above); setDrop(null); setDragId(null); }}
              onDragEnd={() => { setDrop(null); setDragId(null); }}
              title={themeHidden ? `テーマ「${l.themes!.join(", ")}」のときだけ表示` : undefined}
            >
              <span className="glyph" aria-hidden>{TYPE_GLYPH[l.type]}</span>
              {renaming === l.id ? (
                <input
                  className="rename"
                  autoFocus
                  defaultValue={label}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") { e.currentTarget.value = label; e.currentTarget.blur(); }
                  }}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== label) onUpdate(l.id, { name: v }); setRenaming(null); }}
                />
              ) : (
                <span className="lname" onDoubleClick={(e) => { e.stopPropagation(); setRenaming(l.id); }} title="ダブルクリックで名前を変更">{label}</span>
              )}
              {animOrder?.has(l.id) && <span className="badge anim" title={`アニメーション ${animOrder.get(l.id)} 番目`}>▶{animOrder.get(l.id)}</span>}
              {isGen ? <span className="badge gen">生成中</span>
                : isPending ? <span className="badge pending" title="画像が未生成です">未生成</span>
                : <span className="ltype">{l.type === "component" ? CATALOG_BY_NAME[l.component]?.label ?? l.component : TYPE_LABEL[l.type]}</span>}
              <button
                className={"icon" + (l.locked ? " on" : "")}
                title={l.locked ? "ロック解除" : "ロック"}
                aria-label={l.locked ? `${label} のロックを解除` : `${label} をロック`}
                aria-pressed={!!l.locked}
                onClick={(e) => { e.stopPropagation(); onUpdate(l.id, { locked: !l.locked }); }}
              ><Ico name={l.locked ? "lock" : "unlock"} size={14} /></button>
              <button
                className={"icon" + (l.visible === false ? " on" : "")}
                title={l.visible === false ? "表示する" : "非表示にする"}
                aria-label={l.visible === false ? `${label} を表示` : `${label} を非表示`}
                aria-pressed={l.visible === false}
                onClick={(e) => { e.stopPropagation(); onUpdate(l.id, { visible: l.visible === false }); }}
              ><Ico name={l.visible === false ? "eyeOff" : "eye"} size={14} /></button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
