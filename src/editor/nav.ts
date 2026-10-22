import { PosterSpecSchema, type PosterSpec } from "../schema";
import type { Deck, SavedPoster } from "./api";
import { modeEditorUrl, modeOfDeck, readLastId, writeLastId, type AppMode } from "./mode";
import { STORAGE_KEY, writeCurrentId, writeSynced } from "./storage";

/**
 * 画面の URL。`/` がモード（ポスター・PPTX・Instagram）を選ぶ画面、`?mode=<モード>` がそのモードのホーム、
 * エディタは `?view=editor&mode=<モード>`、成果物一覧は `?view=library&mode=<モード>`（mode.ts）。
 * Sign in with ChatGPT の戻り先（?chatgpt=...）はエディタが処理するので、戻り先もエディタにする
 */
export const HOME_URL = location.pathname;
export const EDITOR_URL = "?view=editor";

/** ホームで入力したブリーフをエディタへ渡す（エディタが開いたらすぐ AI に作らせる） */
export const PENDING_BRIEF_KEY = "dc-designer:pending-brief";
export const IMPORT_NOTICE_KEY = "dc-designer:import-notice";

export const BLANK_SPEC: PosterSpec = PosterSpecSchema.parse({
  version: 1,
  meta: { title: "無題のポスター", width: 1000, height: 1414 },
  theme: "ocean",
  layers: [{ id: "bg", name: "背景", type: "background", fill: "$background", x: 0, y: 0, w: 1000, h: 1414 }],
});

/** 白紙のスライド 1 枚（PowerPoint のワイド画面 16:9 = 13.333×7.5 inch を 1 inch = 100px で） */
export const BLANK_SLIDE_SPEC: PosterSpec = PosterSpecSchema.parse({
  version: 1,
  meta: { title: "スライド 1", width: 1333, height: 750 },
  theme: "ocean",
  layers: [{ id: "bg", name: "背景", type: "background", fill: "$background", x: 0, y: 0, w: 1333, h: 750 }],
});

/** 成果物を、そのモードのエディタで開く（ブラウザの控えと ID を差し替えてエディタへ） */
export function openInEditor(p: SavedPoster, mode: AppMode) {
  // 内容と ID は一組で切り替える。控えに入れられなければ古い控えを捨て、エディタがサーバーから読み込むまで保存済みとみなさない
  let stored = true;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p.spec)); } catch { stored = false; }
  if (!stored) try { localStorage.removeItem(STORAGE_KEY); } catch { /* 無視（?open で控えを使わず読み込む） */ }
  writeCurrentId(p.id);
  writeSynced(stored);
  writeLastId(mode, p.id);
  const url = modeEditorUrl(mode);
  location.href = stored ? url : `${url}&open=${encodeURIComponent(p.id)}`;
}

/** プロジェクト（デッキ）を開く: そのモードで最後に開いていたスライドがこのデッキにあればそれ、無ければ 1 枚目 */
export function openDeckInEditor(d: Deck, posterById: Map<string, SavedPoster>) {
  const mode = modeOfDeck(d);
  const lastId = readLastId(mode);
  const target = d.slides.find((s) => s.id === lastId) ?? d.slides[0];
  const p = target && posterById.get(target.id);
  if (p) openInEditor(p, mode);
}
