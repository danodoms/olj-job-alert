/**
 * Render one sample banner and send it to a chat.
 * Usage: TELEGRAM_CHAT_ID=<id> npm run preview:banner -- "Employer Name"
 */
import 'dotenv/config';
import sharp from 'sharp';
import { InputFile } from 'grammy';
import { bot } from '../bot';
import { renderBanner } from '../banner';

async function main(): Promise<void> {
  const chatId = Number(process.env.TELEGRAM_CHAT_ID);
  if (!Number.isFinite(chatId) || chatId === 0) {
    console.error('Set TELEGRAM_CHAT_ID to the chat that should receive the preview.');
    process.exit(1);
  }

  const employer = process.argv[2]?.trim() || 'Sample Employer';
  const logo = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="#2563eb"/><circle cx="120" cy="120" r="72" fill="#fff"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  const banner = await renderBanner(logo, employer);

  await bot.api.sendPhoto(chatId, new InputFile(banner, 'banner.png'), {
    caption: `<b>Banner preview</b>\n${employer}`,
    parse_mode: 'HTML',
    show_caption_above_media: false,
  });
  console.log(`sent preview to ${chatId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
