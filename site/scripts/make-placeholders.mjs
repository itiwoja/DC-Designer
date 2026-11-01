// 仮の画像（「画面は準備中」）を作る。実行：node scripts/make-placeholders.mjs
// 無彩色の地に文字だけ。アプリの実際の画面に見えるものは描かない（SITE-D-26）。
// 日本語フォントが要る（Noto Sans CJK JP など）。無い環境では文字が豆腐になるので、生成後に目で確かめること。
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../src/assets/media");
const FONT = "'Noto Sans CJK JP','Yu Gothic UI','Meiryo','Hiragino Sans',sans-serif";

const TARGETS = [
  { name: "placeholder-hero.png", width: 1600, height: 1000 },
  { name: "placeholder-feature.png", width: 1200, height: 750 },
  { name: "placeholder-demo.png", width: 1280, height: 720 },
];

function svg({ width, height }) {
  const size = Math.round(height * 0.09);
  const frame = Math.round(height * 0.05);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#e4e4e4"/>
  <rect x="${frame}" y="${frame}" width="${width - frame * 2}" height="${height - frame * 2}" fill="none" stroke="#9a9a9a" stroke-width="4" stroke-dasharray="24 16"/>
  <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-family="${FONT}" font-size="${size}" font-weight="700" fill="#4a4a4a">画面は準備中</text>
</svg>`;
}

await mkdir(OUT, { recursive: true });
for (const t of TARGETS) {
  const file = join(OUT, t.name);
  await sharp(Buffer.from(svg(t))).png({ palette: true, colours: 8, compressionLevel: 9 }).toFile(file);
  const { size } = await stat(file);
  console.log(`${t.name} ${t.width}x${t.height} ${size} bytes`);
  if (size > 50 * 1024) throw new Error(`${t.name} が 50KB を超えています`);
}
