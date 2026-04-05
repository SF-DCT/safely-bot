import {
  getActiveEnrollmentsDue,
  getScenario,
  advanceEnrollment,
  completeEnrollment,
  logExecution,
} from "./repository.js";
import { executeStep } from "./actions.js";
import type { ScenarioStep } from "./types.js";

/**
 * メインエンジン: 実行期限が来た enrollment を処理する
 * 5分毎の cron から呼び出される
 */
export async function processEnrollments(): Promise<number> {
  const due = await getActiveEnrollmentsDue();
  if (due.length === 0) return 0;

  let processed = 0;

  for (const enrollment of due) {
    try {
      const scenario = await getScenario(enrollment.scenario_id);
      if (!scenario || !scenario.is_active) {
        console.log(`[Scenario] Skipping enrollment ${enrollment.id}: scenario inactive or missing.`);
        continue;
      }

      const steps = scenario.steps as ScenarioStep[];
      const stepIndex = enrollment.current_step;

      if (stepIndex >= steps.length) {
        await completeEnrollment(enrollment.id);
        await logExecution(
          enrollment.id,
          scenario.id,
          stepIndex,
          "complete",
          "success",
          { reason: "all_steps_done" },
        );
        processed++;
        continue;
      }

      const step = steps[stepIndex];

      // wait ステップはスキップして次のアクションステップへ進む
      if (step.type === "wait") {
        const nextIndex = stepIndex + 1;
        if (nextIndex >= steps.length) {
          await completeEnrollment(enrollment.id);
          await logExecution(enrollment.id, scenario.id, stepIndex, "wait", "success", {
            delay_days: step.delay_days,
            result: "completed_after_wait",
          });
        } else {
          // wait の次のステップを即実行するため、next_execute_at を now に設定
          await advanceEnrollment(enrollment.id, nextIndex, new Date());
          await logExecution(enrollment.id, scenario.id, stepIndex, "wait", "success", {
            delay_days: step.delay_days,
          });
        }
        processed++;
        continue;
      }

      // email / slack_notify ステップを実行
      const result = await executeStep(step, enrollment);

      await logExecution(
        enrollment.id,
        scenario.id,
        stepIndex,
        step.type,
        result.success ? "success" : "failed",
        result.detail,
      );

      if (result.success) {
        const nextIndex = stepIndex + 1;
        if (nextIndex >= steps.length) {
          await completeEnrollment(enrollment.id);
        } else {
          const nextExecuteAt = computeNextExecuteAt(steps, nextIndex);
          await advanceEnrollment(enrollment.id, nextIndex, nextExecuteAt);
        }
      }
      // 失敗時は同じステップに留まり、次回の cron tick でリトライ

      processed++;
    } catch (e) {
      console.error(`[Scenario] Error processing enrollment ${enrollment.id}:`, e);
    }
  }

  if (processed > 0) {
    console.log(`[Scenario] Processed ${processed} enrollment(s).`);
  }

  return processed;
}

/**
 * 次のステップの実行時刻を計算
 * 次が wait ステップならその delay_days 後、それ以外は即時
 */
function computeNextExecuteAt(steps: ScenarioStep[], nextIndex: number): Date {
  const nextStep = steps[nextIndex];
  if (nextStep?.type === "wait") {
    const ms = nextStep.delay_days * 24 * 60 * 60 * 1000;
    return new Date(Date.now() + ms);
  }
  // アクションステップなら即実行
  return new Date();
}
