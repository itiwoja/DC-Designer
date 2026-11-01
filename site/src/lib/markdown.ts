// Markdown → 無害化した HTML（SITE-FR-006・007）。生の HTML は捨て、許可した要素だけ残す。
import { unified, type Plugin } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import type { Element, Root } from "hast";

const BASE_TAGS = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "br", "hr",
  "ul", "ol", "li",
  "a", "em", "strong",
  "code", "pre",
  "blockquote",
];
const TABLE_TAGS = ["table", "thead", "tbody", "tr", "th", "td"];

function makeSchema(withTables: boolean): SanitizeSchema {
  return {
    ...defaultSchema,
    tagNames: withTables ? [...BASE_TAGS, ...TABLE_TAGS] : BASE_TAGS,
    attributes: {
      a: ["href"],
      code: [["className", /^language-./]],
      ...(withTables ? { th: ["align"], td: ["align"] } : {}),
    },
    // リンクは https だけ。相対リンクは protocol が無いので通り、後段で扱う
    protocols: { href: ["https"] },
    // 見出しなどの id は使わない
    clobber: [],
    // 許可しない要素は、中の文字だけ残す（<script> の中身は消す）
    strip: ["script", "style"],
  };
}

/** 全ての要素を巡る（外部依存を増やさないための小さな走査） */
function walk(node: Root | Element, fn: (el: Element) => void): void {
  for (const child of node.children) {
    if (child.type === "element") {
      fn(child);
      walk(child, fn);
    }
  }
}

const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** 無害化の前に、相対リンクだけ書き換える */
const rewriteRelativeLinks =
  (rewriteHref: (href: string) => string): Plugin<[], Root> =>
  () =>
  (tree) => {
    walk(tree, (el) => {
      if (el.tagName !== "a") return;
      const href = el.properties?.href;
      if (typeof href !== "string") return;
      if (HAS_SCHEME.test(href) || href.startsWith("#") || href.startsWith("//")) return;
      el.properties.href = rewriteHref(href);
    });
  };

/** 無害化のあと、https:・サイト内（/…）・ページ内（#…）以外のリンクから href を外し、外部リンクに rel を付ける */
const finalizeLinks =
  (allowInternal: boolean): Plugin<[], Root> =>
  () =>
  (tree) => {
    walk(tree, (el) => {
      if (el.tagName !== "a") return;
      const href = el.properties?.href;
      if (typeof href !== "string") return;
      const isHttps = /^https:\/\//i.test(href);
      const isInternal = allowInternal && (href.startsWith("#") || (href.startsWith("/") && !href.startsWith("//")));
      if (isHttps) {
        el.properties.rel = ["noopener", "noreferrer"];
      } else if (!isInternal) {
        delete el.properties.href;
      }
    });
  };

function render(md: string, opts: { tables: boolean; rewriteHref?: (href: string) => string }): string {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    // allowDangerousHtml を付けないので、生の HTML はここで捨てられる
    .use(remarkRehype);
  if (opts.rewriteHref) processor.use(rewriteRelativeLinks(opts.rewriteHref));
  return String(
    processor
      .use(rehypeSanitize, makeSchema(opts.tables))
      .use(finalizeLinks(Boolean(opts.rewriteHref)))
      .use(rehypeStringify)
      .processSync(md),
  );
}

/** リリースノート用。見出し・段落・リスト・リンク・強調・コード・引用だけ。リンクは https: だけ */
export function renderReleaseNotes(md: string): string {
  return render(md, { tables: false });
}

/** ポリシー用。上に加えて表（GFM）も許可し、相対リンクを rewriteHref で書き換える */
export function renderPolicyMarkdown(md: string, rewriteHref: (href: string) => string): string {
  return render(md, { tables: true, rewriteHref });
}
