import { Bot } from 'grammy';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { userSubscriptions } from './schema';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');

export const bot = new Bot(token);

const HELP = [
  'OLJAlerts — job alerts on Telegram',
  '',
  'Commands:',
  '/keywordsub <k1, k2, k3> — set your keywords (max 3)',
  '/unsub — remove all your keywords',
  '/help — show this message',
].join('\n');

bot.command('start', (ctx) => ctx.reply(HELP));
bot.command('help', (ctx) => ctx.reply(HELP));

bot.command('keywordsub', async (ctx) => {
  const raw = ctx.match ?? '';
  const keywords = raw
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(keywords)];

  if (unique.length === 0) {
    await ctx.reply('Usage: /keywordsub keyword1, keyword2, keyword3');
    return;
  }
  if (unique.length > 3) {
    await ctx.reply('Maximum 3 keywords allowed.');
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  await db.delete(userSubscriptions).where(eq(userSubscriptions.chatId, chatId));
  for (const keyword of unique) {
    await db
      .insert(userSubscriptions)
      .values({ chatId, keyword })
      .onConflictDoNothing();
  }
  await ctx.reply(`Subscription updated. You will be alerted for:\n• ${unique.join('\n• ')}`);
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