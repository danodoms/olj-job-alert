import { eq, inArray, sql } from 'drizzle-orm';
import { db } from './db';
import { jobPostings } from './schema';
import { userSubscriptions } from './schema';
import { matchKeywords } from './match';
import { delay, escapeHtml } from './utils';
import { bot } from './bot';

const NOTIFIER_INTERVAL_MS = Number(process.env.NOTIFIER_INTERVAL_MS ?? 20000);
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
  const [job] = await db
    .select()
    .from(jobPostings)
    .where(eq(jobPostings.isProcessed, false))
    .orderBy(jobPostings.jobId)
    .limit(1);

  if (!job) return;

  const keywordRows = await db
    .selectDistinct({ keyword: userSubscriptions.keyword })
    .from(userSubscriptions);
  const keywords = keywordRows.map((r) => r.keyword);

  const haystack = `${job.jobTitle ?? ''} ${job.jobDescription ?? ''}`;
  const matched = matchKeywords(haystack, keywords);

  if (matched.length > 0) {
    const subscribers = await db
      .selectDistinct({ chatId: userSubscriptions.chatId })
      .from(userSubscriptions)
      .where(inArray(userSubscriptions.keyword, matched));

    const message = buildMessage(job);
    for (const { chatId } of subscribers) {
      try {
        await bot.api.sendMessage(chatId, message, { parse_mode: 'HTML' });
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

export function startNotifier(): void {
  runNotifier().catch((err) => console.error('[notifier] initial run failed:', err));
  setInterval(() => {
    runNotifier().catch((err) => console.error('[notifier] run failed:', err));
  }, NOTIFIER_INTERVAL_MS);
}