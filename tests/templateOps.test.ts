import { describe, expect, it } from "vitest";
import { DESKTOP_OPERATIONS, matchDesktopOperation, resolveDesktopRequest } from "../desktop/operations";

describe("テンプレートの操作表", () => {
  const id = "0123456789ab";
  const table: [string, string, string, string, number | undefined][] = [
    ["templates.list", "GET", "/api/templates", "/api/templates", undefined],
    ["templates.create", "POST", "/api/templates", "/api/templates", 4096],
    ["templates.update", "PUT", "/api/templates/:id", `/api/templates/${id}`, 4096],
    ["templates.delete", "DELETE", "/api/templates/:id", `/api/templates/${id}`, undefined],
    ["templates.use", "POST", "/api/templates/:id/use", `/api/templates/${id}/use`, 1024],
  ];
  it("method・route・上限が約束どおりで、画面の URL から解決できる", () => {
    for (const [name, method, route, url, maxBody] of table) {
      expect(DESKTOP_OPERATIONS[name as keyof typeof DESKTOP_OPERATIONS]).toMatchObject({ method, route, ...(maxBody ? { maxBody } : {}) });
      const m = matchDesktopOperation(method, url);
      expect(m?.operation).toBe(name);
      expect(resolveDesktopRequest({ operation: name, ...(m?.params ? { params: m.params } : {}) })?.path).toBe(url);
    }
  });
  it("不正な ID は解決しない", () => {
    expect(matchDesktopOperation("POST", "/api/templates/../use")).toBeNull();
    expect(matchDesktopOperation("DELETE", "/api/templates/ZZ")).toBeNull();
  });
});
