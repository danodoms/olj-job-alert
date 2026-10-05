import { Bot } from 'grammy';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db';
import { userSubscriptions, notifications } from './schema';

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
  '/unsub — remove all keywords',
  '/help — show this message',
].join('\n');

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

bot.command('start', (ctx) => ctx.reply(HELP));
bot.command('help', (ctx) => ctx.reply(HELP));

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
  lines.push('Commands: /keywordadd · /keywordremove · /keywordsub · /unsub · /help');
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
