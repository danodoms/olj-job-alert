/**
 * Deterministic pre-model signals: hard flags, soft signals, gaps, duplicate
 * descriptions, email/domain checks and description shape.
 *
 * Hard flags are narrow and negation-aware. Ambiguous text becomes a soft
 * signal for the model, never a hard verdict.
 */
import { createHash } from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from './db';
import { jobPostings } from './schema';
import {
  payOutlierFromPool,
  verdictFromPool,
  type ParsedPay,
  type PayOutlier,
  type PayVerdict,
} from './pay';
import type { EmployerSummary } from './employer-check';

export type RiskCategory =
  | 'fee'
  | 'payment'
  | 'identity'
  | 'contact'
  | 'pay'
  | 'mismatch'
  | 'employer'
  | 'other';

export type RiskSignal = {
  category: RiskCategory;
  quote: string;
  level: 'risk' | 'caution';
  reason: string;
};

export type SoftSignal = {
  category: RiskCategory;
  quote: string;
};

export type DuplicateInfo = {
  sameEmployer: boolean;
  otherEmployer: boolean;
};

export type PayContext = {
  raw: string;
  usdHour: number | null;
  usdMonth: number | null;
  peerLabel: string;
  median: number | null;
  p95: number | null;
  ratio: number | null;
  extreme: boolean;
};

export type DeterministicSignals = {
  hardRisk: RiskSignal[];
  hardCaution: RiskSignal[];
  soft: SoftSignal[];
  gaps: string[];
  watchNotes: string[];
  forceUnclear: boolean;
  descriptionHash: string;
  duplicate: DuplicateInfo;
  email: { redacted: string | null; free: boolean; domainMismatch: boolean };
  links: string[];
  titleMismatch: boolean;
  brief: boolean;
};

export type PayInsight = {
  verdict: PayVerdict;
  peerLabel: string;
  value: number;
  outlier: PayOutlier | null;
};

const VERDICT_SAMPLE_FLOOR = 15;
const FREE_EMAIL = /@(?:gmail|yahoo|outlook|hotmail|proton)(?:\.[a-z.]+)?$/i;
const MESSAGING_ONLY =
  /\b(?:contact|message|apply)\b[^.\n]{0,30}\b(?:only|via)\b[^.\n]{0,20}\b(?:whatsapp|telegram|skype)\b|\b(?:whatsapp|telegram|skype)[- ]only\b/i;
const NEGATION = /\b(?:no|not|never|without|none|free)\b[^.\n]{0,25}$|n't\b[^.\n]{0,15}$/i;
const SHORT_LINK = /\b(?:bit\.ly|tinyurl\.com|t\.me|wa\.me)\//i;

const ROLE_NOUNS = [
  'virtual assistant',
  'video editor',
  'media buyer',
  'customer support',
  'technical support',
  'software developer',
  'web developer',
  'frontend developer',
  'backend developer',
  'full stack developer',
  'developer',
  'engineer',
  'designer',
  'writer',
  'editor',
  'marketer',
  'manager',
  'assistant',
  'bookkeeper',
  'accountant',
  'recruiter',
  'seo',
  'sales',
  'support',
  'teacher',
  'tutor',
  'va',
];

function affirmed(text: string, pattern: RegExp): string | null {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    const before = text.slice(Math.max(0, start - 70), start);
    if (NEGATION.test(before)) continue;
    return match[0].slice(0, 160);
  }
  return null;
}

/** Lowercase, strip punctuation, collapse whitespace, then SHA-256 the first 4000 chars. */
export function hashDescription(description: string): string {
  const normalized = (description ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
  return createHash('sha256').update(normalized).digest('hex');
}

export function redactEmails(text: string): string {
  return text.replace(
    /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi,
    (_match, domain: string) => `***@${domain}`,
  );
}

function extractEmail(text: string): { address: string | null; free: boolean } {
  const match = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  if (!match) return { address: null, free: false };
  return { address: match[0], free: FREE_EMAIL.test(match[0]) };
}

function extractLinks(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>()]+|(?:bit\.ly|tinyurl\.com|t\.me|wa\.me)\/[^\s<>()]+/gi) ?? [];
  return [...new Set(matches.map((l) => l.replace(/[.,;:]+$/, '')))].slice(0, 10);
}

function domainMismatch(email: string | null, employer: string): boolean {
  if (!email) return false;
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (!domain || FREE_EMAIL.test(email)) return false;
  const root = domain.split('.').slice(0, -1).join('');
  const company = employer.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!root || !company) return false;
  return !root.includes(company) && !company.includes(root);
}

function rolesIn(text: string): string[] {
  const lower = text.toLowerCase();
  return [
    ...new Set(
      ROLE_NOUNS.filter((role) =>
        new RegExp(`\\b${role.replace(/ /g, '\\s+')}\\b`, 'i').test(lower),
      ).map((role) => (role === 'va' ? 'virtual assistant' : role)),
    ),
  ];
}

function titleMismatch(title: string, description: string): boolean {
  const titleRoles = rolesIn(title);
  const descRoles = rolesIn(description);
  if (titleRoles.length === 0 || descRoles.length === 0) return false;
  return !titleRoles.some((role) => descRoles.includes(role));
}

function textFlags(description: string): { hard: RiskSignal[]; soft: SoftSignal[] } {
  const hard: RiskSignal[] = [];
  const soft: SoftSignal[] = [];

  const addHard = (category: RiskCategory, quote: string, reason: string) => {
    if (!hard.some((s) => s.quote === quote)) hard.push({ category, quote, level: 'risk', reason });
  };

  const fee = affirmed(
    description,
    /\b(?:pay|send|requires?|charge|collect|ask(?:ing)? for)\b[^.\n]{0,40}\b(?:fee|deposit)\b|\b(?:training|equipment|registration|application)\s+fee\b/i,
  );
  if (fee) addHard('fee', fee, 'Upfront fee or deposit requested.');

  const crypto = affirmed(
    description,
    /\b(?:salary|payment|paid|compensation)\b[^.\n]{0,30}\b(?:crypto|usdt|bitcoin|btc|ethereum|eth)\b|\b(?:crypto|usdt)\b[^.\n]{0,20}\b(?:salary|payment|paid)\b/i,
  );
  if (crypto) addHard('payment', crypto, 'Crypto or USDT payment.');

  const identity = affirmed(
    description,
    /\b(?:send|provide|submit|share)\b[^.\n]{0,30}\b(?:bank details|bank account|passport|valid id|government id|id documents?)\b/i,
  );
  if (identity) addHard('identity', identity, 'Identity or bank documents requested.');

  const scheme = affirmed(
    description,
    /\b(?:gift card|wire transfer|money order|overpayment)\b/i,
  );
  if (scheme) addHard('payment', scheme, 'Gift card, wire, or overpayment scheme.');

  // Buying your own laptop, or the employer paying for it, is normal. Only flag
  // money that goes to the employer, or buying the employer's own package.
  const equipment = affirmed(
    description,
    /\b(?:equipment|laptop|computer|software)\s+(?:fee|deposit)\b|\b(?:pay|send|deposit|reimburse)\b[^.\n]{0,20}\b(?:us|our (?:company|store|supplier))\b[^.\n]{0,20}\$\s?\d[\d,]*|\b(?:pay|send|deposit|reimburse)\b[^.\n]{0,20}\$\s?\d[\d,]*[^.\n]{0,40}\b(?:to|into)\s+(?:us|our (?:company|store|supplier))\b|\b(?:buy|purchase|pay for)\b[^.\n]{0,40}\b(?:(?:the|our|their) company(?:'s)?\s+(?:software|equipment|laptop|computer|package|kit)|from (?:us|our (?:company|store|supplier)))\b/i,
  );
  if (equipment) addHard('fee', equipment, 'Equipment payment requested.');

  const ambiguousFee = affirmed(
    description,
    /\b(?:application|registration|processing|training|equipment)\s+fee\b/i,
  );
  if (ambiguousFee && !hard.some((s) => s.category === 'fee')) {
    soft.push({ category: 'fee', quote: ambiguousFee });
  }

  return { hard, soft };
}

function descriptionShape(
  description: string,
  compensation: string,
  hoursPerWeek: string,
): { gaps: string[]; brief: boolean } {
  const text = description ?? '';
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const gaps: string[] = [];
  if (!/requirements?|qualifications?|what you(?:'|’)ll need|skills? (?:required|needed)|must have/i.test(text)) {
    gaps.push('No requirements section');
  }
  if (!/about (?:us|the company|our company)|who we are|company overview/i.test(text)) {
    gaps.push('No company or about section');
  }
  if (!compensation || !/\d/.test(compensation)) gaps.push('No pay amount or period');
  if (
    !/full[- ]?time|part[- ]?time|contract(?:or)?|freelance|time ?zone|hours per week|\b\d+\s*(?:hrs|hours)\b/i.test(
      `${text} ${hoursPerWeek}`,
    )
  ) {
    gaps.push('No contract type or timezone');
  }
  return { gaps, brief: wordCount > 0 && wordCount < 120 };
}

export async function findDuplicate(
  hash: string,
  employerId: number | null,
  excludeJobId: number,
): Promise<DuplicateInfo> {
  if (!hash) return { sameEmployer: false, otherEmployer: false };
  const rows = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE employer_id IS DISTINCT FROM ${employerId})::int AS other,
      count(*) FILTER (WHERE employer_id IS NOT DISTINCT FROM ${employerId})::int AS same
    FROM job_postings
    WHERE description_hash = ${hash}
      AND job_id <> ${excludeJobId}
      AND created_at > now() - interval '90 days'
  `);
  const row = rows.rows[0] as { other?: number; same?: number } | undefined;
  return { sameEmployer: Number(row?.same ?? 0) > 0, otherEmployer: Number(row?.other ?? 0) > 0 };
}

/** Pure signal computation; duplicate data is passed in by the DB caller. */
export function computeSignals(
  job: {
    jobTitle: string | null;
    jobDescription: string | null;
    compensation: string | null;
    hoursPerWeek: string | null;
    employer: string | null;
  },
  pay: PayContext,
  employer: EmployerSummary | null,
  duplicate: DuplicateInfo,
): DeterministicSignals {
  const description = job.jobDescription ?? '';
  const { hard, soft } = textFlags(description);
  const hardRisk = [...hard];
  const hardCaution: RiskSignal[] = [];
  const watchNotes: string[] = [];
  const email = extractEmail(description);
  const links = extractLinks(description);
  const messaging = description.match(MESSAGING_ONLY);
  const { gaps, brief } = descriptionShape(
    description,
    job.compensation ?? '',
    job.hoursPerWeek ?? '',
  );

  if (messaging) soft.push({ category: 'contact', quote: messaging[0].slice(0, 160) });
  if (email.address) {
    if (email.free && messaging) {
      hardRisk.push({
        category: 'contact',
        quote: messaging[0].slice(0, 160),
        level: 'risk',
        reason: 'Free email plus messaging-app-only contact.',
      });
    }
    if (domainMismatch(email.address, job.employer ?? '')) {
      soft.push({ category: 'contact', quote: `Email domain does not match employer name (***@${email.address.split('@')[1]})` });
    }
  }
  for (const link of links) {
    if (SHORT_LINK.test(link)) soft.push({ category: 'contact', quote: link.slice(0, 160) });
  }

  if (pay.extreme && pay.median !== null) {
    const quote = `Pay is ${pay.ratio ?? 'far'}× the median for ${pay.peerLabel}; verify scope and contract terms.`;
    hardCaution.push({ category: 'pay', quote, level: 'caution', reason: 'Pay is above p95 and at least 2× the peer median.' });
  }
  if (pay.extreme && !job.employer) {
    hardCaution.push({
      category: 'employer',
      quote: 'No company name and pay above the peer market.',
      level: 'caution',
      reason: 'No employer name plus extreme pay.',
    });
  }
  if (duplicate.otherEmployer) {
    hardCaution.push({
      category: 'mismatch',
      quote: 'Same description posted by a different employer in the last 90 days.',
      level: 'caution',
      reason: 'Duplicate description across employers.',
    });
  }
  if (duplicate.sameEmployer) {
    watchNotes.push('Same description was posted earlier by this employer.');
  }
  if (titleMismatch(job.jobTitle ?? '', description)) {
    soft.push({
      category: 'mismatch',
      quote: `Title says "${(job.jobTitle ?? '').slice(0, 60)}"; description names another function.`,
    });
  }

  if (employer) {
    if (!employer.nameMatches) {
      // handled as an unclear floor in the merge, not a hard caution
    }
    if (!employer.found) {
      const second = hardRisk.length > 0 || hardCaution.length > 0;
      const target = second ? hardRisk : hardCaution;
      target.push({
        category: 'employer',
        quote: 'Employer not found in OLJ records; verify before applying.',
        level: second ? 'risk' : 'caution',
        reason: second
          ? 'Employer not found plus another risk signal.'
          : 'Employer not found in OLJ records.',
      });
    }
    if ((employer.complaints ?? 0) > 0) {
      const n = employer.complaints ?? 0;
      const signal: RiskSignal = {
        category: 'employer',
        quote: `${n} complaint${n === 1 ? '' : 's'} recorded for this employer.`,
        level: n >= 2 ? 'risk' : 'caution',
        reason: 'OLJ employer complaints.',
      };
      (signal.level === 'risk' ? hardRisk : hardCaution).push(signal);
    }
    if (employer.paidActive && (employer.complaints ?? 0) === 0 && employer.postCount === 1) {
      if (hardRisk.length > 0 || hardCaution.length > 0 || soft.length > 0) {
        hardCaution.push({
          category: 'employer',
          quote: 'Only one listing from this employer; verify before sharing documents.',
          level: 'caution',
          reason: 'One listing plus another signal.',
        });
      }
    }
    if ((employer.postCount ?? 0) > 10 && (employer.newPostCount ?? 0) > 5) {
      hardCaution.push({
        category: 'employer',
        quote: `${employer.postCount} posts, ${employer.newPostCount} marked new.`,
        level: 'caution',
        reason: 'Possible job-farm pattern.',
      });
    }
  }

  if (brief) soft.push({ category: 'other', quote: `${description.split(/\s+/).filter(Boolean).length}-word description.` });

  return {
    hardRisk,
    hardCaution,
    soft,
    gaps,
    watchNotes,
    forceUnclear: Boolean(employer && employer.found && !employer.nameMatches),
    descriptionHash: hashDescription(description),
    duplicate,
    email: {
      redacted: email.address ? `***@${email.address.split('@')[1]}` : null,
      free: email.free,
      domainMismatch: domainMismatch(email.address, job.employer ?? ''),
    },
    links,
    titleMismatch: titleMismatch(job.jobTitle ?? '', description),
    brief,
  };
}

/**
 * Load the peer pay pool for a type_of_work, within the same pool (hourly or
 * monthly). Returns sorted ascending. Small and indexed, fine at this scale.
 */
export async function loadPeerPool(typeOfWork: string | null, useHourly: boolean): Promise<number[]> {
  const column = useHourly ? sql`pay_usd_hour` : sql`pay_usd_month`;
  const rows = await db.execute(sql`
    SELECT ${column} AS v
    FROM job_postings
    WHERE pay_confidence IN ('high','medium')
      AND coalesce(type_of_work,'') = ${typeOfWork ?? ''}
      AND ${column} IS NOT NULL
    ORDER BY ${column} ASC
  `);
  return (rows.rows as { v: number }[]).map((r) => Number(r.v)).filter((n) => Number.isFinite(n));
}

function parsedPay(job: typeof jobPostings.$inferSelect): ParsedPay {
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

/** Grade pay against peers. Null when there is not enough data to be fair. */
export async function payInsightFor(
  job: typeof jobPostings.$inferSelect,
): Promise<PayInsight | null> {
  const parsed = parsedPay(job);
  const useHourly = parsed.payPeriod === 'hour';
  const value = useHourly ? parsed.payUsdHour : parsed.payUsdMonth;
  if (value === null || parsed.payConfidence === 'none' || parsed.payConfidence === 'low') {
    return null;
  }
  const pool = await loadPeerPool(job.typeOfWork, useHourly);
  const verdict = verdictFromPool(value, pool, VERDICT_SAMPLE_FLOOR);
  if (verdict === null) return null;
  const type = (job.typeOfWork ?? '').trim();
  const peerLabel = [type, useHourly ? 'hourly' : 'monthly', 'jobs'].filter(Boolean).join(' ');
  return {
    verdict,
    peerLabel,
    value,
    outlier: payOutlierFromPool(value, pool, VERDICT_SAMPLE_FLOOR),
  };
}

export function payContextFor(
  job: typeof jobPostings.$inferSelect,
  insight: PayInsight | null,
): PayContext {
  const outlier = insight?.outlier ?? null;
  return {
    raw: job.compensation ?? 'Not stated',
    usdHour: job.payUsdHour,
    usdMonth: job.payUsdMonth,
    peerLabel: insight?.peerLabel ?? (job.payPeriod === 'hour' ? 'hourly jobs' : 'monthly jobs'),
    median: outlier?.median ?? null,
    p95: outlier?.p95 ?? null,
    ratio: outlier?.ratio ?? null,
    extreme: outlier?.extreme ?? false,
  };
}

// ---------------------------------------------------------------------------
// Self-check. Run: npx tsx src/signals.ts
// ---------------------------------------------------------------------------
if (require.main === module) {
  let failed = 0;
  const check = (label: string, ok: boolean) => {
    if (!ok) {
      failed++;
      console.error(`FAIL ${label}`);
    }
  };

  const pay: PayContext = {
    raw: '$60/hour',
    usdHour: 60,
    usdMonth: 10392,
    peerLabel: 'Full Time hourly jobs',
    median: 10,
    p95: 18,
    ratio: 6,
    extreme: true,
  };
  const job = (description: string, title = 'Senior React Developer') => ({
    jobTitle: title,
    jobDescription: description,
    compensation: '$60/hour',
    hoursPerWeek: '40',
    employer: 'Acme',
  });
  const noDuplicate: DuplicateInfo = { sameEmployer: false, otherEmployer: false };
  const plainPay: PayContext = { ...pay, median: null, p95: null, ratio: null, extreme: false };

  const fee = computeSignals(job('Pay a $50 training fee before your first shift.'), pay, null, noDuplicate);
  check('fee is hard risk', fee.hardRisk.some((s) => s.category === 'fee'));
  const noFee = computeSignals(job('No fee is required. We never ask for money.'), pay, null, noDuplicate);
  check('negated fee is ignored', noFee.hardRisk.length === 0);
  const crypto = computeSignals(job('Salary is paid in USDT every Friday.'), pay, null, noDuplicate);
  check('crypto pay is hard risk', crypto.hardRisk.some((s) => s.category === 'payment'));
  const id = computeSignals(job('Please send your passport before the interview.'), pay, null, noDuplicate);
  check('identity request is hard risk', id.hardRisk.some((s) => s.category === 'identity'));

  const dup = computeSignals(job('Build dashboards.'), pay, null, {
    sameEmployer: false,
    otherEmployer: true,
  });
  check('duplicate from another employer is caution', dup.hardCaution.some((s) => s.category === 'mismatch'));

  const missingEmployer = computeSignals(job('Build dashboards.'), plainPay, { employerId: 1, name: null, found: false, nameMatches: false, paidActive: null, complaints: null, postCount: null, newPostCount: null }, noDuplicate);
  check('missing employer alone is caution', missingEmployer.hardCaution.some((s) => s.category === 'employer'));
  const missingPlusRisk = computeSignals(
    job('Pay a training fee before work.'),
    plainPay,
    { employerId: 1, name: null, found: false, nameMatches: false, paidActive: null, complaints: null, postCount: null, newPostCount: null },
    noDuplicate,
  );
  check('missing employer plus a risk is risk', missingPlusRisk.hardRisk.some((s) => s.category === 'employer'));

  const titleSoft = computeSignals(
    job('Support the marketing team with admin tasks. Requirements: English. About us: agency.', 'Virtual Assistant'),
    plainPay,
    null,
    noDuplicate,
  );
  check('title mismatch is soft', titleSoft.soft.some((s) => s.category === 'mismatch'));
  check(
    'title mismatch is not hard caution',
    !titleSoft.hardCaution.some((s) => s.category === 'mismatch'),
  );

  const ownLaptop = computeSignals(
    job('You must purchase a laptop before starting. Pay is $5/hour. Requirements: typing. About us: firm.'),
    plainPay,
    null,
    noDuplicate,
  );
  check('buying your own laptop is not a hard fee', !ownLaptop.hardRisk.some((s) => s.category === 'fee'));

  for (const text of [
    'We reimburse equipment costs after 30 days.',
    'We pay for your equipment and software.',
    'We send you the equipment you need.',
    'We pay our team $50 per referral.',
    'We reimburse our team $50 monthly for internet.',
  ]) {
    const benefit = computeSignals(job(`${text} Requirements: typing. About us: firm.`), plainPay, null, noDuplicate);
    check(`"${text}" is not a hard fee`, !benefit.hardRisk.some((s) => s.category === 'fee'));
  }
  const companyPackage = computeSignals(
    job('You must purchase the company software package for $120 before starting. Requirements: typing. About us: firm.'),
    plainPay,
    null,
    noDuplicate,
  );
  check('company software package is a hard fee', companyPackage.hardRisk.some((s) => s.category === 'fee'));
  const equipmentPayment = computeSignals(
    job('Send us $120 for the equipment. Requirements: typing. About us: firm.'),
    plainPay,
    null,
    noDuplicate,
  );
  check(
    'equipment payment quote keeps the full amount',
    equipmentPayment.hardRisk.some((s) => s.category === 'fee' && s.quote.includes('$120')),
  );

  for (const text of [
    'Send $120 to us for the equipment.',
    'Pay $50 to our company for training.',
    'Deposit $80 into our company account.',
  ]) {
    const reverse = computeSignals(job(`${text} Requirements: typing. About us: firm.`), plainPay, null, noDuplicate);
    check(`"${text}" is a hard fee`, reverse.hardRisk.some((s) => s.category === 'fee'));
  }

  check('hash is stable', hashDescription('A  role!') === hashDescription('a role'));
  check('email redaction keeps domain', redactEmails('Mail me@example.com') === 'Mail ***@example.com');

  if (failed === 0) console.log('signals.ts self-check OK');
  else {
    console.error(`${failed} failures`);
    process.exit(1);
  }
}
