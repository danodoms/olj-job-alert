import { eq, sql } from 'drizzle-orm';
import { db } from './db';
import { jobPostings } from './schema';
import { userSubscriptions, userSettings } from './schema';
import { notifications } from './schema';
import { matchJob, type KeywordMatch } from './match';
import { delay } from './utils';
import { payInsightFor } from './signals';
import { buildAlertCaption, alertKeyboard } from './alert';
import { sendAlert } from './banner';
import type { JobAnalysis } from './overview';

const NOTIFIER_INTERVAL_MS = Number(process.env.NOTIFIER_INTERVAL_MS ?? 20000);
const NOTIFIER_BATCH = Number(process.env.NOTIFIER_BATCH ?? 20);

export async function runNotifier(): Promise<void> {
  const jobs = await db
    .select()
    .from(jobPostings)
    .where(eq(jobPostings.isProcessed, false))
    .orderBy(sql`${jobPostings.jobId} DESC`)
    .limit(NOTIFIER_BATCH);

  if (jobs.length === 0) return;

  const subRows = await db
    .select({ chatId: userSubscriptions.chatId, keyword: userSubscriptions.keyword })
    .from(userSubscriptions);

  const settingRows = await db
    .select({ chatId: userSettings.chatId })
    .from(userSettings)
    .where(eq(userSettings.aiOverview, true));
  const aiChats = new Set(settingRows.map((r) => r.chatId));

  // Group keywords by subscriber so each gets only their own match reason.
  const byChat = new Map<number, string[]>();
  for (const { chatId, keyword } of subRows) {
    const list = byChat.get(chatId);
    if (list) list.push(keyword);
    else byChat.set(chatId, [keyword]);
  }

  let sent = 0;
  let matched = 0;

  for (const job of jobs) {
    const title = job.jobTitle ?? '';
    const description = job.jobDescription ?? '';
    const recipients: { chatId: number; matches: KeywordMatch[] }[] = [];

    for (const [chatId, keywords] of byChat) {
      const matches = matchJob(title, description, keywords);
      if (matches.length > 0) recipients.push({ chatId, matches });
    }

    if (recipients.length === 0) {
      await db
        .update(jobPostings)
        .set({ isProcessed: true })
        .where(eq(jobPostings.id, job.id));
      continue;
    }

    matched++;
    const insight = await payInsightFor(job);
    const analysis = (job.aiAnalysis as JobAnalysis | null) ?? null;

    for (const { chatId, matches } of recipients) {
      const showAi = aiChats.has(chatId) && Boolean(analysis);
      const { caption, hasAi } = buildAlertCaption(
        job,
        insight,
        matches,
        showAi ? analysis : null,
      );

      try {
        if (await sendAlert(chatId, caption, job, alertKeyboard(job.jobId, hasAi))) {
          await db.insert(notifications).values({ chatId, jobId: job.jobId });
          sent++;
        }
      } catch (err) {
        console.error(`[notifier] send to ${chatId} failed:`, err);
      }
      await delay(250);
    }

    await db
      .update(jobPostings)
      .set({ isProcessed: true })
      .where(eq(jobPostings.id, job.id));
  }

  console.log(`[notifier] processed ${jobs.length}, matched ${matched}, sent ${sent}`);
}

let notifierRunning = false;

function guardedRun(): void {
  if (notifierRunning) {
    console.warn('[notifier] previous run still active; skipping this tick');
    return;
  }
  notifierRunning = true;
  runNotifier()
    .catch((err) => console.error('[notifier] run failed:', err))
    .finally(() => {
      notifierRunning = false;
    });
}

export function startNotifier(): void {
  guardedRun();
  setInterval(guardedRun, NOTIFIER_INTERVAL_MS);
}
