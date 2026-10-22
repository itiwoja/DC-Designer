/** HTTP ステータス付きのエラー。index.ts の sendError が 4xx ならこの status で返す */
export const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });
