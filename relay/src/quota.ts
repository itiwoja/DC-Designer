/**
 * 中継全体で 1 時間・1 日あたりに作る Issue の数の上限。
 * Workers の Rate Limiting は Cloudflare の拠点ごとに数えるので、本当に全体で数えるため Durable Object を 1 つだけ使う。
 */

/** 1 時間・1 日あたりの上限（超えたら中継は 503 を返し、アプリは「ブラウザの GitHub で送る」を出す） */
export const QUOTA_PER_HOUR = 30;
export const QUOTA_PER_DAY = 100;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Durable Object の storage のうち使う部分 */
export interface QuotaStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

type Window = { w: number; n: number };

/** 期間ごとの件数を数え、上限内なら 1 件数えて true を返す。どちらかが上限なら数えずに false */
export async function takeQuota(storage: QuotaStorage, nowMs: number): Promise<boolean> {
  const hour = Math.floor(nowMs / HOUR_MS);
  const day = Math.floor(nowMs / DAY_MS);
  const h = await storage.get<Window>("hour");
  const d = await storage.get<Window>("day");
  const hn = h?.w === hour ? h.n : 0;
  const dn = d?.w === day ? d.n : 0;
  if (hn >= QUOTA_PER_HOUR || dn >= QUOTA_PER_DAY) return false;
  await storage.put<Window>("hour", { w: hour, n: hn + 1 });
  await storage.put<Window>("day", { w: day, n: dn + 1 });
  return true;
}

/** Durable Object の名前空間のうち使う部分 */
export interface QuotaNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

/** 全体の枠を 1 件取る。上限・失敗なら false（失敗したときも送らない側に倒す） */
export async function takeGlobalQuota(ns: QuotaNamespace): Promise<boolean> {
  try {
    const res = await ns.get(ns.idFromName("global")).fetch("https://quota/take", { method: "POST" });
    return res.status === 204;
  } catch (e) {
    console.warn(`全体の上限の確認に失敗しました: ${e instanceof Error ? e.name : "unknown"}`);
    return false;
  }
}

/** 全体の件数を数える Durable Object（wrangler.jsonc の durable_objects / migrations） */
export class FeedbackQuota {
  constructor(private readonly state: { storage: QuotaStorage }) {}

  async fetch(): Promise<Response> {
    const ok = await takeQuota(this.state.storage, Date.now());
    return new Response(null, { status: ok ? 204 : 429 });
  }
}
