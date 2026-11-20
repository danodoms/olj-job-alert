/**
 * Regenerate cached AI analysis for recent analyzed jobs, without re-alerting.
 * Run: npm run reanalyze:overview
 * Env: REANALYZE_DAYS (default 30), REANALYZE_LIMIT (default 200)
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db';
import { jobPostings } from '../schema';
import { analyzeJobById } from '../overview';

const days = Number(process.env.REANALYZE_DAYS ?? 30);
const limit = Number(process.env.REANALYZE_LIMIT ?? 200);
const windowDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;
const maxJobs = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;

async function main(): Promise<void> {
  const rows = await db
    .update(jobPostings)
    .set({
      aiOverview: null,
      aiAnalysis: null,
      aiVersion: null,
      aiUsage: null,
      aiEscalated: false,
    })
    .where(
      sql`${jobPostings.id} IN (
        SELECT id FROM job_postings
        WHERE ai_overview IS NOT NULL
          AND created_at > now() - make_interval(days => ${windowDays})
        ORDER BY id DESC
        LIMIT ${maxJobs}
      )`,
    )
    .returning({ id: jobPostings.id });

  console.log(`[reanalyze] ${rows.length} jobs in the last ${windowDays} days`);
  for (let i = 0; i < rows.length; i += 2) {
    await Promise.all(
      rows
        .slice(i, i + 2)
        .map((row) => analyzeJobById(row.id, true).catch((err) => console.error(`[reanalyze] ${row.id} failed:`, err))),
    );
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
