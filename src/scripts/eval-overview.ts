/**
 * Offline eval over labeled fixtures.
 * Run: npm run eval:overview
 * Requires OPENCODE_API_KEY; it makes real model calls.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { analyzeFields, type OverviewJob } from '../overview';
import type { EmployerSummary } from '../employer-check';
import type { PayContext } from '../signals';

type Case = {
  id: string;
  title: string;
  description: string;
  compensation?: string;
  hoursPerWeek?: string;
  typeOfWork?: string;
  employer?: string;
  expected: 'likely' | 'caution' | 'risk';
  pay?: Partial<PayContext>;
  employerRecord?: Partial<EmployerSummary> | null;
};

const file = path.join(process.cwd(), 'evals', 'overview-cases.json');
const cases = JSON.parse(fs.readFileSync(file, 'utf8')) as Case[];

if (!process.env.OPENCODE_API_KEY) {
  console.error('OPENCODE_API_KEY is required for eval:overview');
  process.exit(1);
}

async function main(): Promise<void> {
  let riskTotal = 0;
  let riskHit = 0;
  let legitTotal = 0;
  let legitFalsePositive = 0;
  let cautionCount = 0;
  let escalated = 0;
  let tokens = 0;
  let latency = 0;
  let noAnalysis = 0;
  let correct = 0;
  let likelyOverCaution = 0;
  let quoteTotal = 0;
  let quoteDropped = 0;
  const matrix: Record<string, Record<string, number>> = {};

  for (const item of cases) {
    matrix[item.expected] ??= {};
    if (item.expected === 'risk') riskTotal++;
    if (item.expected === 'likely') legitTotal++;
    const employer: EmployerSummary | null =
      item.employerRecord === null
        ? null
        : item.employerRecord
          ? {
              employerId: 1,
              name: item.employer ?? 'Acme',
              found: true,
              nameMatches: true,
              paidActive: true,
              complaints: 0,
              postCount: 2,
              newPostCount: 0,
              ...item.employerRecord,
            }
          : null;
    const pay: PayContext = {
      raw: item.compensation ?? 'Not stated',
      usdHour: null,
      usdMonth: null,
      peerLabel: 'fixture peers',
      median: null,
      p95: null,
      ratio: null,
      extreme: false,
      ...item.pay,
    };
    const job: OverviewJob = {
      jobTitle: item.title,
      jobDescription: item.description,
      jobSkills: '',
      typeOfWork: item.typeOfWork ?? 'Full Time',
      compensation: item.compensation ?? 'Not stated',
      hoursPerWeek: item.hoursPerWeek ?? '40',
      employer: item.employer ?? null,
      employerId: employer ? 1 : null,
    };

    let result: Awaited<ReturnType<typeof analyzeFields>> = null;
    let failure = 'no analysis';
    try {
      result = await analyzeFields(job, pay, employer);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    if (!result) {
      console.error(`FAIL ${item.id}: ${failure}`);
      noAnalysis++;
      matrix[item.expected].error = (matrix[item.expected].error ?? 0) + 1;
      continue;
    }
    const got = result.analysis.final.legit;
    matrix[item.expected][got] = (matrix[item.expected][got] ?? 0) + 1;
    if (got === item.expected) correct++;
    if (item.expected === 'likely' && got === 'caution') likelyOverCaution++;
    const usageTokens =
      (result.usage.main?.prompt_tokens ?? 0) +
      (result.usage.main?.completion_tokens ?? 0) +
      (result.usage.escalation?.prompt_tokens ?? 0) +
      (result.usage.escalation?.completion_tokens ?? 0);
    tokens += usageTokens;
    latency += (result.usage.main?.latency_ms ?? 0) + (result.usage.escalation?.latency_ms ?? 0);
    if (result.analysis.escalated) escalated++;
    quoteTotal += result.quoteStats.total;
    quoteDropped += result.quoteStats.dropped;
    if (got === 'caution') cautionCount++;
    if (item.expected === 'risk' && got === 'risk') riskHit++;
    if (item.expected === 'likely' && got === 'risk') legitFalsePositive++;
    console.log(`${item.id} expected=${item.expected} got=${got} escalated=${result.analysis.escalated}`);
  }

  const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);
  console.log(
    JSON.stringify(
      {
        cases: cases.length,
        noAnalysis,
        accuracy: pct(correct, cases.length),
        likelyToCaution: likelyOverCaution,
        matrix,
        riskRecall: pct(riskHit, riskTotal),
        legitFalsePositiveRate: pct(legitFalsePositive, legitTotal),
        cautionRate: pct(cautionCount, cases.length),
        escalationRate: pct(escalated, cases.length),
        quoteVerificationFailureRate: pct(quoteDropped, quoteTotal),
        avgTokens: Math.round(tokens / cases.length),
        avgLatencyMs: Math.round(latency / cases.length),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
