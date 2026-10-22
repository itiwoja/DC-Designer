import type JSZip from "jszip";
import { soundKey, soundRelId } from "./animation";
import type { BuiltinSound, PosterSpec, SoundRef } from "./schema";
import type { z } from "zod";

/**
 * アニメーション・画面切り替えの効果音。内蔵音は音源ファイルを持たず、ここで波形を合成する。
 * 手持ちの音声ファイル（MP3 / WAV など）も取り込める（サーバーに保存し、spec には保存先だけを持つ）。
 * - エディタのプレビュー・スライドショーでは Web Audio で鳴らす
 * - PowerPoint の書き出しでは同じ波形を WAV にして ppt/media に入れる（どちらも同じ音になる）
 */

export type SoundId = z.infer<typeof BuiltinSound>;
export type FileSound = Exclude<SoundRef, string>;

export const SOUNDS: { value: SoundId; label: string }[] = [
  { value: "pop", label: "ポン" },
  { value: "click", label: "カチッ" },
  { value: "whoosh", label: "シュッ" },
  { value: "pico", label: "ピコン" },
  { value: "chime", label: "ピンポン" },
  { value: "sparkle", label: "キラーン" },
  { value: "drum", label: "ドン" },
  { value: "fanfare", label: "ジャジャーン" },
];
export const SOUND_LABEL = Object.fromEntries(SOUNDS.map((s) => [s.value, s.label])) as Record<SoundId, string>;
export const soundLabel = (s: SoundRef) => (typeof s === "string" ? SOUND_LABEL[s] : s.name);

/** 取り込める音声ファイル。長い音は効果音にならないので秒数で止める */
export const SOUND_FILE_TYPES = /^audio\/(mpeg|mp3|wav|x-wav|wave|ogg|mp4|x-m4a|aac|webm)$/;
export const SOUND_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const SOUND_FILE_MAX_SEC = 10;

/** スライドで使っている効果音（要素の動きと画面切り替え） */
export const specSounds = (spec: PosterSpec): SoundRef[] => [
  ...spec.layers.flatMap((l) => (l.animation?.sound ? [l.animation.sound] : [])),
  ...(spec.transition?.sound ? [spec.transition.sound] : []),
];

export const SAMPLE_RATE = 44100;

/** 決まった並びの雑音（毎回同じ音にするため Math.random は使わない） */
function noise(seed = 1) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return ((x >>> 0) / 0xffffffff) * 2 - 1;
  };
}

const TAU = Math.PI * 2;
/** 指数で減っていく音量（attack 秒で立ち上がり、decay 秒で約 1/e） */
const env = (t: number, attack: number, decay: number) => (t < 0 ? 0 : t < attack ? t / attack : Math.exp(-(t - attack) / decay));

/** 倍音つきの音（ベル・金管の代わり） */
const tone = (f: number, t: number, partials: number[]) => partials.reduce((s, a, k) => s + a * Math.sin(TAU * f * (k + 1) * t), 0);

/** 周波数が変わる音は位相を積み上げて作る */
function sweep(out: Float32Array, at: number, len: number, freq: (t: number) => number, amp: (t: number) => number, wave: (ph: number) => number = Math.sin) {
  let ph = 0;
  const from = Math.round(at * SAMPLE_RATE);
  for (let i = 0; i < len * SAMPLE_RATE && from + i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    ph += TAU * freq(t) / SAMPLE_RATE;
    out[from + i] += wave(ph) * amp(t);
  }
}

const SYNTH: Record<SoundId, { len: number; draw: (out: Float32Array) => void }> = {
  pop: { len: 0.16, draw: (o) => sweep(o, 0, 0.16, (t) => 260 + 700 * Math.exp(-t / 0.025), (t) => env(t, 0.002, 0.04)) },
  click: {
    len: 0.05,
    draw: (o) => {
      const n = noise(7);
      for (let i = 0; i < o.length; i++) { const t = i / SAMPLE_RATE; o[i] = n() * env(t, 0.0005, 0.004) * 0.8 + Math.sin(TAU * 2400 * t) * env(t, 0.0005, 0.008) * 0.6; }
    },
  },
  whoosh: {
    len: 0.5,
    draw: (o) => {
      // 雑音を、通す高さを上げ下げする一次のローパスに通す
      const n = noise(3);
      let y = 0;
      for (let i = 0; i < o.length; i++) {
        const t = i / SAMPLE_RATE, u = t / 0.5;
        const cutoff = 300 + 5000 * Math.sin(Math.PI * u) ** 2;
        y += (1 - Math.exp(-TAU * cutoff / SAMPLE_RATE)) * (n() - y);
        o[i] = y * Math.sin(Math.PI * u) ** 1.5 * 2.5;
      }
    },
  },
  pico: {
    len: 0.22,
    draw: (o) => {
      const square = (ph: number) => (Math.sin(ph) >= 0 ? 0.35 : -0.35);
      sweep(o, 0, 0.08, () => 1320, (t) => env(t, 0.002, 0.05), square);
      sweep(o, 0.08, 0.14, () => 1980, (t) => env(t, 0.002, 0.06), square);
    },
  },
  chime: {
    len: 1.5,
    draw: (o) => {
      // ピン（E5）→ ポン（C5）
      for (const [at, f] of [[0, 659.3], [0.32, 523.3]] as const) {
        for (let i = Math.round(at * SAMPLE_RATE); i < o.length; i++) {
          const t = i / SAMPLE_RATE - at;
          o[i] += tone(f, t, [1, 0.35, 0.12, 0.05]) * env(t, 0.004, 0.45) * 0.6;
        }
      }
    },
  },
  sparkle: {
    len: 0.9,
    draw: (o) => {
      const notes = [2093, 2637, 3136, 4186, 5274];
      notes.forEach((f, k) => {
        const at = k * 0.055;
        for (let i = Math.round(at * SAMPLE_RATE); i < o.length; i++) {
          const t = i / SAMPLE_RATE - at;
          o[i] += Math.sin(TAU * f * t) * (1 + 0.3 * Math.sin(TAU * 9 * t)) * env(t, 0.002, 0.18) * 0.35;
        }
      });
    },
  },
  drum: {
    len: 0.5,
    draw: (o) => {
      sweep(o, 0, 0.5, (t) => 48 + 110 * Math.exp(-t / 0.04), (t) => env(t, 0.002, 0.16));
      const n = noise(11);
      for (let i = 0; i < 0.03 * SAMPLE_RATE; i++) o[i] += n() * env(i / SAMPLE_RATE, 0.0005, 0.006) * 0.5;
    },
  },
  fanfare: {
    len: 1.4,
    draw: (o) => {
      // ジャ（短く）・ジャーン（長く）。ド・ミ・ソ・ドの和音
      const chord = [261.6, 329.6, 392, 523.3];
      for (const [at, decay, hold] of [[0, 0.06, 0.1], [0.16, 0.5, 1.2]] as const) {
        for (let i = Math.round(at * SAMPLE_RATE); i < o.length; i++) {
          const t = i / SAMPLE_RATE - at;
          if (t > hold) break;
          const a = env(t, 0.012, decay) * Math.min(1, (hold - t) / 0.05);
          o[i] += chord.reduce((s, f) => s + tone(f * (1 + 0.002 * Math.sin(TAU * 5 * t)), t, [1, 0.5, 0.33, 0.22, 0.12]), 0) * a * 0.2;
        }
      }
    },
  },
};

const cache = new Map<SoundId, Float32Array>();

/** 効果音の波形（-1〜1、モノラル、SAMPLE_RATE）。一番大きいところを 0.8 にそろえる */
export function soundSamples(id: SoundId): Float32Array {
  const hit = cache.get(id);
  if (hit) return hit;
  const { len, draw } = SYNTH[id];
  const out = new Float32Array(Math.round(len * SAMPLE_RATE));
  draw(out);
  const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  // 最後の 10ms は小さくして、切れ目のプツッという音を消す
  const fade = Math.round(0.01 * SAMPLE_RATE);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] / peak) * 0.8 * Math.min(1, (out.length - i) / fade);
  cache.set(id, out);
  return out;
}

/** 内蔵音の 16bit モノラルの WAV（PowerPoint に埋め込む） */
export const soundWav = (id: SoundId): Uint8Array => encodeWav(soundSamples(id));

/** 波形（-1〜1、モノラル、SAMPLE_RATE）→ 16bit の WAV */
export function encodeWav(s: Float32Array): Uint8Array {
  const buf = new ArrayBuffer(44 + s.length * 2);
  const v = new DataView(buf);
  const str = (at: number, t: string) => [...t].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + s.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, s.length * 2, true);
  s.forEach((x, i) => v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, x)) * 32767), true));
  return new Uint8Array(buf);
}

// ---------- PowerPoint への埋め込み ----------

/**
 * スライドの .rels に効果音（ppt/media/sfx-<名前>.wav）への関係を足す。同じ音は 1 つのファイルを共有する。
 * ファイルの音は読み込んで WAV にする（読めなければ無音にして、関係の切れたファイルにしない）
 */
export async function addSlideSounds(zip: JSZip, slide: number, sounds: SoundRef[]) {
  const used = [...new Map(sounds.map((s) => [soundKey(s), s])).values()];
  if (!used.length) return;
  const relsPath = `ppt/slides/_rels/slide${slide}.xml.rels`;
  let rels = (await zip.file(relsPath)?.async("string")) ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  for (const s of used) {
    const key = soundKey(s);
    const media = `ppt/media/sfx-${key}.wav`;
    if (!zip.file(media)) {
      zip.file(media, typeof s === "string" ? soundWav(s) : encodeWav(await fileSoundSamples(s).catch((e) => {
        console.warn(`効果音「${s.name}」を読み込めなかったので無音にします:`, e);
        return new Float32Array(Math.round(SAMPLE_RATE * 0.1));
      })));
    }
    if (!rels.includes(`Id="${soundRelId(s)}"`)) {
      rels = rels.replace("</Relationships>", `<Relationship Id="${soundRelId(s)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio" Target="../media/sfx-${key}.wav"/></Relationships>`);
    }
  }
  zip.file(relsPath, rels);
  let types = await zip.file("[Content_Types].xml")!.async("string");
  if (!/Extension="wav"/i.test(types)) {
    types = types.replace("</Types>", `<Default Extension="wav" ContentType="audio/wav"/></Types>`);
    zip.file("[Content_Types].xml", types);
  }
}

// ---------- 音声ファイル ----------

/** 音声ファイルの中身 → 波形（モノラル、SAMPLE_RATE）。SOUND_FILE_MAX_SEC より長ければ終わりを小さくして切る */
export async function decodeSound(data: ArrayBuffer): Promise<{ samples: Float32Array; seconds: number }> {
  const buf = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(data);
  const len = Math.min(buf.length, SOUND_FILE_MAX_SEC * SAMPLE_RATE);
  const out = new Float32Array(len);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  const fade = Math.round(0.01 * SAMPLE_RATE);
  for (let i = Math.max(0, len - fade); i < len; i++) out[i] *= (len - i) / fade;
  return { samples: out, seconds: buf.length / SAMPLE_RATE };
}

const fileCache = new Map<string, Promise<Float32Array>>();
/** 取り込んだ音の波形（同じファイルは 1 回だけ読む） */
export function fileSoundSamples(s: FileSound): Promise<Float32Array> {
  let p = fileCache.get(s.src);
  if (!p) {
    p = fetch(s.src).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return r.arrayBuffer();
    }).then((b) => decodeSound(b)).then((d) => d.samples);
    // 失敗は覚えない（サーバーが一時的に落ちていただけなら次に読める）
    p.catch(() => fileCache.delete(s.src));
    fileCache.set(s.src, p);
  }
  return p;
}

/** 先に読み込んでおく（スライドショーで最初の 1 回が遅れないように） */
export const preloadSounds = (sounds: SoundRef[]) => {
  for (const s of sounds) if (typeof s !== "string") fileSoundSamples(s).catch(() => undefined);
};

// ---------- 再生 ----------

let ctx: AudioContext | null = null;
const audio = () => {
  if (!ctx) ctx = new AudioContext();
  // 自動再生の制限で止まっていたら、操作の中で呼ばれたときに再開する
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
};

export type PlayingSound = {
  /** 止める。startedToo = false なら、まだ鳴り始めていないものだけ止める */
  stop: (startedToo?: boolean) => void;
};

/** delay ミリ秒後に効果音を鳴らす。ファイルの音は読み込めてから鳴らす（読み込みで遅れても、鳴る予定の時刻は動かさない） */
export function playSound(sound: SoundRef, delay = 0): PlayingSound {
  let ac: AudioContext;
  try { ac = audio(); } catch (e) {
    console.warn("効果音を鳴らせませんでした:", e);
    return { stop: () => undefined };
  }
  const at = ac.currentTime + Math.max(0, delay) / 1000;
  let node: AudioBufferSourceNode | null = null;
  let stopped = false;
  const start = (samples: Float32Array) => {
    if (stopped) return;
    const buffer = ac.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    node = ac.createBufferSource();
    node.buffer = buffer;
    node.connect(ac.destination);
    node.start(Math.max(at, ac.currentTime));
  };
  if (typeof sound === "string") start(soundSamples(sound));
  else fileSoundSamples(sound).then(start, (e) => console.warn(`効果音「${sound.name}」を鳴らせませんでした:`, e));
  return {
    stop: (startedToo = true) => {
      if (!startedToo && ac.currentTime >= at) return;
      stopped = true;
      try { node?.stop(); } catch { /* 止め済み */ }
    },
  };
}
