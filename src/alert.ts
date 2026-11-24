/**
 * Alert caption and inline keyboard. Pure rendering: no bot, no network.
 * The AI block comes from stored JSON, never from model HTML.
 */
import type { InlineKeyboardMarkup } from 'grammy/types';
import { formatPay, formatVerdict, verdictEmoji, type ParsedPay } from './pay';
import {
  BOTTOM_LABEL,
  LEGIT_EMOJI,
  fitLabel,
  type FinalAnalysis,
  type FitAnalysis,
  type JobAnalysis,
} from './overview';
import type { PayInsight } from './signals';
import { jobPostings } from './schema';
import type { KeywordMatch } from './match';
import { REPOST_VERSION, repostAlertLine } from './reposts';
import { defangUrls, escapeHtml, makeExcerpt, visibleLength } from './utils';

const AI_BLOCK_CAP = 700;
/** Overview must leave room for the fit block, so it shrinks when a fit is shown. */
const AI_BLOCK_WITH_FIT_CAP = 460;
const FIT_BLOCK_CAP = 240;
/** Largest plain-text strength or gap line; keeps two entries inside the fit cap. */
const FIT_LINE_MAX = 100;
const CAPTION_BUDGET = 980;
const CAPTION_LIMIT = 1000;
const EXCERPT_MAX = 500;

/** Kept separate from the score so a long fit is trimmed before the score line. */
function fitLines(fit: FitAnalysis, strengthsCount: number, gapsCount: number): string[] {
  const head =
    fit.score === null
      ? '🎯 Resume fit: not enough info'
      : `🎯 Resume fit: ${fit.score}/10 ${fitLabel(fit.score)}`;
  const lines = [head];
  const strengths = fit.strengths.slice(0, strengthsCount).map((s) => s.slice(0, FIT_LINE_MAX));
  const gaps = fit.gaps.slice(0, gapsCount).map((g) => g.slice(0, FIT_LINE_MAX));
  if (strengths.length > 0) lines.push(`+ ${strengths.join(', ')}`);
  if (gaps.length > 0) lines.push(`- ${gaps.join(', ')}`);
  return lines;
}

function fitBlock(fit: FitAnalysis): string {
  const fits = (counts: [number, number]) =>
    visibleLength(fitLines(fit, counts[0], counts[1]).join('\n')) <= FIT_BLOCK_CAP;
  const counts: [number, number] = fits([2, 2]) ? [2, 2] : fits([2, 1]) ? [2, 1] : fits([1, 1]) ? [1, 1] : [0, 0];
  const lines = fitLines(fit, counts[0], counts[1]);
  return [
    `<b>${escapeHtml(lines[0])}</b>`,
    ...lines.slice(1).map((line) => escapeHtml(defangUrls(line))),
  ].join('\n');
}

function aiBlock(final: FinalAnalysis, fit: FitAnalysis | null): string | null {
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

  const cap = fit ? AI_BLOCK_WITH_FIT_CAP : AI_BLOCK_CAP;
  let kept = optional;
  while (kept.length > 0 && visibleLength(render(kept)) > cap) {
    kept = kept.slice(0, -1);
  }
  const overview = render(kept);
  return fit ? `${overview}\n${fitBlock(fit)}` : overview;
}

export function alertKeyboard(jobId: number, hasAi: boolean, hasKit = false): InlineKeyboardMarkup {
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
  const actions: InlineKeyboardMarkup['inline_keyboard'][number] = [];
  if (hasAi) actions.push({ text: '🔍 Full check', callback_data: `job:${jobId}` });
  if (hasKit) actions.push({ text: '✍️ Kit', callback_data: `kit:${jobId}` });
  if (actions.length > 0) keyboard.inline_keyboard.push(actions);
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
  const repost = repostAlertLine(job);
  if (repost) tail.push(repost);

  const block = analysis ? aiBlock(analysis.final, analysis.fit ?? null) : null;
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

  const aiKeyboard = alertKeyboard(123456, true, true);
  check('apply button row first', aiKeyboard.inline_keyboard[0][0].text === '✅ Apply on OLJ');
  check(
    'callbacks exact',
    JSON.stringify(
      aiKeyboard.inline_keyboard[1].map((b) => ('callback_data' in b ? b.callback_data : null)),
    ) === JSON.stringify(['job:123456', 'kit:123456']),
  );
  check('no feedback buttons', !JSON.stringify(aiKeyboard).includes('fb:'));
  check('no ai buttons without ai', alertKeyboard(123456, false).inline_keyboard.length === 1);
  check('kit hidden without kit', alertKeyboard(123456, true).inline_keyboard[1].length === 1);

  const fitAnalysis = {
    ...analysis,
    fit: {
      score: 8,
      strengths: ['5 yrs React', 'E-commerce dashboards'],
      gaps: ['No Amazon', 'No PPC'],
      note: 'Strong match.',
    },
  } as JobAnalysis;
  const withFit = buildAlertCaption(job, insight, matches, fitAnalysis);
  const fitPart = withFit.caption.slice(withFit.caption.indexOf('🎯 Resume fit'));
  check('fit renders score and label', withFit.caption.includes('8/10 Strong'));
  check('fit renders strengths', withFit.caption.includes('+ 5 yrs React'));
  check('fit renders gaps', withFit.caption.includes('- No Amazon'));
  check('fit block under 240', visibleLength(fitPart) <= FIT_BLOCK_CAP);
  check('fit caption under limit', visibleLength(withFit.caption) <= CAPTION_LIMIT);
  const overviewPart = withFit.caption.slice(
    withFit.caption.indexOf('<blockquote>'),
    withFit.caption.indexOf('</blockquote>') + '</blockquote>'.length,
  );
  check('overview shrinks for fit', visibleLength(overviewPart) <= AI_BLOCK_WITH_FIT_CAP);

  const noInfo = buildAlertCaption(
    job,
    insight,
    matches,
    { ...analysis, fit: { score: null, strengths: [], gaps: [], note: 'Thin listing.' } } as JobAnalysis,
  );
  check('null score renders no-info line', noInfo.caption.includes('Resume fit: not enough info'));

  const longFit = buildAlertCaption(
    job,
    insight,
    matches,
    {
      ...analysis,
      fit: {
        score: 6,
        strengths: ['s'.repeat(160), 't'.repeat(160)],
        gaps: ['g'.repeat(160), 'h'.repeat(160)],
        note: '',
      },
    } as JobAnalysis,
  );
  const longFitPart = longFit.caption.slice(longFit.caption.indexOf('🎯 Resume fit'));
  check('long fit stays under 240', visibleLength(longFitPart) <= FIT_BLOCK_CAP);
  check('long fit keeps the score line', longFitPart.startsWith('🎯 Resume fit: 6/10 Partial'));
  check('long fit caption under limit', visibleLength(longFit.caption) <= CAPTION_LIMIT);
  check('no fit block without fit', !withAi.caption.includes('Resume fit'));

  // Repost line: after Market, inside the caption budget, hidden when stale.
  process.env.REPOST_WATCH_ENABLED = 'true';
  delete process.env.REPOST_RENDER;
  const repostJob = {
    ...job,
    repostVersion: REPOST_VERSION,
    repostCount: 2,
    repostFirstSeen: new Date('2026-06-03T10:00:00Z'),
    repostDiff: { changes: [], confidence: null, pay: '$5 → $4/hr' },
    repostIds: [1, 2],
  } as unknown as typeof jobPostings.$inferSelect;
  const withRepost = buildAlertCaption(repostJob, insight, matches, null);
  check('repost line renders', withRepost.caption.includes('2 similar posts since Jun 3'));
  check('repost line keeps the caption under limit', visibleLength(withRepost.caption) <= CAPTION_LIMIT);
  check(
    'repost line sits after market',
    withRepost.caption.indexOf('📊') < withRepost.caption.indexOf('♻️'),
  );
  const stalePolicy = buildAlertCaption(
    { ...repostJob, repostVersion: REPOST_VERSION + 1 } as typeof jobPostings.$inferSelect,
    insight,
    matches,
    null,
  );
  check('stale repost line hidden', !stalePolicy.caption.includes('♻️'));
  process.env.REPOST_WATCH_ENABLED = 'false';

  if (failed === 0) console.log('alert.ts self-check OK');
  else process.exit(1);
}
