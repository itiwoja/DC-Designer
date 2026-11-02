import { Camera, type Rect } from "./parts";
import { C, FONT_BODY } from "./theme";

/**
 * 機能カードの画像（1200x750）。実画面のキャンバスと右のパネルに寄せて切り出し、下の帯に注記を入れる。
 * カードでは 360〜520px 幅に縮むので、画面全体ではなく見せたい所だけを大きく出す。
 * rect はスクショを 3200x2000 とした座標（ファイルの実寸 4800x3000 とは別。Still.tsx と同じ）
 */
export const FEATURE_SHOTS = {
  poster: { src: "shots/poster-select.jpg", rect: { x: 907, y: 80, w: 2293, h: 1320 } },
  slides: { src: "shots/slides-open.jpg", rect: { x: 640, y: 48, w: 2560, h: 1480 } },
} satisfies Record<string, { src: string; rect: Rect }>;

export function Feature({ width, height, shot }: { width: number; height: number; shot: keyof typeof FEATURE_SHOTS }) {
  const band = 64;
  const { src, rect } = FEATURE_SHOTS[shot];
  return (
    <div style={{ position: "absolute", inset: 0, background: C.ink }}>
      <Camera src={src} natural={{ w: 3200, h: 2000 }} box={{ x: 0, y: 0, w: width, h: height - band }} rects={[rect]} at={[0]} radius={0} shadow={false} />
      <div style={{
        position: "absolute", left: 0, right: 0, bottom: 0, height: band, display: "flex", alignItems: "center", paddingLeft: 32,
        fontFamily: FONT_BODY, fontWeight: 500, fontSize: 25, color: "rgba(255,255,255,.88)", letterSpacing: "0.03em",
      }}>
        作例（架空のイベント）・写真もアプリから AI で生成
      </div>
    </div>
  );
}
