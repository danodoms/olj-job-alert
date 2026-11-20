/**
 * OLJ employer search: parser, one GET for the CSRF token, one POST for the
 * search, cached for 7 days. An unknown result (captcha, timeout, markup
 * change) returns null so the caller falls back to description-only signals.
 */
import * as cheerio from 'cheerio';
import { sql } from 'drizzle-orm';
import { db } from './db';
import { employerChecks } from './schema';

const BASE = 'https://www.onlinejobs.ph';
const TIMEOUT_MS = 4000;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type EmployerSummary = {
  employerId: number;
  name: string | null;
  found: boolean;
  nameMatches: boolean;
  paidActive: boolean | null;
  complaints: number | null;
  postCount: number | null;
  newPostCount: number | null;
};

type EmployerRecord = Omit<EmployerSummary, 'employerId' | 'nameMatches'>;

type FetchLike = typeof fetch;

function normal(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function namesMatch(jobName: string, resultName: string): boolean {
  const a = normal(jobName);
  const b = normal(resultName);
  return Boolean(a && b && (a === b || a.startsWith(b) || b.startsWith(a)));
}

/** Parse employer search HTML. Text only; markup changes return null. */
export function parseEmployerSearch(html: string): EmployerRecord | null {
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ');

  if (/is not found in our system/i.test(text)) {
    return {
      name: null,
      found: false,
      paidActive: null,
      complaints: null,
      postCount: null,
      newPostCount: null,
    };
  }
  if (!/we have found/i.test(text)) return null;

  const name = $('.no-wrap strong').first().text().trim() || null;
  const paidActive = /fully paid active employer account/i.test(text)
    ? true
    : /never been upgraded/i.test(text)
      ? false
      : null;

  let complaints: number | null = null;
  if (/no complaints have been received/i.test(text)) complaints = 0;
  else {
    const match = text.match(/(\d+)\s+complaints?/i);
    if (match) complaints = Number(match[1]);
  }

  const postCount = /there are no jobs posted under this account/i.test(text)
    ? 0
    : $('.jobs-box a[href*="/jobseekers/job/"]').length;
  const newPostCount = $('.jobs-box')
    .find('*')
    .filter((_, el) => $(el).children().length === 0 && /^\s*new\s*$/i.test($(el).text()))
    .length;

  return { name, found: true, paidActive, complaints, postCount, newPostCount };
}

async function fetchEmployerRecord(name: string, fetchImpl: FetchLike): Promise<EmployerRecord | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; OLJAlerts/1.0)' };
    const searchPage = await fetchImpl(`${BASE}/jobseekers/employersearch`, {
      headers,
      signal: controller.signal,
    });
    if (!searchPage.ok) throw new Error(`employer search page HTTP ${searchPage.status}`);
    const token = cheerio
      .load(await searchPage.text())('input[name="csrf-token"]')
      .first()
      .attr('value');
    if (!token) throw new Error('employer search CSRF token missing');
    // Node fetch keeps no cookies, so carry the session cookie to the POST in
    // case OLJ binds the token to a session.
    const cookie = searchPage.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');

    const body = new URLSearchParams({ 'csrf-token': token, search: name, 'btn-search': '' });
    const res = await fetchImpl(`${BASE}/jobseekers/employersearch/`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`employer search HTTP ${res.status}`);
    const record = parseEmployerSearch(await res.text());
    if (!record) console.error(`[employer] search unparseable or captcha for "${name}"`);
    return record;
  } catch (err) {
    console.error(`[employer] lookup failed for "${name}":`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Cached OLJ employer search. Null means unknown; never treat it as not-found. */
export async function lookupEmployer(
  employerId: number,
  name: string,
  fetchImpl: FetchLike = fetch,
): Promise<EmployerSummary | null> {
  const cached = await db
    .select()
    .from(employerChecks)
    .where(sql`${employerChecks.employerId} = ${employerId}`)
    .limit(1);
  const row = cached[0];
  if (row && row.checkedAt && Date.now() - new Date(row.checkedAt).getTime() < TTL_MS) {
    const found =
      row.name !== null ||
      row.paidActive !== null ||
      row.complaints !== null ||
      row.postCount !== null;
    return {
      employerId,
      name: row.name,
      found,
      nameMatches: row.name !== null && namesMatch(name, row.name),
      paidActive: row.paidActive,
      complaints: row.complaints,
      postCount: row.postCount,
      newPostCount: row.newPostCount,
    };
  }

  const record = await fetchEmployerRecord(name, fetchImpl);
  if (!record) return null;

  await db
    .insert(employerChecks)
    .values({
      employerId,
      name: record.name,
      paidActive: record.paidActive,
      complaints: record.complaints,
      postCount: record.postCount,
      newPostCount: record.newPostCount,
      checkedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: employerChecks.employerId,
      set: {
        name: record.name,
        paidActive: record.paidActive,
        complaints: record.complaints,
        postCount: record.postCount,
        newPostCount: record.newPostCount,
        checkedAt: new Date(),
      },
    });

  return {
    employerId,
    ...record,
    nameMatches: record.name !== null && namesMatch(name, record.name),
  };
}

// ---------------------------------------------------------------------------
// Self-check with a fixture matching the current OLJ employer search page.
// Run: npx tsx src/employer-check.ts
// ---------------------------------------------------------------------------
if (require.main === module) {
  let failed = 0;
  const check = (label: string, ok: boolean) => {
    if (!ok) {
      failed++;
      console.error(`FAIL ${label}`);
    }
  };

  const fixture = `<div class="no-wrap">
    <p>We have found <strong>Acme***</strong> in our system and it is associated with a fully paid active employer account.</p>
    <p>No complaints have been received for this employer (<strong>Acme***</strong>).</p>
  </div>
  <div class="jobs-box">
    <a href="/jobseekers/job/one-1">one</a><span>New</span>
    <a href="/jobseekers/job/two-2">two</a>
    <a href="/jobseekers/job/three-3">three</a>
  </div>`;
  const record = parseEmployerSearch(fixture);
  check('found', record?.found === true);
  check('paid active', record?.paidActive === true);
  check('complaints', record?.complaints === 0);
  check('post count', record?.postCount === 3);
  check('new post count', record?.newPostCount === 1);
  check('no result is unknown', parseEmployerSearch('<p>captcha</p>') === null);
  check(
    'not found',
    parseEmployerSearch('<p>That name zzz is not found in our system.</p>')?.found === false,
  );
  check('masked name matches', namesMatch('Acme', '****Acme'));
  check('different name does not match', !namesMatch('Acme', 'Other Co'));

  if (failed === 0) console.log('employer-check.ts self-check OK');
  else {
    console.error(`${failed} failures`);
    process.exit(1);
  }
}
