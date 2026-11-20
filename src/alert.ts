/**
 * Alert caption and inline keyboard. Pure rendering: no bot, no network.
 * The AI block comes from stored JSON, never from model HTML.
 */
import type { InlineKeyboardMarkup } from 'grammy/types';
import { formatPay, formatVerdict, verdictEmoji, type ParsedPay } from './pay';
import { BOTTOM_LABEL, LEGIT_EMOJI, type FinalAnalysis, type JobAnalysis } from './overview';
import type { PayInsight } from './signals';
import { jobPostings } from './schema';
import type { KeywordMatch } from './match';
import { defangUrls, escapeHtml, makeExcerpt, visibleLength } from './utils';

const AI_BLOCK_CAP = 700;
const CAPTION_BUDGET = 980;
const CAPTION_LIMIT = 1000;
const EXCERPT_MAX = 500;

function aiBlock(final: FinalAnalysis): string | null {
  const core = [
    '<b>Bottom line:</b> ' + BOTTOM_LABEL[final.bottom_line],
    `<b>Legit:</b> ${LEGIT_EMOJI[final.legit]} — ${escapeHtml(defangUrls(final.legit_reason))}`,
  ].join('\n');

  const optional: string[] = [];
  if (final.what) optional.push(`<b>What:</b> ${escapeHtml(defangUrls(final.what))}`);
  if (final.needs) optional.push(`<b>Needs:</b> ${escapeHtml(defangUrls(final.needs))}`);
  if (final.watch) optional.push(`<b>Watch:</b> ${escapeHtml(defangUrls(final.watch))}`);
  if (final.ask.length > 0) {
    optional.push(`<b>Ask:</b> ${escapeHtml(defangUrls(final.ask.join(' ')))}`);
  }

  const render = (lines: string[]) =>
    `<blockquote>🤖 <b>AI overview</b>\n${core}${lines.map((l) => `\n${l}`).join('')}</blockquote>`;

  let kept = optional;
  while (kept.length > 0 && visibleLength(render(kept)) > AI_BLOCK_CAP) {
    kept = kept.slice(0, -1);
  }
  return render(kept);
}

export function alertKeyboard(jobId: number, hasAi: boolean): InlineKeyboardMarkup {
  const keyboard: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        {
          text: '✅ Apply on OLJ',
          url: `https://www.onlinejobs.ph/jobseekers/job/${jobId}`,
        },
      ],
    ],
  };
  if (hasAi) {
    keyboard.inline_keyboard.push([
      { text: '🔍 Full check', callback_data: `job:${jobId}` },
      { text: '👍 Helpful', callback_data: `fb:helpful:${jobId}` },
      { text: '👎', callback_data: `fb:unhelpful:${jobId}` },
      { text: '🚩', callback_data: `fb:report:${jobId}` },
    ]);
  }
  return keyboard;
}

export type AlertCaption = { caption: string; hasAi: boolean };

export function parsedPayOf(job: typeof jobPostings.$inferSelect): ParsedPay {
  return {
    payMin: job.payMin,
    payMax: job.payMax,
    payCurrency: job.payCurrency,
    payPeriod: (job.payPeriod ?? 'unknown') as ParsedPay['payPeriod'],
    payUnitLabel: job.payUnitLabel,
    payUsdHour: job.payUsdHour,
    payUsdMonth: job.payUsdMonth,
    payConfidence: (job.payConfidence ?? 'none') as ParsedPay['payConfidence'],
  };
}

/** `20` becomes `20h/week`; free text like `10-20 hrs` is kept verbatim. */
export function hoursLabel(raw: string | null | undefined): string | null {
  const value = raw?.replace(/\s+/g, ' ').trim();
  if (!value) return null;
  return /^\d+$/.test(value) ? `${value}h/week` : value;
}

export function buildAlertCaption(
  job: typeof jobPostings.$inferSelect,
  insight: PayInsight | null,
  matches: KeywordMatch[],
  analysis: JobAnalysis | null,
): AlertCaption {
  const parsed = parsedPayOf(job);

  const onlyPossible =
    matches.length > 0 && matches.every((m) => m.strength === 'possible');
  const headline = onlyPossible ? '🔎 <b>Possible match</b>' : '🔔 <b>New job match</b>';

  const meta = [job.employer, job.typeOfWork, hoursLabel(job.hoursPerWeek)]
    .map((part) => part?.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' · ');

  const head: string[] = [headline, '', `<b>${escapeHtml(job.jobTitle ?? '')}</b>`];
  if (meta) head.push(`<i>${escapeHtml(meta)}</i>`);

  const tail: string[] = ['', `💰 <b>${escapeHtml(formatPay(parsed))}</b>`];
  const verdict = insight ? formatVerdict(insight.verdict) : null;
  if (insight && verdict) {
    const emoji = verdictEmoji(insight.verdict) ?? '';
    tail.push(
      `📊 <b>Market:</b> ${emoji} ${escapeHtml(verdict)} · vs ${escapeHtml(insight.peerLabel)}`,
    );
  }

  const block = analysis ? aiBlock(analysis.final) : null;
  if (block) tail.push('', block);

  const room = CAPTION_BUDGET - visibleLength([...head, ...tail].join('\n'));
  const excerpt = makeExcerpt(
    job.jobDescription ?? '',
    Math.min(EXCERPT_MAX, room),
    job.jobTitle ?? undefined,
  );

  const assemble = (text: string | null): string =>
    [
      ...head,
      ...(text ? ['', `📝 <i>“${escapeHtml(defangUrls(text))}”</i>`] : []),
      ...tail,
    ].join('\n');

  let caption = assemble(excerpt);
  if (excerpt && visibleLength(caption) > CAPTION_LIMIT) caption = assemble(null);

  return { caption, hasAi: Boolean(block) };
}

// ---------------------------------------------------------------------------
// Self-check. Run: npx tsx src/alert.ts
// ---------------------------------------------------------------------------
if (require.main === module) {
  let failed = 0;
  const check = (label: string, ok: boolean) => {
    if (!ok) {
      failed++;
      console.error(`FAIL ${label}`);
    }
  };

  const final: FinalAnalysis = {
    bottom_line: 'apply',
    legit: 'likely',
    legit_reason: 'OLJ paid active, 3 posts, no complaints.',
    what: 'Remote Amazon launch specialist for a Dutch supplement brand. '.repeat(4),
    needs: '3+ yrs Amazon, EU marketplaces, PPC. '.repeat(4),
    watch: 'Pay 2.3x median; no leave stated. '.repeat(4),
    ask: ['Is it full-time by month 3?', 'Who owns Seller Central?'],
    risk_signals: [],
    gaps: [],
    confidence: 'medium',
  };
  const analysis = {
    version: 2,
    main: final,
    escalation: null,
    escalated: false,
    final,
    signals: {},
    employer: null,
    pay: {},
  } as unknown as JobAnalysis;

  const job = {
    jobId: 123456,
    jobTitle: 'Amazon Launch & Growth Specialist',
    jobDescription:
      'We are a fast-growing e-commerce brand in health & nutrition, selling meal replacement shakes in the Netherlands, Belgium, Germany and the UK. We run two brands and sell through our own Shopify stores. We are not on Amazon yet. '.repeat(
        2,
      ),
    employer: 'Shakeplus',
    employerId: 42,
    employerLogo: 'https://cdn.onlinejobs.ph/logo.png',
    typeOfWork: 'Part Time',
    hoursPerWeek: '20',
    payMin: 6,
    payMax: 10,
    payCurrency: 'USD',
    payPeriod: 'hour',
    payUnitLabel: null,
    payUsdHour: 6,
    payUsdMonth: null,
    payConfidence: 'high',
  } as unknown as typeof jobPostings.$inferSelect;

  const insight: PayInsight = {
    verdict: 'high',
    peerLabel: 'Part Time hourly jobs',
    value: 6,
    outlier: null,
  };
  const matches: KeywordMatch[] = [
    { keyword: 'amazon', fields: ['title'], strength: 'strong' },
  ];

  const withAi = buildAlertCaption(job, insight, matches, analysis);
  check('caption has blockquote', withAi.caption.includes('<blockquote>'));
  check('caption closes blockquote', withAi.caption.includes('</blockquote>'));
  check('caption under limit', visibleLength(withAi.caption) <= CAPTION_LIMIT);
  check('caption keeps apply pay', withAi.caption.includes('💰'));
  check('hasAi reported', withAi.hasAi);
  const start = withAi.caption.indexOf('<blockquote>');
  const end = withAi.caption.indexOf('</blockquote>') + '</blockquote>'.length;
  check('ai block under 700', visibleLength(withAi.caption.slice(start, end)) <= AI_BLOCK_CAP);
  check('ai keeps bottom line', withAi.caption.includes('<b>Bottom line:</b>'));
  check('ai keeps legit', withAi.caption.includes('<b>Legit:</b>'));

  const noAi = buildAlertCaption(job, insight, matches, null);
  check('no blockquote without ai', !noAi.caption.includes('<blockquote>'));
  check('no force ai flag', !noAi.hasAi);

  const withUrl = buildAlertCaption(
    job,
    insight,
    matches,
    { ...analysis, final: { ...final, what: 'Apply at https://evil.example/scam' } } as JobAnalysis,
  );
  check('ai urls defanged', !withUrl.caption.includes('https://evil'));

  const aiKeyboard = alertKeyboard(123456, true);
  check('apply button row first', aiKeyboard.inline_keyboard[0][0].text === '✅ Apply on OLJ');
  check(
    'callbacks exact',
    JSON.stringify(
      aiKeyboard.inline_keyboard[1].map((b) => ('callback_data' in b ? b.callback_data : null)),
    ) ===
      JSON.stringify(['job:123456', 'fb:helpful:123456', 'fb:unhelpful:123456', 'fb:report:123456']),
  );
  check('no ai buttons without ai', alertKeyboard(123456, false).inline_keyboard.length === 1);

  if (failed === 0) console.log('alert.ts self-check OK');
  else process.exit(1);
}
