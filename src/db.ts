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
