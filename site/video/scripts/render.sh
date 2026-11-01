#!/usr/bin/env bash
# デモ動画・ポスター画像・ヒーロー画像を書き出し、site/src/assets/media/ に置く形に変換する。
# 使い方: site/video で `npm run render`（先に npm install）
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=out
MEDIA=../src/assets/media
mkdir -p "$OUT"

# WSL で sudo なしに展開した Chromium のライブラリ（web-check の setup-chromium-libs.sh）
LIBS="$HOME/.local/chromium-libs/root/usr/lib/x86_64-linux-gnu"
if [ -d "$LIBS" ]; then export LD_LIBRARY_PATH="$LIBS${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"; fi

# 配置は 1280x720 で組み、1.5 倍の 1920x1080 で書き出す（素材は 3〜4 倍で撮ってあるので、寄ってもぼけない）
npx remotion render src/index.ts Demo "$OUT/demo-master.mp4" --codec=h264 --crf=12 --scale=1.5 --log=error
npx remotion still src/index.ts DemoPoster "$OUT/demo-poster.png" --scale=1.5 --log=error
npx remotion still src/index.ts Hero "$OUT/hero.png" --log=error

# サイト用：H.264＋AAC（再生互換のため yuv420p と faststart）と VP9＋Opus の WebM。上限 8MB（06_ux_design「媒体の枠」）
# 効果音だけ（ナレーションなし）。音量はデモ向けの -16 LUFS・True Peak -2 dB 以下にそろえる（AAC・Opus への変換でピークが少し上がるので、目標は -3 dB）
# 効果音がまばらなので、1 回目で測った値を 2 回目に渡す（1 回だけだと -18 LUFS・ピーク -1.7 dB になった）
M=$(ffmpeg -hide_banner -i "$OUT/demo-master.mp4" -af "loudnorm=I=-16:TP=-3:LRA=11:print_format=json" -f null - 2>&1 | sed -n '/^{/,/^}/p')
val() { echo "$M" | sed -n "s/.*\"$1\" : \"\([^\"]*\)\".*/\1/p"; }
AF="loudnorm=I=-16:TP=-3:LRA=11:measured_I=$(val input_i):measured_TP=$(val input_tp):measured_LRA=$(val input_lra):measured_thresh=$(val input_thresh):offset=$(val target_offset):linear=true"
echo "loudnorm: $AF"
ffmpeg -loglevel error -y -i "$OUT/demo-master.mp4" -vf "scale=in_range=pc:out_range=tv,format=yuv420p" -c:v libx264 -preset slow -crf 19 -tune animation -color_range tv -af "$AF" -ar 48000 -c:a aac -b:a 128k -movflags +faststart "$MEDIA/demo.mp4"
ffmpeg -loglevel error -y -i "$OUT/demo-master.mp4" -vf "scale=in_range=pc:out_range=tv,format=yuv420p" -c:v libvpx-vp9 -b:v 0 -crf 33 -row-mt 1 -deadline good -cpu-used 2 -af "$AF" -ar 48000 -c:a libopus -b:a 96k "$MEDIA/demo.webm"
cp "$OUT/demo-poster.png" "$MEDIA/demo-poster.png"
cp "$OUT/hero.png" "$MEDIA/hero.png"
ls -la "$MEDIA"
