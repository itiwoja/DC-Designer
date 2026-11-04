import { describe, expect, it } from "vitest";
import { imagesOf } from "../src/editor/ChatLog";

describe("imagesOf", () => {
  it("古いログの image（1 枚）も images と同じく出せる", () => {
    expect(imagesOf({ image: "/generated/a.png" })).toEqual(["/generated/a.png"]);
    expect(imagesOf({ images: ["/generated/a.png", "/generated/b.png"] })).toEqual(["/generated/a.png", "/generated/b.png"]);
    expect(imagesOf({})).toEqual([]);
  });
});
