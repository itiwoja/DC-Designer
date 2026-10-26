import { useEffect, useRef, useState } from "react";
import { ensureWebFont, FONT_BY_FAMILY, FONT_CATALOG, FONT_ROLE_LABELS, FONT_SCRIPT_LABELS, fontCovers } from "../fonts";
import type { AiSubject } from "./aiSubject";
import { api, type FontProposal, type FontStatus } from "./api";
import { FontCatalog, type FontPick } from "./FontCatalog";

const MOOD_CHIPS = ["やさしく親しみやすい", "フォーマル・信頼感", "ポップで元気", "和風・伝統", "テック・未来的", "かわいい", "高級感・上品"];
const TARGET_LABELS: Record<FontStatus["target"], string> = { windows: "この PC（Windows）", mac: "この Mac", linux: "この PC" };
/** デッキ（PPTX エディター）とポスターで変わる文言 */
const SUBJECTS = {
  slides: { target: "全スライド", fallback: "見出しのサンプル", installWhy: "書き出した PPTX を PowerPoint で同じ見た目で開くのに必要。PowerPoint を開いている場合は再起動後に反映" },
  instagram: { target: "全画像", fallback: "見出しのサンプル", installWhy: "PNG の書き出しには不要。PC のほかのアプリで同じフォントを使って手直しするときに必要。開いているアプリは再起動後に反映" },
  poster: { target: "このポスター", fallback: "無題のポスター", installWhy: "書き出した SVG をほかのアプリで開いたり、同じフォントで手直ししたりするのに必要。開いているアプリは再起動後に反映" },
} as const;

/**
 * フォント変更: 雰囲気を伝える → ChatGPT が 3 案提案 → 選ぶ（または一覧から条件で絞り込んで選ぶ）→ 未インストールなら PC に入れる → 全スライド（ポスターならその 1 枚）に適用
 */
export function FontDialog({
  kind = "slides", deckName, texts, current, subject, onApply, onError, onClose,
}: {
  kind?: keyof typeof SUBJECTS;
  /** デッキ名（ポスターならタイトル） */
  deckName: string;
  /** 全スライド（ポスター）の文面（提案の材料とプレビュー） */
  texts: string[];
  current: { display?: string; body?: string };
  /** 提案を頼む対象の保存済み作品（製品版の送信確認に出す） */
  subject?: AiSubject;
  onApply: (fonts: { display: string; body: string }) => Promise<void>;
  onError: (e: unknown) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"ai" | "catalog">("ai");
  const [mood, setMood] = useState("");
  const [pick, setPick] = useState<FontPick>(() => ({
    display: current.display && FONT_BY_FAMILY.has(current.display) ? current.display : undefined,
    body: current.body && FONT_BY_FAMILY.has(current.body) ? current.body : undefined,
  }));
  /** 一覧タブで使う、カタログ全体のインストール状況 */
  const [catalogStatus, setCatalogStatus] = useState<FontStatus | null>(null);
  const [proposals, setProposals] = useState<FontProposal[] | null>(null);
  const [picked, setPicked] = useState(0);
  const [installed, setInstalled] = useState<FontStatus | null>(null);
  const [install, setInstall] = useState(true);
  const [phase, setPhase] = useState<null | "suggest" | "install" | "apply">(null);
  const abort = useRef<AbortController | null>(null);

  const sub = SUBJECTS[kind];
  const heading = deckName || texts[0] || sub.fallback;
  const body = texts.find((t) => t.length >= 20 && t !== heading)?.slice(0, 80) ?? "本文のサンプルです。読みやすさと雰囲気を確認できます。";

  const allText = [deckName, ...texts].join("\n");
  useEffect(() => { ensureWebFont(pick.display); ensureWebFont(pick.body); }, [pick]);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (tab !== "catalog" || catalogStatus) return;
    api.fontStatus(FONT_CATALOG.map((f) => f.family)).then(setCatalogStatus).catch(() => {});
  }, [tab, catalogStatus]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !phase) onClose(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [phase, onClose]);

  const suggest = async () => {
    abort.current = new AbortController();
    setPhase("suggest");
    try {
      const r = await api.suggestFonts({ kind, mood, title: deckName, texts: texts.slice(0, 200), current, ...(subject ? { subject } : {}) }, abort.current.signal);
      r.proposals.forEach((p) => { ensureWebFont(p.display); ensureWebFont(p.body); });
      setProposals(r.proposals);
      setPicked(0);
      setInstalled(null);
      const fams = [...new Set(r.proposals.flatMap((p) => [p.display, p.body]))];
      api.fontStatus(fams).then(setInstalled).catch(() => {});
    } catch (e) {
      if (!abort.current?.signal.aborted) onError(e);
    } finally { setPhase(null); }
  };

  /** 適用するフォント（提案タブなら選んだ案、一覧タブなら見出しと本文の両方を選んだとき） */
  const chosen = tab === "ai" ? proposals?.[picked] : pick.display && pick.body ? { display: pick.display, body: pick.body } : undefined;
  const status = tab === "ai" ? installed : catalogStatus;

  const apply = async () => {
    const p = chosen;
    if (!p) return;
    try {
      const missing = [...new Set([p.display, p.body])].filter((f) => status && !status.installed[f]);
      if (install && missing.length) {
        setPhase("install");
        await api.installFonts(missing);
      }
      setPhase("apply");
      await onApply({ display: p.display, body: p.body });
      onClose();
    } catch (e) {
      onError(e);
    } finally { setPhase(null); }
  };

  const badge = (family: string) => {
    if (!installed) return <span className="font-badge">確認中…</span>;
    return installed.installed[family]
      ? <span className="font-badge ok">インストール済み</span>
      : <span className="font-badge warn">未インストール</span>;
  };
  const p = chosen;
  const missing = p && status ? [...new Set([p.display, p.body])].filter((f) => !status.installed[f]) : [];
  /** 文字が足りないフォント（足りない文字は Noto Sans JP で表示される） */
  const short = p ? [...new Set([p.display, p.body])].filter((f) => { const e = FONT_BY_FAMILY.get(f); return e && !fontCovers(e, allText); }) : [];

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !phase && onClose()}>
      <div className="modal font-dialog" role="dialog" aria-modal="true" aria-labelledby="font-dialog-title">
        <h2 id="font-dialog-title">🔤 フォントを変える</h2>
        <div className="tabs" role="tablist" aria-label="フォントの選び方">
          <button role="tab" aria-selected={tab === "ai"} className={tab === "ai" ? "active" : ""} onClick={() => setTab("ai")} disabled={!!phase}>✨ AI に提案してもらう</button>
          <button role="tab" aria-selected={tab === "catalog"} className={tab === "catalog" ? "active" : ""} onClick={() => setTab("catalog")} disabled={!!phase}>🔎 一覧から選ぶ（{FONT_CATALOG.length} 書体）</button>
        </div>
        {tab === "ai" ? <>
        <p className="hint">「{deckName || sub.fallback}」の内容と雰囲気に合う、見出しと本文のフォントの組み合わせを ChatGPT が提案します。選んだフォントは{sub.target}に適用されます。</p>
        <label className="field">
          <span>どんな雰囲気にしたい？（空欄なら内容から判断）</span>
          <textarea rows={2} value={mood} onChange={(e) => setMood(e.target.value)} placeholder="例）高校生向けの説明会なので、明るく親しみやすく。でも子どもっぽすぎない感じ"
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !phase) suggest(); }} />
        </label>
        <div className="mood-chips">
          {MOOD_CHIPS.map((c) => (
            <button key={c} className="mood-chip" disabled={!!phase} onClick={() => setMood((m) => (m.includes(c) ? m : m ? `${m}、${c}` : c))}>{c}</button>
          ))}
        </div>
        <div className="row">
          <button className={proposals ? "" : "primary"} onClick={suggest} disabled={!!phase}>{phase === "suggest" ? "提案を考え中…" : proposals ? "↻ もう一度提案" : "✨ 提案してもらう"}</button>
          {phase === "suggest" && <button onClick={() => abort.current?.abort()}>キャンセル</button>}
        </div>

        {proposals && (
          <div className="font-proposals" role="radiogroup" aria-label="フォントの提案">
            {proposals.map((pr, i) => (
              <label key={i} className={"font-card" + (i === picked ? " on" : "")}>
                <input type="radio" name="font-proposal" checked={i === picked} onChange={() => setPicked(i)} disabled={!!phase} />
                <div className="font-card-head"><strong>{pr.name}</strong><small>{pr.reason}</small></div>
                <div className="font-preview-h" style={{ fontFamily: `'${pr.display}', sans-serif` }}>{heading}</div>
                <div className="font-preview-b" style={{ fontFamily: `'${pr.body}', sans-serif` }}>{body}</div>
                <div className="font-names">
                  <span>見出し: {pr.display}<small>（{FONT_ROLE_LABELS[FONT_BY_FAMILY.get(pr.display)!.role]}）</small> {badge(pr.display)}</span>
                  <span>本文: {pr.body}<small>（{FONT_ROLE_LABELS[FONT_BY_FAMILY.get(pr.body)!.role]}）</small> {badge(pr.body)}</span>
                </div>
              </label>
            ))}
          </div>
        )}

        </> : <>
          <FontCatalog heading={heading} allText={allText} pick={pick} onPick={setPick} installed={catalogStatus?.installed ?? null} disabled={!!phase} />
          <div className="font-card on font-chosen">
            <div className="font-preview-h" style={{ fontFamily: `'${pick.display ?? ""}', 'Noto Sans JP', sans-serif` }}>{heading}</div>
            <div className="font-preview-b" style={{ fontFamily: `'${pick.body ?? ""}', 'Noto Sans JP', sans-serif` }}>{body}</div>
            <div className="font-names">
              <span>見出し: {pick.display ?? "（未選択）"}</span>
              <span>本文: {pick.body ?? "（未選択）"}</span>
            </div>
          </div>
        </>}

        {short.length > 0 && (
          <p className="hint warn-text">{short.map((f) => `${f}（${FONT_SCRIPT_LABELS[FONT_BY_FAMILY.get(f)!.script]}）`).join("・")} に無い文字は Noto Sans JP で表示されます。</p>
        )}

        {p && missing.length > 0 && (
          <label className="check">
            <input type="checkbox" checked={install} onChange={(e) => setInstall(e.target.checked)} disabled={!!phase} />
            <span>{missing.join("・")} を{TARGET_LABELS[status!.target]}にインストールする（Google Fonts から取得。{sub.installWhy}）</span>
          </label>
        )}

        <div className="row end">
          <button onClick={onClose} disabled={!!phase}>閉じる</button>
          <button className="primary" onClick={apply} disabled={!p || !!phase}>
            {phase === "install" ? "インストール中…" : phase === "apply" ? "適用中…" : `このフォントを${sub.target}に適用`}
          </button>
        </div>
      </div>
    </div>
  );
}
