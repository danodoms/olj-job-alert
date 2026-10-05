import { eq, inArray, sql } from 'drizzle-orm';
import { db } from './db';
import { jobPostings } from './schema';
import { userSubscriptions } from './schema';
import { matchKeywords } from './match';
import { delay, escapeHtml } from './utils';
import { bot } from './bot';

const NOTIFIER_INTERVAL_MS = Number(process.env.NOTIFIER_INTERVAL_MS ?? 20000);
const NOTIFIER_BATCH = Number(process.env.NOTIFIER_BATCH ?? 20);
const DESCRIPTION_LIMIT = 120;

function buildMessage(job: typeof jobPostings.$inferSelect): string {
  const description = (job.jobDescription ?? '').slice(0, DESCRIPTION_LIMIT);
  return [
    '🔔 <b>New job match!</b>',
    '',
    `<b>${escapeHtml(job.jobTitle ?? '')}</b>`,
    '',
    `📝 ${escapeHtml(description)}...`,
    '',
    `💼 <b>Type:</b> ${escapeHtml(job.typeOfWork ?? '')}`,
    `💰 <b>Pay:</b> ${escapeHtml(job.compensation ?? '')}`,
    `⏰ <b>Hours:</b> ${escapeHtml(job.hoursPerWeek ?? '')}`,
    '',
    `👉 <a href="https://www.onlinejobs.ph/jobseekers/job/${job.jobId}">Apply here</a>`,
  ].join('\n');
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

      const message = buildMessage(job);
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