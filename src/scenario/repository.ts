import { getDb } from "../data-sources/database.js";
import type { Scenario, ScenarioStep, Enrollment, ExecutionStatus } from "./types.js";

function generateId(): string {
  return crypto.randomUUID();
}

// --- Scenarios ---

export async function getScenario(id: string): Promise<Scenario | null> {
  const db = getDb();
  const rows = await db`SELECT * FROM scenarios WHERE id = ${id}`;
  if (rows.length === 0) return null;
  return rowToScenario(rows[0]);
}

export async function listScenarios(activeOnly = true): Promise<Scenario[]> {
  const db = getDb();
  const rows = activeOnly
    ? await db`SELECT * FROM scenarios WHERE is_active = true ORDER BY created_at`
    : await db`SELECT * FROM scenarios ORDER BY created_at`;
  return rows.map(rowToScenario);
}

export async function upsertScenario(scenario: Scenario): Promise<void> {
  const db = getDb();
  const stepsJson = JSON.stringify(scenario.steps);
  const configJson = JSON.stringify(scenario.trigger_config);
  await db`
    INSERT INTO scenarios (id, name, description, trigger_type, trigger_config, steps, is_active, updated_at)
    VALUES (${scenario.id}, ${scenario.name}, ${scenario.description ?? null}, ${scenario.trigger_type}, ${configJson}::jsonb, ${stepsJson}::jsonb, ${scenario.is_active}, NOW())
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      trigger_type = EXCLUDED.trigger_type,
      trigger_config = EXCLUDED.trigger_config,
      steps = EXCLUDED.steps,
      is_active = EXCLUDED.is_active,
      updated_at = NOW()
  `;
}

// --- Enrollments ---

export async function enrollContact(
  scenarioId: string,
  email: string,
  name: string | null,
  contactData: Record<string, unknown>,
  nextExecuteAt: Date,
): Promise<string> {
  const db = getDb();
  const id = generateId();
  const dataJson = JSON.stringify(contactData);
  const nextAt = nextExecuteAt.toISOString();
  await db`
    INSERT INTO enrollments (id, scenario_id, contact_email, contact_name, contact_data, current_step, status, next_execute_at)
    VALUES (${id}, ${scenarioId}, ${email}, ${name}, ${dataJson}::jsonb, 0, 'active', ${nextAt}::timestamptz)
  `;
  return id;
}

export async function getActiveEnrollmentsDue(): Promise<Enrollment[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM enrollments
    WHERE status = 'active' AND next_execute_at <= NOW()
    ORDER BY next_execute_at
    LIMIT 50
  `;
  return rows.map(rowToEnrollment);
}

export async function advanceEnrollment(
  enrollmentId: string,
  nextStep: number,
  nextExecuteAt: Date,
): Promise<void> {
  const db = getDb();
  const nextAt = nextExecuteAt.toISOString();
  await db`
    UPDATE enrollments SET current_step = ${nextStep}, next_execute_at = ${nextAt}::timestamptz WHERE id = ${enrollmentId}
  `;
}

export async function completeEnrollment(enrollmentId: string): Promise<void> {
  const db = getDb();
  await db`
    UPDATE enrollments SET status = 'completed', completed_at = NOW(), next_execute_at = NULL WHERE id = ${enrollmentId}
  `;
}

export async function cancelEnrollment(enrollmentId: string): Promise<void> {
  const db = getDb();
  await db`
    UPDATE enrollments SET status = 'cancelled', next_execute_at = NULL WHERE id = ${enrollmentId}
  `;
}

export async function getEnrollmentsByScenario(scenarioId: string): Promise<Enrollment[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM enrollments WHERE scenario_id = ${scenarioId} AND status = 'active' ORDER BY enrolled_at DESC
  `;
  return rows.map(rowToEnrollment);
}

export async function getEnrollmentByEmail(
  scenarioId: string,
  email: string,
): Promise<Enrollment | null> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM enrollments WHERE scenario_id = ${scenarioId} AND contact_email = ${email} AND status = 'active' LIMIT 1
  `;
  if (rows.length === 0) return null;
  return rowToEnrollment(rows[0]);
}

export async function getAllActiveEnrollments(): Promise<Enrollment[]> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM enrollments WHERE status = 'active' ORDER BY enrolled_at DESC LIMIT 100
  `;
  return rows.map(rowToEnrollment);
}

// --- Execution Logs ---

export async function logExecution(
  enrollmentId: string,
  scenarioId: string,
  stepIndex: number,
  stepType: string,
  status: ExecutionStatus,
  detail: Record<string, unknown> = {},
): Promise<void> {
  const db = getDb();
  const id = generateId();
  const detailJson = JSON.stringify(detail);
  await db`
    INSERT INTO execution_logs (id, enrollment_id, scenario_id, step_index, step_type, status, detail)
    VALUES (${id}, ${enrollmentId}, ${scenarioId}, ${stepIndex}, ${stepType}, ${status}, ${detailJson}::jsonb)
  `;
}

// --- Helpers ---

function rowToScenario(row: Record<string, unknown>): Scenario {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string | undefined,
    trigger_type: row.trigger_type as Scenario["trigger_type"],
    trigger_config: (row.trigger_config ?? {}) as Record<string, unknown>,
    steps: row.steps as ScenarioStep[],
    is_active: row.is_active as boolean,
  };
}

function rowToEnrollment(row: Record<string, unknown>): Enrollment {
  return {
    id: row.id as string,
    scenario_id: row.scenario_id as string,
    contact_email: row.contact_email as string,
    contact_name: row.contact_name as string | null,
    contact_data: (row.contact_data ?? {}) as Record<string, unknown>,
    current_step: row.current_step as number,
    status: row.status as Enrollment["status"],
    enrolled_at: row.enrolled_at as string,
    next_execute_at: row.next_execute_at as string | null,
    completed_at: row.completed_at as string | null,
  };
}
