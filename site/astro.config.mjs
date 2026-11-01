// DC-Designer 紹介サイト（docs/design/07_architecture.md）。
// CSP を <meta> で入れるため、インラインの CSS・JS を出さない（SITE-D-31）。
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://itiwoja.github.io",
  base: "/DC-Designer",
  trailingSlash: "always",
  output: "static",
  build: {
    inlineStylesheets: "never",
    format: "directory",
  },
  vite: {
    build: {
      // 小さなスクリプト・画像も data: やインラインにせず、別ファイルで出す
      assetsInlineLimit: 0,
    },
  },
});
