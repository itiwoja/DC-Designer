import { continueRender, delayRender, staticFile } from "remotion";

// 書き出しの前にフォントを読み終える（読み込み前のコマが代わりの書体で出ないように）
const faces = [
  new FontFace("Mochiy Pop One", `url(${staticFile("fonts/MochiyPopOne-Regular.ttf")})`, { weight: "400" }),
  new FontFace("Noto Sans JP", `url(${staticFile("fonts/NotoSansJP.ttf")})`, { weight: "100 900" }),
];
const handle = delayRender("fonts");
Promise.all(faces.map((f) => f.load().then(() => document.fonts.add(f))))
  .then(() => continueRender(handle))
  .catch((e) => {
    console.error(e);
    continueRender(handle);
  });
