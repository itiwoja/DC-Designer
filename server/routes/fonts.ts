import type { Router } from "express";
import { runWithAiSubject } from "../ai-consent";
import { acquireFonts, embedFonts, fontFiles, fontStatus, installFonts, parseExpect, parseFaces, suggestFonts } from "../fonts";
import { parseSubject, strings } from "../request-parsers";
import type { RouteHandlers } from "../route-handlers";

/** フォントの提案・取得・インストール・埋め込み */
export function registerFontRoutes(app: Router, { route }: RouteHandlers) {
  const families = (v: unknown) => strings(v, 20);
  app.post("/api/fonts/suggest", route(async (req, signal) => {
    const subject = parseSubject(req.body?.subject);
    const { kind, mood, title, texts, current } = req.body ?? {};
    return runWithAiSubject(subject, async () => ({ proposals: await suggestFonts({ kind: kind === "poster" || kind === "instagram" ? kind : "slides", mood, title, texts: strings(texts, 200), current, signal }) }));
  }));
  app.post("/api/fonts/status", route((req) => fontStatus(families(req.body?.families))));
  app.post("/api/fonts/files", route((req) => fontFiles(parseFaces(req.body?.faces))));
  app.post("/api/fonts/acquire", route((req) => acquireFonts(parseFaces(req.body?.faces))));
  app.post("/api/fonts/install", route((req) => {
    const expect = req.body?.expect === undefined ? undefined : parseExpect(req.body.expect);
    return installFonts(families(req.body?.families), expect);
  }));
  app.post("/api/fonts/embed", route(async (req) => {
    const list: unknown[] = Array.isArray(req.body?.fonts) ? req.body.fonts.slice(0, 20) : [];
    const fonts = list.flatMap((f) => {
      const { family, bold } = (f ?? {}) as Record<string, unknown>;
      return typeof family === "string" ? [{ family, bold: bold === true }] : [];
    });
    return { fonts: await embedFonts(fonts) };
  }));
}
