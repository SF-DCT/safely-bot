import { z } from "zod";

// --- ステップ定義 ---

const WaitStepSchema = z.object({
  type: z.literal("wait"),
  delay_days: z.number().positive(),
});

const EmailStepSchema = z.object({
  type: z.literal("email"),
  subject_template: z.string(),
  body_template: z.string(),
  from_name: z.string().optional(),
});

const SlackNotifyStepSchema = z.object({
  type: z.literal("slack_notify"),
  channel: z.string().optional(),
  message_template: z.string(),
});

export const ScenarioStepSchema = z.discriminatedUnion("type", [
  WaitStepSchema,
  EmailStepSchema,
  SlackNotifyStepSchema,
]);

export type ScenarioStep = z.infer<typeof ScenarioStepSchema>;

// --- シナリオ定義 ---

export const ScenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  trigger_type: z.enum(["manual", "webhook", "sf_poll"]),
  trigger_config: z.record(z.unknown()).default({}),
  steps: z.array(ScenarioStepSchema).min(1),
  is_active: z.boolean().default(true),
});

export type Scenario = z.infer<typeof ScenarioSchema>;

// --- Enrollment ---

export type EnrollmentStatus = "active" | "completed" | "paused" | "cancelled";

export interface Enrollment {
  id: string;
  scenario_id: string;
  contact_email: string;
  contact_name: string | null;
  contact_data: Record<string, unknown>;
  current_step: number;
  status: EnrollmentStatus;
  enrolled_at: string;
  next_execute_at: string | null;
  completed_at: string | null;
}

// --- 実行ログ ---

export type ExecutionStatus = "success" | "failed" | "skipped";

export interface ExecutionLog {
  id: string;
  enrollment_id: string;
  scenario_id: string;
  step_index: number;
  step_type: string;
  status: ExecutionStatus;
  detail: Record<string, unknown>;
  executed_at: string;
}
