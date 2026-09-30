import cron from "node-cron";
import { app } from "../app.js";
import { SLACK_USER_ID } from "../config/env.js";
import { runWorkScan } from "../data-sources/work-inbox.js";
import { isBusinessDay } from "../utils/jp-holidays.js";

let running = false;

/**
 * 平日 9:30 / 14:00 JST に高橋さん宛ての依頼を拾い、DM に提案カードを送る
 * （22時〜翌5時は動かさない。執行役員の行動指針に合わせて日中だけ）
 */
export function scheduleWorkInbox(): void {
  cron.schedule(
    "30 9 * * 1-5",
    () => void runScheduled("morning"),
    { timezone: "Asia/Tokyo" },
  );
  cron.schedule(
    "0 14 * * 1-5",
    () => void runScheduled("afternoon"),
    { timezone: "Asia/Tokyo" },
  );
  console.log("[Scheduler] Work inbox scheduled: weekdays 9:30 / 14:00 JST");
}

export async function runScheduled(label: string): Promise<void> {
  if (!isBusinessDay()) {
    console.log(`[Scheduler] Skipping work inbox (${label}, holiday).`);
    return;
  }
  if (running) {
    console.log(`[Scheduler] Work inbox already running, skip (${label}).`);
    return;
  }
  running = true;
  console.log(`[Scheduler] Starting work inbox scan (${label})...`);
  try {
    const summary = await runWorkScan(app.client);
    console.log(`[Scheduler] Work inbox done: ${summary}`);
  } catch (e) {
    console.error("[Scheduler] Work inbox failed:", e);
    try {
      const dm = await app.client.conversations.open({ users: SLACK_USER_ID });
      if (dm.channel?.id) {
        await app.client.chat.postMessage({
          channel: dm.channel.id,
          text: `:x: 依頼の拾い上げでエラーが発生しました: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    } catch {
      // DM送信自体が失敗した場合はログのみ
    }
  } finally {
    running = false;
  }
}

/** DM からの手動実行（「依頼を拾って」など）。定時実行と重ならないようにする */
export async function runManualWorkScan(): Promise<string> {
  if (running) return "いま依頼の拾い上げを実行中です。終わり次第カードが届きます。";
  running = true;
  try {
    return await runWorkScan(app.client, { manual: true });
  } finally {
    running = false;
  }
}
