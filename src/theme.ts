import { useEffect, useState } from "react";

// 画面のテーマ。"system" は OS の設定に従う。初回描画のちらつき防止で index.html でも同じ解決をしている
export type ThemePref = "system" | "light" | "dark";
const THEME_KEY = "dc-designer:theme";
export const THEME_ORDER: ThemePref[] = ["light", "dark", "system"];
export const THEME_LABELS: Record<ThemePref, { icon: "sun" | "moon" | "monitor"; label: string }> = {
  light: { icon: "sun", label: "ライト" },
  dark: { icon: "moon", label: "ダーク" },
  system: { icon: "monitor", label: "自動（OS の設定に合わせる）" },
};

const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch { return "system"; }
}

const resolve = (pref: ThemePref): "light" | "dark" =>
  pref === "dark" || (pref === "system" && darkQuery().matches) ? "dark" : "light";

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readPref);
  const [resolved, setResolved] = useState(() => resolve(readPref()));
  useEffect(() => {
    const apply = () => {
      const r = resolve(pref);
      document.documentElement.dataset.theme = r;
      setResolved(r);
    };
    apply();
    try {
      if (pref === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, pref);
    } catch { /* 無視 */ }
    if (pref !== "system") return;
    const mq = darkQuery();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [pref]);
  return { pref, resolved, setPref };
}
