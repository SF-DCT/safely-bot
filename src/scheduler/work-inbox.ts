import cron from "node-cron";
import { app } from "../app.js";
import { enqueueJob } from "../data-sources/llm-jobs.js";
import { isBusinessDay } from "../utils/jp-holidays.js";

/**
 * 平日 9:30 / 14:00 JST に「依頼の拾い上げ」を PC の worker に依頼する。
 * 仕分けに Claude を使うため、実行は worker（サブスクの Claude Code）側。
 * PC が止まっていれば作業待ちのまま残り、次に起動したときにまとめて1回実行される。
 */
export function scheduleWorkInbox(): void {
  cron.schedule("30 9 * * 1-5", () => void requestScan("morning"), { timezone: "Asia/Tokyo" });
  cron.schedule("0 14 * * 1-5", () => void requestScan("afternoon"), { timezone: "Asia/Tokyo" });
  console.log("[Scheduler] Work inbox scheduled: weekdays 9:30 / 14:00 JST (run on PC worker)");
}

async function requestScan(label: string): Promise<void> {
  if (!isBusinessDay()) {
    console.log(`[Scheduler] Skipping work inbox (${label}, holiday).`);
    return;
  }
  try {
    await enqueueJob(app.client, "work_scan", { manual: false, label });
    console.log(`[Scheduler] Work inbox scan requested to PC worker (${label}).`);
  } catch (e) {
    console.error("[Scheduler] Work inbox request failed:", e);
  }
}
