import { useRef } from "react";
import { Ico } from "./uiIcons";

/** 読み上げの速さの目安（1 分あたりの文字数。日本語のプレゼンでおよそ 300 字） */
const CHARS_PER_MIN = 300;

/** 台本を読み上げるのにかかる時間の目安（「約 40 秒」「約 1 分 30 秒」） */
export function readingTime(text: string): string | null {
  const n = text.replace(/\s/g, "").length;
  if (!n) return null;
  const sec = Math.max(5, Math.round((n / CHARS_PER_MIN) * 60 / 5) * 5);
  return sec < 60 ? `約 ${sec} 秒` : `約 ${Math.floor(sec / 60)} 分${sec % 60 ? ` ${sec % 60} 秒` : ""}`;
}

/**
 * PPTX エディターモードの台本（スライドのノート）欄。キャンバスとスライド一覧の間の帯。
 * 畳むと見出しと 1 行目だけの細い帯になる。入力はフォーカスしている間を 1 手として Undo に積む
 */
export function NotesPanel({ notes, open, onToggle, onChange, missing, canWrite, onWriteMissing }: {
  notes: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  /** coalesce: 同じ値の間の入力は Undo で 1 手にまとめる */
  onChange: (notes: string, coalesce: string) => void;
  /** 台本が空のスライドの枚数（デッキ全体） */
  missing: number;
  /** AI が使えて、ほかの処理をしていないか */
  canWrite: boolean;
  /** 台本が空のスライドに AI で台本を書く */
  onWriteMissing: () => void;
}) {
  const session = useRef("notes");
  const textRef = useRef<HTMLTextAreaElement>(null);
  const time = readingTime(notes);
  const firstLine = notes.trim().split("\n")[0];
  const expand = () => {
    onToggle(true);
    requestAnimationFrame(() => textRef.current?.focus());
  };
  return (
    <div className={"notes-panel" + (open ? "" : " collapsed")} role="region" aria-label="台本">
      <div className="notes-head" onClick={open ? undefined : expand}>
        <strong><Ico name="notes" size={14} /> 台本</strong>
        {!open && <span className="notes-preview">{firstLine || "クリックしてこのスライドで話す内容を書く"}</span>}
        <span className="spacer" />
        {missing > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); onWriteMissing(); }} disabled={!canWrite}
            title="台本が空のスライドに、デッキ全体の流れを踏まえた台本を ChatGPT に書いてもらう（チャットの /notes と同じ。書いてある台本はそのまま）"
          >
            <Ico name="sparkles" size={14} /> 台本の無い {missing} 枚に書く
          </button>
        )}
        {time && <span className="notes-time" title={`${CHARS_PER_MIN} 字/分で読み上げたときの目安`}>{time}</span>}
        <button
          className="icon" onClick={(e) => { e.stopPropagation(); onToggle(!open); }}
          title={open ? "台本を畳む" : "台本を開く"} aria-label={open ? "台本を畳む" : "台本を開く"} aria-expanded={open}
        >
          <Ico name={open ? "chevronDown" : "chevronUp"} size={14} />
        </button>
      </div>
      <textarea
        ref={textRef}
        className="notes-text"
        inert={!open}
        value={notes}
        placeholder="このスライドで話す内容（スライドショーで T キーを押すと表示。PPTX ではノートとして書き出します）"
        aria-label="このスライドの台本"
        onFocus={() => { session.current = `notes-${Date.now()}`; }}
        onChange={(e) => onChange(e.target.value, session.current)}
        onKeyDown={(e) => { if (e.key === "Escape") e.currentTarget.blur(); }}
      />
    </div>
  );
}
