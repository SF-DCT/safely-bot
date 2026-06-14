import cron from "node-cron";
import { app } from "../app.js";
import { SLACK_USER_ID } from "../config/env.js";
import { findMirrorBounces } from "../data-sources/gmail.js";

// 同一バウンスの重複通知を防ぐ（プロセス内で記憶。再デプロイ時はリセット）
const alertedBounceIds = new Set<string>();

/**
 * ミラーサイト通知メールの送信失敗を監視する（30分ごと）。
 *
 * mailer-daemon の 535 BadCredentials バウンス（= Send mail as エイリアス
 * toiretsumari.center@gmail.com のアプリPW失効）を検知し、新規があれば
 * 高橋さんのDMへ対処手順つきで即時アラートする。
 *
 * 背景: 2026-06-13、アプリPW失効で全ミラー通知（事業者通知・お客様自動返信）が
 * サイレントにバウンスし、約21時間気づけなかった。その再発防止。
 * フォーム流入は土日・深夜も発生するため、平日判定は入れない（24/7監視）。
 */
export function scheduleMirrorBounceCheck(): void {
  cron.schedule(
    "*/30 * * * *",
    async () => {
      try {
        const bounces = await findMirrorBounces(2);
        const fresh = bounces.filter((b) => !alertedBounceIds.has(b.id));
        if (fresh.length === 0) return;
        fresh.forEach((b) => alertedBounceIds.add(b.id));

        const dm = await app.client.conversations.open({
          users: SLACK_USER_ID,
        });
        const channelId = dm.channel?.id;
        if (!channelId) {
          console.error("[MirrorBounce] Failed to open DM channel.");
          return;
        }

        const message = [
          ":rotating_light: *ミラー通知メールの送信が失敗しています*",
          "",
          `直近2時間で *${fresh.length}件* の配信エラー（535 BadCredentials）を検知しました。`,
          "送信元エイリアス `toiretsumari.center@gmail.com` のアプリパスワード失効が原因の可能性が高く、",
          "この状態では全ミラーサイトの事業者通知・お客様への自動返信が届きません。",
          "",
          "*対処手順:*",
          "1. `toiretsumari.center@gmail.com` でアプリパスワードを再生成",
          "2. `takahashi@safely.co.jp` Gmail → 設定 → アカウントとインポート → 「他のメールアドレスでメールを送信」→ 該当エイリアスの SMTP パスワードを更新",
          "3. いずれかのミラーフォームからテスト送信で復旧を確認",
          "",
          "*検知したエラー:*",
          ...fresh
            .slice(0, 10)
            .map((b) => `• ${b.date} — ${b.subject || "(件名なし)"}`),
        ].join("\n");

        await app.client.chat.postMessage({
          channel: channelId,
          text: message,
          mrkdwn: true,
        });

        console.log(`[MirrorBounce] Alerted ${fresh.length} new bounce(s).`);
      } catch (e) {
        console.error("[MirrorBounce] check failed:", e);
      }
    },
    { timezone: "Asia/Tokyo" },
  );

  console.log("[Scheduler] Mirror bounce check scheduled: every 30 min (24/7)");
}
