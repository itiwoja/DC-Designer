import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./editor/App";
import { Home } from "./editor/Home";
import { Library } from "./editor/Library";
import { readModeParam } from "./editor/mode";
import { api } from "./editor/api";
import { STORAGE_KEY } from "./editor/storage";
import { ConfirmHost, RENDER_HELLO_MESSAGE, RENDER_READY_MESSAGE, RENDER_SPEC_MESSAGE } from "./editor/ui";
import { Poster } from "./render/Poster";
import { useRenderReady } from "./render/useRenderReady";
import { PosterSpecSchema, type PosterSpec } from "./schema";
import sample from "../samples/ai-workshop.json";
import "./styles.css";

const params = new URLSearchParams(location.search);

/**
 * ?view=render[&theme=night] … エディタUIなしでポスターだけを描画（確認・ヘッドレス書き出し用）
 * ?view=render&poster=<id> … 保存済みの成果物を描画（成果物一覧のサムネイル）
 * ?view=render&embed=1 … 親画面から postMessage で受け取った spec を描画（エディタのスライド一覧のサムネイル）
 */
function RenderOnly() {
  const [spec, setSpec] = useState<PosterSpec | null>(() => {
    if (params.has("poster") || params.has("embed")) return null;
    let s = PosterSpecSchema.parse(sample);
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && !params.has("sample")) s = PosterSpecSchema.parse(JSON.parse(saved));
    } catch { /* サンプルを使う */ }
    return s;
  });
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!params.has("embed") || window.parent === window) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== window.parent || e.data?.type !== RENDER_SPEC_MESSAGE) return;
      setSpec(e.data.spec);
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage(RENDER_HELLO_MESSAGE, location.origin);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  useEffect(() => {
    const id = params.get("poster");
    if (id) api.poster(id).then((p) => setSpec(p.spec)).catch(() => setFailed(true));
  }, []);
  // 画像まで描き終えたら、サムネイルとして埋め込んでいる親画面に知らせる（読み込み中の表示を消す）
  const svgRef = useRef<SVGSVGElement>(null);
  const ready = useRenderReady(svgRef);
  useEffect(() => {
    if ((spec && ready) || failed) {
      if (window.parent !== window) window.parent.postMessage(RENDER_READY_MESSAGE, location.origin);
    }
  }, [spec, ready, failed]);
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
  view === "render" ? <RenderOnly /> : <>
    {view === "library" ? <Library /> : view === "editor" || authReturn ? <App /> : <Home mode={readModeParam() ?? undefined} />}
    <ConfirmHost />
  </>,
);
