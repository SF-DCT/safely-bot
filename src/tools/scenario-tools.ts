import Anthropic from "@anthropic-ai/sdk";
import {
  listScenarios,
  enrollContact,
  getEnrollmentByEmail,
  getAllActiveEnrollments,
  cancelEnrollment,
  getScenario,
} from "../scenario/repository.js";
import type { ScenarioStep } from "../scenario/types.js";

export const scenarioTools: Anthropic.Tool[] = [
  {
    name: "list_scenarios",
    description:
      "利用可能なシナリオ（ドリップキャンペーン）の一覧を表示する。「シナリオ一覧」「どんなシナリオがある？」などのリクエストで使う。",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "enroll_contact",
    description:
      "連絡先をシナリオに登録する。メールアドレスとシナリオIDを指定する。「〇〇さんを資料請求フォローに登録して」「シナリオに追加して」などのリクエストで使う。",
    input_schema: {
      type: "object" as const,
      properties: {
        scenario_id: {
          type: "string",
          description:
            "シナリオID。例: document_request_drip, lost_deal_followup",
        },
        email: {
          type: "string",
          description: "登録する連絡先のメールアドレス",
        },
        name: {
          type: "string",
          description: "連絡先の名前（任意）",
        },
        company: {
          type: "string",
          description: "会社名（任意）",
        },
      },
      required: ["scenario_id", "email"],
    },
  },
  {
    name: "check_enrollments",
    description:
      "シナリオの登録状況を確認する。現在アクティブなシナリオ登録者の一覧を表示する。「シナリオの進捗は？」「誰がシナリオに入ってる？」などのリクエストで使う。",
    input_schema: {
      type: "object" as const,
      properties: {
        scenario_id: {
          type: "string",
          description: "特定シナリオのみ確認する場合のシナリオID（省略時は全シナリオ）",
        },
      },
      required: [],
    },
  },
  {
    name: "cancel_enrollment",
    description:
      "シナリオ登録を解除する。メールアドレスとシナリオIDを指定する。「〇〇さんのシナリオ止めて」「シナリオ解除して」などのリクエストで使う。",
    input_schema: {
      type: "object" as const,
      properties: {
        scenario_id: {
          type: "string",
          description: "シナリオID",
        },
        email: {
          type: "string",
          description: "解除する連絡先のメールアドレス",
        },
      },
      required: ["scenario_id", "email"],
    },
  },
];

export async function executeScenarioTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "list_scenarios": {
      const scenarios = await listScenarios();
      if (scenarios.length === 0) return "登録されたシナリオはありません。";

      const lines = [`シナリオ一覧（${scenarios.length}件）\n`];
      for (const s of scenarios) {
        const stepSummary = summarizeSteps(s.steps as ScenarioStep[]);
        lines.push(`■ ${s.name} (ID: ${s.id})`);
        if (s.description) lines.push(`  ${s.description}`);
        lines.push(`  ステップ: ${stepSummary}`);
        lines.push("");
      }
      return lines.join("\n");
    }

    case "enroll_contact": {
      const scenarioId = input.scenario_id as string;
      const email = input.email as string;
      const contactName = (input.name as string) || null;
      const company = (input.company as string) || undefined;

      const scenario = await getScenario(scenarioId);
      if (!scenario) return `シナリオ「${scenarioId}」が見つかりません。`;

      const existing = await getEnrollmentByEmail(scenarioId, email);
      if (existing) {
        return `${email} は既にシナリオ「${scenario.name}」に登録済みです（ステップ ${existing.current_step + 1}）。`;
      }

      const contactData: Record<string, unknown> = {};
      if (company) contactData.company = company;

      // 最初のステップに応じて next_execute_at を計算
      const steps = scenario.steps as ScenarioStep[];
      const firstStep = steps[0];
      const nextExecuteAt =
        firstStep?.type === "wait"
          ? new Date(Date.now() + firstStep.delay_days * 24 * 60 * 60 * 1000)
          : new Date();

      const enrollmentId = await enrollContact(
        scenarioId,
        email,
        contactName,
        contactData,
        nextExecuteAt,
      );

      return [
        `✅ シナリオ登録完了`,
        `シナリオ: ${scenario.name}`,
        `連絡先: ${contactName ?? email} (${email})`,
        `登録ID: ${enrollmentId}`,
        `最初のアクション: ${formatNextExecute(firstStep, nextExecuteAt)}`,
      ].join("\n");
    }

    case "check_enrollments": {
      const scenarioId = input.scenario_id as string | undefined;
      const enrollments = await getAllActiveEnrollments();
      const filtered = scenarioId
        ? enrollments.filter((e) => e.scenario_id === scenarioId)
        : enrollments;

      if (filtered.length === 0) return "現在アクティブなシナリオ登録はありません。";

      const lines = [`アクティブな登録（${filtered.length}件）\n`];
      for (const e of filtered) {
        const scenario = await getScenario(e.scenario_id);
        lines.push(
          `• ${e.contact_name ?? e.contact_email} (${e.contact_email})`,
        );
        lines.push(
          `  シナリオ: ${scenario?.name ?? e.scenario_id} | ステップ ${e.current_step + 1} | 次回: ${e.next_execute_at ?? "完了待ち"}`,
        );
      }
      return lines.join("\n");
    }

    case "cancel_enrollment": {
      const scenarioId = input.scenario_id as string;
      const email = input.email as string;

      const enrollment = await getEnrollmentByEmail(scenarioId, email);
      if (!enrollment) {
        return `${email} はシナリオ「${scenarioId}」に登録されていません。`;
      }

      await cancelEnrollment(enrollment.id);
      return `✅ ${email} のシナリオ登録を解除しました。`;
    }

    default:
      return `未知のシナリオツール: ${name}`;
  }
}

// --- Helpers ---

function summarizeSteps(steps: ScenarioStep[]): string {
  return steps
    .map((s) => {
      switch (s.type) {
        case "wait":
          return `${s.delay_days}日待機`;
        case "email":
          return "メール送信";
        case "slack_notify":
          return "Slack通知";
      }
    })
    .join(" → ");
}

function formatNextExecute(step: ScenarioStep | undefined, date: Date): string {
  if (!step) return "なし";
  if (step.type === "wait") {
    return `${step.delay_days}日後 (${date.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })})`;
  }
  return "即時実行";
}
