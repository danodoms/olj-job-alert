import { eq, sql } from 'drizzle-orm';
import { db } from './db';
import { jobPostings } from './schema';
import { userSubscriptions, userSettings } from './schema';
import { notifications } from './schema';
import { matchJob, describeMatches, type KeywordMatch } from './match';
import { delay, escapeHtml } from './utils';
import { bot } from './bot';
import { formatPay, formatVerdict, verdictEmoji, type ParsedPay } from './pay';
import { payInsightFor, type PayInsight } from './signals';

const NOTIFIER_INTERVAL_MS = Number(process.env.NOTIFIER_INTERVAL_MS ?? 20000);
const NOTIFIER_BATCH = Number(process.env.NOTIFIER_BATCH ?? 20);
const DESCRIPTION_LIMIT = 120;

function buildMessage(
  job: typeof jobPostings.$inferSelect,
  insight: PayInsight | null,
  matches: KeywordMatch[],
  aiOverview: string | null,
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
  const verdictText = insight ? formatVerdict(insight.verdict) : null;

  const onlyPossible = matches.length > 0 && matches.every((m) => m.strength === 'possible');
  const headline = onlyPossible ? '🔎 <b>Possible match</b>' : '🔔 <b>New job match!</b>';

  const lines: string[] = [];
  lines.push(
    headline,
    '',
    `<b>${escapeHtml(job.jobTitle ?? '')}</b>`,
    '',
    `📝 ${escapeHtml(description)}...`,
    '',
    `💼 <b>Type:</b> ${escapeHtml(job.typeOfWork ?? '')}`,
    `💰 <b>Pay:</b> ${escapeHtml(payText)}`,
  );
  if (verdictText) {
    const emoji = verdictEmoji(insight!.verdict) ?? '';
    lines.push(
      `📊 <b>Market:</b> ${emoji} ${escapeHtml(verdictText)} · vs ${escapeHtml(insight!.peerLabel)}`,
    );
  }
  if (aiOverview) lines.push('', escapeHtml(aiOverview));
  if (matches.length > 0) {
    lines.push(`🎯 <b>Matched:</b> ${escapeHtml(describeMatches(matches))}`);
  }
  lines.push(
    `⏰ <b>Hours:</b> ${escapeHtml(job.hoursPerWeek ?? '')}`,
    '',
    `👉 <a href="https://www.onlinejobs.ph/jobseekers/job/${job.jobId}">Apply here</a>`,
  );
  if (aiOverview) lines.push('', `Details: /job ${job.jobId}`);
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
    const aiOverview = job.aiOverview;

    for (const { chatId, matches } of recipients) {
      const showAi = aiChats.has(chatId) && Boolean(aiOverview);
      const message = buildMessage(job, insight, matches, showAi ? aiOverview : null);
      const reply_markup = showAi
        ? {
            inline_keyboard: [
              [
                { text: '👍 Helpful', callback_data: `fb:helpful:${job.jobId}` },
                { text: '👎 Not helpful', callback_data: `fb:unhelpful:${job.jobId}` },
                { text: '🚩 Report', callback_data: `fb:report:${job.jobId}` },
              ],
            ],
          }
        : undefined;

      try {
        await bot.api.sendMessage(
          chatId,
          message,
          reply_markup ? { parse_mode: 'HTML', reply_markup } : { parse_mode: 'HTML' },
        );
        await db.insert(notifications).values({ chatId, jobId: job.jobId });
        sent++;
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
