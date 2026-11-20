/**
 * Alert transport: employer banner generation, Telegram file_id cache, and the
 * text fallback. A banner is rendered once per employer, then reused by
 * file_id. This module never throws to the caller: a failed image degrades to
 * text, and a possible timeout never resends.
 */
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { GrammyError, InputFile } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { db } from './db';
import { employerBanners, jobPostings } from './schema';
import { isAllowedLogoUrl, stripHtml, visibleLength } from './utils';

/** Lazy so the renderer self-check runs without a bot token. */
async function telegramApi() {
  const { bot } = await import('./bot');
  return bot.api;
}

const BANNER_W = 1200;
const BANNER_H = 300;
const LOGO_TIMEOUT_MS = 5000;
const LOGO_MAX_BYTES = 5 * 1024 * 1024;
const BANNER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CAPTION_LIMIT = 1000;
const LOGO_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

export type AlertJob = Pick<
  typeof jobPostings.$inferSelect,
  'jobId' | 'employer' | 'employerId' | 'employerLogo'
>;

type Failure = 'invalid_file' | 'bad_request' | 'parse' | 'network' | 'blocked';

function describe(err: unknown): string {
  return err instanceof GrammyError ? err.description : String(err);
}

function failureOf(err: unknown): Failure {
  if (err instanceof GrammyError) {
    const text = err.description.toLowerCase();
    if (/file identifier|file reference|file is not valid|wrong file/.test(text)) {
      return 'invalid_file';
    }
    if (/parse entities|can't find end tag|unsupported start tag/.test(text)) return 'parse';
    if (/blocked|deactivated|chat not found|kicked/.test(text)) return 'blocked';
    return err.error_code === 400 ? 'bad_request' : 'network';
  }
  return 'network';
}

/** HTTPS-only OLJ logo fetch. Rejects redirects off the allowlist. */
async function fetchLogo(url: string): Promise<Buffer | null> {
  if (!isAllowedLogoUrl(url)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOGO_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': LOGO_USER_AGENT, Accept: 'image/*' },
    });
    if (!res.ok) return null;
    if (!isAllowedLogoUrl(res.url || url)) return null;
    if (!/^image\//i.test(res.headers.get('content-type') ?? '')) return null;
    if (Number(res.headers.get('content-length') ?? 0) > LOGO_MAX_BYTES) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.length > 0 && buffer.length <= LOGO_MAX_BYTES ? buffer : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 1200×300 banner: navy gradient, white logo card, employer name. */
export async function renderBanner(logo: Buffer, employer: string): Promise<Buffer> {
  const fitted = await sharp(logo, { limitInputPixels: 25_000_000 })
    .rotate()
    .resize(180, 180, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  const meta = await sharp(fitted).metadata();
  const left = 40 + Math.floor((240 - (meta.width ?? 180)) / 2);
  const top = 30 + Math.floor((240 - (meta.height ?? 180)) / 2);

  const name = employer.replace(/\s+/g, ' ').trim().slice(0, 24);
  const text = name
    ? [
        `<text x="320" y="146" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="64" font-weight="bold" fill="#ffffff">${escapeXml(name)}</text>`,
        '<rect x="322" y="155" width="160" height="3" fill="#38bdf8"/>',
        '<text x="322" y="198" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="28" fill="#94a3b8">NEW JOB MATCH</text>',
      ].join('\n')
    : '';

  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BANNER_W}" height="${BANNER_H}">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#0f172a"/>
          <stop offset="1" stop-color="#1e293b"/>
        </linearGradient>
      </defs>
      <rect width="${BANNER_W}" height="${BANNER_H}" fill="url(#bg)"/>
      <rect x="40" y="30" width="240" height="240" rx="32" fill="#ffffff"/>
      ${text}
    </svg>`,
  );

  return sharp(overlay)
    .composite([{ input: fitted, left, top }])
    .png()
    .toBuffer();
}

async function cachedBanner(employerId: number, logoUrl: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(employerBanners)
    .where(eq(employerBanners.employerId, employerId))
    .limit(1);
  if (!row || row.logoUrl !== logoUrl) return null;
  if (!row.updatedAt || Date.now() - new Date(row.updatedAt).getTime() > BANNER_TTL_MS) {
    return null;
  }
  return row.fileId;
}

async function storeBanner(
  employerId: number,
  logoUrl: string,
  fileId: string,
): Promise<void> {
  try {
    await db
      .insert(employerBanners)
      .values({ employerId, logoUrl, fileId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: employerBanners.employerId,
        set: { logoUrl, fileId, updatedAt: new Date() },
      });
  } catch (err) {
    // A cache write failure must not fail the alert.
    console.warn('[banner] cache write failed:', err);
  }
}

type PhotoResult =
  | { ok: true; fileId: string }
  | { ok: false; failure: Failure };

async function sendPhoto(
  chatId: number,
  photo: string | InputFile,
  caption: string,
  keyboard: InlineKeyboardMarkup,
): Promise<PhotoResult> {
  try {
    const message = await (await telegramApi()).sendPhoto(chatId, photo, {
      caption,
      parse_mode: 'HTML',
      reply_markup: keyboard,
      show_caption_above_media: false,
    });
    const sizes = message.photo ?? [];
    const fileId = sizes[sizes.length - 1]?.file_id ?? '';
    return fileId ? { ok: true, fileId } : { ok: false, failure: 'bad_request' };
  } catch (err) {
    const failure = failureOf(err);
    console.warn(`[banner] sendPhoto failed (${failure}): ${describe(err)}`);
    return { ok: false, failure };
  }
}

/** HTML message; one plain-text retry when Telegram rejects the entities. */
async function sendText(
  chatId: number,
  caption: string,
  keyboard: InlineKeyboardMarkup,
): Promise<Failure | null> {
  try {
    await (await telegramApi()).sendMessage(chatId, caption, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
    return null;
  } catch (err) {
    if (failureOf(err) !== 'parse') {
      console.error(`[banner] sendMessage failed: ${describe(err)}`);
      return failureOf(err);
    }
    console.warn(`[banner] entity parse failed, plain-text fallback: ${describe(err)}`);
    try {
      await (await telegramApi()).sendMessage(chatId, stripHtml(caption), {
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
      return null;
    } catch (plainErr) {
      console.error(`[banner] plain-text fallback failed: ${describe(plainErr)}`);
      return failureOf(plainErr);
    }
  }
}

/**
 * Send one alert. Cached banner first, then render+upload, then text.
 * `retry` is true only for a network failure: the alert is worth sending again.
 */
export type AlertSend = { ok: boolean; retry: boolean };

function outcome(failure: Failure | null): AlertSend {
  return { ok: failure === null, retry: failure === 'network' };
}

export async function sendAlert(
  chatId: number,
  caption: string,
  job: AlertJob,
  keyboard: InlineKeyboardMarkup,
): Promise<AlertSend> {
  const employerId = job.employerId;
  const logoUrl = job.employerLogo;

  if (!employerId || !logoUrl || visibleLength(caption) > CAPTION_LIMIT) {
    return outcome(await sendText(chatId, caption, keyboard));
  }

  const cached = await cachedBanner(employerId, logoUrl);
  if (cached) {
    const result = await sendPhoto(chatId, cached, caption, keyboard);
    if (result.ok) return { ok: true, retry: false };
    if (result.failure !== 'invalid_file') {
      return result.failure === 'bad_request'
        ? outcome(await sendText(chatId, caption, keyboard))
        : outcome(result.failure);
    }
    await db
      .delete(employerBanners)
      .where(eq(employerBanners.employerId, employerId))
      .catch((err) => console.warn('[banner] cache clear failed:', err));
  }

  const logo = await fetchLogo(logoUrl);
  if (!logo) {
    console.warn('[banner] logo fetch failed, text fallback');
    return outcome(await sendText(chatId, caption, keyboard));
  }

  let banner: Buffer;
  try {
    banner = await renderBanner(logo, job.employer ?? '');
  } catch (err) {
    console.warn('[banner] render failed, text fallback:', err);
    return outcome(await sendText(chatId, caption, keyboard));
  }

  const result = await sendPhoto(chatId, new InputFile(banner, 'banner.png'), caption, keyboard);
  if (result.ok) {
    await storeBanner(employerId, logoUrl, result.fileId);
    return { ok: true, retry: false };
  }
  if (result.failure === 'network') return outcome('network');
  return outcome(await sendText(chatId, caption, keyboard));
}

// ---------------------------------------------------------------------------
// Self-check. Run: npx tsx src/banner.ts
// ---------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    const logo = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#2563eb"/><circle cx="100" cy="100" r="60" fill="#fff"/></svg>',
    );
    const banner = await renderBanner(logo, 'Test Employer & Co');
    const meta = await sharp(banner).metadata();
    const logoOnly = await renderBanner(logo, '');
    const logoOnlyMeta = await sharp(logoOnly).metadata();
    const ok =
      meta.width === 1200 &&
      meta.height === 300 &&
      meta.format === 'png' &&
      logoOnlyMeta.width === 1200 &&
      logoOnlyMeta.height === 300;
    if (!ok) {
      console.error(`FAIL banner ${meta.width}x${meta.height} ${meta.format}`);
      process.exit(1);
    }
    // A dropped alert is retried only on a network failure.
    const sendChecks = [
      outcome(null).ok && !outcome(null).retry,
      !outcome('network').ok && outcome('network').retry,
      !outcome('blocked').ok && !outcome('blocked').retry,
      !outcome('bad_request').retry,
    ];
    if (sendChecks.includes(false)) {
      console.error('FAIL banner send outcome mapping');
      process.exit(1);
    }
    console.log('banner.ts self-check OK (1200x300 PNG)');
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
