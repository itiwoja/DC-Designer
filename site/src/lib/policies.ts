// docs/ のポリシー文書を読み込む（SITE-FR-007、SITE-TBL-005）。
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { Policy } from "./types.ts";
import { SITE_CONFIG, REPO_URL } from "./config.ts";
import { renderPolicyMarkdown } from "./markdown.ts";

type Slug = Policy["slug"];

const SOURCES: Record<Slug, string> = {
  privacy: "docs/privacy.md",
  "code-signing": "docs/code-signing-policy.md",
};

/** サイトのページになっている文書（GitHub の URL ではなくサイト内へ） */
const SITE_PAGES: Record<string, string> = Object.fromEntries(
  (Object.keys(SOURCES) as Slug[]).map((slug) => [SOURCES[slug], `${SITE_CONFIG.base}/${slug}/`]),
);

const BLOB_ROOT = `${REPO_URL}/blob/main/`;

/** 相対リンクを、GitHub 上の URL（サイトのページがある文書はサイト内）へ書き換える */
export function rewritePolicyHref(href: string, sourcePath: string): string {
  const url = new URL(href, BLOB_ROOT + sourcePath);
  if (url.origin === "https://github.com" && url.pathname.startsWith(new URL(BLOB_ROOT).pathname)) {
    const repoPath = decodeURIComponent(url.pathname.slice(new URL(BLOB_ROOT).pathname.length));
    const page = SITE_PAGES[repoPath];
    if (page) return page + url.hash;
  }
  return url.href;
}

/** 最初の `#` 見出しを取り出し、見出しを除いた本文を返す（コードブロック内は見ない） */
export function splitTitle(md: string): { title: string; body: string } {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      return { title: m[1]!, body: [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n") };
    }
  }
  throw new Error("ポリシー文書に # 見出しがありません");
}

function lastCommitDate(sourcePath: string, repoRoot: string): string | null {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cI", "--", sourcePath], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** Markdown と更新日から Policy を作る（テスト用に export） */
export function buildPolicy(slug: Slug, md: string, updatedAt: string | null): Policy {
  const sourcePath = SOURCES[slug];
  const { title, body } = splitTitle(md);
  return {
    slug,
    sourcePath,
    title,
    bodyHtml: renderPolicyMarkdown(body, (href) => rewritePolicyHref(href, sourcePath)),
    updatedAt,
  };
}

export async function getPolicy(slug: Slug): Promise<Policy> {
  const sourcePath = SOURCES[slug];
  // ビルドは site/ で動くので、リポジトリの直下はひとつ上
  const repoRoot = resolve(process.cwd(), "..");
  const md = await readFile(resolve(repoRoot, sourcePath), "utf8");
  return buildPolicy(slug, md, lastCommitDate(sourcePath, repoRoot));
}
