import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { animationGroups, animationSequence, buildTimingXml, SOUND_REL_RE, soundKey } from "../src/animation";
import { PosterSpecSchema } from "../src/schema";
import { addSlideSounds, SAMPLE_RATE, SOUNDS, soundSamples, soundWav, specSounds } from "../src/sounds";

describe("効果音", () => {
  it("どの音も無音でなく、-0.8〜0.8 に収まり、終わりは 0 に戻る", () => {
    for (const { value } of SOUNDS) {
      const s = soundSamples(value);
      const peak = s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      expect(peak, value).toBeCloseTo(0.8, 5);
      expect(Number.isFinite(s.reduce((a, b) => a + b, 0)), value).toBe(true);
      expect(s.at(-1)!, value).toBeCloseTo(0, 2);
      expect(s.length / SAMPLE_RATE, value).toBeLessThan(2);
    }
  });

  it("WAV は 16bit モノラルのヘッダーを持つ", () => {
    const w = soundWav("pop");
    const v = new DataView(w.buffer);
    expect(String.fromCharCode(...w.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...w.slice(8, 12))).toBe("WAVE");
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(SAMPLE_RATE);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(soundSamples("pop").length * 2);
  });

  it("書き出しの <p:timing> で、効果音の付いた効果だけに音を入れる", () => {
    const spec = PosterSpecSchema.parse({
      meta: {},
      layers: [
        { id: "a", type: "text", text: "a", animation: { effect: "fade", sound: "chime" } },
        { id: "b", type: "text", text: "b", animation: { effect: "fade", start: "with" } },
      ],
    });
    const xml = buildTimingXml(animationGroups(animationSequence(spec)), new Map([["a", 2], ["b", 3]]));
    expect([...xml.matchAll(SOUND_REL_RE)].map((m) => m[1])).toEqual(["chime"]);
    expect(xml).toContain(`<p:sndTgt r:embed="rIdSfx_chime" name="chime.wav"/>`);
    // subTnLst は childTnLst の後ろ
    expect(xml.indexOf("<p:subTnLst>")).toBeGreaterThan(xml.indexOf("</p:childTnLst>"));
    // cTn の id は重ならない
    const ids = [...xml.matchAll(/<p:cTn id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("効果音の埋め込み", () => {
  it("WAV を 1 つだけ置き、スライドの .rels と Content_Types に足す", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<Types xmlns="x"><Default Extension="png" ContentType="image/png"/></Types>`);
    zip.file("ppt/slides/_rels/slide1.xml.rels", `<Relationships xmlns="y"><Relationship Id="rId1" Type="t" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`);
    await addSlideSounds(zip, 1, ["pop", "pop", "chime"]);
    await addSlideSounds(zip, 2, ["pop"]);
    expect(zip.file(/^ppt\/media\//).map((f) => f.name).sort()).toEqual(["ppt/media/sfx-chime.wav", "ppt/media/sfx-pop.wav"]);
    const rels1 = await zip.file("ppt/slides/_rels/slide1.xml.rels")!.async("string");
    expect(rels1.match(/rIdSfx_pop/g)).toHaveLength(1);
    expect(rels1).toContain(`Id="rIdSfx_chime" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio" Target="../media/sfx-chime.wav"`);
    expect(await zip.file("ppt/slides/_rels/slide2.xml.rels")!.async("string")).toContain("rIdSfx_pop");
    expect((await zip.file("[Content_Types].xml")!.async("string")).match(/Extension="wav"/g)).toHaveLength(1);
  });
});

describe("取り込んだ音声ファイル", () => {
  const file = { src: "/generated/up-0123abcd.mp3", name: "ドラム ロール" };

  it("書き出しでは保存先のファイル名から英数字の名前を作り、WAV として参照する", () => {
    expect(soundKey(file)).toBe("file_up_0123abcd");
    expect(soundKey("pop")).toBe("pop");
    const spec = PosterSpecSchema.parse({ meta: {}, layers: [{ id: "a", type: "text", text: "a", animation: { effect: "fade", sound: file } }] });
    const xml = buildTimingXml(animationGroups(animationSequence(spec)), new Map([["a", 2]]));
    expect(xml).toContain(`<p:sndTgt r:embed="rIdSfx_file_up_0123abcd" name="file_up_0123abcd.wav"/>`);
    expect([...xml.matchAll(SOUND_REL_RE)].map((m) => m[1])).toEqual(["file_up_0123abcd"]);
    expect(specSounds({ ...spec, transition: { effect: "fade", duration: 700, sound: "pop" } })).toEqual([file, "pop"]);
  });

  it("読み込めなければ無音の WAV を入れて、参照の切れたファイルにしない", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<Types xmlns="x"></Types>`);
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      await addSlideSounds(zip, 1, [{ src: "http://127.0.0.1:9/none.mp3", name: "x" }]);
    } finally {
      console.warn = warn;
    }
    expect(zip.file("ppt/media/sfx-file_none.wav")).not.toBeNull();
    expect(await zip.file("ppt/slides/_rels/slide1.xml.rels")!.async("string")).toContain(`Id="rIdSfx_file_none"`);
  });
});
