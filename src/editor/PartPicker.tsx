import { CATALOG, type CatalogEntry } from "../components/catalog";
import { RENDERERS } from "../components/index";
import { resolveTheme } from "../themes";
import type { PosterSpec } from "../schema";
import { Menu } from "./ui";
import { Ico } from "./uiIcons";

/** 写真系パーツのサムネイルに入れる見本の絵（空の枠だと何のパーツか分かりにくいため） */
const SAMPLE_IMAGE = "data:image/svg+xml;utf8," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8fb8ff"/><stop offset="1" stop-color="#ffb3c7"/></linearGradient></defs><rect width="320" height="240" fill="url(#g)"/><circle cx="240" cy="70" r="30" fill="#fff" opacity=".7"/><path d="M0 240 L90 120 L170 200 L230 150 L320 240Z" fill="#fff" opacity=".55"/></svg>`,
);

/** サムネイル用の props。カタログの defaults に、空に見えるものだけ見本を足す（カタログ自体は変えない） */
export function thumbProps(c: CatalogEntry): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (["polaroid", "circlePhoto", "roundPhoto", "laptop", "phone"].includes(c.name)) extra.src = SAMPLE_IMAGE;
  if (c.name === "stars") Object.assign(extra, { color: "#f4b73f", count: 16 }); // 既定の白だと明るい下地で見えない
  return { ...c.defaults, ...extra };
}

/** サムネイルに描く大きさ。ポスター全面のパーツは、そのままだと小さな粒が潰れるので縮める */
export function thumbSize(c: CatalogEntry): [number, number] {
  return c.name === "stars" ? [320, 200] : c.defaultSize;
}

/** カタログのパーツを、実際の見た目のサムネイル付きで選んで追加するボタン */
export function PartPicker({ spec, onPick }: { spec: PosterSpec; onPick: (name: string) => void }) {
  return (
    <Menu className="part-picker" fixed trigger={({ open, toggle }) => (
      <button aria-haspopup="true" aria-expanded={open} onClick={toggle} aria-label="パーツを追加"><Ico name="plus" size={14} /> パーツ</button>
    )}>
      {(close) => <PartGrid spec={spec} onPick={(name) => { onPick(name); close(); }} />}
    </Menu>
  );
}

function PartGrid({ spec, onPick }: { spec: PosterSpec; onPick: (name: string) => void }) {
  const theme = resolveTheme(spec.theme, spec.themeOverride);
  return (
    <div className="menu-list part-grid" role="group" aria-label="パーツ一覧">
      {CATALOG.map((c) => {
        const render = RENDERERS[c.name];
        const [w, h] = thumbSize(c);
        return (
          <button key={c.name} className="part-cell" title={c.description} onClick={() => onPick(c.name)}>
            <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
              {render?.(thumbProps(c), { id: `thumb-${c.name}`, w, h, theme })}
            </svg>
            <span>{c.label}</span>
          </button>
        );
      })}
    </div>
  );
}
