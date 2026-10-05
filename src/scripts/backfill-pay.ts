/**
 * One-time backfill: parse pay for every existing job and store the columns.
 * Safe to re-run (idempotent — recomputes from compensation each time).
 *
 *   docker compose exec app node dist/scripts/backfill-pay.js
 *   (dev) npx tsx scripts/backfill-pay.ts
 */
import 'dotenv/config';
import { db, pool } from '../db';
import { jobPostings } from '../schema';
import { parsePay } from '../pay';
import { eq } from 'drizzle-orm';

async function main(): Promise<void> {
  const rows = await db
    .select({
      id: jobPostings.id,
      compensation: jobPostings.compensation,
      hoursPerWeek: jobPostings.hoursPerWeek,
    })
    .from(jobPostings);

  let updated = 0;
  for (const row of rows) {
    const p = parsePay(row.compensation, row.hoursPerWeek);
    await db
      .update(jobPostings)
      .set({
        payMin: p.payMin,
        payMax: p.payMax,
        payCurrency: p.payCurrency,
        payPeriod: p.payPeriod,
        payUnitLabel: p.payUnitLabel,
        payUsdHour: p.payUsdHour,
        payUsdMonth: p.payUsdMonth,
        payConfidence: p.payConfidence,
      })
      .where(eq(jobPostings.id, row.id));
    updated++;
  }

  console.log(`[backfill-pay] updated ${updated} rows`);
  await pool.end();
}

main().catch((err) => {
  console.error('[backfill-pay] failed:', err);
  process.exit(1);
});
