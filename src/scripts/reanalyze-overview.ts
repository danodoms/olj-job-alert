/**
 * Regenerate cached AI analysis for recent analyzed jobs, without re-alerting.
 * Existing analyses stay in place until a fresh one succeeds.
 * Run: npm run reanalyze:overview
 * Env: REANALYZE_DAYS (default 30), REANALYZE_LIMIT (default 200)
 */
import 'dotenv/config';
import { desc, sql } from 'drizzle-orm';
import { db, pool } from '../db';
import { jobPostings } from '../schema';
import { analyzeJobById, isOverviewAvailable } from '../overview';

const days = Number(process.env.REANALYZE_DAYS ?? 30);
const limit = Number(process.env.REANALYZE_LIMIT ?? 200);
const windowDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;
const maxJobs = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;

async function main(): Promise<void> {
  if (!isOverviewAvailable()) {
    console.error('[reanalyze] AI overview is not configured (OPENCODE_API_KEY); nothing changed.');
    await pool.end();
    process.exit(1);
  }

  const rows = await db
    .select({ id: jobPostings.id })
    .from(jobPostings)
    .where(
      sql`${jobPostings.aiOverview} IS NOT NULL
        AND ${jobPostings.createdAt} > now() - make_interval(days => ${windowDays})`,
    )
    .orderBy(desc(jobPostings.id))
    .limit(maxJobs);

  console.log(`[reanalyze] ${rows.length} jobs in the last ${windowDays} days`);
  let failed = 0;
  for (let i = 0; i < rows.length; i += 2) {
    await Promise.all(
      rows
        .slice(i, i + 2)
        .map(async (row) => {
          try {
            if (!(await analyzeJobById(row.id, true))) {
              failed++;
              console.error(`[reanalyze] ${row.id} produced no analysis; old kept`);
            }
          } catch (err) {
            failed++;
            console.error(`[reanalyze] ${row.id} failed:`, err);
          }
        }),
    );
  }
  if (failed > 0) {
    console.error(`[reanalyze] ${failed} of ${rows.length} failed; old analyses kept`);
    process.exitCode = 1;
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
