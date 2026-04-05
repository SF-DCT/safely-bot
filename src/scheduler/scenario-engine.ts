import cron from "node-cron";
import { processEnrollments } from "../scenario/engine.js";

/**
 * 5分毎にシナリオエンジンを実行
 * Railway再起動に強いDBベースのポーリング方式
 */
export function scheduleScenarioEngine(): void {
  cron.schedule(
    "*/5 * * * *",
    async () => {
      try {
        await processEnrollments();
      } catch (e) {
        console.error("[Scheduler] Scenario engine error:", e);
      }
    },
    { timezone: "Asia/Tokyo" },
  );

  console.log("[Scheduler] Scenario engine scheduled: every 5 minutes");
}
