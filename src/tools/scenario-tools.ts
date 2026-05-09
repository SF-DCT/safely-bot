/**
 * シナリオツール — Orbit AE のシナリオエンジンをSlack経由で操作する。
 *
 * Phase B (2026-05-09): 直接DB操作からOrbit HTTP APIへ移行。
 * 旧: src/scenario/repository.ts (Neon DB直接)
 * 新: ORBIT_API_BASE/ae/scenarios/api/* (Bearer token認証)
 */
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env.js";

const ORBIT_API_BASE =
  env.ORBIT_API_BASE || "https://cgs-crm-production.up.railway.app";
const SCENARIO_API_TOKEN = env.SCENARIO_API_TOKEN || "";

interface OrbitScenario {
  id: string;
  name: string;
  description?: string;
  steps_count: number;
  steps_summary: string;
}

interface OrbitEnrollment {
  id: string;
  scenario_id: string;
  scenario_name?: string;
  contact_email: string;
  contact_name?: string | null;
  current_step: number;
  status: string;
  enrolled_at?: string;
  next_execute_at?: string | null;
}

async function orbitGet<T>(path: string): Promise<T> {
  if (!SCENARIO_API_TOKEN) {
    throw new Error("SCENARIO_API_TOKEN is not set");
  }
  const res = await fetch(`${ORBIT_API_BASE}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${SCENARIO_API_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Orbit API ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function orbitPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  if (!SCENARIO_API_TOKEN) {
    throw new Error("SCENARIO_API_TOKEN is not set");
  }
  const res = await fetch(`${ORBIT_API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SCENARIO_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok?: boolean; error?: string } & T;
  if (!res.ok) {
    return data; // 4xx でも JSON で error を返してくる前提
  }
  return data;
}

export const scenarioTools: Anthropic.Tool[] = [
  {
    name: "list_scenarios",
    description:
      "Orbit AE で利用可能なシナリオ（ドリップキャンペーン）の一覧を表示する。「シナリオ一覧」「どんなシナリオがある？」などのリクエストで使う。",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "enroll_contact",
    description:
      "連絡先をOrbit AEのシナリオに登録する。メールアドレスとシナリオIDを指定する。「〇〇さんを資料請求フォローに登録して」「シナリオに追加して」などのリクエストで使う。",
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
      "Orbit AE のシナリオ登録状況を確認する。現在アクティブなシナリオ登録者の一覧を表示する。「シナリオの進捗は？」「誰がシナリオに入ってる？」などのリクエストで使う。",
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
      "Orbit AE のシナリオ登録を解除する。メールアドレスとシナリオIDを指定する。「〇〇さんのシナリオ止めて」「シナリオ解除して」などのリクエストで使う。",
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
      const scenarios = await orbitGet<OrbitScenario[]>("/ae/scenarios/api/list");
      if (scenarios.length === 0) return "登録されたシナリオはありません。";

      const lines = [`シナリオ一覧（${scenarios.length}件）\n`];
      for (const s of scenarios) {
        lines.push(`■ ${s.name} (ID: ${s.id})`);
        if (s.description) lines.push(`  ${s.description}`);
        lines.push(`  ステップ: ${s.steps_summary}`);
        lines.push("");
      }
      return lines.join("\n");
    }

    case "enroll_contact": {
      const scenarioId = input.scenario_id as string;
      const email = input.email as string;
      const contactName = (input.name as string) || null;
      const company = (input.company as string) || undefined;

      const result = await orbitPost<{
        ok: boolean;
        enrollment_id?: string;
        next_execute_at?: string;
        error?: string;
        current_step?: number;
      }>("/ae/scenarios/api/enroll", {
        scenario_id: scenarioId,
        email,
        name: contactName,
        company,
      });

      if (!result.ok) {
        if (result.error === "already enrolled") {
          return `${email} は既にシナリオ「${scenarioId}」に登録済みです（ステップ ${(result.current_step ?? 0) + 1}）。`;
        }
        return `登録に失敗しました: ${result.error ?? "unknown"}`;
      }

      return [
        `✅ シナリオ登録完了`,
        `シナリオID: ${scenarioId}`,
        `連絡先: ${contactName ?? email} (${email})`,
        `登録ID: ${result.enrollment_id}`,
        `次回実行: ${result.next_execute_at ?? "—"}`,
      ].join("\n");
    }

    case "check_enrollments": {
      const scenarioId = input.scenario_id as string | undefined;
      const path = scenarioId
        ? `/ae/scenarios/api/enrollments?scenario_id=${encodeURIComponent(scenarioId)}`
        : "/ae/scenarios/api/enrollments";
      const enrollments = await orbitGet<OrbitEnrollment[]>(path);
      if (enrollments.length === 0) return "現在アクティブなシナリオ登録はありません。";

      const lines = [`アクティブな登録（${enrollments.length}件）\n`];
      for (const e of enrollments) {
        lines.push(
          `• ${e.contact_name ?? e.contact_email} (${e.contact_email})`,
        );
        lines.push(
          `  シナリオ: ${e.scenario_name ?? e.scenario_id} | ステップ ${e.current_step + 1} | 次回: ${e.next_execute_at ?? "完了待ち"}`,
        );
      }
      return lines.join("\n");
    }

    case "cancel_enrollment": {
      const scenarioId = input.scenario_id as string;
      const email = input.email as string;
      const result = await orbitPost<{ ok: boolean; error?: string }>(
        "/ae/scenarios/api/cancel",
        { scenario_id: scenarioId, email },
      );
      if (!result.ok) {
        if (result.error === "enrollment not found") {
          return `${email} はシナリオ「${scenarioId}」に登録されていません。`;
        }
        return `解除に失敗しました: ${result.error ?? "unknown"}`;
      }
      return `✅ ${email} のシナリオ登録を解除しました。`;
    }

    default:
      return `未知のシナリオツール: ${name}`;
  }
}
