import { useEffect, useRef, useState } from "react";
import type { PosterSpec } from "../schema";
import { api, type ChatContext, type ChatTurn, type RefImage } from "./api";
import { desktopBridge } from "./desktop";
import { uid } from "./specOps";
import { Ico } from "./uiIcons";

/**
 * チャットの 1 メッセージ。
 * - divider: 別のポスターを開いた区切り（AI には「別のポスターを開いた」という出来事として渡す）
 * - before: AI が変更する前の spec（「元に戻す」用。メモリ上だけに持ち、保存しない）
 */
export type ChatMsg = {
  id: string;
  role: "user" | "assistant" | "divider";
  text: string;
  mode?: "chat" | "image";
  /** 依頼したときの対象（「ポスター全体」「タイトル」など） */
  scope?: string;
  /** 変更内容の要約（「3 件変更・1 件追加」） */
  changes?: string;
  image?: string;
  /** 添付はタブ内だけ保持し、再送信でも同じ資料を使う。 */
  references?: RefImage[];
  hasReferences?: boolean;
  error?: boolean;
  before?: PosterSpec;
  /** before を適用するポスター（デッキで別スライドを書き換えたとき用） */
  posterId?: string | null;
  /** 同じ返答でほかにも書き換えたスライドの変更前（「元に戻す」用。保存しない） */
  others?: { posterId: string; before: PosterSpec }[];
  undone?: boolean;
};

const CHAT_KEY = "dc-designer:chat";
const MEMORY_KEY = "dc-designer:chat-memory";
/** 画面に残す件数。これより古い発言は要約（記憶）にだけ残る */
const MAX_SAVED = 400;

const loadChat = (): ChatMsg[] => {
  try { return JSON.parse(localStorage.getItem(CHAT_KEY) ?? "[]"); } catch { return []; }
};
const saveChat = (msgs: ChatMsg[]) => {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(msgs.slice(-MAX_SAVED).map(({ before: _b, others: _o, references: _r, ...m }) => m))); } catch { /* 無視 */ }
};

/**
 * 会話の記憶（ローリング要約）。会話は 1 本で無限に続くため、
 * 古いやりとりは要約に畳み込み、AI には「要約 ＋ 直近の原文」だけを渡す。
 * upTo: 要約に取り込み済みの最後のメッセージ id / count: 取り込んだ発言数
 */
type ChatMemory = { summary: string; upTo: string; count: number };

const loadMemory = (): ChatMemory | null => {
  try { return JSON.parse(localStorage.getItem(MEMORY_KEY) ?? "null"); } catch { return null; }
};
const saveMemory = (m: ChatMemory | null) => {
  try { m ? localStorage.setItem(MEMORY_KEY, JSON.stringify(m)) : localStorage.removeItem(MEMORY_KEY); } catch { /* 無視 */ }
};

/** 要約していない発言がこれを超えたら、直近 KEEP_RECENT 件を残して古い方を要約する（毎回要約しないためのヒステリシス） */
const COMPACT_AT = 24;
const KEEP_RECENT = 10;
/** 直近の原文として渡す量の上限（文字数）。超えた分は古い方から落とす（要約待ちの間の保険） */
const RECENT_BUDGET = 12000;

const toTurn = (m: ChatMsg): ChatTurn | null => {
  if (m.error) return null;
  if (m.role === "divider") return { role: "note", text: m.text };
  return { role: m.role, text: m.mode === "image" ? `（画像を生成）${m.text}` : [m.text, m.changes].filter(Boolean).join(" ") };
};

/** 記憶にまだ取り込んでいないメッセージ（upTo が見つからない＝表示から押し出された後なら全件） */
const unsummarized = (msgs: ChatMsg[], memory: ChatMemory | null) => {
  if (!memory) return msgs;
  const i = msgs.findIndex((m) => m.id === memory.upTo);
  return i < 0 ? msgs : msgs.slice(i + 1);
};

/** AI に渡す文脈: 記憶（要約）＋ 要約していない直近の発言（エラーは除く・文字数の上限内） */
const chatContext = (msgs: ChatMsg[], memory: ChatMemory | null): ChatContext => {
  const turns = unsummarized(msgs, memory).map(toTurn).filter((t): t is ChatTurn => !!t);
  // 新しい方から、1 件あたり最大 1000 字と数えて予算に収まるだけ残す
  let used = 0, from = turns.length;
  while (from > 0) {
    const cost = Math.min(turns[from - 1].text.length, 1000);
    if (used + cost > RECENT_BUDGET) break;
    used += cost;
    from--;
  }
  return { memory: memory?.summary, history: turns.slice(from) };
};

/** 要約に畳み込むべき古い発言。まだ不要なら null */
const compactionCandidate = (msgs: ChatMsg[], memory: ChatMemory | null) => {
  const rest = unsummarized(msgs, memory);
  if (rest.length <= COMPACT_AT) return null;
  const old = rest.slice(0, rest.length - KEEP_RECENT);
  const turns = old.map(toTurn).filter((t): t is ChatTurn => !!t);
  return { upTo: old[old.length - 1].id, count: old.length, turns };
};

/**
 * チャットの状態（発言・記憶・返答待ち）とブラウザへの保存。
 * 会話は 1 本で続け、要約していない発言が溜まったら古い方を記憶に畳み込む
 */
export function useChat({ ready, posterId, posterTitle }: { ready: boolean; posterId: string | null; posterTitle: string }) {
  const [messages, setMessages] = useState<ChatMsg[]>(loadChat);
  useEffect(() => { saveChat(messages); }, [messages]);
  const [memory, setMemory] = useState<ChatMemory | null>(loadMemory);
  useEffect(() => { saveMemory(memory); }, [memory]);
  const [compacting, setCompacting] = useState(false);
  /** AI の返答待ち（チャットに「入力中…」として出す文言） */
  const [pending, setPending] = useState<string | null>(null);
  /** 履歴を消したら、実行中の要約の結果は捨てる */
  const epoch = useRef(0);

  const push = (...m: Omit<ChatMsg, "id">[]) => setMessages((c) => [...c, ...m.map((x) => ({ ...x, id: uid("msg") }))]);
  /** 再生成: その発言より後の AI の返答を消す（発言そのものは残す） */
  const dropRepliesAfter = (id: string) => setMessages((c) => {
    const i = c.findIndex((x) => x.id === id);
    return i < 0 ? c : [...c.slice(0, i + 1), ...c.slice(i + 1).filter((x) => x.role !== "assistant")];
  });
  const markUndone = (id: string) => setMessages((c) => c.map((x) => (x.id === id ? { ...x, undone: true } : x)));
  const clear = () => {
    epoch.current++;
    setMessages([]);
    setMemory(null);
  };

  // 返答待ちの間は要約しない。失敗したら次の発言のあとに再試行。
  // 製品版は AI への送信ごとに本人の確認が要るので、頼まれていない裏の要約はしない（直近のやりとりだけを渡す）
  useEffect(() => {
    if (compacting || pending || !ready || desktopBridge()) return;
    const c = compactionCandidate(messages, memory);
    if (!c) return;
    const started = epoch.current;
    setCompacting(true);
    api.summarizeChat(memory?.summary, c.turns)
      .then(({ summary }) => { if (started === epoch.current) setMemory({ summary, upTo: c.upTo, count: (memory?.count ?? 0) + c.count }); })
      .catch((e) => console.warn("チャットの要約に失敗しました", e))
      .finally(() => setCompacting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, pending, ready]);

  // 別のポスターに切り替えたら区切りを入れる（AI には出来事として伝わる。チャット中にスライドを開いたときは除く）
  const lastPoster = useRef(posterId);
  useEffect(() => {
    if (!posterId || posterId === lastPoster.current) return;
    const prev = lastPoster.current;
    lastPoster.current = posterId;
    if (!prev || pending) return;
    setMessages((c) => (c.length && c[c.length - 1].role !== "divider" ? [...c, { id: uid("msg"), role: "divider", text: `「${posterTitle || "無題"}」を開きました` }] : c));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posterId]);

  /** AI に渡す文脈。before を渡すと、その発言より前までにする（再生成用） */
  const context = (before?: string) => {
    const i = before ? messages.findIndex((m) => m.id === before) : -1;
    return chatContext(i < 0 ? messages : messages.slice(0, i), memory);
  };
  return { messages, memory, compacting, pending, setPending, push, dropRepliesAfter, markUndone, clear, context };
}

export function ChatLog(props: {
  messages: ChatMsg[];
  pending: string | null;
  examples: string[];
  onExample: (text: string) => void;
  onUndo: (m: ChatMsg) => void;
  /** 最後の自分の発言への返答を作り直す（対象は今の選択） */
  onResend: (m: ChatMsg) => void;
  canResend: (m: ChatMsg) => boolean;
}) {
  const { messages, pending } = props;
  // 再送信の対象: 最後の自分の発言（区切りより前の発言は対象にしない）
  const last = [...messages].reverse().find((m) => m.role !== "assistant");
  const resendable = last?.role === "user" ? last : null;
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages.length, pending]);

  return (
    <div className="chat-log" role="log" aria-live="polite" aria-label="AI とのチャット">
      {!messages.length && !pending && (
        <div className="chat-empty">
          {props.examples.map((t) => <button key={t} className="chat-example" onClick={() => props.onExample(t)}>{t}</button>)}
        </div>
      )}
      {messages.map((m) => m.role === "divider"
        ? <div key={m.id} className="chat-divider"><span>{m.text}</span></div>
        : (
          <div key={m.id} className={`chat-msg ${m.role}${m.error ? " error" : ""}`}>
            {m.role === "user" && (m.scope || m.mode === "image") && (
              <div className="chat-meta">{m.mode === "image" ? "画像生成" : "チャット"}{m.scope ? ` · ${m.scope}` : ""}</div>
            )}
            <div className="chat-bubble">
              {m.text}
              {m.image && <img className="chat-image" src={m.image} alt="生成した画像" />}
              {m.changes && <div className="chat-changes">{m.changes}</div>}
              {m.before && (
                <button className="small chat-undo" disabled={m.undone} onClick={() => props.onUndo(m)}>
                  {m.undone ? "元に戻しました" : "↶ 元に戻す"}
                </button>
              )}
            </div>
            {m === resendable && !pending && (
              <button className="small chat-resend" disabled={!props.canResend(m)} onClick={() => props.onResend(m)}
                title={m.hasReferences && !m.references ? "添付資料は再読み込みで消えます。資料をもう一度添付し、新しいメッセージで送信してください" : m.mode === "image" ? "このプロンプトで画像を作り直す（対象は今の選択）" : "返答を作り直す（AI の変更を送る前の状態に戻してから、もう一度考えさせる）"}>
                <Ico name="retry" size={12} /> 再送信
              </button>
            )}
          </div>
        ))}
      {pending && (
        <div className="chat-msg assistant pending">
          <div className="chat-bubble"><span className="typing" aria-hidden><i /><i /><i /></span>{pending}</div>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}
