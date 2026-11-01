import type { Deck } from "./api";
import { readPref, writePref } from "./storage";

/**
 * 作るものの種類（モード）。ポスターと PowerPoint のスライドは、
 * ホーム・成果物の一覧・エディタをそれぞれ別に持ち、互いの成果物を作ったり開いたりしない。
 * - poster: デッキに入っていない単体のポスター（PDF・PNG で書き出す）
 * - slides: デッキ（PowerPoint のスライド。PPTX で書き出す）
 * 以前の版で作った Instagram の投稿（kind が "instagram" のデッキ）はデータとして残し、画面には出さない（isShownDeck）
 */
export type AppMode = "poster" | "slides";

export const MODES: Record<AppMode, { label: string; item: string; icon: "file" | "slides"; note: string }> = {
  poster: { label: "ポスター", item: "ポスター", icon: "file", note: "A4 縦（1000×1414）のポスターを作り、PDF・PNG で書き出す" },
  slides: { label: "スライド", item: "プレゼンテーション", icon: "slides", note: "16:9 のスライドを作り、PowerPoint（PPTX）で書き出す・投影する" },
};
export const MODE_KEYS: AppMode[] = ["poster", "slides"];

export const isMode = (v: unknown): v is AppMode => v === "poster" || v === "slides";

/** デッキの種類からモードを決める（デッキに入っていなければポスター） */
export const modeOfDeck = (d: Pick<Deck, "kind"> | null | undefined): AppMode => (d ? "slides" : "poster");

/** 画面に出すデッキか（以前の版の Instagram の投稿は出さない。データは消さずに残す） */
export const isShownDeck = (d: Pick<Deck, "kind">) => d.kind !== "instagram";

/** URL の ?mode=（無い・不正なら null） */
export const readModeParam = (): AppMode | null => {
  try { const m = new URLSearchParams(location.search).get("mode"); return isMode(m) ? m : null; } catch { return null; }
};

/** モードごとの画面の URL。モードを選ぶ画面は `/`（nav.ts の HOME_URL） */
export const modeHomeUrl = (mode: AppMode) => `?mode=${mode}`;
export const modeLibraryUrl = (mode: AppMode) => `?view=library&mode=${mode}`;
export const modeEditorUrl = (mode: AppMode) => `?view=editor&mode=${mode}`;

/**
 * モードごとに最後に開いていた成果物の ID（ホームの「続きから編集」用）。
 * 編集中の控え（STORAGE_KEY / CURRENT_ID_KEY）は 1 つだけなので、モードを行き来しても続きを開けるように別に覚えておく
 */
const LAST_ID_KEY = (mode: AppMode) => `dc-designer:last-id:${mode}`;
export const readLastId = (mode: AppMode) => readPref(LAST_ID_KEY(mode));
export const writeLastId = (mode: AppMode, id: string) => writePref(LAST_ID_KEY(mode), id);
