#!/usr/bin/env python3
"""見出し用フォント（Mochiy Pop One）を、サイトで使う文字だけに絞って woff2 にする。

使い方（fonttools と brotli が要る： pip install fonttools brotli）:
  python3 site/scripts/subset-display-font.py <MochiyPopOne-Regular.ttf>
元の ttf は https://github.com/google/fonts/tree/main/ofl/mochiypopone （OFL 1.1）。
文字は「基本ラテン・かな・記号」と「サイトの原稿（site/src と docs のポリシー 2 本）に出てくる文字」。
原稿に新しい漢字が増えたら、このスクリプトを回し直す（無い字は本文の書体で出るだけで、崩れはしない）。
"""
import pathlib
import sys

from fontTools import subset

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "site/src/assets/fonts/mochiy-pop-one-subset.woff2"
SOURCES = [*(ROOT / "site/src").rglob("*.astro"), *(ROOT / "site/src").rglob("*.md"),
           *(ROOT / "site/src").rglob("*.json"), *(ROOT / "site/src").rglob("*.ts"),
           ROOT / "docs/privacy.md", ROOT / "docs/code-signing-policy.md"]

def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    chars = set(chr(c) for c in range(0x20, 0x7F))           # 基本ラテン
    chars |= set(chr(c) for c in range(0x3000, 0x3100))      # 和文の記号・ひらがな・カタカナ
    chars |= set(chr(c) for c in range(0xFF01, 0xFF5F))      # 全角英数・記号
    chars |= set("●▲■→←↑↓…・※　")
    for path in SOURCES:
        chars |= {ch for ch in path.read_text(encoding="utf-8") if 0x4E00 <= ord(ch) <= 0x9FFF}
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    font = subset.load_font(sys.argv[1], opts)
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=[ord(c) for c in chars])
    sub.subset(font)
    subset.save_font(font, str(OUT), opts)
    print(f"{OUT.relative_to(ROOT)}: {OUT.stat().st_size // 1024} KB, {len(chars)} 字")

if __name__ == "__main__":
    main()
