// SVG を原本として、プレビュー PNG と Windows 用の複数解像度 ICO を生成する。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const assets = new URL("../desktop/assets/", import.meta.url);
const image = await loadImage(readFileSync(new URL("icon.svg", assets)));
function png(size) {
  const canvas = createCanvas(size, size);
  canvas.getContext("2d").drawImage(image, 0, 0, size, size);
  return canvas.toBuffer("image/png");
}

writeFileSync(new URL("icon.png", assets), png(512));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map(png);
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, i) => {
  const entry = 6 + i * 16;
  header[entry] = size === 256 ? 0 : size;
  header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[i].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[i].length;
});
writeFileSync(new URL("icon.ico", assets), Buffer.concat([header, ...images]));
console.log(`アイコンを生成しました: ${fileURLToPath(assets)}`);
