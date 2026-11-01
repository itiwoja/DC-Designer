// sitemap.xml（404 を除く 5 ページ）。依存を足さず、静的エンドポイントで出す。
import type { APIRoute } from "astro";

const paths = ["/", "/download/", "/changelog/", "/privacy/", "/code-signing/"];

export const GET: APIRoute = ({ site }) => {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, "");
  const urls = paths.map((p) => `  <url><loc>${new URL(`${base}${p}`, site).href}</loc></url>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
};
