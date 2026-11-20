import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });
export { pool };

/**
 * Idempotent schema bootstrap. Additive `IF NOT EXISTS` statements only, so it
 * is safe to run on every boot against both fresh and existing databases.
 * Keeps production free of the drizzle-kit dev dependency.
 */
const BOOTSTRAP_SQL = `
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS pay_min real;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS pay_max real;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS pay_currency text;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS pay_period text;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS pay_unit_label text;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS pay_usd_hour real;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS pay_usd_month real;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS pay_confidence text;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS ai_overview text;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS ai_analysis jsonb;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS ai_version int;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS ai_usage jsonb;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS ai_escalated boolean DEFAULT false;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS ai_attempts int DEFAULT 0;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS employer text;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS employer_id bigint;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS employer_logo text;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS description_hash text;
CREATE TABLE IF NOT EXISTS employer_banners (
  employer_id bigint PRIMARY KEY,
  file_id text NOT NULL,
  logo_url text,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE employer_banners ADD COLUMN IF NOT EXISTS logo_url text;
CREATE TABLE IF NOT EXISTS user_settings (
  chat_id bigint PRIMARY KEY,
  ai_overview boolean NOT NULL DEFAULT false,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS employer_checks (
  employer_id bigint PRIMARY KEY,
  name text,
  paid_active boolean,
  complaints int,
  post_count int,
  new_post_count int,
  checked_at timestamptz DEFAULT now()
);
ALTER TABLE employer_checks ADD COLUMN IF NOT EXISTS new_post_count int;
CREATE TABLE IF NOT EXISTS overview_feedback (
  id serial PRIMARY KEY,
  chat_id bigint NOT NULL,
  job_id bigint NOT NULL,
  value text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (chat_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_job_postings_description_hash ON job_postings(description_hash);
CREATE INDEX IF NOT EXISTS idx_job_postings_employer_id ON job_postings(employer_id);
CREATE INDEX IF NOT EXISTS idx_job_postings_pay_usd_month ON job_postings(pay_usd_month);
CREATE INDEX IF NOT EXISTS idx_job_postings_is_processed ON job_postings(is_processed);
CREATE TABLE IF NOT EXISTS notifications (
  id serial PRIMARY KEY,
  chat_id bigint NOT NULL,
  job_id bigint NOT NULL,
  sent_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_chat_id ON notifications(chat_id);
CREATE INDEX IF NOT EXISTS idx_notifications_chat_sent ON notifications(chat_id, sent_at);
`;

export async function migrate(): Promise<void> {
  await pool.query(BOOTSTRAP_SQL);
}
