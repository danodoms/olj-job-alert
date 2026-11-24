import { Bot, type Context } from 'grammy';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db';
import {
  jobFits,
  jobKits,
  jobPostings,
  userSubscriptions,
  userSettings,
  notifications,
} from './schema';
import {
  AI_VERSION,
  BOTTOM_LABEL,
  LEGIT_EMOJI,
  clearFitsForChat,
  fitLabel,
  isFitEnabled,
  isOverviewAvailable,
  readFitForChat,
  type JobAnalysis,
} from './overview';
import { forgetFitWait } from './notifier';
import {
  RESUME_MAX,
  RESUME_MIN,
  RESUME_PRIVACY_NOTE,
  isPrivateChat,
  resumeHash,
  resumeStateText,
  validateResume,
} from './resume';
import { defangUrls, escapeHtml, makeExcerpt, visibleLength } from './utils';
import { formatPay } from './pay';
import { alertKeyboard, hoursLabel, parsedPayOf } from './alert';
import {
  clearKitsForChat,
  isKitBuilding,
  isKitEnabled,
  renderKit,
  requestKit,
  type KitFailure,
  type KitOutcome,
} from './kit';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');

export const bot = new Bot(token);

/** Max keywords a subscriber may hold. */
const MAX_KEYWORDS = 10;

const HELP = [
  'OLJAlerts — job alerts on Telegram',
  '',
  'Manage your keywords:',
  `/keywordsub <k1, k2> — replace all keywords (max ${MAX_KEYWORDS})`,
  '/keywordadd <k1, k2> — add keywords',
  '/keywordremove <k1, k2> — remove keywords',
  '/mysubs — show your keywords and activity',
  '/job <jobId> — full AI analysis for an alerted job',
  '/kit <jobId> — application kit for an alerted job',
  '/ai on|off — enable or disable the AI overview and resume fit',
  '/resume — add, view, or clear your resume (max 4,000 chars)',
  '/unsub — remove all keywords',
  '/help — show this message',
].join('\n');

/** Keep in sync with bot.command: lets a resume paste start with an unknown slash word. */
const KNOWN_COMMAND =
  /^\/(?:start|help|ai|resume|job|kit|keywordsub|keywordadd|keywordremove|mysubs|unsub)(?:@\w+)?(?:\s|$)/i;

/** A pending resume paste, in memory only. Restart loses it. */
const pendingResume = new Map<number, number>();
const RESUME_PENDING_TTL_MS = 15 * 60_000;

function isResumePending(chatId: number): boolean {
  const at = pendingResume.get(chatId);
  if (at === undefined) return false;
  if (Date.now() - at > RESUME_PENDING_TTL_MS) {
    pendingResume.delete(chatId);
    return false;
  }
  return true;
}

/** Any known command except /resume cancels a pending paste before it can swallow text. */
bot.use((ctx, next) => {
  const text = ctx.message?.text ?? '';
  const chatId = ctx.chat?.id;
  if (chatId && KNOWN_COMMAND.test(text) && !/^\/resume\b/.test(text) && !/^\/resume@/.test(text)) {
    pendingResume.delete(chatId);
  }
  return next();
});

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

/** Notice for the automatic AI opt-in on resume save. */
function aiOnNotice(): string {
  if (!isFitEnabled()) {
    return 'AI overview turned ON. Fit checks are disabled by the operator. /ai off still overrides.';
  }
  return isOverviewAvailable()
    ? 'AI overview turned ON so fit checks can run. /ai off still overrides.'
    : 'AI overview turned ON. Fit checks start when AI is configured. /ai off still overrides.';
}

async function getResumeState(chatId: number) {
  const [row] = await db
    .select({
      resumeText: userSettings.resumeText,
      resumeHash: userSettings.resumeHash,
      resumeUpdatedAt: userSettings.resumeUpdatedAt,
      aiOverview: userSettings.aiOverview,
    })
    .from(userSettings)
    .where(eq(userSettings.chatId, chatId))
    .limit(1);
  return row ?? null;
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

bot.command('resume', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  if (!isPrivateChat(ctx.chat?.type)) {
    await ctx.reply('DM the bot to add a resume.');
    return;
  }

  const arg = (ctx.match ?? '').trim().toLowerCase();
  const state = await getResumeState(chatId);

  if (arg === 'status') {
    const lines = [resumeStateText(state?.resumeText ?? null, state?.resumeUpdatedAt ?? null)];
    const fitOn = Boolean(isFitEnabled() && state?.aiOverview && state?.resumeText);
    const generating = fitOn && isOverviewAvailable();
    lines.push(
      `Fit: ${generating ? 'ON' : fitOn ? 'ON (cached only; AI not configured)' : 'OFF'}`,
    );
    if (!isFitEnabled()) lines.push('Fit checks are disabled by the operator.');
    else if (fitOn && !isOverviewAvailable()) {
      lines.push('Saved fits still show. New fits need AI configured.');
    }
    if (isResumePending(chatId)) lines.push('Waiting for resume text (200-4,000 chars).');
    await ctx.reply(lines.join('\n'));
    return;
  }

  if (arg === 'clear') {
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(userSettings)
          .set({ resumeText: null, resumeHash: null, resumeUpdatedAt: null, updatedAt: new Date() })
          .where(eq(userSettings.chatId, chatId));
        await tx.delete(jobFits).where(eq(jobFits.chatId, chatId));
        await tx.delete(jobKits).where(eq(jobKits.chatId, chatId));
      });
    } catch (err) {
      console.error(
        '[resume] clear failed:',
        (err as { code?: string }).code ?? (err as Error).name ?? 'unknown',
      );
      await ctx.reply('Could not clear your resume. Try again.');
      return;
    }
    pendingResume.delete(chatId);
    clearFitsForChat(chatId);
    clearKitsForChat(chatId);
    forgetFitWait(chatId);
    await ctx.reply('Resume, saved fits, and kits removed. AI setting unchanged.');
    return;
  }

  if (arg) {
    pendingResume.delete(chatId);
    await ctx.reply('Usage:\n/resume — paste a resume\n/resume status\n/resume clear');
    return;
  }

  pendingResume.set(chatId, Date.now());
  await ctx.reply(
    `${resumeStateText(state?.resumeText ?? null, state?.resumeUpdatedAt ?? null)}\n\n` +
      `Paste your resume as one message. ${RESUME_MIN}-${RESUME_MAX} characters. ` +
      'Send /help to cancel the paste. /resume clear deletes your saved resume.',
  );
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
  const fitAnalysis = await readFitForChat(chatId, jobId);
  const shared = job.aiAnalysis && job.aiVersion === AI_VERSION ? (job.aiAnalysis as JobAnalysis) : null;
  const analysis = fitAnalysis ?? shared;
  if (!analysis) {
    return { ok: false, reason: job.aiAnalysis ? 'outdated' : 'no_analysis' };
  }

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

  const fit = analysis.fit;
  const fitLines: string[] = [];
  if (fit) {
    fitLines.push('🎯 <b>Resume fit</b>');
    fitLines.push(
      fit.score === null ? 'Not enough info to score.' : `${fit.score}/10 ${fitLabel(fit.score)}`,
    );
    if (fit.strengths.length > 0) {
      fitLines.push(`+ ${fit.strengths.map((s) => escapeHtml(defangUrls(s))).join(', ')}`);
    }
    if (fit.gaps.length > 0) {
      fitLines.push(`- ${fit.gaps.map((g) => escapeHtml(defangUrls(g))).join(', ')}`);
    }
    if (fit.note) fitLines.push(`Note: ${escapeHtml(defangUrls(fit.note))}`);
    fitLines.push('<i>Uses your saved resume.</i>');
  }

  const tailLines: string[] = ['', '<b>Employer record</b>'];
  const employer = analysis.employer;
  if (!employer) {
    tailLines.push('No employer record available');
  } else if (!employer.found) {
    tailLines.push('Not found in OLJ records');
  } else {
    tailLines.push(`Name: ${escapeHtml(employer.name ?? 'Not stated')}`);
    tailLines.push(
      `Paid active: ${employer.paidActive === null ? 'Unknown' : employer.paidActive ? 'Yes' : 'No'}`,
    );
    tailLines.push(`Complaints: ${employer.complaints ?? 'Unknown'}`);
    tailLines.push(`Posts: ${employer.postCount ?? 'Unknown'} (${employer.newPostCount ?? 0} new)`);
  }

  tailLines.push('', '<i>AI estimate. Verify before sharing documents.</i>');

  const buildMain = () =>
    [...lines, ...(fitLines.length > 0 ? ['', ...fitLines] : []), ...tailLines].join('\n');
  let main = buildMain();

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
    if (fitLines.length > 2) fitLines.pop();
    else if (gapLines.length > 0) gapLines = gapLines.slice(0, -1);
    else if (riskLines.length > 0) riskLines = riskLines.slice(0, -1);
    else break;
    main = buildMain();
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
  hasAi: boolean,
  hasKit: boolean,
): Promise<'sent' | DetailFailure> {
  const detail = await buildJobDetail(chatId, jobId);
  if (!detail.ok) return detail.reason;

  const options = {
    parse_mode: 'HTML' as const,
    link_preview_options: { is_disabled: true },
  };
  const combined = detail.evidence ? `${detail.main}\n\n${detail.evidence}` : detail.main;
  if (visibleLength(combined) <= MESSAGE_LIMIT) {
    await ctx.reply(combined, { ...options, reply_markup: alertKeyboard(jobId, hasAi, hasKit) });
  } else {
    await ctx.reply(detail.main, { ...options, reply_markup: alertKeyboard(jobId, hasAi, hasKit) });
    if (detail.evidence) await ctx.reply(detail.evidence, options);
  }
  return 'sent';
}

function detailFailureText(reason: DetailFailure): string {
  if (reason === 'no_alert') return 'I have no alert for that job in this chat.';
  if (reason === 'outdated') return 'Analysis is outdated. Try again later.';
  return 'No AI analysis is available for this job yet.';
}

const KIT_PLACEHOLDER = '✍️ Building your application kit. This takes up to 45 seconds.';

function kitFailureText(reason: KitFailure): string {
  if (reason === 'no_alert') return 'I have no alert for that job in this chat.';
  if (reason === 'ai_off') return 'Application kit needs AI on. Send /ai on.';
  if (reason === 'no_resume') {
    return 'Save your resume first with /resume. The kit uses it to avoid generic text.';
  }
  if (reason === 'cap') return 'Daily kit limit reached. Saved kits still open.';
  if (reason === 'unavailable') return 'Application kit is not available right now.';
  return 'Could not build the kit. Try again in a minute.';
}

/** Edits the placeholder into the kit, and sends a new message if the edit fails. */
async function sendKit(
  ctx: Context,
  chatId: number,
  jobId: number,
  placeholderId?: number,
): Promise<void> {
  let outcome: KitOutcome;
  try {
    outcome = await requestKit(chatId, jobId);
  } catch (err) {
    console.error('[kit] request failed:', (err as { code?: string }).code ?? (err as Error).name);
    outcome = { ok: false as const, reason: 'failed' as const };
  }
  const options = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

  if (!outcome.ok) {
    const text = kitFailureText(outcome.reason);
    if (placeholderId) {
      const edited = await ctx.api.editMessageText(chatId, placeholderId, text).catch(() => null);
      if (edited) return;
    }
    await ctx.reply(text);
    return;
  }

  const { parts, keyboard } = renderKit(outcome.kit, outcome.jobTitle, jobId);
  for (let i = 0; i < parts.length; i++) {
    const reply_markup = i === parts.length - 1 ? keyboard : undefined;
    if (i === 0 && placeholderId) {
      const edited = await ctx.api
        .editMessageText(chatId, placeholderId, parts[0], { ...options, reply_markup })
        .catch(() => null);
      if (edited) continue;
    }
    await ctx.reply(parts[i], { ...options, reply_markup });
  }
}

bot.command('job', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const jobId = Number((ctx.match ?? '').trim());
  if (!Number.isFinite(jobId) || jobId <= 0) {
    await ctx.reply('Usage: /job <jobId>');
    return;
  }
  const aiOn = await getAiEnabled(chatId);
  const result = await sendJobDetail(ctx, chatId, jobId, aiOn, aiOn && isKitEnabled());
  if (result !== 'sent') await ctx.reply(detailFailureText(result));
});

bot.callbackQuery(/^job:(\d+)$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  const jobId = Number(ctx.match[1]);
  if (!chatId) {
    await ctx.answerCallbackQuery({ text: 'Not available.' });
    return;
  }
  const aiOn = await getAiEnabled(chatId);
  const result = await sendJobDetail(ctx, chatId, jobId, aiOn, aiOn && isKitEnabled());
  await ctx.answerCallbackQuery(result === 'sent' ? undefined : { text: 'Not available.' });
});

bot.command('kit', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const jobId = Number((ctx.match ?? '').trim());
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    await ctx.reply('Usage: /kit <jobId>');
    return;
  }
  if (!isPrivateChat(ctx.chat?.type)) {
    await ctx.reply('DM the bot to use /kit.');
    return;
  }
  if (isKitBuilding(chatId, jobId)) {
    await ctx.reply('Still building…');
    return;
  }
  const placeholder = await ctx.reply(KIT_PLACEHOLDER);
  await sendKit(ctx, chatId, jobId, placeholder.message_id);
});

bot.callbackQuery(/^kit:(\d+)(?::(?:apply|msg|prep))?$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  const jobId = Number(ctx.match[1]);
  if (!chatId || !Number.isFinite(jobId)) {
    await ctx.answerCallbackQuery({ text: 'Not available.' });
    return;
  }
  if (!isPrivateChat(ctx.chat?.type)) {
    await ctx.answerCallbackQuery({ text: 'DM the bot to use /kit.' });
    return;
  }
  if (isKitBuilding(chatId, jobId)) {
    await ctx.answerCallbackQuery({ text: 'Still building…' });
    return;
  }
  await ctx.answerCallbackQuery({ text: 'Building your kit…' });
  const placeholder = await ctx.reply(KIT_PLACEHOLDER);
  await sendKit(ctx, chatId, jobId, placeholder.message_id);
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
  const resume = await getResumeState(chatId);
  lines.push(resumeStateText(resume?.resumeText ?? null, resume?.resumeUpdatedAt ?? null));
  lines.push('');
  lines.push(
    'Commands: /keywordadd · /keywordremove · /keywordsub · /job · /kit · /ai · /resume · /unsub · /help',
  );
  await ctx.reply(lines.join('\n'));
});

bot.command('unsub', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  await db.delete(userSubscriptions).where(eq(userSubscriptions.chatId, chatId));
  await ctx.reply('All your keywords were removed.');
});

/** Runs before the HELP fallback and stops the chain when it handles the paste. */
bot.on('message', async (ctx, next) => {
  const chatId = ctx.chat?.id;
  if (!chatId || !isResumePending(chatId)) return next();
  if (!ctx.message.text) {
    await ctx.reply('Send resume as text only.');
    return;
  }
  if (KNOWN_COMMAND.test(ctx.message.text)) return next();

  const checked = validateResume(ctx.message.text);
  if (!checked.ok) {
    await ctx.reply(
      `Resume must be ${RESUME_MIN}-${RESUME_MAX} characters. Yours is ${checked.length.toLocaleString('en-US')}. ` +
        'Paste a different version, or send /help to cancel.',
    );
    return;
  }

  const hash = resumeHash(checked.text);
  const state = await getResumeState(chatId);
  if (state && state.resumeHash === hash) {
    pendingResume.delete(chatId);
    const note = state.aiOverview
      ? ''
      : !isFitEnabled()
        ? '\n\nAI is off. Fit checks are disabled by the operator.'
        : '\n\nAI is off. Run /ai on to resume fit checks.';
    await ctx.reply(`Resume unchanged. Saved fit results kept.${note}`);
    return;
  }

  const wasAi = state?.aiOverview ?? false;
  // Saving a resume is the opt-in, even before a key is configured. The AI
  // worker no-ops until AI is available.
  const aiOn = true;
  try {
    await db.transaction(async (tx) => {
      await tx
        .insert(userSettings)
        .values({
          chatId,
          aiOverview: aiOn,
          resumeText: checked.text,
          resumeHash: hash,
          resumeUpdatedAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: userSettings.chatId,
          set: {
            aiOverview: aiOn,
            resumeText: checked.text,
            resumeHash: hash,
            resumeUpdatedAt: new Date(),
            updatedAt: new Date(),
          },
        });
      await tx.delete(jobFits).where(eq(jobFits.chatId, chatId));
      await tx.delete(jobKits).where(eq(jobKits.chatId, chatId));
    });
  } catch (err) {
    // The resume is a query parameter: log a code or name only.
    console.error(
      '[resume] save failed:',
      (err as { code?: string }).code ?? (err as Error).name ?? 'unknown',
    );
    await ctx.reply('Could not save your resume. Try again.');
    return;
  }

  pendingResume.delete(chatId);
  clearFitsForChat(chatId);
  clearKitsForChat(chatId);
  forgetFitWait(chatId);

  let reply =
    `Saved: ${checked.text.length.toLocaleString('en-US')}/${RESUME_MAX.toLocaleString('en-US')} chars.\n\n` +
    RESUME_PRIVACY_NOTE;
  if (!wasAi) {
    reply += `\n\n${aiOnNotice()}`;
  } else if (!isOverviewAvailable()) {
    reply += '\n\nAI is not configured, so fit checks are unavailable until it is.';
  }
  await ctx.reply(reply);
});

bot.on('message', (ctx) => {
  if (ctx.message.text?.startsWith('/')) return;
  ctx.reply(HELP);
});

export function startBot(): void {
  const run = async (): Promise<void> => {
    for (;;) {
      try {
        await bot.start({
          onStart: (info) => console.log(`[bot] polling as @${info.username}`),
        });
        return;
      } catch (err) {
        const code = (err as { error_code?: number }).error_code;
        const name = (err as { name?: string }).name ?? 'error';
        console.error(`[bot] polling failed (${code ?? name}); retrying in 5s`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  };
  void run();
}
