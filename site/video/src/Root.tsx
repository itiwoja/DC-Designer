import "./fonts";
import { Composition, Still as StillComp } from "remotion";
import { Demo, DEMO_FRAMES } from "./Demo";
import { Still } from "./Still";
import { FPS } from "./theme";

// 寸法は docs/design/06_ux_design.md「媒体の枠」：デモ 1280x720・無音・15〜30 秒、hero 1600x1000
export function Root() {
  return (
    <>
      <Composition id="Demo" component={Demo} durationInFrames={DEMO_FRAMES} fps={FPS} width={1280} height={720} />
      <StillComp id="DemoPoster" component={Still} width={1280} height={720} defaultProps={{ width: 1280, height: 720 }} />
      <StillComp id="Hero" component={Still} width={1600} height={1000} defaultProps={{ width: 1600, height: 1000 }} />
    </>
  );
}
