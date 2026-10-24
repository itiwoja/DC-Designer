import { useRef, useState, type DragEvent } from "react";
import { hasFiles } from "./fileDrop";

/**
 * 要素をファイルのドロップ先にする。返した props をその要素に広げ、over でドロップできる状態の見た目を切り替える。
 * 子要素をまたぐたびに dragleave が飛ぶので、enter / leave を数えて over を安定させる。
 * ドロップは内側の要素が受け取ったら外側へは伝えない（ネストしたドロップ先で二重に取り込まない）
 */
export function useFileDrop(onFiles: (files: File[], e: DragEvent) => void, { disabled = false, effect = "copy" as DataTransfer["dropEffect"] } = {}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const reset = () => { depth.current = 0; setOver(false); };
  const props = {
    onDragEnter: (e: DragEvent) => {
      if (disabled || !hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (e: DragEvent) => {
      if (disabled || !hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = effect;
    },
    onDragLeave: (e: DragEvent) => {
      if (disabled || !hasFiles(e.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (disabled || !hasFiles(e.dataTransfer)) { reset(); return; }
      e.preventDefault();
      e.stopPropagation();
      reset();
      const files = Array.from(e.dataTransfer.files);
      if (files.length) onFiles(files, e);
    },
  };
  return { over: over && !disabled, props };
}
