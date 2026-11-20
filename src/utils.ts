export const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(input: string): string {
  return input.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
    (match, dec?: string, hex?: string, name?: string) => {
      if (dec) {
        const code = Number(dec);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      if (hex) {
        const code = parseInt(hex, 16);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      return ENTITIES[name?.toLowerCase() ?? ''] ?? match;
    },
  );
}

/** Strip tags, decode entities, collapse whitespace. */
export function stripHtml(input: string): string {
  return decodeEntities(
    input
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Characters Telegram renders: tags gone, entities decoded. Emoji count as two. */
export function visibleLength(html: string): number {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).length;
}

const URL_TOKEN = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const DOMAIN_TOKEN =
  /\b(?:[a-z0-9-]+\.)+(?:com|net|org|ph|io|co|uk|de|nl|be|ng|info|biz|xyz|online|site|app|dev|me)\b/gi;

/** Break clickable links: hxxps:// and [.] in hostnames. */
export function defangUrls(text: string): string {
  return text
    .replace(URL_TOKEN, (url) => url.replace(/^http/i, 'hxxp').replace(/\./g, '[.]'))
    .replace(DOMAIN_TOKEN, (domain) => domain.replace(/\./g, '[.]'));
}

const LOGO_HOST = /(^|\.)onlinejobs\.ph$/i;

function isPrivateHost(host: string): boolean {
  if (/^\[?::1\]?$/.test(host)) return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Only https OLJ media is a valid logo source. Blocks SSRF pivots. */
export function isAllowedLogoUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return false;
    if (!LOGO_HOST.test(url.hostname)) return false;
    return !isPrivateHost(url.hostname);
  } catch {
    return false;
  }
}

const CONTACT_URL = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const CONTACT_EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;
// ponytail: digit-run heuristic; upgrade to a lib if false positives show up.
const CONTACT_PHONE = /\+?\d[\d\s().-]{7,}\d/g;
const PLACEHOLDER = /(?:-{3,}|_{3,}|\*{3,})/g;
const EXCERPT_MIN = 120;

/** Description text safe to quote: no HTML, links, emails, phones, placeholders. */
export function cleanPostText(raw: string): string {
  return stripHtml(raw)
    .replace(CONTACT_URL, '[contact removed]')
    .replace(CONTACT_EMAIL, '[contact removed]')
    .replace(CONTACT_PHONE, (phone) =>
      phone.replace(/\D/g, '').length >= 8 ? '[contact removed]' : phone,
    )
    .replace(PLACEHOLDER, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cutAtBoundary(text: string, max: number): string {
  const slice = text.slice(0, max);
  const sentence = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
  );
  if (sentence + 1 >= EXCERPT_MIN) return slice.slice(0, sentence + 1).trim();
  const word = slice.lastIndexOf(' ');
  if (word + 1 >= EXCERPT_MIN) return slice.slice(0, word).trim();
  return Array.from(text).slice(0, max - 1).join('').trim();
}

/**
 * Verbatim post excerpt. Sentence boundary first, then word boundary.
 * Returns null when the budget or the source is too short.
 */
export function makeExcerpt(raw: string, limit: number, jobTitle?: string): string | null {
  if (limit < EXCERPT_MIN) return null;
  let text = cleanPostText(raw);
  const title = (jobTitle ?? '').replace(/\s+/g, ' ').trim();
  if (title && text.toLowerCase().startsWith(`${title.toLowerCase()} `)) {
    text = text.slice(title.length + 1).trim();
  }
  if (text.length < EXCERPT_MIN) return null;
  if (text.length <= limit) return text;
  return `${cutAtBoundary(text, limit)}…`;
}

// ---------------------------------------------------------------------------
// Self-check. Run: npx tsx src/utils.ts
// ---------------------------------------------------------------------------
if (require.main === module) {
  let failed = 0;
  const check = (label: string, ok: boolean) => {
    if (!ok) {
      failed++;
      console.error(`FAIL ${label}`);
    }
  };

  check('visibleLength strips tags and decodes', visibleLength('<b>a &amp; b</b>') === 5);
  check('visibleLength counts emoji as two', visibleLength('👍') === 2);
  check('stripHtml decodes nbsp', stripHtml('<p>a&nbsp;&amp;&nbsp;b</p>') === 'a & b');
  check(
    'defang full url',
    defangUrls('See https://amazon.com/x now') === 'See hxxps://amazon[.]com/x now',
  );
  check('defang bare domain', defangUrls('visit amazon.com') === 'visit amazon[.]com');
  check('rejects non-OLJ logo', !isAllowedLogoUrl('https://evil.example/logo.png'));
  check('rejects http logo', !isAllowedLogoUrl('http://www.onlinejobs.ph/logo.png'));
  check('accepts OLJ logo', isAllowedLogoUrl('https://cdn.onlinejobs.ph/media/logo.png'));

  const long = 'We are hiring a specialist. '.repeat(20);
  const excerpt = makeExcerpt(long, 500);
  check('excerpt is capped', (excerpt?.length ?? 0) <= 501);
  check('excerpt ends at a boundary', Boolean(excerpt?.endsWith('…')));
  check('short text omitted', makeExcerpt('Too short.', 500) === null);
  check('small budget omitted', makeExcerpt(long, 100) === null);

  const contact = makeExcerpt(
    'We are hiring now. Contact hr@example.com or https://example.com or 0917 123 4567 today. '.repeat(3),
    500,
  );
  check('contacts redacted', Boolean(contact?.includes('[contact removed]')));
  check('no email left', !contact?.includes('@'));
  check('no link left', !contact?.includes('http'));

  const titled = makeExcerpt(
    `Senior Dev ${'We build tools for teams. '.repeat(10)}`,
    800,
    'Senior Dev',
  );
  check('duplicate title skipped', Boolean(titled?.startsWith('We build')));

  if (failed === 0) console.log('utils.ts self-check OK');
  else process.exit(1);
}
