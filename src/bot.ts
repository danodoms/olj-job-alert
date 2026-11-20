import { Bot, type Context } from 'grammy';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db';
import { jobPostings, userSubscriptions, userSettings, notifications, overviewFeedback } from './schema';
import {
  AI_VERSION,
  BOTTOM_LABEL,
  LEGIT_EMOJI,
  isOverviewAvailable,
  type JobAnalysis,
} from './overview';
import { defangUrls, escapeHtml, makeExcerpt, visibleLength } from './utils';
import { formatPay } from './pay';
import { alertKeyboard, hoursLabel, parsedPayOf } from './alert';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');

export const bot = new Bot(token);

/** Max keywords a subscriber may hold. */
const MAX_KEYWORDS = 5;

const HELP = [
  'OLJAlerts — job alerts on Telegram',
  '',
  'Manage your keywords:',
  `/keywordsub <k1, k2> — replace all keywords (max ${MAX_KEYWORDS})`,
  '/keywordadd <k1, k2> — add keywords',
  '/keywordremove <k1, k2> — remove keywords',
  '/mysubs — show your keywords and activity',
  '/job <jobId> — full AI analysis for an alerted job',
  '/ai on|off — enable or disable the AI overview',
  '/unsub — remove all keywords',
  '/help — show this message',
].join('\n');

async function getAiEnabled(chatId: number): Promise<boolean> {
  const rows = await db
    .select({ aiOverview: userSettings.aiOverview })
    .from(userSettings)
    .where(eq(userSettings.chatId, chatId))
    .limit(1);
  return rows[0]?.aiOverview ?? false;
}

async function setAiEnabled(chatId: number, enabled: boolean): Promise<void> {
  await db
    .insert(userSettings)
    .values({ chatId, aiOverview: enabled, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userSettings.chatId,
      set: { aiOverview: enabled, updatedAt: new Date() },
    });
}

function parseKeywords(raw: string): string[] {
  return [...new Set(raw.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean))];
}

async function getKeywords(chatId: number): Promise<string[]> {
  const rows = await db
    .select({ keyword: userSubscriptions.keyword })
    .from(userSubscriptions)
    .where(eq(userSubscriptions.chatId, chatId))
    .orderBy(userSubscriptions.createdAt);
  return rows.map((r) => r.keyword);
}

function listKeywords(keywords: string[]): string {
  return keywords.map((k) => `• ${k}`).join('\n');
}

async function replyHelp(ctx: { chat?: { id: number }; reply: (text: string) => Promise<unknown> }) {
  const chatId = ctx.chat?.id;
  const on = chatId ? await getAiEnabled(chatId) : false;
  await ctx.reply(`${HELP}\n\nAI overview: ${on ? 'ON' : 'OFF'}`);
}

bot.command('start', (ctx) => replyHelp(ctx));
bot.command('help', (ctx) => replyHelp(ctx));

bot.command('ai', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const arg = (ctx.match ?? '').trim().toLowerCase();
  if (!arg) {
    const on = await getAiEnabled(chatId);
    await ctx.reply(
      `AI overview: ${on ? 'ON' : 'OFF'}\n\nUsage:\n/ai on — enable\n/ai off — disable`,
    );
    return;
  }
  if (arg !== 'on' && arg !== 'off') {
    await ctx.reply('Usage: /ai on | /ai off');
    return;
  }
  if (arg === 'on') {
    if (!isOverviewAvailable()) {
      await ctx.reply('AI overview is not available right now.');
      return;
    }
    await setAiEnabled(chatId, true);
    await ctx.reply(
      'AI overview: ON\nEach matching job alert gets one shared AI estimate. It is a heuristic, not a scam verdict. Turn it off with /ai off.',
    );
    return;
  }
  await setAiEnabled(chatId, false);
  await ctx.reply('AI overview: OFF');
});

const JOB_DETAIL_CAP = 3500;
const MESSAGE_LIMIT = 4096;

type DetailFailure = 'no_alert' | 'no_analysis' | 'outdated';
type DetailResult = { ok: true; main: string; evidence: string } | { ok: false; reason: DetailFailure };

function evidenceBlock(title: string, lines: string[]): string {
  if (lines.length === 0) return '';
  return `<blockquote expandable>\n<b>${title}</b>\n${lines.join('\n')}\n</blockquote>`;
}

async function buildJobDetail(chatId: number, jobId: number): Promise<DetailResult> {
  const [alerted] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.chatId, chatId), eq(notifications.jobId, jobId)))
    .limit(1);
  if (!alerted) return { ok: false, reason: 'no_alert' };

  const [job] = await db
    .select()
    .from(jobPostings)
    .where(eq(jobPostings.jobId, jobId))
    .limit(1);
  if (!job) return { ok: false, reason: 'no_alert' };
  if (!job.aiAnalysis || job.aiVersion !== AI_VERSION) {
    return { ok: false, reason: job.aiAnalysis ? 'outdated' : 'no_analysis' };
  }

  const analysis = job.aiAnalysis as JobAnalysis;
  const final = analysis.final;
  const meta = [job.employer, job.typeOfWork, hoursLabel(job.hoursPerWeek)]
    .map((part) => part?.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' · ');

  const lines: string[] = [`<b>${escapeHtml(job.jobTitle ?? `Job ${jobId}`)}</b>`];
  if (meta) lines.push(`<i>${escapeHtml(meta)}</i>`);

  const excerpt = makeExcerpt(job.jobDescription ?? '', 800, job.jobTitle ?? undefined);
  if (excerpt) lines.push('', `📝 <i>“${escapeHtml(defangUrls(excerpt))}”</i>`);

  lines.push('', `💰 <b>${escapeHtml(formatPay(parsedPayOf(job)))}</b>`);
  const pay = analysis.pay;
  const market = [
    pay.median !== null ? `median $${pay.median}` : null,
    pay.p95 !== null ? `p95 $${pay.p95}` : null,
    pay.ratio !== null ? `${pay.ratio}× median` : null,
  ].filter(Boolean);
  if (market.length > 0) {
    lines.push(`📊 <b>Market:</b> ${escapeHtml(market.join(' · '))} · vs ${escapeHtml(pay.peerLabel)}`);
  }

  lines.push('', '🤖 <b>AI overview</b>');
  lines.push(`<b>Bottom line:</b> ${BOTTOM_LABEL[final.bottom_line]}`);
  lines.push(`<b>What:</b> ${escapeHtml(defangUrls(final.what))}`);
  lines.push(`<b>Needs:</b> ${escapeHtml(defangUrls(final.needs))}`);
  lines.push(`<b>Legit:</b> ${LEGIT_EMOJI[final.legit]} — ${escapeHtml(defangUrls(final.legit_reason))}`);
  lines.push(`<b>Watch:</b> ${escapeHtml(defangUrls(final.watch))}`);
  if (final.ask.length > 0) lines.push(`<b>Ask:</b> ${escapeHtml(defangUrls(final.ask.join(' ')))}`);

  const employer = analysis.employer;
  lines.push('', '<b>Employer record</b>');
  if (!employer) {
    lines.push('No employer record available');
  } else if (!employer.found) {
    lines.push('Not found in OLJ records');
  } else {
    lines.push(`Name: ${escapeHtml(employer.name ?? 'Not stated')}`);
    lines.push(
      `Paid active: ${employer.paidActive === null ? 'Unknown' : employer.paidActive ? 'Yes' : 'No'}`,
    );
    lines.push(`Complaints: ${employer.complaints ?? 'Unknown'}`);
    lines.push(`Posts: ${employer.postCount ?? 'Unknown'} (${employer.newPostCount ?? 0} new)`);
  }

  lines.push('', '<i>AI estimate. Verify before sharing documents.</i>');
  const main = lines.join('\n');

  const signals = analysis.signals;
  const risks = [
    ...signals.hardRisk.map(
      (s) => `• ${s.category}: "${defangUrls(s.quote)}" — ${defangUrls(s.reason)}`,
    ),
    ...signals.hardCaution.map((s) => `• ${s.category}: "${defangUrls(s.quote)}"`),
    ...final.risk_signals.map((s) => `• ${s.category}: "${defangUrls(s.quote)}"`),
    ...signals.soft.map((s) => `• ${s.category}: ${defangUrls(s.quote)}`),
  ].map(escapeHtml);
  let riskLines = [...new Set(risks)];
  let gapLines = final.gaps.map((gap) => escapeHtml(defangUrls(gap)));

  let evidence = [evidenceBlock('Risk quotes', riskLines), evidenceBlock('Gaps', gapLines)]
    .filter(Boolean)
    .join('\n\n');
  while (visibleLength(`${main}\n\n${evidence}`) > JOB_DETAIL_CAP) {
    if (gapLines.length > 0) gapLines = gapLines.slice(0, -1);
    else if (riskLines.length > 0) riskLines = riskLines.slice(0, -1);
    else break;
    evidence = [evidenceBlock('Risk quotes', riskLines), evidenceBlock('Gaps', gapLines)]
      .filter(Boolean)
      .join('\n\n');
  }

  return { ok: true, main, evidence };
}

async function sendJobDetail(
  ctx: Context,
  chatId: number,
  jobId: number,
): Promise<'sent' | DetailFailure> {
  const detail = await buildJobDetail(chatId, jobId);
  if (!detail.ok) return detail.reason;

  const options = {
    parse_mode: 'HTML' as const,
    link_preview_options: { is_disabled: true },
  };
  const combined = detail.evidence ? `${detail.main}\n\n${detail.evidence}` : detail.main;
  if (visibleLength(combined) <= MESSAGE_LIMIT) {
    await ctx.reply(combined, { ...options, reply_markup: alertKeyboard(jobId, false) });
  } else {
    await ctx.reply(detail.main, { ...options, reply_markup: alertKeyboard(jobId, false) });
    if (detail.evidence) await ctx.reply(detail.evidence, options);
  }
  return 'sent';
}

function detailFailureText(reason: DetailFailure): string {
  if (reason === 'no_alert') return 'I have no alert for that job in this chat.';
  if (reason === 'outdated') return 'Analysis is outdated. Try again later.';
  return 'No AI analysis is available for this job yet.';
}

bot.command('job', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const jobId = Number((ctx.match ?? '').trim());
  if (!Number.isFinite(jobId) || jobId <= 0) {
    await ctx.reply('Usage: /job <jobId>');
    return;
  }
  const result = await sendJobDetail(ctx, chatId, jobId);
  if (result !== 'sent') await ctx.reply(detailFailureText(result));
});

bot.callbackQuery(/^job:(\d+)$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  const jobId = Number(ctx.match[1]);
  if (!chatId) {
    await ctx.answerCallbackQuery({ text: 'Not available.' });
    return;
  }
  const result = await sendJobDetail(ctx, chatId, jobId);
  await ctx.answerCallbackQuery(result === 'sent' ? undefined : { text: 'Not available.' });
});

bot.callbackQuery(/^fb:(helpful|unhelpful|report):(\d+)$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  const value = ctx.match[1];
  const jobId = Number(ctx.match[2]);
  if (!chatId || !Number.isFinite(jobId)) {
    await ctx.answerCallbackQuery({ text: 'Not available.' });
    return;
  }

  const [alerted] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.chatId, chatId), eq(notifications.jobId, jobId)))
    .limit(1);
  if (!alerted) {
    await ctx.answerCallbackQuery({ text: 'Not available.' });
    return;
  }

  let saved = true;
  await db
    .insert(overviewFeedback)
    .values({ chatId, jobId, value })
    .onConflictDoUpdate({
      target: [overviewFeedback.chatId, overviewFeedback.jobId],
      set: { value, createdAt: new Date() },
    })
    .catch((err) => {
      saved = false;
      console.error('[bot] feedback save failed:', err);
    });
  await ctx.answerCallbackQuery({ text: saved ? 'Thanks — feedback saved.' : 'Could not save feedback.' });
});

bot.command('keywordsub', async (ctx) => {
  const unique = parseKeywords(ctx.match ?? '');
  if (unique.length === 0) {
    await ctx.reply('Usage: /keywordsub keyword1, keyword2');
    return;
  }
  if (unique.length > MAX_KEYWORDS) {
    await ctx.reply(`Maximum ${MAX_KEYWORDS} keywords allowed.`);
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  await db.delete(userSubscriptions).where(eq(userSubscriptions.chatId, chatId));
  for (const keyword of unique) {
    await db.insert(userSubscriptions).values({ chatId, keyword }).onConflictDoNothing();
  }
  await ctx.reply(`Keywords updated:\n${listKeywords(unique)}`);
});

bot.command('keywordadd', async (ctx) => {
  const incoming = parseKeywords(ctx.match ?? '');
  if (incoming.length === 0) {
    await ctx.reply('Usage: /keywordadd keyword1, keyword2');
    return;
  }
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const current = await getKeywords(chatId);
  const toAdd = incoming.filter((k) => !current.includes(k));
  if (current.length + toAdd.length > MAX_KEYWORDS) {
    await ctx.reply(
      `You already have ${current.length}/${MAX_KEYWORDS} keywords. Adding ${toAdd.length} would exceed the limit.`,
    );
    return;
  }

  for (const keyword of toAdd) {
    await db.insert(userSubscriptions).values({ chatId, keyword }).onConflictDoNothing();
  }
  const updated = await getKeywords(chatId);
  await ctx.reply(
    toAdd.length === 0
      ? `No new keywords added.\n\nYour keywords (${updated.length}/${MAX_KEYWORDS}):\n${listKeywords(updated)}`
      : `Added: ${toAdd.join(', ')}\n\nYour keywords (${updated.length}/${MAX_KEYWORDS}):\n${listKeywords(updated)}`,
  );
});

bot.command('keywordremove', async (ctx) => {
  const incoming = parseKeywords(ctx.match ?? '');
  if (incoming.length === 0) {
    await ctx.reply('Usage: /keywordremove keyword1, keyword2');
    return;
  }
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  await db
    .delete(userSubscriptions)
    .where(and(eq(userSubscriptions.chatId, chatId), inArray(userSubscriptions.keyword, incoming)));

  const updated = await getKeywords(chatId);
  await ctx.reply(
    updated.length === 0
      ? 'All keywords removed. Use /keywordadd to start again.'
      : `Your keywords (${updated.length}/${MAX_KEYWORDS}):\n${listKeywords(updated)}`,
  );
});

bot.command('mysubs', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const keywords = await getKeywords(chatId);
  const [stats] = await db
    .select({
      last7: sql<number>`count(*) FILTER (WHERE ${notifications.sentAt} > now() - interval '7 days')`,
      last30: sql<number>`count(*) FILTER (WHERE ${notifications.sentAt} > now() - interval '30 days')`,
      lastSent: sql<string | null>`max(${notifications.sentAt})`,
    })
    .from(notifications)
    .where(eq(notifications.chatId, chatId));

  const lines: string[] = [];
  if (keywords.length === 0) {
    lines.push('You have no keywords yet.');
    lines.push('Add some with: /keywordadd keyword1, keyword2');
  } else {
    lines.push(`Your keywords (${keywords.length}/${MAX_KEYWORDS}):`);
    lines.push(listKeywords(keywords));
  }

  lines.push('');
  lines.push('Activity:');
  lines.push(`• ${Number(stats?.last7 ?? 0)} alerts in the last 7 days`);
  lines.push(`• ${Number(stats?.last30 ?? 0)} alerts in the last 30 days`);
  if (stats?.lastSent) {
    lines.push(`• Last alert: ${new Date(stats.lastSent).toLocaleString()}`);
  } else {
    lines.push('• No alerts sent yet');
  }

  lines.push('');
  lines.push(`AI overview: ${(await getAiEnabled(chatId)) ? 'ON' : 'OFF'}`);
  lines.push('');
  lines.push('Commands: /keywordadd · /keywordremove · /keywordsub · /job · /ai · /unsub · /help');
  await ctx.reply(lines.join('\n'));
});

bot.command('unsub', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  await db.delete(userSubscriptions).where(eq(userSubscriptions.chatId, chatId));
  await ctx.reply('All your keywords were removed.');
});

bot.on('message', (ctx) => {
  if (ctx.message.text?.startsWith('/')) return;
  ctx.reply(HELP);
});

export function startBot(): void {
  bot.start();
}
