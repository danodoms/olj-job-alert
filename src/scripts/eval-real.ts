/**
 * Live eval over real job postings from the database.
 * Run: npm run eval:real [-- 10]
 * Requires OPENCODE_API_KEY and DATABASE_URL; it makes real model calls.
 *
 * Every posting is run through the same analyzeFields path as production, then
 * the result is checked against the invariants the alert path relies on. The
 * overviews are written to evals/real-run.json so a run can be read later.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db';
import { jobPostings } from '../schema';
import { AI_VERSION, analyzeFields, buildExcerpt, isOverviewAvailable } from '../overview';
import { lookupEmployer, type EmployerSummary } from '../employer-check';
import {
  findDuplicate,
  hashDescription,
  payContextFor,
  payInsightFor,
  redactEmails,
  redactPhones,
} from '../signals';

const COUNT = Number(process.argv[2] ?? 5);
const MIN_DESCRIPTION = 500;

const LEGIT = ['likely', 'caution', 'risk', 'unclear'];
const BOTTOM = ['apply', 'maybe', 'skip'];
const CONFIDENCE = ['low', 'medium', 'high'];

/** bottom_line must agree with legit, per the prompt rules. */
const AGREES: Record<string, string[]> = {
  risk: ['skip'],
  caution: ['maybe'],
  unclear: ['maybe'],
  likely: ['apply'],
};

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

let failed = 0;
function check(jobId: number, label: string, ok: boolean): void {
  if (!ok) {
    failed++;
    console.error(`FAIL job ${jobId}: ${label}`);
  }
}

type Run = {
  jobId: number;
  title: string;
  expectedQuotes: number;
  overview: string;
  legit: string;
  bottomLine: string;
  confidence: string;
  escalated: boolean;
  latencyMs: number;
  tokens: number;
};

async function main(): Promise<void> {
  if (!isOverviewAvailable()) {
    console.error('OPENCODE_API_KEY is required for eval:real');
    process.exit(1);
  }
  if (!Number.isFinite(COUNT) || COUNT < 1) {
    console.error('Usage: npm run eval:real [-- <count>]');
    process.exit(1);
  }

  // Random real postings with enough text to analyze, skipping synthetic rows.
  const jobs = await db
    .select()
    .from(jobPostings)
    .where(
      sql`length(${jobPostings.jobDescription}) >= ${MIN_DESCRIPTION}
        AND ${jobPostings.jobId} < 999999000`,
    )
    .orderBy(sql`random()`)
    .limit(COUNT);

  if (jobs.length === 0) {
    console.error('No usable job postings in the database');
    process.exit(1);
  }

  const runs: Run[] = [];

  for (const job of jobs) {
    const description = job.jobDescription ?? '';
    const title = job.jobTitle ?? '';
    console.log(`\n--- job ${job.jobId}: ${title}`);

    const insight = await payInsightFor(job);
    const pay = payContextFor(job, insight);

    let employer: EmployerSummary | null = null;
    if (job.employerId && job.employer) {
      try {
        employer = await lookupEmployer(job.employerId, job.employer);
      } catch (err) {
        console.warn(`[eval] employer lookup failed for ${job.jobId}:`, err);
      }
    }

    const hash = job.descriptionHash ?? hashDescription(description);
    const duplicate = await findDuplicate(hash, job.employerId, job.jobId);

    const result = await analyzeFields(
      {
        jobTitle: job.jobTitle,
        jobDescription: job.jobDescription,
        jobSkills: job.jobSkills,
        typeOfWork: job.typeOfWork,
        compensation: job.compensation,
        hoursPerWeek: job.hoursPerWeek,
        employer: job.employer,
        employerId: job.employerId,
      },
      pay,
      employer,
      duplicate,
    );

    check(job.jobId, 'model returned an analysis', result !== null);
    if (!result) continue;

    const { analysis, overview, usage, quoteStats } = result;
    const final = analysis.final;
    const excerpt = squash(redactPhones(redactEmails(buildExcerpt(description, title))));

    check(job.jobId, `version is ${AI_VERSION}`, analysis.version === AI_VERSION);
    check(job.jobId, `legit is known (${final.legit})`, LEGIT.includes(final.legit));
    check(job.jobId, `bottom_line is known (${final.bottom_line})`, BOTTOM.includes(final.bottom_line));
    check(
      job.jobId,
      `bottom_line ${final.bottom_line} agrees with legit ${final.legit}`,
      (AGREES[final.legit] ?? []).includes(final.bottom_line),
    );
    check(job.jobId, `confidence is known (${final.confidence})`, CONFIDENCE.includes(final.confidence));
    check(job.jobId, 'what is not empty', final.what.trim().length > 0);
    check(job.jobId, 'legit_reason is not empty', final.legit_reason.trim().length > 0);

    for (const signal of final.risk_signals) {
      check(
        job.jobId,
        `quote is verbatim in the post (${signal.category})`,
        squash(signal.quote).length > 0 && excerpt.includes(squash(signal.quote)),
      );
    }

    check(job.jobId, 'overview is not empty', overview.trim().length > 0);
    check(job.jobId, 'overview fits one Telegram message', overview.length <= 4096);
    check(job.jobId, 'overview leaks no email', !/\b[\w.+-]+@[\w-]+\.[\w.]+\b/.test(overview));
    check(job.jobId, 'main call recorded latency', (usage.main?.latency_ms ?? 0) > 0);

    const latencyMs = (usage.main?.latency_ms ?? 0) + (usage.escalation?.latency_ms ?? 0);
    const tokens =
      (usage.main?.prompt_tokens ?? 0) +
      (usage.main?.completion_tokens ?? 0) +
      (usage.escalation?.prompt_tokens ?? 0) +
      (usage.escalation?.completion_tokens ?? 0);

    runs.push({
      jobId: job.jobId,
      title,
      expectedQuotes: quoteStats.total,
      overview,
      legit: final.legit,
      bottomLine: final.bottom_line,
      confidence: final.confidence,
      escalated: analysis.escalated,
      latencyMs,
      tokens,
    });

    console.log(
      `legit=${final.legit} bottom=${final.bottom_line} escalated=${analysis.escalated} ` +
        `quotes=${quoteStats.total} dropped=${quoteStats.dropped} ` +
        `latency=${latencyMs}ms tokens=${tokens}`,
    );
    console.log(overview);
  }

  const out = path.join(process.cwd(), 'evals', 'real-run.json');
  fs.writeFileSync(out, `${JSON.stringify({ ranAt: new Date().toISOString(), runs }, null, 2)}\n`);
  console.log(`\nwrote ${path.relative(process.cwd(), out)}`);

  const avg = (pick: (r: Run) => number) =>
    runs.length === 0 ? 0 : Math.round(runs.reduce((sum, r) => sum + pick(r), 0) / runs.length);
  console.log(
    JSON.stringify(
      {
        sampled: jobs.length,
        analyzed: runs.length,
        failures: failed,
        escalationRate: runs.length ? runs.filter((r) => r.escalated).length / runs.length : 0,
        avgLatencyMs: avg((r) => r.latencyMs),
        avgTokens: avg((r) => r.tokens),
      },
      null,
      2,
    ),
  );

  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
