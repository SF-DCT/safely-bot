import Anthropic from "@anthropic-ai/sdk";

// moved = Railway 上から呼ばれた（Claude の処理は PC の worker で動かす方針）
// outdated = PC の Claude Code が古く、既定のモデルを使えない（claude update が必要）
export type ClaudeErrorKind = "credit" | "auth" | "rate" | "server" | "moved" | "outdated";

/**
 * Slack にそのまま出せる日本語の説明を持つ Claude API エラー。
 * 生の API エラー（英語の JSON）を DM に流さないために使う。
 */
export class FriendlyClaudeError extends Error {
  constructor(
    message: string,
    readonly kind: ClaudeErrorKind,
  ) {
    super(message);
    this.name = "FriendlyClaudeError";
  }
}

/**
 * Claude API のエラーのうち、利用者が対処できる既知のもの（残高不足・認証・上限・不調）を
 * 日本語の説明つきエラーに変える。それ以外は null。
 */
export function toFriendlyClaudeError(e: unknown): FriendlyClaudeError | null {
  if (e instanceof FriendlyClaudeError) return e;
  if (!(e instanceof Anthropic.APIError)) return null;
  const body = e.error as { error?: { message?: string } } | undefined;
  const message = body?.error?.message || e.message || "";

  if (/credit balance is too low/i.test(message)) {
    return new FriendlyClaudeError(
      "Anthropic API のクレジット残高が不足しているため、mamo の Claude 機能（依頼の仕分け・返信の下書き・DMでの会話）が止まっています。Claude Console（platform.claude.com）の Plans & Billing でクレジットを追加すると再開します。",
      "credit",
    );
  }
  if (e.status === 401) {
    return new FriendlyClaudeError(
      "Anthropic API キーが無効になっています（Railway の ANTHROPIC_API_KEY を確認してください）。",
      "auth",
    );
  }
  if (e.status === 429) {
    return new FriendlyClaudeError(
      "Anthropic API の利用上限に達しています。しばらくしてから再度お試しください。",
      "rate",
    );
  }
  if (typeof e.status === "number" && e.status >= 500) {
    return new FriendlyClaudeError(
      "Anthropic API が一時的に不調です。しばらくしてから再度お試しください。",
      "server",
    );
  }
  return null;
}
