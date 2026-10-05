import { eq, inArray, sql } from 'drizzle-orm';
import { db } from './db';
import { jobPostings } from './schema';
import { userSubscriptions } from './schema';
import { matchKeywords } from './match';
import { delay, escapeHtml } from './utils';
import { bot } from './bot';
import { formatPay, formatVerdict, verdictFromPool, type ParsedPay, type PayVerdict } from './pay';

const NOTIFIER_INTERVAL_MS = Number(process.env.NOTIFIER_INTERVAL_MS ?? 20000);
const NOTIFIER_BATCH = Number(process.env.NOTIFIER_BATCH ?? 20);
const DESCRIPTION_LIMIT = 120;
const VERDICT_SAMPLE_FLOOR = 15;

/**
 * Load the peer pay pool for a type_of_work, within the same pool (hourly or
 * monthly). Returns sorted ascending. Small and indexed, fine at this scale.
 */
async function loadPeerPool(typeOfWork: string | null, useHourly: boolean): Promise<number[]> {
  const column = useHourly ? sql`pay_usd_hour` : sql`pay_usd_month`;
  const rows = await db.execute(sql`
    SELECT ${column} AS v
    FROM job_postings
    WHERE pay_confidence IN ('high','medium')
      AND coalesce(type_of_work,'') = ${typeOfWork ?? ''}
      AND ${column} IS NOT NULL
    ORDER BY ${column} ASC
  `);
  return (rows.rows as { v: number }[]).map((r) => Number(r.v)).filter((n) => Number.isFinite(n));
}

type PayInsight = { verdict: PayVerdict; peerLabel: string };

/**
 * Grade a job's pay against peers of the same type_of_work and pay shape
 * (hourly vs monthly). Returns null when there is not enough data to be fair.
 */
async function payInsightFor(job: typeof jobPostings.$inferSelect): Promise<PayInsight | null> {
  const parsed: ParsedPay = {
    payMin: job.payMin,
    payMax: job.payMax,
    payCurrency: job.payCurrency,
    payPeriod: (job.payPeriod ?? 'unknown') as ParsedPay['payPeriod'],
    payUnitLabel: job.payUnitLabel,
    payUsdHour: job.payUsdHour,
    payUsdMonth: job.payUsdMonth,
    payConfidence: (job.payConfidence ?? 'none') as ParsedPay['payConfidence'],
  };
  // Only time-based pay with a real number can be graded.
  const useHourly = parsed.payPeriod === 'hour';
  const value = useHourly ? parsed.payUsdHour : parsed.payUsdMonth;
  if (value === null || parsed.payConfidence === 'none' || parsed.payConfidence === 'low') {
    return null;
  }
  const pool = await loadPeerPool(job.typeOfWork, useHourly);
  const verdict = verdictFromPool(value, pool, VERDICT_SAMPLE_FLOOR);
  if (verdict === null) return null;

  const type = (job.typeOfWork ?? '').trim();
  const peerLabel = [type, useHourly ? 'hourly' : 'monthly', 'jobs'].filter(Boolean).join(' ');
  return { verdict, peerLabel };
}

function buildMessage(
  job: typeof jobPostings.$inferSelect,
  insight: PayInsight | null,
): string {
  const description = (job.jobDescription ?? '').slice(0, DESCRIPTION_LIMIT);
  const parsed: ParsedPay = {
    payMin: job.payMin,
    payMax: job.payMax,
    payCurrency: job.payCurrency,
    payPeriod: (job.payPeriod ?? 'unknown') as ParsedPay['payPeriod'],
    payUnitLabel: job.payUnitLabel,
    payUsdHour: job.payUsdHour,
    payUsdMonth: job.payUsdMonth,
    payConfidence: (job.payConfidence ?? 'none') as ParsedPay['payConfidence'],
  };
  const payText = formatPay(parsed);
  const isHigh = insight?.verdict === 'high';
  const verdictText = insight && !isHigh ? formatVerdict(insight.verdict) : null;

  const lines: string[] = [];
  if (isHigh) {
    lines.push('🔥 <b>HIGH PAY</b>', '');
  }
  lines.push(
    '🔔 <b>New job match!</b>',
    '',
    `<b>${escapeHtml(job.jobTitle ?? '')}</b>`,
    '',
    `📝 ${escapeHtml(description)}...`,
    '',
    `💼 <b>Type:</b> ${escapeHtml(job.typeOfWork ?? '')}`,
    `💰 <b>Pay:</b> ${escapeHtml(payText)}`,
  );
  if (verdictText) {
    lines.push(`📊 <b>Market:</b> ${escapeHtml(verdictText)} · vs ${escapeHtml(insight!.peerLabel)}`);
  }
  lines.push(
    `⏰ <b>Hours:</b> ${escapeHtml(job.hoursPerWeek ?? '')}`,
    '',
    `👉 <a href="https://www.onlinejobs.ph/jobseekers/job/${job.jobId}">Apply here</a>`,
  );
  return lines.join('\n');
}

export async function runNotifier(): Promise<void> {
  const jobs = await db
    .select()
    .from(jobPostings)
    .where(eq(jobPostings.isProcessed, false))
    .orderBy(sql`${jobPostings.jobId} DESC`)
    .limit(NOTIFIER_BATCH);

  if (jobs.length === 0) return;

  const keywordRows = await db
    .selectDistinct({ keyword: userSubscriptions.keyword })
    .from(userSubscriptions);
  const keywords = keywordRows.map((r) => r.keyword);

  let sent = 0;
  let matched = 0;

  for (const job of jobs) {
    const haystack = `${job.jobTitle ?? ''} ${job.jobDescription ?? ''}`;
    const jobMatches = matchKeywords(haystack, keywords);

    if (jobMatches.length > 0) {
      matched++;
      const subscribers = await db
        .selectDistinct({ chatId: userSubscriptions.chatId })
        .from(userSubscriptions)
        .where(inArray(userSubscriptions.keyword, jobMatches));

      const message = buildMessage(job, await payInsightFor(job));
      for (const { chatId } of subscribers) {
        try {
          await bot.api.sendMessage(chatId, message, { parse_mode: 'HTML' });
          sent++;
        } catch (err) {
          console.error(`[notifier] send to ${chatId} failed:`, err);
        }
        await delay(250);
      }
    }

    await db
      .update(jobPostings)
      .set({ isProcessed: true })
      .where(eq(jobPostings.id, job.id));
  }

  console.log(`[notifier] processed ${jobs.length}, matched ${matched}, sent ${sent}`);
}

export function startNotifier(): void {
  runNotifier().catch((err) => console.error('[notifier] initial run failed:', err));
  setInterval(() => {
    runNotifier().catch((err) => console.error('[notifier] run failed:', err));
  }, NOTIFIER_INTERVAL_MS);
}