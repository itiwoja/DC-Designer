/**
 * 画像生成・Codex の準備で起きた、利用者が自分で直せる失敗。
 * userMessage は製品版でも画面にそのまま出す文言（パス・キー・外部の応答本文を含めない）。
 * message は開発版の画面とログ用で、原因の詳細（外部の応答の一部など）を含めてよい
 */
export class ImageGenError extends Error {
  constructor(
    public code: string,
    public userMessage: string,
    detail?: string,
    /** 応答の HTTP ステータス。設定の不足など利用者側で直すものは 4xx、外部の失敗は 502 */
    public status = 502,
  ) {
    super(detail ? `${userMessage}（${detail}）` : userMessage);
    this.name = "ImageGenError";
  }
}
