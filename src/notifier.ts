import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db';
import { jobPostings } from './schema';
import { userSubscriptions, userSettings } from './schema';
import { notifications } from './schema';
import { matchJob, type KeywordMatch } from './match';
import { delay } from './utils';
import { payInsightFor } from './signals';
import { buildAlertCaption, alertKeyboard } from './alert';
import { isKitEnabled } from './kit';
import { repostRenderEnabled } from './reposts';
import { sendAlert, sendNotice } from './banner';
import {
  AI_VERSION,
  FIT_WAIT_MS,
  enqueueFit,
  fitsForJob,
  isFitEnabled,
  isOverviewAvailable,
  pruneFitAttempts,
  readFitForChat,
  type CachedFit,
  type JobAnalysis,
} from './overview';

const NOTIFIER_INTERVAL_MS = Number(process.env.NOTIFIER_INTERVAL_MS ?? 20000);
const NOTIFIER_BATCH = Number(process.env.NOTIFIER_BATCH ?? 20);

/** Consecutive failing ticks before a recovery notice is worth sending (~5 min at 20s). */
const OUTAGE_NOTICE_TICKS = 15;
let outageTicks = 0;

/** Hold a fresh alert this long so its AI overview can land first. */
const AI_WAIT_MS = 120_000;

/** Fit wait starts at first sighting in the notifier, not at job.createdAt. */
const fitFirstSeen = new Map<string, number>();

/** Drop the wait clock for a chat after a resume save or clear. */
export function forgetFitWait(chatId: number): void {
  const prefix = `${chatId}:`;
  for (const key of [...fitFirstSeen.keys()]) {
    if (key.startsWith(prefix)) fitFirstSeen.delete(key);
  }
}

/** True when an AI-enabled recipient's overview is still being generated. */
export function shouldAwaitAi(
  analysis: unknown,
  recipients: { chatId: number }[],
  aiChats: Set<number>,
  createdAt: Date | null,
  now: number,
  apiAvailable: boolean,
): boolean {
  if (!apiAvailable || analysis) return false;
  if (!recipients.some((r) => aiChats.has(r.chatId))) return false;
  return now - (createdAt?.getTime() ?? 0) < AI_WAIT_MS;
}

/** Resume-fit recipients wait only for their fit, never for the shared overview. */
export function shouldAwaitFit(
  fitReady: boolean,
  aiEnabled: boolean,
  firstSeen: number,
  now: number,
  fitEnabled: boolean,
  apiAvailable: boolean,
): boolean {
  if (fitReady || !aiEnabled || !fitEnabled || !apiAvailable) return false;
  return now - firstSeen < FIT_WAIT_MS;
}

/** Send only recipients whose own lane is ready; held lanes keep the job queued. */
function sendableRecipients<T extends { chatId: number }>(
  pending: T[],
  resumeChats: Map<number, string>,
  aiChats: Set<number>,
  heldResume: Set<number>,
  sharedWaiting: boolean,
): T[] {
  return pending.filter(({ chatId }) => {
    if (resumeChats.has(chatId)) return !heldResume.has(chatId);
    return !(sharedWaiting && aiChats.has(chatId));
  });
}

type ResumeSnapshot = { hash: string | null; aiOverview: boolean };

/** Re-read the resume state so a save or clear during this tick is not missed. */
async function freshResumeStates(chatIds: number[]): Promise<Map<number, ResumeSnapshot>> {
  const out = new Map<number, ResumeSnapshot>();
  if (chatIds.length === 0) return out;
  const rows = await db
    .select({
      chatId: userSettings.chatId,
      resumeHash: userSettings.resumeHash,
      aiOverview: userSettings.aiOverview,
    })
    .from(userSettings)
    .where(inArray(userSettings.chatId, chatIds));
  for (const row of rows) {
    out.set(row.chatId, { hash: row.resumeHash, aiOverview: row.aiOverview });
  }
  return out;
}

/**
 * Repost detection lands after the tick snapshot. Re-read its columns before
 * rendering so a same-tick alert does not lose the line.
 */
async function freshRepostFields(
  job: typeof jobPostings.$inferSelect,
): Promise<typeof jobPostings.$inferSelect> {
  const rows = await db
    .select({
      repostOfJobId: jobPostings.repostOfJobId,
      repostIds: jobPostings.repostIds,
      repostScore: jobPostings.repostScore,
      repostCount: jobPostings.repostCount,
      repostFirstSeen: jobPostings.repostFirstSeen,
      repostDiff: jobPostings.repostDiff,
      repostVersion: jobPostings.repostVersion,
      repostCheckedAt: jobPostings.repostCheckedAt,
    })
    .from(jobPostings)
    .where(eq(jobPostings.id, job.id))
    .limit(1);
  return rows[0] ? { ...job, ...rows[0] } : job;
}

function resumeUnchanged(
  chatId: number,
  oldHash: string,
  fresh: Map<number, ResumeSnapshot>,
): boolean {
  const row = fresh.get(chatId);
  return Boolean(row?.aiOverview && row.hash === oldHash);
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

  // Fit rows are ignored when the kill switch is off. A missing API key still
  // shows cached fits; it only stops both new fits and the fit wait.
  const fitAvailable = isFitEnabled();
  const resumeChats = new Map<number, string>();
  if (fitAvailable) {
    const resumeRows = await db
      .select({ chatId: userSettings.chatId, resumeHash: userSettings.resumeHash })
      .from(userSettings)
      .where(
        and(
          eq(userSettings.aiOverview, true),
          sql`${userSettings.resumeText} IS NOT NULL AND ${userSettings.resumeHash} IS NOT NULL`,
        ),
      );
    for (const row of resumeRows) {
      if (row.resumeHash) resumeChats.set(row.chatId, row.resumeHash);
    }
  }

  // Wait windows and retry timestamps only live for jobs still in the batch.
  const batchJobIds = new Set(jobs.map((j) => j.jobId));
  for (const key of [...fitFirstSeen.keys()]) {
    if (!batchJobIds.has(Number(key.slice(key.indexOf(':') + 1)))) fitFirstSeen.delete(key);
  }
  pruneFitAttempts(batchJobIds);

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

    // A retry after a partial send must not wait on or pay for chats already alerted.
    const pendingRecipients = recipients.filter(
      (r) => !notified.has(`${r.chatId}:${job.jobId}`),
    );
    // Resume recipients wait only for their own fit; the shared overview gate
    // must not delay them.
    const resumeRecipients = fitAvailable
      ? pendingRecipients.filter((r) => resumeChats.has(r.chatId))
      : [];
    const sharedRecipients = fitAvailable
      ? pendingRecipients.filter((r) => !resumeChats.has(r.chatId))
      : pendingRecipients;

    const fits: Map<number, CachedFit> =
      resumeRecipients.length > 0 ? await fitsForJob(job.jobId) : new Map();

    // A save or clear during this tick must not be served the old hash or fit.
    const freshResume = await freshResumeStates(resumeRecipients.map((r) => r.chatId));
    const heldResume = new Set<number>();
    for (const { chatId } of resumeRecipients) {
      const hash = resumeChats.get(chatId);
      if (!hash || !resumeUnchanged(chatId, hash, freshResume)) {
        heldResume.add(chatId);
        continue;
      }
      const cached = fits.get(chatId);
      if (cached && cached.hash === hash) continue;
      enqueueFit(job.id, chatId, job.jobId, hash);
    }

    // The clock starts at first sighting, before any wait can hold the job.
    const now = Date.now();
    for (const { chatId } of resumeRecipients) {
      const key = `${chatId}:${job.jobId}`;
      if (!fitFirstSeen.has(key)) fitFirstSeen.set(key, now);
    }

    const sharedWaiting = shouldAwaitAi(
      job.aiAnalysis,
      sharedRecipients,
      aiChats,
      job.createdAt,
      now,
      isOverviewAvailable(),
    );

    for (const { chatId } of resumeRecipients) {
      if (heldResume.has(chatId)) continue;
      const hash = resumeChats.get(chatId);
      const cached = fits.get(chatId);
      const ready = Boolean(hash && cached && cached.hash === hash);
      const firstSeen = fitFirstSeen.get(`${chatId}:${job.jobId}`) ?? now;
      if (
        shouldAwaitFit(ready, aiChats.has(chatId), firstSeen, now, isFitEnabled(), isOverviewAvailable())
      ) {
        heldResume.add(chatId);
      }
    }

    const sendRecipients = sendableRecipients(
      pendingRecipients,
      resumeChats,
      aiChats,
      heldResume,
      sharedWaiting,
    );
    const stillWaiting = sharedWaiting || heldResume.size > 0;

    if (sendRecipients.length === 0) {
      if (stillWaiting) {
        waiting++;
        continue;
      }
    } else {
      const insight = await payInsightFor(job);
      const renderJob = repostRenderEnabled() ? await freshRepostFields(job) : job;
      const sharedAnalysis = (job.aiAnalysis as JobAnalysis | null) ?? null;

      for (const { chatId, matches } of sendRecipients) {
        if (notified.has(`${chatId}:${job.jobId}`)) continue;
        let analysis: JobAnalysis | null = sharedAnalysis;
        if (fitAvailable && resumeChats.has(chatId)) {
          // Re-read so a save or clear during this tick cannot render an old fit.
          // ponytail: two reads per resume recipient; batch if a job ever has many.
          analysis =
            (await readFitForChat(chatId, job.jobId)) ??
            (job.aiVersion === AI_VERSION ? sharedAnalysis : null);
        }
        const showAi = aiChats.has(chatId) && Boolean(analysis);
        const hasKit = isKitEnabled() && aiChats.has(chatId);
        const { caption, hasAi } = buildAlertCaption(
          renderJob,
          insight,
          matches,
          showAi ? analysis : null,
        );

        try {
          const result = await sendAlert(chatId, caption, job, alertKeyboard(job.jobId, hasAi, hasKit));
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
    }

    if (stillWaiting) {
      waiting++;
      continue;
    }

    for (const { chatId } of recipients) fitFirstSeen.delete(`${chatId}:${job.jobId}`);
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
    // AI wait: only for a fresh job with an AI-enabled recipient, no analysis, and a key.
    shouldAwaitAi(null, [{ chatId: 1 }], new Set([1]), new Date(0), 60_000, true) === true,
    shouldAwaitAi(null, [{ chatId: 1 }], new Set([2]), new Date(0), 60_000, true) === false,
    shouldAwaitAi({}, [{ chatId: 1 }], new Set([1]), new Date(0), 60_000, true) === false,
    shouldAwaitAi(null, [{ chatId: 1 }], new Set([1]), new Date(0), 200_000, true) === false,
    shouldAwaitAi(null, [{ chatId: 1 }], new Set([1]), new Date(0), 60_000, false) === false,
    // Fit wait: fresh and not ready waits; ready, stale, disabled, or no key does not.
    shouldAwaitFit(false, true, 1_000, 2_000, true, true) === true,
    shouldAwaitFit(false, true, 0, 200_000, true, true) === false,
    shouldAwaitFit(true, true, 1_000, 2_000, true, true) === false,
    shouldAwaitFit(false, true, 1_000, 2_000, true, false) === false,
    shouldAwaitFit(false, true, 1_000, 2_000, false, true) === false,
    shouldAwaitFit(false, false, 1_000, 2_000, true, true) === false,
    // Resume recipients must not reach the shared-overview gate.
    shouldAwaitAi(null, [], new Set([1]), new Date(0), 60_000, true) === false,
    // Mixed lanes: a held resume fit or a held shared overview never blocks the other lane.
    sendableRecipients(
      [{ chatId: 1 }, { chatId: 2 }, { chatId: 3 }],
      new Map([[1, 'h']]),
      new Set([1, 2]),
      new Set([1]),
      true,
    )
      .map((r) => r.chatId)
      .join(',') === '3',
    sendableRecipients(
      [{ chatId: 1 }, { chatId: 2 }, { chatId: 3 }],
      new Map([[1, 'h']]),
      new Set([1, 2]),
      new Set(),
      true,
    )
      .map((r) => r.chatId)
      .join(',') === '1,3',
  ];
  if (checks.includes(false)) {
    console.error('notifier.ts self-check FAIL');
    process.exit(1);
  }
  console.log('notifier.ts self-check OK');
}
