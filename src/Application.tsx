import { lazy, Suspense } from "react";
import { DesktopRuntime } from "./editor/DesktopRuntime";
import { readModeParam } from "./editor/mode";
import { ConfirmHost } from "./editor/ui";

const Home = lazy(() => import("./editor/Home").then((m) => ({ default: m.Home })));
const Editor = lazy(() => import("./editor/App").then((m) => ({ default: m.App })));
const Library = lazy(() => import("./editor/Library").then((m) => ({ default: m.Library })));
const RenderOnly = lazy(() => import("./render/RenderOnly").then((m) => ({ default: m.RenderOnly })));

/** 起動時は必要な画面だけを読み込む。exe では描画専用画面も API の準備完了を待つ。 */
export function Application({ params }: { params: URLSearchParams }) {
  const view = params.get("view");
  // Sign in with ChatGPT の戻りはエディタが処理する。
  const authReturn = params.has("chatgpt") || params.has("chatgpt_error");
  return (
    <DesktopRuntime showUpdates={view !== "render"}>
      <Suspense fallback={<div role="status" style={{ padding: 24 }}>画面を読み込んでいます…</div>}>
        {view === "render" ? <RenderOnly posterId={params.get("poster")} theme={params.get("theme")} />
          : view === "library" ? <Library />
          : view === "editor" || authReturn ? <Editor />
          : <Home mode={readModeParam() ?? undefined} />}
      </Suspense>
      {view !== "render" && <ConfirmHost />}
    </DesktopRuntime>
  );
}
