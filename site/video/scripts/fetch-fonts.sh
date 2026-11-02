#!/usr/bin/env bash
# 動画で使うフォント（OFL）を google/fonts から取ってくる。大きいのでリポジトリには入れない
set -euo pipefail
cd "$(dirname "$0")/../public/fonts"
get() { [ -s "$1" ] || curl -sSLf -o "$1" "$2"; }
get MochiyPopOne-Regular.ttf "https://github.com/google/fonts/raw/main/ofl/mochiypopone/MochiyPopOne-Regular.ttf"
get NotoSansJP.ttf "https://github.com/google/fonts/raw/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf"
