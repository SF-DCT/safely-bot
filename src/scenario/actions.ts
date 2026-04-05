import type { ScenarioStep, Enrollment } from "./types.js";
import { renderTemplate, buildVariables } from "./templates.js";
import { sendScenarioEmail } from "./email-sender.js";
import { app } from "../app.js";
import { SLACK_USER_ID } from "../config/env.js";

export interface StepResult {
  success: boolean;
  detail: Record<string, unknown>;
}

/**
 * ステップを実行し、結果を返す
 */
export async function executeStep(
  step: ScenarioStep,
  enrollment: Enrollment,
): Promise<StepResult> {
  const vars = buildVariables(
    enrollment.contact_email,
    enrollment.contact_name,
    enrollment.contact_data,
  );

  switch (step.type) {
    case "wait":
      // wait ステップは engine 側で next_execute_at を計算するだけ
      return { success: true, detail: { delay_days: step.delay_days } };

    case "email":
      return await executeEmailStep(step, vars);

    case "slack_notify":
      return await executeSlackNotifyStep(step, vars);
  }
}

async function executeEmailStep(
  step: Extract<ScenarioStep, { type: "email" }>,
  vars: Record<string, string>,
): Promise<StepResult> {
  const subject = renderTemplate(step.subject_template, vars);
  const body = renderTemplate(step.body_template, vars);
  const to = vars.contact_email;

  const result = await sendScenarioEmail(to, subject, body, step.from_name);

  return {
    success: result.success,
    detail: {
      to,
      subject,
      message_id: result.messageId,
      error: result.error,
    },
  };
}

async function executeSlackNotifyStep(
  step: Extract<ScenarioStep, { type: "slack_notify" }>,
  vars: Record<string, string>,
): Promise<StepResult> {
  const message = renderTemplate(step.message_template, vars);
  const channel = step.channel ?? undefined;

  try {
    if (channel) {
      await app.client.chat.postMessage({ channel, text: message });
    } else {
      // デフォルト: オペレーター（高橋）のDMに通知
      const dm = await app.client.conversations.open({ users: SLACK_USER_ID });
      if (dm.channel?.id) {
        await app.client.chat.postMessage({ channel: dm.channel.id, text: message });
      }
    }
    return { success: true, detail: { channel: channel ?? "DM", message } };
  } catch (e) {
    return {
      success: false,
      detail: { error: e instanceof Error ? e.message : String(e) },
    };
  }
}
