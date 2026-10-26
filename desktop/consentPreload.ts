/**
 * AI 送信確認窓の専用 preload（sandbox・isolated world）。electron 以外を読まない。
 * 表示の DOM はここで組み立てる（テキストは textContent、画像は data: URL のプレビューだけ）
 */
import { ipcRenderer } from "electron";

type Img = { mediaType: string; byteLength: number; sha256: string; data: string };
type View = {
  requestId: string; payloadHash: string; expiresAt: number;
  payload: {
    endpoint: string; model: string; providerRouting: string; purpose: string; instructions: string;
    turns: { role: "user" | "assistant"; text: string; images?: Img[] }[];
  };
};

const ARM_DELAY_MS = 1000;
const IMG_TYPE = /^image\/(png|jpeg|webp|gif)$/;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function section(title: string, id: string): HTMLElement {
  const s = el("section");
  s.setAttribute("aria-labelledby", id);
  const h = el("h2", title);
  h.id = id;
  s.append(h);
  return s;
}

function render(v: View): void {
  const root = document.getElementById("root");
  if (!root) return;
  const p = v.payload;
  const images = p.turns.flatMap((t) => t.images ?? []);
  const totalBytes = images.reduce((a, i) => a + i.byteLength, 0);

  const h1 = el("h1", "AI へ送信する内容の確認");
  const lead = el("p", "下の内容がそのまま外部へ送られます。送る場合は「この内容を一回送信」を押してください。今回だけ有効です。", "lead");

  const dest = section("送信先と用途", "h-dest");
  const dl = el("dl");
  const rows: [string, string][] = [
    ["送信先", p.endpoint], ["モデル", p.model], ["接続", p.providerRouting === "direct" ? "直接接続" : p.providerRouting],
    ["用途", p.purpose], ["画像", `${images.length} 枚（合計 ${kb(totalBytes)}）`],
  ];
  for (const [k, val] of rows) dl.append(el("dt", k), el("dd", val));
  dest.append(dl);

  const body = section("送信する本文", "h-body");
  const addBlock = (label: string, text: string, imgs: Img[] = []) => {
    const box = el("div", undefined, "turn");
    box.append(el("h3", label));
    const pre = el("pre", text);
    pre.tabIndex = 0;
    pre.setAttribute("aria-label", `${label}の本文`);
    box.append(pre);
    imgs.forEach((im, i) => {
      const fig = el("figure");
      if (IMG_TYPE.test(im.mediaType)) {
        const img = el("img");
        img.alt = `${label}に添付する画像 ${i + 1}`;
        img.src = `data:${im.mediaType};base64,${im.data}`;
        fig.append(img);
      }
      fig.append(el("figcaption", `画像 ${i + 1}：${im.mediaType}・${kb(im.byteLength)}`));
      box.append(fig);
    });
    body.append(box);
  };
  addBlock("指示文", p.instructions);
  p.turns.forEach((t, i) => addBlock(`${i + 1}. ${t.role === "user" ? "あなたの入力" : "AI の過去の返答"}`, t.text, t.images));

  const status = el("p", "", "status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const remain = el("p", "", "remain");

  const bar = el("div", undefined, "bar");
  const cancel = el("button", "送信しない", "secondary");
  cancel.type = "button";
  const send = el("button", "この内容を一回送信", "primary");
  send.type = "button";
  send.disabled = true;
  bar.append(cancel, send);

  root.replaceChildren(h1, lead, dest, body, status, remain, bar);

  let done = false;
  const decide = (decision: "approve" | "deny") => {
    if (done) return;
    done = true;
    cancel.disabled = true;
    send.disabled = true;
    ipcRenderer.send("consent:decide", { requestId: v.requestId, payloadHash: v.payloadHash, decision });
  };
  cancel.addEventListener("click", () => decide("deny"));
  // Enter 単独では承認しない（クリックか Space、表示から待ち時間の後だけ）
  send.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
  send.addEventListener("click", (e) => {
    if (!e.isTrusted || send.disabled) return;
    decide("approve");
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") decide("deny"); });

  status.textContent = `誤操作を防ぐため、送信ボタンは約 ${ARM_DELAY_MS / 1000} 秒後に押せるようになります。`;
  setTimeout(() => {
    if (done) return;
    send.disabled = false;
    status.textContent = "";
  }, ARM_DELAY_MS);
  cancel.focus();

  const tick = () => {
    const s = Math.max(0, Math.ceil((v.expiresAt - Date.now()) / 1000));
    remain.textContent = `この確認は あと ${Math.floor(s / 60)}分${String(s % 60).padStart(2, "0")}秒 で期限切れになります。`;
  };
  tick();
  setInterval(tick, 1000);
}

ipcRenderer.on("consent:outcome", (_e, o: unknown) => {
  const status = document.querySelector(".status");
  if (!status) return;
  const text: Record<string, string> = {
    sending: "送信中です。", completed: "送信が完了しました。", failed: "送信に失敗しました。", outcomeUnknown: "送信の結果を確認できませんでした。",
  };
  if (typeof o === "string" && o in text) status.textContent = text[o];
  if (o === "completed" || o === "failed" || o === "outcomeUnknown") {
    document.querySelectorAll("button").forEach((b) => { (b as HTMLButtonElement).disabled = true; });
    const close = el("button", "閉じる", "primary");
    close.type = "button";
    close.addEventListener("click", () => ipcRenderer.send("consent:close"));
    document.querySelector(".bar")?.replaceChildren(close);
    close.focus();
  }
});

window.addEventListener("DOMContentLoaded", () => {
  void ipcRenderer.invoke("consent:get-view").then((v: View | null) => {
    if (v) render(v);
  });
});
