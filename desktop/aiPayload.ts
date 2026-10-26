/**
 * AI 送信時に worker と main が共有する送信内容の形とハッシュ。
 * worker は実際に送る bytes からこれを作り、main は画像の bytes を自分でハッシュし直して検証する。
 * payloadHash は画像の data を含めず、sha256・byteLength・mediaType で画像を表した canonical JSON の SHA-256
 */
import { createHash } from "node:crypto";

/** 段階2で製品版が送ってよい AI の送信先（ChatGPT プランのみ） */
export const AI_DESTINATIONS = {
  chatgpt: { endpoint: "https://api.openai.com/v1/responses", label: "ChatGPT プラン（OpenAI）" },
} as const;
export type AiProviderId = keyof typeof AI_DESTINATIONS;

/** 送る画像1枚。data は実際に送る bytes の base64（縮小・圧縮後のもの） */
export type AiImage = { mediaType: string; byteLength: number; sha256: string; data: string };
export type AiTurn = { role: "user" | "assistant"; text: string; images?: AiImage[] };

/** AI 依頼の対象作品（画面が要求に付ける。保存前の新規作品などでは無い） */
export type AiSubject = { kind: "poster" | "deck"; id: string; title: string };

/** subject の形の検証（worker の要求検証と main の verifyAiPayload で共有） */
export function isAiSubject(v: unknown): v is AiSubject {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "kind" && k !== "id" && k !== "title")) return false;
  return (o.kind === "poster" || o.kind === "deck") && typeof o.id === "string" && /^[a-z0-9]{12}$/.test(o.id) && typeof o.title === "string" && o.title.length <= 200;
}

export type AiConsentPayload = {
  providerId: AiProviderId;
  endpoint: string;
  model: string;
  /** 直接接続は "direct"（仲介サービスは段階2では使わない） */
  providerRouting: "direct";
  /** 利用者向けの用途（例「レイアウトの生成」） */
  purpose: string;
  instructions: string;
  turns: AiTurn[];
  /** 対象の作品（無ければ付けない） */
  subject?: AiSubject;
};

/** main による送信内容の検証応答を待つ期限の基準 */
export const AI_CONSENT_TTL_MS = 5 * 60 * 1000;
/** 1回の送信に含めてよい画像の合計（IPC で main へ渡すため） */
export const AI_MAX_IMAGE_BYTES = 64 * 1024 * 1024;

const sha256Hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** 実際に送る bytes から AiImage を作る */
export function toAiImage(mediaType: string, bytes: Buffer): AiImage {
  return { mediaType, byteLength: bytes.length, sha256: sha256Hex(bytes), data: bytes.toString("base64") };
}

/** 画像の data を除いた canonical JSON（キーの順を固定） */
export function canonicalPayload(p: AiConsentPayload): string {
  return JSON.stringify({
    providerId: p.providerId,
    endpoint: p.endpoint,
    model: p.model,
    providerRouting: p.providerRouting,
    purpose: p.purpose,
    instructions: p.instructions,
    subject: p.subject ? { kind: p.subject.kind, id: p.subject.id, title: p.subject.title } : null,
    turns: p.turns.map((t) => ({
      role: t.role,
      text: t.text,
      images: (t.images ?? []).map((i) => ({ mediaType: i.mediaType, byteLength: i.byteLength, sha256: i.sha256 })),
    })),
  });
}

export const payloadHash = (p: AiConsentPayload) => sha256Hex(canonicalPayload(p));

/**
 * main 側の検証：形・送信先・画像の bytes とハッシュの一致を確かめる。
 * 不正なら null（送らない）。正しければ main が計算した payloadHash を返す
 */
export function verifyAiPayload(raw: unknown): { payload: AiConsentPayload; payloadHash: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
  if (typeof p.providerId !== "string" || !Object.hasOwn(AI_DESTINATIONS, p.providerId)) return null;
  const dest = AI_DESTINATIONS[p.providerId as AiProviderId];
  if (p.endpoint !== dest.endpoint || p.providerRouting !== "direct") return null;
  if (!str(p.model, 200) || !p.model || !str(p.purpose, 200) || !str(p.instructions, 2_000_000)) return null;
  if (p.subject !== undefined && !isAiSubject(p.subject)) return null;
  if (!Array.isArray(p.turns) || p.turns.length === 0 || p.turns.length > 200) return null;
  let total = 0;
  for (const t of p.turns as unknown[]) {
    const turn = t as Record<string, unknown> | null;
    if (!turn || (turn.role !== "user" && turn.role !== "assistant") || !str(turn.text, 2_000_000)) return null;
    if (turn.images === undefined) continue;
    if (!Array.isArray(turn.images) || turn.role !== "user") return null;
    for (const i of turn.images as unknown[]) {
      const img = i as Record<string, unknown> | null;
      if (!img || !str(img.mediaType, 100) || !/^image\/(png|jpeg|webp|gif)$/.test(img.mediaType as string)) return null;
      if (typeof img.data !== "string" || typeof img.sha256 !== "string" || typeof img.byteLength !== "number") return null;
      const bytes = Buffer.from(img.data, "base64");
      total += bytes.length;
      if (total > AI_MAX_IMAGE_BYTES) return null;
      if (bytes.length !== img.byteLength || sha256Hex(bytes) !== img.sha256) return null;
    }
  }
  const payload = raw as AiConsentPayload;
  return { payload, payloadHash: payloadHash(payload) };
}
