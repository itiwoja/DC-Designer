import { useRef, useState } from "react";
import { readPref, writePref } from "./storage";
import { usePanelSize } from "./usePanelSize";

const LEFT_OPEN_KEY = "dc-designer:left-open";
const RIGHT_OPEN_KEY = "dc-designer:right-open";
const LEFT_WIDTH_KEY = "dc-designer:left-width";
const RIGHT_WIDTH_KEY = "dc-designer:right-width";
const DECK_HEIGHT_KEY = "dc-designer:deck-height";
const NOTES_OPEN_KEY = "dc-designer:notes-open";
const NOTES_HEIGHT_KEY = "dc-designer:notes-height";
const LAYERS_OPEN_KEY = "dc-designer:layers-open";
/** スライド一覧の既定の高さ（styles.css の --dh と合わせる）と、サムネイル以外の見出し・余白の分 */
const DECK_H = 127;
export const DECK_CHROME_H = 63;
/** 台本欄の既定の高さ（styles.css の --nh と合わせる）と、畳んだときの高さ */
const NOTES_H = 132;
export const NOTES_CHROME_H = 38;

/** 開いているか（"0" で畳む）を覚えておく真偽値 */
function useOpenPref(key: string) {
  const [open, setOpen] = useState(() => readPref(key) !== "0");
  const toggle = (on: boolean) => { setOpen(on); writePref(key, on ? "1" : "0"); };
  return [open, toggle] as const;
}

/**
 * エディタの左右パネル・スライド一覧・台本欄の開閉と大きさ。
 * 左のパネル（新規作成・チャット）と右のパネルは細いバーに畳める。
 * 左右パネルの幅とスライド一覧の高さは縁のつまみをドラッグして変えられる（画面が狭いときは画面に対する割合で頭打ち）。
 * 台本欄（PPTX エディターモード）も畳めて、高さを変えられる。右のレイヤー欄も畳めて、閉じたぶんインスペクターが伸びる
 */
export function usePanelLayout() {
  const [leftOpen, toggleLeft] = useOpenPref(LEFT_OPEN_KEY);
  const [rightOpen, toggleRight] = useOpenPref(RIGHT_OPEN_KEY);
  const [leftW, setLeftW] = usePanelSize(LEFT_WIDTH_KEY);
  const [rightW, setRightW] = usePanelSize(RIGHT_WIDTH_KEY);
  const [deckH, setDeckH] = usePanelSize(DECK_HEIGHT_KEY);
  const [resizing, setResizing] = useState(false);
  const leftRef = useRef<HTMLElement>(null);
  const rightRef = useRef<HTMLElement>(null);
  const deckMax = Math.round(window.innerHeight * 0.5);
  const deckHeight = Math.max(DECK_CHROME_H + 24, Math.min(deckH ?? DECK_H, deckMax));
  const [notesOpen, toggleNotes] = useOpenPref(NOTES_OPEN_KEY);
  const [notesH, setNotesH] = usePanelSize(NOTES_HEIGHT_KEY);
  const [layersOpen, toggleLayers] = useOpenPref(LAYERS_OPEN_KEY);
  const notesMax = Math.round(window.innerHeight * 0.4);
  const notesHeight = Math.max(NOTES_CHROME_H + 40, Math.min(notesH ?? NOTES_H, notesMax));
  return {
    leftOpen, toggleLeft, rightOpen, toggleRight, leftW, setLeftW, rightW, setRightW, resizing, setResizing, leftRef, rightRef,
    deckH, setDeckH, deckHeight, deckMax, notesOpen, toggleNotes, notesH, setNotesH, notesHeight, notesMax,
    layersOpen, toggleLayers,
  };
}
