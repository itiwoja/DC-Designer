import { describe, expect, it } from "vitest";
import { insertTiming, SOUND_REL_RE } from "../src/animation";
import { PosterSpecSchema } from "../src/schema";
import { buildTransitionXml, transitionKeyframes } from "../src/transition";

const SLIDE = `<p:sld><p:cSld><p:spTree/></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

describe("画面切り替え", () => {
  it("無ければ何も書かない", () => {
    expect(buildTransitionXml(undefined)).toBe("");
  });

  it("向きは動いていく向きで書き、長さは p14:dur と古い版向けの速さの両方で書く", () => {
    const xml = buildTransitionXml({ effect: "push", direction: "bottom", duration: 1200 });
    expect(xml).toContain(`<p:transition spd="slow" p14:dur="1200"><p:push dir="u"/></p:transition>`);
    expect(xml).toContain(`<mc:Fallback><p:transition spd="slow"><p:push dir="u"/></p:transition></mc:Fallback>`);
    expect(buildTransitionXml({ effect: "wipe", direction: "right", duration: 500 })).toContain(`spd="fast" p14:dur="500"><p:wipe dir="l"/>`);
    // 向きの無い効果には dir を付けない
    expect(buildTransitionXml({ effect: "fade", direction: "left", duration: 700 })).toContain(`spd="med" p14:dur="700"><p:fade/>`);
  });

  it("効果音は書き出しで WAV を足す関係 ID で書く", () => {
    const xml = buildTransitionXml({ effect: "fade", duration: 700, sound: "whoosh" });
    expect(xml).toContain(`<p:sndAc><p:stSnd><p:snd r:embed="rIdSfx_whoosh" name="whoosh.wav"/></p:stSnd></p:sndAc>`);
    expect([...xml.matchAll(SOUND_REL_RE)].map((m) => m[1])).toEqual(["whoosh", "whoosh"]);
  });

  it("スライドには clrMapOvr の後・timing の前に入る", () => {
    const xml = insertTiming(SLIDE, buildTransitionXml({ effect: "fade", duration: 700 }) + "<p:timing/>");
    expect(xml.indexOf("</p:clrMapOvr>")).toBeLessThan(xml.indexOf("<mc:AlternateContent"));
    expect(xml.indexOf("</mc:AlternateContent>")).toBeLessThan(xml.indexOf("<p:timing/>"));
    expect(xml.endsWith("<p:timing/></p:sld>")).toBe(true);
  });

  it("プッシュは前のスライドを押し出し、カバーは上に重ねるだけ", () => {
    const push = transitionKeyframes({ effect: "push", direction: "right", duration: 700 });
    expect(push.incoming[0]).toEqual({ translate: "100% 0" });
    expect(push.outgoing?.at(-1)).toEqual({ translate: "-100% 0" });
    expect(transitionKeyframes({ effect: "cover", direction: "right", duration: 700 }).outgoing).toBeUndefined();
  });

  it("スライドの spec に残る（読み込みで捨てない）", () => {
    const spec = PosterSpecSchema.parse({ meta: {}, layers: [], transition: { effect: "zoom" } });
    expect(spec.transition).toEqual({ effect: "zoom", duration: 700 });
  });
});
