// 紹介サイトの手書きの中身（docs/design/08_database.md の SITE-TBL-003・004・007）。
// 文字数・列挙値・必須の条件は ここで検証し、違反はビルドを止める。
import { defineCollection } from "astro:content";
import { file, glob } from "astro/loaders";
import { z } from "astro/zod";

// 機能紹介（1 ファイル = 1 機能。本文は説明 2 行まで）
const features = defineCollection({
  loader: glob({ pattern: "*.md", base: "./src/content/features" }),
  schema: z.object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "id はケバブケース"),
    title: z.string().min(1).max(20),
    order: z.number().int(),
    exeAvailable: z.boolean(),
    exeNote: z.string().max(60).optional(),
    mediaId: z.string().optional(),
  }),
});

// 固定文（トップのキャッチ・動作要件）
const pages = defineCollection({
  loader: glob({ pattern: "*.md", base: "./src/content/pages" }),
  schema: z.object({
    slug: z.enum(["home", "requirements"]),
  }),
});

// 媒体。ready のときは src 必須、video は poster 必須
const media = defineCollection({
  loader: file("src/content/media.json"),
  schema: z
    .object({
      id: z.string().min(1),
      type: z.enum(["image", "video"]),
      status: z.enum(["placeholder", "ready"]),
      src: z.string().optional(),
      poster: z.string().optional(),
      alt: z.string().min(1),
    })
    .superRefine((m, ctx) => {
      if (m.status === "ready" && !m.src) {
        ctx.addIssue({ code: "custom", path: ["src"], message: "status が ready のときは src が必要です" });
      }
      if (m.type === "video" && !m.poster) {
        ctx.addIssue({ code: "custom", path: ["poster"], message: "動画にはポスター画像（poster）が必要です" });
      }
    }),
});

export const collections = { features, pages, media };
