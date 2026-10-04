import * as cheerio from 'cheerio';
import { sql } from 'drizzle-orm';
import { db } from './db';
import { jobPostings } from './schema';
import { delay } from './utils';

const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS ?? 120000);
const SYNC_BATCH = Number(process.env.SYNC_BATCH ?? 5);

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

async function fetchJob(jobId: number): Promise<ScrapedJob | null> {
  const res = await fetch(`https://www.onlinejobs.ph/jobseekers/job/${jobId}`);
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

async function getLastJobId(): Promise<number> {
  const rows = await db
    .select({ max: sql<number>`coalesce(max(${jobPostings.jobId}), 0)` })
    .from(jobPostings);
  return Number(rows[0]?.max ?? 0);
}

export async function runScraper(): Promise<void> {
  const lastId = await getLastJobId();
  for (let i = 1; i <= SYNC_BATCH; i++) {
    const jobId = lastId + i;
    try {
      const job = await fetchJob(jobId);
      if (job) {
        await db
          .insert(jobPostings)
          .values(job)
          .onConflictDoNothing({ target: jobPostings.jobId });
    } catch (err) {
      console.error(`[scraper] job ${jobId} failed:`, err);
    }
    await delay(50);
  }
}

export function startScraper(): void {
  runScraper().catch((err) => console.error('[scraper] initial run failed:', err));
  setInterval(() => {
    runScraper().catch((err) => console.error('[scraper] run failed:', err));
  }, SYNC_INTERVAL_MS);
}