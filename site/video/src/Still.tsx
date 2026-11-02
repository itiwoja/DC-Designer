import { Img, staticFile } from "remotion";
import { Camera, Note, Shape, Stage } from "./parts";
import { C, FONT_BODY, FONT_DISPLAY } from "./theme";

/**
 * 動画のポスター画像（再生前に見える 1 枚）とヒーロー画像。自動再生しないので、訪問者の多くはこの絵だけを見る。
 * 寸法の違い（1280x720 / 1600x1000）は u（幅 1280 を 1 とした倍率）で合わせる
 */
export function Still({ width, height }: { width: number; height: number }) {
  const u = width / 1280;
  const posterH = height * 0.78;
  const posterW = (posterH * 1000) / 1414;
  const slideW = width * 0.34;
  const slideH = (slideW * 945) / 1820;
  return (
    <Stage>
      <div style={{ position: "absolute", left: 80 * u, top: height * 0.2, width: 600 * u }}>
        <div style={{ display: "flex", gap: 14 * u, marginBottom: 26 * u }}>
          <Shape kind="circle" size={34 * u} color={C.red} />
          <Shape kind="triangle" size={34 * u} color={C.yellow} />
          <Shape kind="square" size={34 * u} color={C.blue} />
        </div>
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 56 * u, lineHeight: 1.3, color: C.white, fontFeatureSettings: '"palt"' }}>
          ポスターも<br />スライドも、<br /><span style={{ color: C.yellow }}>AIの下書き</span>から。
        </div>
        <div style={{ marginTop: 22 * u, fontFamily: FONT_BODY, fontWeight: 700, fontSize: 24 * u, color: "rgba(255,255,255,.82)", letterSpacing: "0.04em" }}>
          レイヤーで、自分の手で仕上げる。
        </div>
      </div>
      <div style={{
        position: "absolute", left: width - 90 * u - posterW, top: (height - posterH) / 2 - 10 * u, width: posterW, height: posterH,
        borderRadius: 10 * u, overflow: "hidden", transform: "rotate(2.5deg)", boxShadow: "0 30px 80px rgba(0,0,0,.6)",
      }}>
        <Img src={staticFile("shots/poster.jpg")} style={{ width: "100%", height: "100%" }} />
      </div>
      <Camera
        src="shots/slides-open.jpg" natural={{ w: 3200, h: 2000 }}
        box={{ x: width - 90 * u - posterW - slideW * 0.62, y: height - slideH - 70 * u, w: slideW, h: slideH }}
        rects={[{ x: 712, y: 251, w: 1776, h: 998 }]} at={[0]} radius={8 * u}
      />
      <Note style={{ left: 80 * u, top: 36 * u, fontSize: 22 * u }}>作例（架空のイベント）・写真もアプリから AI で生成</Note>
    </Stage>
  );
}
