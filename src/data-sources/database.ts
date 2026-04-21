import { env } from "../config/env.js";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let sql: NeonQueryFunction<false, false>;

export function getDb() {
  if (!sql) {
    if (!env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set");
    }
    sql = neon(env.DATABASE_URL);
  }
  return sql;
}

export async function initDatabase(): Promise<void> {
  const db = getDb();

  await db`
    CREATE TABLE IF NOT EXISTS scenarios (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      description    TEXT,
      trigger_type   TEXT NOT NULL,
      trigger_config JSONB DEFAULT '{}',
      steps          JSONB NOT NULL,
      is_active      BOOLEAN DEFAULT true,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await db`
    CREATE TABLE IF NOT EXISTS enrollments (
      id              TEXT PRIMARY KEY,
      scenario_id     TEXT NOT NULL REFERENCES scenarios(id),
      contact_email   TEXT NOT NULL,
      contact_name    TEXT,
      contact_data    JSONB DEFAULT '{}',
      current_step    INTEGER DEFAULT 0,
      status          TEXT DEFAULT 'active',
      enrolled_at     TIMESTAMPTZ DEFAULT NOW(),
      next_execute_at TIMESTAMPTZ,
      completed_at    TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await db`
    CREATE TABLE IF NOT EXISTS execution_logs (
      id             TEXT PRIMARY KEY,
      enrollment_id  TEXT NOT NULL REFERENCES enrollments(id),
      scenario_id    TEXT NOT NULL,
      step_index     INTEGER NOT NULL,
      step_type      TEXT NOT NULL,
      status         TEXT NOT NULL,
      detail         JSONB DEFAULT '{}',
      executed_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // Orbit改修依頼の状態永続化（Sub-Phase 2.1）
  await db`
    CREATE TABLE IF NOT EXISTS orbit_requests (
      id                 TEXT PRIMARY KEY,
      channel_id         TEXT NOT NULL,
      thread_ts          TEXT NOT NULL,
      requester_user_id  TEXT NOT NULL,
      raw_text           TEXT NOT NULL,
      type               TEXT NOT NULL,
      title              TEXT NOT NULL,
      summary            TEXT NOT NULL,
      affected_area      TEXT,
      reference_images   JSONB DEFAULT '[]',
      state              TEXT NOT NULL,
      approval_dm_ts     TEXT,
      sheet_row_number   INTEGER,
      source_link        TEXT,
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // Indexes — try/catch で「already exists」を無視
  try {
    await db`CREATE INDEX idx_enrollments_next ON enrollments(status, next_execute_at) WHERE status = 'active'`;
  } catch (e: unknown) {
    if (!(e instanceof Error && e.message.includes("already exists"))) throw e;
  }
  try {
    await db`CREATE UNIQUE INDEX idx_enrollments_dedup ON enrollments(scenario_id, contact_email) WHERE status = 'active'`;
  } catch (e: unknown) {
    if (!(e instanceof Error && e.message.includes("already exists"))) throw e;
  }
  try {
    await db`CREATE INDEX idx_logs_enrollment ON execution_logs(enrollment_id)`;
  } catch (e: unknown) {
    if (!(e instanceof Error && e.message.includes("already exists"))) throw e;
  }
  try {
    await db`CREATE INDEX idx_orbit_thread ON orbit_requests(channel_id, thread_ts)`;
  } catch (e: unknown) {
    if (!(e instanceof Error && e.message.includes("already exists"))) throw e;
  }
  try {
    await db`CREATE INDEX idx_orbit_state ON orbit_requests(state)`;
  } catch (e: unknown) {
    if (!(e instanceof Error && e.message.includes("already exists"))) throw e;
  }

  console.log("[Database] Tables and indexes initialized.");
}
