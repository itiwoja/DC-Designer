import { useEffect, useMemo, useRef, useState } from "react";
import { ensureWebFont, FONT_CATALOG, FONT_ROLE_LABELS, FONT_SCRIPT_LABELS, fontCovers, type FontEntry, type FontRole, type FontScript } from "../fonts";

export type FontPick = { display?: string; body?: string };

const ROLES = Object.keys(FONT_ROLE_LABELS) as FontRole[];
const SCRIPTS = Object.keys(FONT_SCRIPT_LABELS) as FontScript[];
const SAMPLE: Record<FontScript, string> = { ja: "", kana: "あいうえお アイウエオ ABC", latin: "Design Your Story 2026" };

/** 検索語（空白区切りの AND）。名前・ID・分類・文字・雰囲気のどれかに含まれれば一致 */
function matches(f: FontEntry, query: string) {
  const hay = `${f.family} ${f.id} ${FONT_ROLE_LABELS[f.role]} ${FONT_SCRIPT_LABELS[f.script]} ${f.mood}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/** 画面に入ったときだけ Web フォントを読み込む（121 書体を一度に読まない） */
function FontSample({ family, text, className }: { family: string; text: string; className: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) { ensureWebFont(family); io.disconnect(); }
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [family]);
  return <div ref={ref} className={className} style={{ fontFamily: `'${family}', sans-serif` }}>{text}</div>;
}

/**
 * カタログから見出し・本文のフォントを条件で絞り込んで選ぶ。
 * かな・英数字だけのフォントは、文面に足りない文字があれば注意を出す（その文字は Noto Sans JP で表示される）
 */
export function FontCatalog({ heading, allText, pick, onPick, installed, disabled }: {
  /** プレビューに使う見出し */
  heading: string;
  /** 資料全体の文面（文字が足りるかの判定） */
  allText: string;
  pick: FontPick;
  onPick: (p: FontPick) => void;
  installed: Record<string, boolean> | null;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const [roles, setRoles] = useState<Set<FontRole>>(new Set());
  const [scripts, setScripts] = useState<Set<FontScript>>(new Set());
  const [fitsOnly, setFitsOnly] = useState(false);
  const [boldOnly, setBoldOnly] = useState(false);
  const [installedOnly, setInstalledOnly] = useState(false);

  const toggle = <T,>(set: Set<T>, v: T) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); return n; };
  const list = useMemo(() => FONT_CATALOG.filter((f) =>
    (!roles.size || roles.has(f.role)) &&
    (!scripts.size || scripts.has(f.script)) &&
    (!fitsOnly || fontCovers(f, allText)) &&
    (!boldOnly || f.weights.some((w) => w >= 600)) &&
    (!installedOnly || installed?.[f.family]) &&
    matches(f, query),
  ), [roles, scripts, fitsOnly, boldOnly, installedOnly, installed, query, allText]);
  const count = (pred: (f: FontEntry) => boolean) => FONT_CATALOG.filter(pred).length;
  const reset = () => { setQuery(""); setRoles(new Set()); setScripts(new Set()); setFitsOnly(false); setBoldOnly(false); setInstalledOnly(false); };

  return (
    <div className="font-catalog">
      <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="名前・ID・雰囲気で検索（例: 丸 かわいい / noto / 和風）" aria-label="フォントを検索" />
      <div className="font-filter" role="group" aria-label="分類">
        <span>分類</span>
        {ROLES.map((r) => (
          <button key={r} className={"mood-chip" + (roles.has(r) ? " on" : "")} aria-pressed={roles.has(r)} onClick={() => setRoles(toggle(roles, r))}>
            {FONT_ROLE_LABELS[r]} <small>{count((f) => f.role === r)}</small>
          </button>
        ))}
      </div>
      <div className="font-filter" role="group" aria-label="文字">
        <span>文字</span>
        {SCRIPTS.map((s) => (
          <button key={s} className={"mood-chip" + (scripts.has(s) ? " on" : "")} aria-pressed={scripts.has(s)} onClick={() => setScripts(toggle(scripts, s))}>
            {FONT_SCRIPT_LABELS[s]} <small>{count((f) => f.script === s)}</small>
          </button>
        ))}
      </div>
      <div className="font-filter">
        <label className="check"><input type="checkbox" checked={fitsOnly} onChange={(e) => setFitsOnly(e.target.checked)} /><span>この資料の文字を全部表示できる</span></label>
        <label className="check"><input type="checkbox" checked={boldOnly} onChange={(e) => setBoldOnly(e.target.checked)} /><span>太字あり</span></label>
        <label className="check"><input type="checkbox" checked={installedOnly} onChange={(e) => setInstalledOnly(e.target.checked)} disabled={!installed} /><span>インストール済み</span></label>
      </div>
      <div className="font-count">
        <span>{list.length} / {FONT_CATALOG.length} 書体</span>
        {list.length !== FONT_CATALOG.length && <button className="link" onClick={reset}>条件をクリア</button>}
      </div>

      <div className="font-list" role="list">
        {list.map((f) => {
          const short = !fontCovers(f, allText);
          return (
            <div key={f.id} role="listitem" className={"font-row" + (pick.display === f.family || pick.body === f.family ? " on" : "")}>
              <div className="font-row-head">
                <strong>{f.family}</strong>
                <code className="font-id">{f.id}</code>
                <small>{FONT_ROLE_LABELS[f.role]}・{f.weights.length > 1 ? `${f.weights.length} ウェイト` : "1 ウェイト"}</small>
                {f.script !== "ja" && <span className={"font-badge" + (short ? " warn" : "")} title={short ? "この資料には表示できない文字があります（Noto Sans JP で表示）" : undefined}>{FONT_SCRIPT_LABELS[f.script]}</span>}
                {installed?.[f.family] && <span className="font-badge ok">インストール済み</span>}
              </div>
              <FontSample family={f.family} className="font-row-sample" text={fontCovers(f, heading) && heading ? heading : SAMPLE[f.script] || heading} />
              <div className="font-row-foot">
                <small className="font-mood">{f.mood}</small>
                <button className={pick.display === f.family ? "on" : ""} aria-pressed={pick.display === f.family} disabled={disabled} onClick={() => onPick({ ...pick, display: f.family })}>見出し</button>
                <button className={pick.body === f.family ? "on" : ""} aria-pressed={pick.body === f.family} disabled={disabled} onClick={() => onPick({ ...pick, body: f.family })}>本文</button>
              </div>
            </div>
          );
        })}
        {!list.length && <p className="empty">条件に合うフォントがありません。</p>}
      </div>
    </div>
  );
}
