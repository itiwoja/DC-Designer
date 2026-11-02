import "./fonts";
import { Composition, Still as StillComp } from "remotion";
import { Demo, DEMO_FRAMES } from "./Demo";
import { Feature } from "./Feature";
import { Still } from "./Still";
import { FPS } from "./theme";

// 寸法は docs/design/06_ux_design.md「媒体の枠」：デモ 1280x720（1.5 倍で書き出す）、hero 1600x1000、機能画像 1200x750、OGP 1200x630
export function Root() {
  return (
    <>
      <Composition id="Demo" component={Demo} durationInFrames={DEMO_FRAMES} fps={FPS} width={1280} height={720} />
      <StillComp id="DemoPoster" component={Still} width={1280} height={720} defaultProps={{ width: 1280, height: 720 }} />
      <StillComp id="Hero" component={Still} width={1600} height={1000} defaultProps={{ width: 1600, height: 1000 }} />
      <StillComp id="Ogp" component={Still} width={1200} height={630} defaultProps={{ width: 1200, height: 630 }} />
      <StillComp id="FeaturePoster" component={Feature} width={1200} height={750} defaultProps={{ width: 1200, height: 750, shot: "poster" as const }} />
      <StillComp id="FeatureSlides" component={Feature} width={1200} height={750} defaultProps={{ width: 1200, height: 750, shot: "slides" as const }} />
    </>
  );
}
