/**
 * Pay parsing and normalization.
 *
 * OLJ compensation strings are free text (`$9/hour`, `PHP 55,000 - 80,000 per
 * month`, `$8/video`, `750`, `N/A`). This module turns them into structured,
 * comparable values and, where there is enough peer data, a pay verdict.
 *
 * Design notes:
 * - Bare numbers with no currency and no period are marked confidence=low and
 *   are never given a USD figure; we do not invent a period.
 * - Per-unit rates (`/video`, `/email`, `/order`, per-class) are not time-based
 *   and are never forced into a monthly number.
 * - Hourly jobs with unknown hours stay hourly; we do not assume 40h/week.
 */

export type PayPeriod = 'hour' | 'day' | 'week' | 'month' | 'unit' | 'unknown';
export type PayConfidence = 'high' | 'medium' | 'low' | 'none';
export type PayVerdict = 'high' | 'fair' | 'low';

export type ParsedPay = {
  payMin: number | null;
  payMax: number | null;
  payCurrency: string | null;
  payPeriod: PayPeriod;
  payUnitLabel: string | null;
  payUsdHour: number | null;
  payUsdMonth: number | null;
  payConfidence: PayConfidence;
};

/** Static FX table, base USD. Update rarely. */
const FX_TO_USD: Record<string, number> = {
  USD: 1,
  PHP: 0.0175, // ~57 PHP per USD
  SGD: 0.74,
  AUD: 0.66,
  EUR: 1.08,
  GBP: 1.27,
};

const NO_PAY = /\b(n\/?a|negotiable|to be negotiated|competitive|depends|doe)\b/i;

const UNIT_WORDS = '(video|email|order|class|task|article|post|piece|word|project|lead|design|lesson)';

const HOURS_PER_MONTH_FACTOR = 4.33;

function detectCurrency(text: string): string | null {
  if (/₱/.test(text)) return 'PHP';
  // "P10,000" / "P 10,000" — peso prefix directly before a number.
  if (/\bP\s?\d/.test(text)) return 'PHP';
  if (/\bphp\.?\b|peso/i.test(text)) return 'PHP';
  if (/\bsgd\b/i.test(text)) return 'SGD';
  if (/\baud\b/i.test(text)) return 'AUD';
  if (/€|\beur\b/i.test(text)) return 'EUR';
  if (/£|\bgbp\b/i.test(text)) return 'GBP';
  if (/us\$|\busd\b|us d/i.test(text)) return 'USD';
  if (/\$/.test(text)) return 'USD';
  return null;
}

function detectPeriod(text: string): { period: PayPeriod; unitLabel: string | null } {
  const perUnit = new RegExp(
    `per\\s+(?:[\\w-]+\\s+){0,2}${UNIT_WORDS}\\b|/\\s*${UNIT_WORDS}\\b`,
    'i',
  );
  const unitMatch = text.match(perUnit);
  if (unitMatch) {
    const label = unitMatch[0].match(new RegExp(UNIT_WORDS, 'i'))?.[0] ?? null;
    return { period: 'unit', unitLabel: label ? label.toLowerCase() : null };
  }
  if (/\/\s*(hr|hour)\b|\bper\s+hour\b|\ban\s+hour\b|hourly/i.test(text)) {
    return { period: 'hour', unitLabel: null };
  }
  if (/\/\s*day\b|\bper\s+day\b|daily/i.test(text)) return { period: 'day', unitLabel: null };
  if (/\/\s*(wk|week)\b|\bper\s+week\b|weekly/i.test(text))
    return { period: 'week', unitLabel: null };
  if (/\/\s*month\b|\bper\s+month\b|\bp\/m\b|\bp\.m\.?\b|\/\s*mo\b|monthly/i.test(text))
    return { period: 'month', unitLabel: null };
  return { period: 'unknown', unitLabel: null };
}

/** Pull the first one or two numeric amounts out of the string. */
function detectAmounts(text: string): { min: number | null; max: number | null } {
  const cleaned = text
    .replace(/[₱$€£]/g, ' ')
    .replace(/\b(php|sgd|aud|eur|gbp|usd|us)\b/gi, ' ');
  const nums = [...cleaned.matchAll(/\d[\d,\s]*(?:\.\d+)?/g)]
    .map((m) => Number(m[0].replace(/[,\s]/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 100_000_000);
  if (nums.length === 0) return { min: null, max: null };
  if (nums.length === 1) return { min: nums[0], max: nums[0] };
  return { min: Math.min(nums[0], nums[1]), max: Math.max(nums[0], nums[1]) };
}

function toUsd(amount: number, currency: string | null): number | null {
  if (!currency || !(currency in FX_TO_USD)) return amount;
  return amount * FX_TO_USD[currency];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function parsePay(compensation: string | null, hoursPerWeek: string | null): ParsedPay {
  const empty: ParsedPay = {
    payMin: null,
    payMax: null,
    payCurrency: null,
    payPeriod: 'unknown',
    payUnitLabel: null,
    payUsdHour: null,
    payUsdMonth: null,
    payConfidence: 'none',
  };

  const raw = (compensation ?? '').trim();
  if (!raw || NO_PAY.test(raw)) return empty;

  const currency = detectCurrency(raw);
  const { period, unitLabel } = detectPeriod(raw);
  const { min, max } = detectAmounts(raw);

  if (min === null) return empty;

  const hasCurrency = currency !== null;
  const hasPeriod = period !== 'unknown';

  // Bare number: no currency, no period. Do not invent either.
  if (!hasCurrency && !hasPeriod) {
    return {
      ...empty,
      payMin: min,
      payMax: max,
      payConfidence: !!raw.match(/\d/) ? 'low' : 'none',
    };
  }

  const usdMin = toUsd(min, currency);
  const usdMax = toUsd(max ?? min, currency);

  let usdHour: number | null = null;
  let usdMonth: number | null = null;

  if (period === 'hour') {
    usdHour = usdMin !== null ? round2(usdMin) : null;
    const hrs = Number((hoursPerWeek ?? '').replace(/[^\d.]/g, ''));
    if (usdHour !== null && Number.isFinite(hrs) && hrs > 0) {
      usdMonth = round2(usdHour * hrs * HOURS_PER_MONTH_FACTOR);
    }
  } else if (period === 'day') {
    if (usdMin !== null) usdMonth = round2(usdMin * 22);
  } else if (period === 'week') {
    if (usdMin !== null) usdMonth = round2(usdMin * HOURS_PER_MONTH_FACTOR);
    if (usdMin !== null) usdHour = round2(usdMin / 40);
  } else if (period === 'month') {
    usdMonth = usdMin !== null ? round2(usdMin) : null;
  }
  // period === 'unit' -> leave both null; not comparable to time-based pay.

  const confidence: PayConfidence =
    period === 'unit'
      ? 'medium'
      : hasCurrency && hasPeriod
        ? 'high'
        : hasPeriod
          ? 'medium'
          : 'low';

  return {
    payMin: min,
    payMax: max,
    payCurrency: currency,
    payPeriod: period,
    payUnitLabel: unitLabel,
    payUsdHour: usdHour,
    payUsdMonth: usdMonth,
    payConfidence: confidence,
  };
}

/** Human string for a parsed pay, e.g. `$9/hr (~$1,560/mo)` or `$8/video`. */
export function formatPay(p: ParsedPay): string {
  if (p.payConfidence === 'none' || p.payMin === null) return 'N/A';
  const cur = p.payCurrency ?? '';
  const amt =
    p.payMax !== null && p.payMax !== p.payMin
      ? `${p.payMin.toLocaleString()}–${p.payMax.toLocaleString()}`
      : p.payMin.toLocaleString();
  const per = p.payPeriod === 'unit' ? `/${p.payUnitLabel ?? 'unit'}` : `/${p.payPeriod}`;
  let out = `${cur} ${amt}${p.payPeriod === 'unknown' ? '' : per}`.trim();
  if (p.payUsdMonth !== null && p.payPeriod === 'hour') {
    out += ` (~$${Math.round(p.payUsdMonth).toLocaleString()}/mo)`;
  }
  return out;
}

const VERDICT_TEXT: Record<PayVerdict, string> = {
  high: 'High pay',
  fair: 'Fair pay',
  low: 'Low pay',
};

export function formatVerdict(v: PayVerdict | null): string | null {
  return v ? VERDICT_TEXT[v] : null;
}

/**
 * Compare a value against a peer distribution.
 * `pool` must be pre-sorted ascending. Returns null when there is too little data.
 */
export function verdictFromPool(
  value: number | null,
  pool: number[],
  sampleFloor = 15,
): PayVerdict | null {
  if (value === null || pool.length < sampleFloor) return null;
  const sorted = pool;
  const q = (p: number) => {
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  const p35 = q(0.35);
  const p65 = q(0.65);
  if (value > p65) return 'high';
  if (value < p35) return 'low';
  return 'fair';
}

// ---------------------------------------------------------------------------
// Self-check. Run: npx tsx src/pay.ts
// ---------------------------------------------------------------------------
if (require.main === module) {
  const cases: [string, string | null, Partial<ParsedPay>][] = [
    ['$9/hour', null, { payCurrency: 'USD', payPeriod: 'hour', payUsdHour: 9, payConfidence: 'high' }],
    ['$7.50 USD/hour', null, { payUsdHour: 7.5, payPeriod: 'hour' }],
    ['$2-4/hr', null, { payUsdHour: 2, payMin: 2, payMax: 4, payPeriod: 'hour' }],
    ['PHP 55,000 - 80,000 per month', null, { payCurrency: 'PHP', payPeriod: 'month', payMin: 55000, payMax: 80000 }],
    ['₱26,500 - ₱32,300 per month', null, { payCurrency: 'PHP', payPeriod: 'month', payMin: 26500, payMax: 32300 }],
    ['$60/week', null, { payPeriod: 'week', payUsdMonth: 259.8 }],
    ['$8/video', null, { payPeriod: 'unit', payUnitLabel: 'video', payUsdMonth: null }],
    ['$7 USD per email', null, { payPeriod: 'unit', payUnitLabel: 'email' }],
    ['250', null, { payMin: 250, payPeriod: 'unknown', payConfidence: 'low', payUsdMonth: null }],
    ['N/A', null, { payConfidence: 'none' }],
    ['negotiable', null, { payConfidence: 'none' }],
    ['₱200 per 1-hour class (approximate)', null, { payPeriod: 'unit', payUnitLabel: 'class', payCurrency: 'PHP' }],
    ['$1000/month', null, { payPeriod: 'month', payUsdMonth: 1000, payConfidence: 'high' }],
    ['OTE is $1,200/mo', null, { payPeriod: 'month', payUsdMonth: 1200, payConfidence: 'high' }],
    ['$3', null, { payPeriod: 'unknown', payConfidence: 'low', payUsdMonth: null }],
    ['SGD $1500 to $2,000 excluding bonuses', null, { payCurrency: 'SGD', payPeriod: 'unknown', payConfidence: 'low' }],
    ['P10,000-P15,000/mo.', null, { payCurrency: 'PHP', payPeriod: 'month', payMin: 10000, payMax: 15000 }],
  ];

  let failed = 0;
  for (const [input, hours, expect] of cases) {
    const got = parsePay(input, hours);
    for (const [k, v] of Object.entries(expect)) {
      if ((got as Record<string, unknown>)[k] !== v) {
        failed++;
        console.error(`FAIL "${input}" ${k}: expected ${v}, got ${(got as Record<string, unknown>)[k]}`);
      }
    }
  }

  // Verdict self-check.
  const pool = Array.from({ length: 20 }, (_, i) => 100 + i * 100); // 100..2000, 20 samples
  const high = verdictFromPool(1950, pool);
  const low = verdictFromPool(150, pool);
  const fair = verdictFromPool(1000, pool);
  const tooFew = verdictFromPool(1000, [100, 200, 300]);
  if (high !== 'high' || low !== 'low' || fair !== 'fair' || tooFew !== null) {
    failed++;
    console.error(`FAIL verdicts: high=${high} low=${low} fair=${fair} tooFew=${tooFew}`);
  }

  if (failed === 0) console.log(`pay.ts self-check OK (${cases.length} cases)`);
  else {
    console.error(`${failed} failures`);
    process.exit(1);
  }
}
