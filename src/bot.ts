import { Bot } from 'grammy';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db';
import { jobPostings, userSubscriptions, userSettings, notifications, overviewFeedback } from './schema';
import { isOverviewAvailable, type JobAnalysis } from './overview';
import { escapeHtml } from './utils';

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

const LEGIT_LABEL = {
  likely: '✅ Likely legit',
  caution: '⚠️ Caution',
  risk: '🚩 High risk',
  unclear: '❓ Unclear',
} as const;

const BOTTOM_LABEL = { apply: 'Apply', maybe: 'Maybe', skip: 'Skip' } as const;

bot.command('job', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const jobId = Number((ctx.match ?? '').trim());
  if (!Number.isFinite(jobId) || jobId <= 0) {
    await ctx.reply('Usage: /job <jobId>');
    return;
  }

  const [alerted] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.chatId, chatId), eq(notifications.jobId, jobId)))
    .limit(1);
  if (!alerted) {
    await ctx.reply('I have no alert for that job in this chat.');
    return;
  }

  const [job] = await db
    .select()
    .from(jobPostings)
    .where(eq(jobPostings.jobId, jobId))
    .limit(1);
  const analysis = job?.aiAnalysis as JobAnalysis | null | undefined;
  if (!job || !analysis) {
    await ctx.reply('No AI analysis is available for this job yet.');
    return;
  }

  const final = analysis.final;
  const lines: string[] = [
    `<b>${escapeHtml(job.jobTitle ?? `Job ${jobId}`)}</b>`,
    '',
    '🤖 <b>AI analysis</b>',
    `Bottom line: ${BOTTOM_LABEL[final.bottom_line]}`,
    `Legit: ${LEGIT_LABEL[final.legit]} — ${escapeHtml(final.legit_reason)}`,
    `What: ${escapeHtml(final.what)}`,
    `Needs: ${escapeHtml(final.needs)}`,
    `Watch: ${escapeHtml(final.watch)}`,
  ];
  if (final.ask.length > 0) lines.push(`Ask: ${escapeHtml(final.ask.join(' '))}`);

  const modelRisks = final.risk_signals.map((s) => `• ${s.category}: "${s.quote}"`);
  const hardRisks = analysis.signals.hardRisk.map((s) => `• ${s.category}: "${s.quote}" — ${s.reason}`);
  const hardCautions = analysis.signals.hardCaution.map((s) => `• ${s.category}: "${s.quote}"`);
  const soft = analysis.signals.soft.map((s) => `• ${s.category}: ${s.quote}`);
  lines.push('', '<b>Risk quotes</b>');
  const allRisks = [...new Set([...hardRisks, ...hardCautions, ...modelRisks])];
  lines.push(...(allRisks.length > 0 ? allRisks.map(escapeHtml) : ['None flagged']));
  if (soft.length > 0) {
    lines.push('', '<b>Soft signals</b>');
    lines.push(...soft.map(escapeHtml));
  }

  lines.push('', '<b>Gaps</b>');
  lines.push(...(final.gaps.length > 0 ? final.gaps.map(escapeHtml) : ['None listed']));

  const employer = analysis.employer;
  lines.push('', '<b>Employer record</b>');
  if (!employer) {
    lines.push('No employer record available');
  } else if (!employer.found) {
    lines.push('Not found in OLJ records');
  } else {
    lines.push(`Name: ${escapeHtml(employer.name ?? 'Not stated')}`);
    lines.push(`Paid active: ${employer.paidActive === null ? 'Unknown' : employer.paidActive ? 'Yes' : 'No'}`);
    lines.push(`Complaints: ${employer.complaints ?? 'Unknown'}`);
    lines.push(`Posts: ${employer.postCount ?? 'Unknown'} (${employer.newPostCount ?? 0} new)`);
  }

  const pay = analysis.pay;
  lines.push('', '<b>Pay context</b>');
  lines.push(`Listing: ${escapeHtml(pay.raw)}`);
  lines.push(`Peer median: ${pay.median ?? 'Not stated'} · p95: ${pay.p95 ?? 'Not stated'}`);
  lines.push(`Ratio: ${pay.ratio ?? 'Not stated'} · extreme: ${pay.extreme ? 'Yes' : 'No'}`);

  lines.push(
    '',
    `<a href="https://www.onlinejobs.ph/jobseekers/job/${job.jobId}">View original listing</a>`,
  );
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
});

bot.callbackQuery(/^fb:(helpful|unhelpful|report):(\d+)$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  const value = ctx.match[1];
  const jobId = Number(ctx.match[2]);
  if (!chatId || !Number.isFinite(jobId)) {
    await ctx.answerCallbackQuery({ text: 'Could not save feedback.' });
    return;
  }

  const [alerted] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.chatId, chatId), eq(notifications.jobId, jobId)))
    .limit(1);
  if (!alerted) {
    await ctx.answerCallbackQuery({ text: 'No alert found for this job.' });
    return;
  }

  await db
    .insert(overviewFeedback)
    .values({ chatId, jobId, value })
    .onConflictDoUpdate({
      target: [overviewFeedback.chatId, overviewFeedback.jobId],
      set: { value, createdAt: new Date() },
    });
  await ctx.answerCallbackQuery({ text: 'Thanks — feedback saved.' });
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
