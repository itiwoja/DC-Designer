import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./editor/App";
import { DesktopRuntime } from "./editor/DesktopRuntime";
import { Home } from "./editor/Home";
import { Library } from "./editor/Library";
import { readModeParam } from "./editor/mode";
import { api } from "./editor/api";
import { loadInitialSpec } from "./editor/nav";
import { ConfirmHost } from "./editor/ui";
import { Poster } from "./render/Poster";
import type { PosterSpec } from "./schema";
import "./styles.css";

const params = new URLSearchParams(location.search);

/**
 * ?view=render[&theme=night] … エディタUIなしでポスターだけを描画（確認・ヘッドレス書き出し用）
 * ?view=render&poster=<id> … 保存済みの成果物を描画
 */
function RenderOnly() {
  const [spec, setSpec] = useState<PosterSpec | null>(() => (params.has("poster") ? null : loadInitialSpec()));
  useEffect(() => {
    const id = params.get("poster");
    if (id) api.poster(id).then((p) => setSpec(p.spec)).catch(() => {});
  }, []);
  const svgRef = useRef<SVGSVGElement>(null);
  if (!spec) return null;
  const s = params.get("theme") ? { ...spec, theme: params.get("theme")! } : spec;
  return (
    <div style={{ width: `min(100vw, calc(100vh * ${s.meta.width} / ${s.meta.height}))`, margin: "0 auto" }}>
      <Poster ref={svgRef} spec={s} />
    </div>
  );
}

const view = params.get("view");
// Sign in with ChatGPT の戻り（?chatgpt=... / ?chatgpt_error=...）はエディタが処理する
const authReturn = params.has("chatgpt") || params.has("chatgpt_error");
// useHistory は state 更新関数内で履歴を積むため StrictMode（二重実行）は使わない
createRoot(document.getElementById("root")!).render(
  view === "render" ? <RenderOnly /> : <DesktopRuntime>
    {view === "library" ? <Library /> : view === "editor" || authReturn ? <App /> : <Home mode={readModeParam() ?? undefined} />}
    <ConfirmHost />
  </DesktopRuntime>,
);
