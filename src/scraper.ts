import * as cheerio from 'cheerio';
import { sql } from 'drizzle-orm';
import { db } from './db';
import { jobPostings } from './schema';
import { delay } from './utils';

const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS ?? 120000);
const SYNC_BATCH = Number(process.env.SYNC_BATCH ?? 5);
const SYNC_DELAY_MS = Number(process.env.SYNC_DELAY_MS ?? 1000);
const SYNC_PAGES = Number(process.env.SYNC_PAGES ?? 3);
const SYNC_DEAD_LIMIT = Number(process.env.SYNC_DEAD_LIMIT ?? 20);
const SYNC_MAX_RETRIES = Number(process.env.SYNC_MAX_RETRIES ?? 3);

const BASE = 'https://www.onlinejobs.ph';
const LISTING_URL = `${BASE}/jobseekers/jobsearch`;
const LISTING_PAGE_STEP = 30;

type ScrapedJob = {
  jobId: number;
  jobTitle: string;
  jobDescription: string;
  jobSkills: string;
  typeOfWork: string;
  compensation: string;
  hoursPerWeek: string;
  jobDate: string;
};

/**
 * In-memory scan cursor. Advances on every attempt (not just inserts) so the
 * scraper never wedges on a run of dead/expired ids. Resets on restart; that is
 * safe because inserts are idempotent and the listing page re-discovers recent
 * jobs regardless.
 */
let scanCursor = 0;
let cursorInitialised = false;

function fieldAfter($: cheerio.CheerioAPI, label: string): string {
  let value = '';
  $('h3').each((_, el) => {
    if ($(el).text().toUpperCase().includes(label)) {
      value = $(el).next('p').first().text().trim();
    }
  });
  return value;
}

function toIsoDate(input: string): string | null {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Fetch with 429 backoff. Returns the raw response, or null if it ultimately
 * failed. A 429 is retried with exponential backoff so valid jobs are never
 * silently dropped. 410 (gone) and other 4xx are returned as-is for the caller
 * to treat as dead.
 */
async function fetchWithBackoff(url: string): Promise<Response | null> {
  let backoff = 1000;
  for (let attempt = 0; attempt <= SYNC_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OLJAlerts/1.0)' },
      });

      if (res.status === 429) {
        if (attempt === SYNC_MAX_RETRIES) {
          console.error(`[scraper] 429 exhausted retries: ${url}`);
          return null;
        }
        console.warn(`[scraper] 429 rate-limited, backing off ${backoff}ms: ${url}`);
        await delay(backoff);
        backoff = Math.min(backoff * 2, 30000);
        continue;
      }

      return res;
    } catch (err) {
      if (attempt === SYNC_MAX_RETRIES) {
        console.error(`[scraper] fetch failed ${url}:`, err);
        return null;
      }
      await delay(backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  }
  return null;
}

type ListingResult = { ids: number[]; maxId: number };

/**
 * Discover current job ids from the listing pages (newest first, 30 per page).
 * `jobsearch` is page 1; `jobsearch/30`, `/60`, ... are later pages. This is the
 * downtime-recovery path: after any outage it re-reads the live board directly.
 */
async function discoverFromListing(pages: number): Promise<ListingResult> {
  const ids = new Set<number>();
  let maxId = 0;

  for (let p = 0; p < pages; p++) {
    const offset = p * LISTING_PAGE_STEP;
    const url = offset === 0 ? LISTING_URL : `${LISTING_URL}/${offset}`;
    const res = await fetchWithBackoff(url);
    if (!res || res.status !== 200) {
      console.error(`[scraper] listing page ${offset} failed (status ${res?.status ?? 'none'})`);
      await delay(SYNC_DELAY_MS);
      continue;
    }
    const html = await res.text();
    const found = html.matchAll(/\/jobseekers\/job\/[a-z0-9-]+-(\d+)/g);
    for (const m of found) {
      const id = Number(m[1]);
      if (Number.isFinite(id) && id > 0) {
        ids.add(id);
        if (id > maxId) maxId = id;
      }
    }
    await delay(SYNC_DELAY_MS);
  }

  return { ids: [...ids], maxId };
}

async function fetchJob(jobId: number): Promise<ScrapedJob | null> {
  const initial = await fetchWithBackoff(`${BASE}/jobseekers/job/${jobId}`);
  if (!initial) return null;

  let res: Response;
  if (initial.status === 301 || initial.status === 302 || initial.status === 307 || initial.status === 308) {
    const loc = initial.headers.get('location') ?? '';
    // Homepage (or "#") redirect means the id is a gap / does not exist.
    if (!loc || loc === BASE || loc === `${BASE}/` || loc.endsWith('/#')) return null;
    const next = loc.startsWith('http') ? loc : `${BASE}${loc}`;
    const followed = await fetchWithBackoff(next);
    if (!followed) return null;
    res = followed;
  } else {
    res = initial;
  }

  // 410 (gone) and other non-ok statuses are dead ids, not errors.
  if (!res.ok) return null;

  const html = await res.text();
  const $ = cheerio.load(html);

  const jobTitle = $('h1').first().text().trim();
  const jobDescription = $('.job-description').first().text().trim();
  const jobSkills = $('.card-worker-topskill').first().text().trim();
  const typeOfWork = fieldAfter($, 'TYPE OF WORK');
  const compensation = fieldAfter($, 'WAGE / SALARY');
  const hoursPerWeek = fieldAfter($, 'HOURS PER WEEK');
  const rawDate = fieldAfter($, 'DATE UPDATED');
  const jobDate = toIsoDate(rawDate);

  if (!jobDescription || !typeOfWork || !compensation || !jobDate) return null;

  return {
    jobId,
    jobTitle,
    jobDescription,
    jobSkills,
    typeOfWork,
    compensation,
    hoursPerWeek,
    jobDate,
  };
}

async function insertJob(job: ScrapedJob): Promise<boolean> {
  const result = await db
    .insert(jobPostings)
    .values(job)
    .onConflictDoNothing({ target: jobPostings.jobId })
    .returning({ id: jobPostings.id });
  return result.length > 0;
}

async function getMaxStoredJobId(): Promise<number> {
  const rows = await db
    .select({ max: sql<number>`coalesce(max(${jobPostings.jobId}), 0)` })
    .from(jobPostings);
  return Number(rows[0]?.max ?? 0);
}

async function getExistingIds(ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ jobId: jobPostings.jobId })
    .from(jobPostings)
    .where(sql`${jobPostings.jobId} IN ${ids}`);
  return new Set(rows.map((r) => Number(r.jobId)));
}

/**
 * Primary pass: read the listing, fetch only ids we do not already have.
 * Recovers from any downtime because it reads the live board, not a cursor.
 */
async function runListingDiscovery(): Promise<number> {
  const { ids, maxId } = await discoverFromListing(SYNC_PAGES);
  if (ids.length === 0) {
    console.warn('[scraper] listing returned no job ids');
    return 0;
  }

  // Seed the forward crawl from near the newest listing id if we have never set
  // a cursor, or if our stored max is far behind (legacy id range).
  const storedMax = await getMaxStoredJobId();
  if (!cursorInitialised || scanCursor < storedMax) {
    scanCursor = storedMax;
    cursorInitialised = true;
  }
  if (storedMax > 0 && maxId > storedMax * 10) {
    // Our stored ids are in a legacy/small range; jump the cursor to the live range.
    console.warn(`[scraper] stored max ${storedMax} looks legacy vs live ${maxId}; jumping cursor`);
    scanCursor = maxId - 1;
  }

  const existing = await getExistingIds(ids);
  const fresh = ids.filter((id) => !existing.has(id));
  let inserted = 0;

  for (const id of fresh) {
    try {
      const job = await fetchJob(id);
      if (job && (await insertJob(job))) inserted++;
    } catch (err) {
      console.error(`[scraper] listing job ${id} failed:`, err);
    }
    await delay(SYNC_DELAY_MS);
  }

  if (inserted > 0) console.log(`[scraper] listing: +${inserted} new of ${fresh.length} fresh`);
  return inserted;
}

/**
 * Secondary pass: crawl forward from the scan cursor to backfill ids the listing
 * rotated off. The cursor advances on every attempt and the loop stops after a
 * run of dead ids, so a gap can never wedge it.
 */
async function runForwardCrawl(): Promise<number> {
  if (scanCursor <= 0) {
    const storedMax = await getMaxStoredJobId();
    scanCursor = storedMax;
  }
  if (scanCursor <= 0) return 0;

  let inserted = 0;
  let deadRun = 0;

  for (let i = 0; i < SYNC_BATCH && deadRun < SYNC_DEAD_LIMIT; i++) {
    scanCursor += 1;
    const jobId = scanCursor;
    deadRun++;

    try {
      const job = await fetchJob(jobId);
      if (job) {
        deadRun = 0;
        if (await insertJob(job)) inserted++;
      }
    } catch (err) {
      console.error(`[scraper] crawl job ${jobId} failed:`, err);
    }
    await delay(SYNC_DELAY_MS);
  }

  if (inserted > 0) console.log(`[scraper] crawl: +${inserted} (cursor ${scanCursor})`);
  return inserted;
}

/**
 * One full sync cycle: listing discovery first (recent jobs, downtime-safe),
 * then forward crawl (backfill).
 */
export async function runScraper(): Promise<void> {
  const fromListing = await runListingDiscovery();
  const fromCrawl = await runForwardCrawl();
  if (fromListing > 0 || fromCrawl > 0) {
    console.log(`[scraper] cycle done: listing +${fromListing}, crawl +${fromCrawl}`);
  }
}

export function startScraper(): void {
  runScraper().catch((err) => console.error('[scraper] initial run failed:', err));
  setInterval(() => {
    runScraper().catch((err) => console.error('[scraper] run failed:', err));
  }, SYNC_INTERVAL_MS);
}
