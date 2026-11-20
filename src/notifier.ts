import { eq, inArray, sql } from 'drizzle-orm';
import { db } from './db';
import { jobPostings } from './schema';
import { userSubscriptions, userSettings } from './schema';
import { notifications } from './schema';
import { matchJob, type KeywordMatch } from './match';
import { delay } from './utils';
import { payInsightFor } from './signals';
import { buildAlertCaption, alertKeyboard } from './alert';
import { sendAlert, sendNotice } from './banner';
import type { JobAnalysis } from './overview';

const NOTIFIER_INTERVAL_MS = Number(process.env.NOTIFIER_INTERVAL_MS ?? 20000);
const NOTIFIER_BATCH = Number(process.env.NOTIFIER_BATCH ?? 20);

/** Consecutive failing ticks before a recovery notice is worth sending (~5 min at 20s). */
const OUTAGE_NOTICE_TICKS = 15;
let outageTicks = 0;

/** Hold a fresh alert this long so its AI overview can land first. */
const AI_WAIT_MS = 120_000;

/** True when an AI-enabled recipient's overview is still being generated. */
export function shouldAwaitAi(
  analysis: unknown,
  recipients: { chatId: number }[],
  aiChats: Set<number>,
  createdAt: Date | null,
  now: number,
): boolean {
  if (analysis) return false;
  if (!recipients.some((r) => aiChats.has(r.chatId))) return false;
  return now - (createdAt?.getTime() ?? 0) < AI_WAIT_MS;
}

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

  // Chats already alerted for these jobs: a retry after a partial send must
  // not message the same chat twice.
  const notified = new Set<string>();
  const noticeRows = await db
    .select({ chatId: notifications.chatId, jobId: notifications.jobId })
    .from(notifications)
    .where(
      inArray(
        notifications.jobId,
        jobs.map((j) => j.jobId),
      ),
    );
  for (const row of noticeRows) notified.add(`${row.chatId}:${row.jobId}`);

  // Group keywords by subscriber so each gets only their own match reason.
  const byChat = new Map<number, string[]>();
  for (const { chatId, keyword } of subRows) {
    const list = byChat.get(chatId);
    if (list) list.push(keyword);
    else byChat.set(chatId, [keyword]);
  }

  let sent = 0;
  let matched = 0;
  let retried = 0;
  let failed = 0;
  let waiting = 0;

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
    let retryLater = false;

    // Let the overview land first; the job stays queued meanwhile.
    if (shouldAwaitAi(job.aiAnalysis, recipients, aiChats, job.createdAt, Date.now())) {
      waiting++;
      continue;
    }

    const insight = await payInsightFor(job);
    const analysis = (job.aiAnalysis as JobAnalysis | null) ?? null;

    for (const { chatId, matches } of recipients) {
      if (notified.has(`${chatId}:${job.jobId}`)) continue;
      const showAi = aiChats.has(chatId) && Boolean(analysis);
      const { caption, hasAi } = buildAlertCaption(
        job,
        insight,
        matches,
        showAi ? analysis : null,
      );

      try {
        const result = await sendAlert(chatId, caption, job, alertKeyboard(job.jobId, hasAi));
        if (result.ok) {
          await db
            .insert(notifications)
            .values({ chatId, jobId: job.jobId })
            .onConflictDoNothing();
          sent++;
        } else if (result.retry) {
          retryLater = true;
          failed++;
        }
      } catch (err) {
        retryLater = true;
        failed++;
        console.error(`[notifier] send to ${chatId} failed:`, err);
      }
      await delay(250);
    }

    if (retryLater) {
      retried++;
      continue;
    }

    await db
      .update(jobPostings)
      .set({ isProcessed: true })
      .where(eq(jobPostings.id, job.id));
  }

  if (failed > 0) {
    outageTicks++;
    console.warn(`[notifier] network send failed ${failed}x; outage tick ${outageTicks}`);
  } else {
    const notice = outageNotice(outageTicks);
    if (notice) {
      for (const chatId of byChat.keys()) {
        await sendNotice(chatId, notice).catch((err) =>
          console.error(`[notifier] notice to ${chatId} failed:`, err),
        );
      }
    }
    outageTicks = 0;
  }

  console.log(
    `[notifier] processed ${jobs.length}, matched ${matched}, sent ${sent}, retried ${retried}, waiting ${waiting}`,
  );
}

/**
 * Recovery text after a real outage, or null when the outage was short.
 * Minutes come from failed ticks, not wall clock, so a slept laptop wakes
 * without announcing a fake multi-hour outage.
 */
export function outageNotice(ticks: number): string | null {
  if (ticks < OUTAGE_NOTICE_TICKS) return null;
  const minutes = Math.max(5, Math.round((ticks * NOTIFIER_INTERVAL_MS) / 60000));
  return `Alerts resumed. Telegram was unreachable for about ${minutes} min, so alerts were held instead of dropped.`;
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

if (require.main === module) {
  const checks = [
    outageNotice(14) === null,
    outageNotice(15)?.includes('5 min') === true,
    outageNotice(45)?.includes('15 min') === true,
    // AI wait: only for a fresh job with an AI-enabled recipient and no analysis.
    shouldAwaitAi(null, [{ chatId: 1 }], new Set([1]), new Date(0), 60_000) === true,
    shouldAwaitAi(null, [{ chatId: 1 }], new Set([2]), new Date(0), 60_000) === false,
    shouldAwaitAi({}, [{ chatId: 1 }], new Set([1]), new Date(0), 60_000) === false,
    shouldAwaitAi(null, [{ chatId: 1 }], new Set([1]), new Date(0), 200_000) === false,
  ];
  if (checks.includes(false)) {
    console.error('notifier.ts self-check FAIL');
    process.exit(1);
  }
  console.log('notifier.ts self-check OK');
}
