import { useEffect, useState } from "react";
import { api } from "../editor/api";
import { loadInitialSpec } from "../editor/nav";
import type { PosterSpec } from "../schema";
import { Poster } from "./Poster";

/** ?view=render[&poster=<id>][&theme=night]：UI なしの確認・ヘッドレス描画。 */
export function RenderOnly({ posterId, theme }: { posterId: string | null; theme: string | null }) {
  const [loaded, setLoaded] = useState<{ id: string | null; spec?: PosterSpec; failed?: boolean }>(() => ({
    id: posterId, ...(!posterId ? { spec: loadInitialSpec() } : {}),
  }));
  useEffect(() => {
    let alive = true;
    if (!posterId) setLoaded({ id: posterId, spec: loadInitialSpec() });
    else api.poster(posterId).then(
      (p) => { if (alive) setLoaded({ id: posterId, spec: p.spec }); },
      () => { if (alive) setLoaded({ id: posterId, failed: true }); },
    );
    return () => { alive = false; };
  }, [posterId]);
  if (loaded.id !== posterId) return null;
  if (loaded.failed) return <p role="alert">ポスターを読み込めませんでした。</p>;
  if (!loaded.spec) return null;
  const spec = theme ? { ...loaded.spec, theme } : loaded.spec;
  return (
    <div style={{ width: `min(100vw, calc(100vh * ${spec.meta.width} / ${spec.meta.height}))`, margin: "0 auto" }}>
      <Poster spec={spec} />
    </div>
  );
}
