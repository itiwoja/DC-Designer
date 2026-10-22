/**
 * TrueType フォントを EOT（Embedded OpenType）にする。
 * PowerPoint の埋め込みフォント（ppt/fonts/*.fntdata）は、圧縮も XOR もしない EOT（版 0x00020001）で TTF を包んだもの
 */

interface FontInfo {
  familyName: string;
  styleName: string;
  versionName: string;
  fullName: string;
  /** OS/2 の fsType（埋め込みの許可） */
  fsType: number;
}

function tables(ttf: Buffer) {
  const map = new Map<string, { offset: number; length: number }>();
  const n = ttf.readUInt16BE(4);
  for (let i = 0; i < n; i++) {
    const p = 12 + i * 16;
    map.set(ttf.toString("latin1", p, p + 4), { offset: ttf.readUInt32BE(p + 8), length: ttf.readUInt32BE(p + 12) });
  }
  return map;
}

/** name テーブルから Windows（Unicode BMP）の英語名を優先して読む */
function readNames(ttf: Buffer, at: number): Map<number, string> {
  const count = ttf.readUInt16BE(at + 2);
  const strings = at + ttf.readUInt16BE(at + 4);
  const out = new Map<number, { text: string; rank: number }>();
  for (let i = 0; i < count; i++) {
    const r = at + 6 + i * 12;
    const [platform, encoding, lang, id, len, off] = [0, 2, 4, 6, 8, 10].map((o) => ttf.readUInt16BE(r + o));
    if (!(platform === 3 && (encoding === 1 || encoding === 10)) && platform !== 0) continue;
    const rank = platform === 3 && lang === 0x409 ? 0 : platform === 3 ? 1 : 2;
    if ((out.get(id)?.rank ?? 9) <= rank) continue;
    const be = ttf.subarray(strings + off, strings + off + len);
    out.set(id, { text: Buffer.from(be).swap16().toString("utf16le"), rank });
  }
  return new Map([...out].map(([id, v]) => [id, v.text]));
}

export function fontInfo(ttf: Buffer): FontInfo {
  const t = tables(ttf);
  const os2 = t.get("OS/2");
  const name = t.get("name");
  if (!os2 || !name) throw new Error("OS/2 か name テーブルがありません");
  const names = readNames(ttf, name.offset);
  return {
    familyName: names.get(1) ?? "",
    styleName: names.get(2) ?? "",
    versionName: names.get(5) ?? "",
    fullName: names.get(4) ?? "",
    fsType: ttf.readUInt16BE(os2.offset + 8),
  };
}

/** 埋め込みが禁止されている（fsType の Restricted License）か */
export const embeddingRestricted = (fsType: number) => (fsType & 0x000f) === 0x0002;

export function ttfToEot(ttf: Buffer): Buffer {
  const t = tables(ttf);
  const os2 = t.get("OS/2")!;
  const head = t.get("head");
  if (!head) throw new Error("head テーブルがありません");
  const info = fontInfo(ttf);
  const o = os2.offset;
  const os2Version = ttf.readUInt16BE(o);

  const str = (s: string) => {
    const data = Buffer.from(s, "utf16le");
    const size = Buffer.alloc(2);
    size.writeUInt16LE(data.length);
    return Buffer.concat([size, data]);
  };
  const pad = Buffer.alloc(2);

  const fixed = Buffer.alloc(82);
  fixed.writeUInt32LE(0x00020001, 8); // Version
  fixed.writeUInt32LE(0, 12); // Flags: 圧縮・XOR なし
  ttf.copy(fixed, 16, o + 32, o + 42); // PANOSE
  fixed.writeUInt8(1, 26); // Charset: DEFAULT_CHARSET
  fixed.writeUInt8(ttf.readUInt16BE(o + 62) & 1, 27); // Italic（fsSelection の bit 0）
  fixed.writeUInt32LE(ttf.readUInt16BE(o + 4), 28); // Weight
  fixed.writeUInt16LE(info.fsType, 32);
  fixed.writeUInt16LE(0x504c, 34); // MagicNumber
  for (let i = 0; i < 4; i++) fixed.writeUInt32LE(ttf.readUInt32BE(o + 42 + i * 4), 36 + i * 4); // UnicodeRange1-4
  if (os2Version >= 1) for (let i = 0; i < 2; i++) fixed.writeUInt32LE(ttf.readUInt32BE(o + 78 + i * 4), 52 + i * 4); // CodePageRange1-2
  fixed.writeUInt32LE(ttf.readUInt32BE(head.offset + 8), 60); // CheckSumAdjustment
  // 64-79: Reserved1-4、80-81: Padding1

  const body = Buffer.concat([
    fixed,
    str(info.familyName), pad,
    str(info.styleName), pad,
    str(info.versionName), pad,
    str(info.fullName), pad,
    str(""), // RootString
  ]);
  body.writeUInt32LE(body.length + ttf.length, 0); // EOTSize
  body.writeUInt32LE(ttf.length, 4); // FontDataSize
  return Buffer.concat([body, ttf]);
}
