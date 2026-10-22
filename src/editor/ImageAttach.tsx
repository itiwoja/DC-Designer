import { useRef, useState } from "react";
import { Ico } from "./uiIcons";
import { IMAGE_FILE_ACCEPT } from "./specOps";

export type AttachedImage = { name: string; url: string };

/**
 * 角丸の正方形のタイルに画像を添付する。添付した画像はタイルに収めて並べ、
 * 上限までは末尾に空のタイル（クリック・ドロップで追加）を出す
 */
export function ImageAttach({ images, max, label, caption, onAdd, onRemove, disabled, accept = IMAGE_FILE_ACCEPT }: {
  images: AttachedImage[];
  max: number;
  /** 空のタイルの説明（読み上げ・ツールチップ） */
  label: string;
  /** 空のタイルに出す短い見出し */
  caption?: string;
  onAdd: (files: FileList | File[]) => void;
  onRemove: (index: number) => void;
  disabled?: boolean;
  accept?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const canAdd = !disabled && images.length < max;
  return (
    <div className="attach" aria-label={label} role="group">
      {images.map((img, i) => (
        <div key={img.url + i} className="attach-tile filled">
          <img src={img.url} alt={img.name} title={img.name} />
          <button className="attach-x" aria-label={`${img.name} を外す`} title="外す" disabled={disabled} onClick={() => onRemove(i)}>×</button>
        </div>
      ))}
      {canAdd && (
        <button
          type="button"
          className={"attach-tile empty" + (over ? " over" : "")}
          aria-label={`${label}（${images.length}/${max}）`}
          title={`${label}（${max} 枚まで・ドロップでも追加可）`}
          onClick={() => input.current?.click()}
          onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { setOver(false); if (e.dataTransfer.files.length) { e.preventDefault(); e.stopPropagation(); onAdd(e.dataTransfer.files); } }}
        >
          <Ico name="plus" size={20} />
          {caption && <span className="attach-caption">{caption}</span>}
        </button>
      )}
      <input ref={input} type="file" accept={accept} multiple hidden disabled={disabled} onChange={(e) => { if (e.target.files) onAdd(e.target.files); e.target.value = ""; }} />
    </div>
  );
}
