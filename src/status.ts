import http from 'http';
import { db } from './db';
import { jobPostings, userSubscriptions } from './schema';
import { sql } from 'drizzle-orm';

const STATUS_PORT = Number(process.env.STATUS_PORT) || 3000;
const STATUS_ENABLED = process.env.STATUS_ENABLED !== 'false';
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS) || 120000;
const STALE_MULTIPLIER = 2;

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function collectStatus() {
  const [
    totals,
    pending,
    lastCreated,
    lastDate,
    subscriberCount,
    keywordCount,
    newLastHour,
    newLast24h,
    dailyRows,
    recentRows,
  ] = await Promise.all([
    db.select({ v: sql`COUNT(*)` }).from(jobPostings),
    db
      .select({ v: sql`COUNT(*)` })
      .from(jobPostings)
      .where(sql`${jobPostings.isProcessed} = false`),
    db.select({ v: sql`MAX(${jobPostings.createdAt})` }).from(jobPostings),
    db.select({ v: sql`MAX(${jobPostings.jobDate})` }).from(jobPostings),
    db
      .select({ v: sql`COUNT(DISTINCT ${userSubscriptions.chatId})` })
      .from(userSubscriptions),
    db.select({ v: sql`COUNT(*)` }).from(userSubscriptions),
    db
      .select({ v: sql`COUNT(*)` })
      .from(jobPostings)
      .where(sql`${jobPostings.createdAt} > now() - interval '1 hour'`),
    db
      .select({ v: sql`COUNT(*)` })
      .from(jobPostings)
      .where(sql`${jobPostings.createdAt} > now() - interval '24 hours'`),
    db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${jobPostings.createdAt}), 'YYYY-MM-DD')`,
        v: sql<number>`COUNT(*)`,
      })
      .from(jobPostings)
      .where(sql`${jobPostings.createdAt} > now() - interval '13 days'`)
      .groupBy(sql`date_trunc('day', ${jobPostings.createdAt})`)
      .orderBy(sql`date_trunc('day', ${jobPostings.createdAt})`),
    db
      .select({
        jobId: jobPostings.jobId,
        title: jobPostings.jobTitle,
        typeOfWork: jobPostings.typeOfWork,
        compensation: jobPostings.compensation,
        createdAt: jobPostings.createdAt,
      })
      .from(jobPostings)
      .orderBy(sql`${jobPostings.createdAt} DESC NULLS LAST`)
      .limit(6),
  ]);

  const lastCreatedAt = toIso(lastCreated[0]?.v ?? null);
  const lastCreatedMs = lastCreatedAt ? new Date(lastCreatedAt).getTime() : null;

  const dailyMap = new Map<string, number>();
  for (const row of dailyRows) dailyMap.set(String(row.day), Number(row.v));
  const series: { day: string; count: number }[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    series.push({ day: key, count: dailyMap.get(key) ?? 0 });
  }

  return {
    up: true,
    jobsTotal: Number(totals[0]?.v ?? 0),
    jobsPending: Number(pending[0]?.v ?? 0),
    lastJobCreatedAt: lastCreatedAt,
    lastJobDate: toIso(lastDate[0]?.v ?? null)?.slice(0, 10) ?? null,
    subscribers: Number(subscriberCount[0]?.v ?? 0),
    keywords: Number(keywordCount[0]?.v ?? 0),
    newLastHour: Number(newLastHour[0]?.v ?? 0),
    newLast24h: Number(newLast24h[0]?.v ?? 0),
    daily: series,
    recent: recentRows.map((r) => ({
      jobId: Number(r.jobId),
      title: r.title,
      typeOfWork: r.typeOfWork,
      compensation: r.compensation,
      createdAt: toIso(r.createdAt),
    })),
    db: { ok: true },
    stale:
      lastCreatedMs !== null && Date.now() - lastCreatedMs > STALE_MULTIPLIER * SYNC_INTERVAL_MS,
  };
}

const SORT_COLUMNS: Record<string, string> = {
  createdAt: 'created_at',
  jobDate: 'job_date',
  jobId: 'job_id',
  jobTitle: 'job_title',
  compensation: 'compensation',
};

function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function listJobs(params: URLSearchParams) {
  const page = clampInt(params.get('page'), 1, 1, 100000);
  const pageSize = clampInt(params.get('pageSize'), 20, 5, 100);
  const q = (params.get('q') ?? '').trim().slice(0, 200);
  const type = (params.get('type') ?? '').trim().slice(0, 100);
  const sortKey = params.get('sort') ?? 'createdAt';
  const sortCol = SORT_COLUMNS[sortKey] ?? SORT_COLUMNS.createdAt;
  const dir = params.get('dir') === 'asc' ? 'ASC' : 'DESC';

  const conditions = [];
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    conditions.push(
      sql`(${jobPostings.jobTitle} ILIKE ${like} OR ${jobPostings.jobDescription} ILIKE ${like} OR ${jobPostings.compensation} ILIKE ${like})`,
    );
  }
  if (type) {
    conditions.push(sql`${jobPostings.typeOfWork} = ${type}`);
  }
  const whereClause = conditions.length
    ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
    : sql``;

  const offset = (page - 1) * pageSize;

  const [countRows, rows, typeRows] = await Promise.all([
    db.execute(sql`SELECT COUNT(*)::int AS total FROM job_postings ${whereClause}`),
    db.execute(sql`
      SELECT job_id, job_title, type_of_work, compensation, hours_per_week,
             job_date, is_processed, created_at
      FROM job_postings
      ${whereClause}
      ORDER BY ${sql.raw(sortCol)} ${sql.raw(dir)} NULLS LAST, job_id DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `),
    db.execute(
      sql`SELECT DISTINCT type_of_work FROM job_postings WHERE type_of_work IS NOT NULL AND type_of_work <> '' ORDER BY type_of_work`,
    ),
  ]);

  const total = Number((countRows.rows[0] as { total: number } | undefined)?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return {
    page,
    pageSize,
    total,
    totalPages,
    sort: sortKey,
    dir: dir.toLowerCase(),
    q,
    type,
    types: (typeRows.rows as { type_of_work: string }[]).map((r) => r.type_of_work),
    jobs: (rows.rows as Record<string, unknown>[]).map((r) => ({
      jobId: Number(r.job_id),
      title: r.job_title,
      typeOfWork: r.type_of_work,
      compensation: r.compensation,
      hoursPerWeek: r.hours_per_week,
      jobDate: r.job_date ? String(r.job_date).slice(0, 10) : null,
      isProcessed: r.is_processed,
      createdAt: toIso(r.created_at),
    })),
  };
}

async function getJob(jobId: number) {
  const rows = await db
    .select()
    .from(jobPostings)
    .where(sql`${jobPostings.jobId} = ${jobId}`)
    .limit(1);
  const job = rows[0];
  if (!job) return null;
  return {
    jobId: Number(job.jobId),
    title: job.jobTitle,
    description: job.jobDescription,
    skills: job.jobSkills,
    typeOfWork: job.typeOfWork,
    compensation: job.compensation,
    hoursPerWeek: job.hoursPerWeek,
    jobDate: job.jobDate,
    isProcessed: job.isProcessed,
    createdAt: toIso(job.createdAt),
  };
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OLJAlerts — Status</title>
<style>
  :root {
    --bg: #070a12;
    --panel: rgba(21, 27, 40, 0.72);
    --panel-solid: #151b28;
    --border: rgba(255,255,255,0.07);
    --border-strong: rgba(255,255,255,0.13);
    --text: #eef2f8;
    --muted: #8a97ad;
    --muted-dim: #667085;
    --accent: #4f8cff;
    --accent-2: #a855f7;
    --ok: #34d399;
    --warn: #fbbf24;
    --bad: #f87171;
    --shadow: 0 10px 40px -12px rgba(0,0,0,0.65);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    min-height: 100vh;
    padding: 40px 24px 56px;
    display: flex;
    flex-direction: column;
    align-items: center;
    overflow-x: hidden;
  }
  body::before {
    content: "";
    position: fixed; inset: 0; z-index: -1;
    background:
      radial-gradient(900px 500px at 15% -5%, rgba(79,140,255,0.16), transparent 60%),
      radial-gradient(800px 500px at 90% 0%, rgba(168,85,247,0.13), transparent 60%),
      radial-gradient(700px 600px at 50% 110%, rgba(52,211,153,0.08), transparent 60%);
  }
  .wrap { width: 100%; max-width: 1080px; }

  header {
    display: flex; align-items: center; justify-content: space-between;
    flex-wrap: wrap; gap: 16px; margin-bottom: 28px;
  }
  .brand { display: flex; align-items: center; gap: 14px; }
  .logo {
    width: 46px; height: 46px; border-radius: 14px;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    display: grid; place-items: center; font-size: 23px;
    box-shadow: 0 10px 30px -8px var(--accent);
  }
  h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.4px; }
  .sub { color: var(--muted); font-size: 13px; }
  .status-pill {
    display: inline-flex; align-items: center; gap: 9px;
    padding: 9px 16px; border-radius: 999px;
    background: var(--panel); border: 1px solid var(--border-strong);
    font-size: 13.5px; font-weight: 600; backdrop-filter: blur(12px);
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted-dim); }
  .dot.ok { background: var(--ok); box-shadow: 0 0 12px 0 var(--ok); animation: glow 2.4s ease-in-out infinite; }
  .dot.warn { background: var(--warn); box-shadow: 0 0 12px 0 var(--warn); }
  .dot.bad { background: var(--bad); box-shadow: 0 0 12px 0 var(--bad); }
  @keyframes glow { 0%,100% { opacity: 1; } 50% { opacity: .55; } }

  .stats {
    display: grid; gap: 16px; margin-bottom: 16px;
    grid-template-columns: repeat(4, 1fr);
  }
  .card {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 18px; padding: 20px;
    box-shadow: var(--shadow); backdrop-filter: blur(14px);
    transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease;
    position: relative; overflow: hidden;
  }
  .card:hover { transform: translateY(-3px); border-color: var(--border-strong); }
  .card .label {
    color: var(--muted); font-size: 11.5px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 12px;
    display: flex; align-items: center; gap: 8px;
  }
  .card .label .ic { font-size: 14px; }
  .card .value { font-size: 34px; font-weight: 750; letter-spacing: -1px; line-height: 1; }
  .card .hint { color: var(--muted-dim); font-size: 12px; margin-top: 8px; }
  .spin { animation: shimmer 1.5s ease-in-out infinite; }
  @keyframes shimmer { 0%,100% { opacity: .35 } 50% { opacity: .8 } }

  .value .accent { color: var(--accent); }
  .delta { font-size: 12.5px; font-weight: 600; margin-top: 8px; display: inline-flex; align-items: center; gap: 5px; }
  .delta.pos { color: var(--ok); }
  .delta.zero { color: var(--muted-dim); }

  .panel {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 18px; padding: 22px; box-shadow: var(--shadow);
    backdrop-filter: blur(14px); margin-bottom: 16px;
  }
  .panel h2 {
    font-size: 14px; font-weight: 650; color: var(--text);
    margin-bottom: 4px; display: flex; align-items: center; gap: 9px;
  }
  .panel .panel-sub { color: var(--muted-dim); font-size: 12.5px; margin-bottom: 18px; }

  .two-col { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; }

  /* Sparkline chart */
  .chart { width: 100%; height: 150px; display: block; }
  .chart .bar { fill: url(#barGrad); transition: 0.3s; }
  .chart .bar:hover { fill: var(--accent); }
  .chart .axis { fill: var(--muted-dim); font-size: 10px; }
  .chart .grid-line { stroke: rgba(255,255,255,0.05); stroke-width: 1; }

  /* Ring gauge */
  .rings { display: flex; flex-direction: column; gap: 18px; }
  .ring-row { display: flex; align-items: center; gap: 16px; }
  .ring { position: relative; width: 62px; height: 62px; flex: 0 0 auto; }
  .ring svg { transform: rotate(-90deg); }
  .ring .ring-bg { fill: none; stroke: rgba(255,255,255,0.07); stroke-width: 7; }
  .ring .ring-fill { fill: none; stroke-width: 7; stroke-linecap: round; transition: stroke-dashoffset .7s cubic-bezier(.4,0,.2,1); }
  .ring .ring-label {
    position: absolute; inset: 0; display: grid; place-items: center;
    font-size: 15px; font-weight: 700;
  }
  .ring-info .rt { font-size: 14px; font-weight: 600; }
  .ring-info .rs { font-size: 12.5px; color: var(--muted-dim); }

  /* Recent list */
  .recent-list { display: flex; flex-direction: column; }
  .recent-item {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 0; border-bottom: 1px solid var(--border);
    text-decoration: none; color: inherit;
  }
  .recent-item:last-child { border-bottom: none; }
  .recent-item:hover .ri-title { color: var(--accent); }
  .ri-badge {
    width: 34px; height: 34px; border-radius: 10px; flex: 0 0 auto;
    background: linear-gradient(135deg, rgba(79,140,255,0.25), rgba(168,85,247,0.25));
    display: grid; place-items: center; font-size: 15px;
  }
  .ri-body { flex: 1; min-width: 0; }
  .ri-title {
    font-size: 13.5px; font-weight: 600; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; transition: color .15s;
  }
  .ri-meta { font-size: 12px; color: var(--muted-dim); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ri-time { font-size: 11.5px; color: var(--muted); flex: 0 0 auto; text-align: right; }
  .empty { color: var(--muted-dim); font-size: 13px; padding: 20px 0; text-align: center; }

  footer {
    margin-top: 20px; color: var(--muted-dim); font-size: 12px;
    display: flex; justify-content: space-between; flex-wrap: wrap; gap: 10px;
  }
  footer .refresh { display: inline-flex; align-items: center; gap: 6px; }
  @media (max-width: 860px) {
    .stats { grid-template-columns: repeat(2, 1fr); }
    .two-col { grid-template-columns: 1fr; }
  }
  @media (max-width: 460px) {
    .stats { grid-template-columns: 1fr; }
    body { padding: 24px 16px 40px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand">
      <div class="logo">🚨</div>
      <div>
        <h1>OLJAlerts</h1>
        <div class="sub">Job alert pipeline status</div>
      </div>
    </div>
    <div class="status-pill">
      <span class="dot" id="overall-dot"></span><span id="overall-text">Connecting…</span>
    </div>
    <a href="/jobs" style="text-decoration:none;color:#eef2f8;font-size:13px;font-weight:600;padding:9px 15px;border-radius:11px;border:1px solid rgba(255,255,255,0.13);background:rgba(21,27,40,0.72)">Browse jobs →</a>
  </header>
  <div class="stats">
    <div class="card">
      <div class="label"><span class="ic">📦</span> Jobs total</div>
      <div class="value" id="jobsTotal">—</div>
      <div class="delta zero" id="jobsTotalDelta">&nbsp;</div>
    </div>
    <div class="card">
      <div class="label"><span class="ic">🆕</span> New (24h)</div>
      <div class="value" id="newLast24h">—</div>
      <div class="delta" id="newLastHourDelta">&nbsp;</div>
    </div>
    <div class="card">
      <div class="label"><span class="ic">⏳</span> Pending</div>
      <div class="value" id="jobsPending">—</div>
      <div class="delta zero">awaiting match</div>
    </div>
    <div class="card">
      <div class="label"><span class="ic">👥</span> Subscribers</div>
      <div class="value" id="subscribers">—</div>
      <div class="delta zero" id="keywordsDelta">&nbsp;</div>
    </div>
  </div>

  <div class="two-col">
    <div class="panel">
      <h2>📊 Jobs scraped · last 14 days</h2>
      <div class="panel-sub" id="chartSub">daily volume</div>
      <svg class="chart" id="chart" preserveAspectRatio="none" viewBox="0 0 560 150">
        <defs>
          <linearGradient id="barGrad" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stop-color="#4f8cff"/>
            <stop offset="100%" stop-color="#a855f7"/>
          </linearGradient>
        </defs>
        <g id="chart-content"></g>
      </svg>
    </div>

    <div class="panel">
      <h2>🧩 Pipeline health</h2>
      <div class="panel-sub">derived from data freshness</div>
      <div class="rings">
        <div class="ring-row">
          <div class="ring">
            <svg width="62" height="62"><circle class="ring-bg" cx="31" cy="31" r="26"></circle>
            <circle class="ring-fill" id="ring-db" cx="31" cy="31" r="26" stroke="#34d399" stroke-dasharray="163.4" stroke-dashoffset="163.4"></circle></svg>
            <div class="ring-label" id="ring-db-label">—</div>
          </div>
          <div class="ring-info">
            <div class="rt">Database</div>
            <div class="rs" id="ring-db-sub">checking…</div>
          </div>
        </div>
        <div class="ring-row">
          <div class="ring">
            <svg width="62" height="62"><circle class="ring-bg" cx="31" cy="31" r="26"></circle>
            <circle class="ring-fill" id="ring-scraper" cx="31" cy="31" r="26" stroke="#34d399" stroke-dasharray="163.4" stroke-dashoffset="163.4"></circle></svg>
            <div class="ring-label" id="ring-scraper-label">—</div>
          </div>
          <div class="ring-info">
            <div class="rt">Scraper freshness</div>
            <div class="rs" id="ring-scraper-sub">checking…</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="panel">
    <h2>🕒 Latest job postings</h2>
    <div class="panel-sub">most recently scraped, newest first</div>
    <div class="recent-list" id="recent"><div class="empty">Loading…</div></div>
  </div>

  <footer>
    <span id="updated">—</span>
    <span class="refresh">Auto-refresh every 15s</span>
  </footer>
</div>

<script>
  var RING_CIRC = 163.4;
  function relative(iso) {
    if (!iso) return '';
    var secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 0) return 'in the future';
    if (secs < 5) return 'just now';
    var units = [['year',31536000],['month',2592000],['week',604800],['day',86400],['hour',3600],['minute',60],['second',1]];
    for (var i = 0; i < units.length; i++) {
      var n = Math.floor(secs / units[i][1]);
      if (n >= 1) return n + ' ' + units[i][0] + (n > 1 ? 's' : '') + ' ago';
    }
    return 'just now';
  }
  function human(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString(undefined, {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }
  function fmtDay(key) {
    var d = new Date(key + 'T00:00:00');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function setRing(id, pct, color) {
    var el = document.getElementById(id);
    if (!el) return;
    el.setAttribute('stroke', color);
    el.setAttribute('stroke-dashoffset', String(RING_CIRC * (1 - Math.max(0, Math.min(1, pct)))));
  }

  function renderChart(daily) {
    var g = document.getElementById('chart-content');
    if (!daily || !daily.length) { g.innerHTML = ''; return; }
    var W = 560, H = 150, pad = 18, bottom = 26;
    var max = Math.max.apply(null, daily.map(function (d) { return d.count; }).concat([1]));
    var n = daily.length;
    var slot = (W - pad * 2) / n;
    var barW = slot * 0.6;
    var html = '';
    // grid lines
    for (var gl = 0; gl <= 3; gl++) {
      var y = pad + (H - pad - bottom) * (gl / 3);
      html += '<line class="grid-line" x1="' + pad + '" y1="' + y + '" x2="' + (W - pad) + '" y2="' + y + '"></line>';
    }
    for (var i = 0; i < n; i++) {
      var d = daily[i];
      var h = max > 0 ? (d.count / max) * (H - pad - bottom) : 0;
      var x = pad + i * slot + (slot - barW) / 2;
      var y2 = H - bottom - h;
      html += '<rect class="bar" data-t="' + esc(fmtDay(d.day)) + ': ' + d.count + '" x="' + x + '" y="' + y2 + '" width="' + barW + '" height="' + Math.max(h, 2) + '" rx="3"></rect>';
      if (i % 3 === 0 || i === n - 1) {
        html += '<text class="axis" x="' + (x + barW / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(fmtDay(d.day)) + '</text>';
      }
    }
    g.innerHTML = html;
  }

  function renderRecent(list) {
    var el = document.getElementById('recent');
    if (!list || !list.length) { el.innerHTML = '<div class="empty">No job postings yet.</div>'; return; }
    el.innerHTML = list.map(function (j) {
      var meta = [j.typeOfWork, j.compensation].filter(Boolean).map(esc).join(' · ');
      return '<a class="recent-item" href="https://www.onlinejobs.ph/jobseekers/job/' + j.jobId + '" target="_blank" rel="noopener">' +
        '<div class="ri-badge">💼</div>' +
        '<div class="ri-body">' +
          '<div class="ri-title">' + esc(j.title || ('Job #' + j.jobId)) + '</div>' +
          '<div class="ri-meta">' + (meta || '—') + '</div>' +
        '</div>' +
        '<div class="ri-time">' + esc(relative(j.createdAt)) + '</div>' +
      '</a>';
    }).join('');
  }

  function load() {
    fetch('/status.json').then(function (r) { return r.json(); }).then(function (data) {
      document.getElementById('jobsTotal').textContent = data.jobsTotal;
      document.getElementById('newLast24h').textContent = data.newLast24h;
      document.getElementById('jobsPending').textContent = data.jobsPending;
      document.getElementById('subscribers').textContent = data.subscribers;

      document.getElementById('jobsTotalDelta').textContent = 'last job ' + (relative(data.lastJobCreatedAt) || '—');
      var hEl = document.getElementById('newLastHourDelta');
      hEl.textContent = (data.newLastHour > 0 ? '+' : '') + data.newLastHour + ' in last hour';
      hEl.className = 'delta ' + (data.newLastHour > 0 ? 'pos' : 'zero');
      document.getElementById('keywordsDelta').textContent = data.keywords + ' keywords tracked';

      renderChart(data.daily);
      renderRecent(data.recent);

      var dbOk = data.db && data.db.ok;
      setRing('ring-db', dbOk ? 1 : 0, dbOk ? '#34d399' : '#f87171');
      document.getElementById('ring-db-label').textContent = dbOk ? '✓' : '✕';
      document.getElementById('ring-db-sub').textContent = dbOk ? 'Connected' : 'Unreachable';

      var stale = data.stale;
      setRing('ring-scraper', stale ? 0.5 : 1, stale ? '#fbbf24' : '#34d399');
      document.getElementById('ring-scraper-label').textContent = stale ? '!' : '✓';
      document.getElementById('ring-scraper-sub').textContent = data.lastJobCreatedAt
        ? 'last run ' + relative(data.lastJobCreatedAt)
        : 'no data yet';

      var od = document.getElementById('overall-dot');
      var ot = document.getElementById('overall-text');
      if (!dbOk) { od.className = 'dot bad'; ot.textContent = 'Database down'; }
      else if (stale) { od.className = 'dot warn'; ot.textContent = 'Scraper stale'; }
      else { od.className = 'dot ok'; ot.textContent = 'All systems healthy'; }

      document.getElementById('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
    }).catch(function () {
      var od = document.getElementById('overall-dot');
      od.className = 'dot bad';
      document.getElementById('overall-text').textContent = 'Offline';
      document.getElementById('updated').textContent = 'Last attempt ' + new Date().toLocaleTimeString();
    });
  }

  load();
  setInterval(load, 15000);
</script>
</body>
</html>`;

const JOBS_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OLJAlerts — Jobs</title>
<style>
  :root {
    --bg: #070a12; --panel: rgba(21,27,40,0.72); --border: rgba(255,255,255,0.07);
    --border-strong: rgba(255,255,255,0.13); --text: #eef2f8; --muted: #8a97ad;
    --muted-dim: #667085; --accent: #4f8cff; --accent-2: #a855f7;
    --ok: #34d399; --warn: #fbbf24; --bad: #f87171;
    --shadow: 0 10px 40px -12px rgba(0,0,0,0.65);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    min-height: 100vh; padding: 40px 24px 56px; display: flex; flex-direction: column;
    align-items: center; overflow-x: hidden;
  }
  body::before {
    content: ""; position: fixed; inset: 0; z-index: -1;
    background:
      radial-gradient(900px 500px at 15% -5%, rgba(79,140,255,0.16), transparent 60%),
      radial-gradient(800px 500px at 90% 0%, rgba(168,85,247,0.13), transparent 60%),
      radial-gradient(700px 600px at 50% 110%, rgba(52,211,153,0.08), transparent 60%);
  }
  .wrap { width: 100%; max-width: 1180px; }
  header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; margin-bottom: 24px; }
  .brand { display: flex; align-items: center; gap: 14px; }
  .logo { width: 46px; height: 46px; border-radius: 14px; background: linear-gradient(135deg, var(--accent), var(--accent-2)); display: grid; place-items: center; font-size: 23px; box-shadow: 0 10px 30px -8px var(--accent); }
  h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.4px; }
  .sub { color: var(--muted); font-size: 13px; }
  .nav { display: flex; gap: 8px; }
  .nav a {
    text-decoration: none; color: var(--muted); font-size: 13px; font-weight: 600;
    padding: 9px 15px; border-radius: 11px; border: 1px solid var(--border);
    background: var(--panel); transition: .15s;
  }
  .nav a:hover { color: var(--text); border-color: var(--border-strong); }
  .nav a.active { color: #fff; background: linear-gradient(135deg, var(--accent), var(--accent-2)); border-color: transparent; }

  .toolbar {
    display: flex; gap: 12px; flex-wrap: wrap; align-items: center;
    background: var(--panel); border: 1px solid var(--border); border-radius: 16px;
    padding: 14px; margin-bottom: 16px; backdrop-filter: blur(14px); box-shadow: var(--shadow);
  }
  .search { position: relative; flex: 1; min-width: 220px; }
  .search input {
    width: 100%; padding: 11px 14px 11px 40px; border-radius: 11px;
    background: rgba(0,0,0,0.28); border: 1px solid var(--border-strong);
    color: var(--text); font-size: 14px; outline: none; transition: .15s;
  }
  .search input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(79,140,255,0.18); }
  .search .mag { position: absolute; left: 13px; top: 50%; transform: translateY(-50%); color: var(--muted); font-size: 15px; }
  select {
    padding: 11px 14px; border-radius: 11px; background: rgba(0,0,0,0.28);
    border: 1px solid var(--border-strong); color: var(--text); font-size: 13.5px;
    outline: none; cursor: pointer;
  }
  select:focus { border-color: var(--accent); }
  label.mini { font-size: 12px; color: var(--muted-dim); margin-right: -4px; }

  .tablecard { background: var(--panel); border: 1px solid var(--border); border-radius: 16px; overflow: hidden; box-shadow: var(--shadow); backdrop-filter: blur(14px); }
  table { width: 100%; border-collapse: collapse; }
  thead th {
    text-align: left; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--muted); font-weight: 700; padding: 14px 16px; border-bottom: 1px solid var(--border);
    white-space: nowrap; user-select: none;
  }
  thead th.sortable { cursor: pointer; transition: color .15s; }
  thead th.sortable:hover { color: var(--text); }
  thead th .arrow { opacity: 0.45; margin-left: 5px; font-size: 10px; }
  tbody tr { border-bottom: 1px solid var(--border); cursor: pointer; transition: background .12s; }
  tbody tr:last-child { border-bottom: none; }
  tbody tr:hover { background: rgba(79,140,255,0.07); }
  tbody td { padding: 13px 16px; font-size: 13.5px; vertical-align: middle; }
  .jt { font-weight: 600; color: var(--text); max-width: 380px; }
  .jt:hover { color: var(--accent); }
  .mono { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 12.5px; }
  .tag { display: inline-block; padding: 3px 9px; border-radius: 7px; font-size: 11.5px; font-weight: 600; background: rgba(79,140,255,0.14); color: #9ec1ff; white-space: nowrap; }
  .pill-ok { color: var(--ok); } .pill-pending { color: var(--warn); }
  .empty { padding: 60px 20px; text-align: center; color: var(--muted-dim); }

  .pager { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-top: 16px; }
  .pager .info { color: var(--muted); font-size: 13px; }
  .pages { display: flex; gap: 6px; flex-wrap: wrap; }
  .pages button {
    min-width: 36px; padding: 8px 11px; border-radius: 9px; border: 1px solid var(--border);
    background: var(--panel); color: var(--muted); font-size: 13px; font-weight: 600; cursor: pointer; transition: .15s;
  }
  .pages button:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
  .pages button.active { color: #fff; background: linear-gradient(135deg, var(--accent), var(--accent-2)); border-color: transparent; }
  .pages button:disabled { opacity: .35; cursor: not-allowed; }

  /* Drawer */
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); backdrop-filter: blur(3px); opacity: 0; pointer-events: none; transition: opacity .22s; z-index: 40; }
  .overlay.open { opacity: 1; pointer-events: auto; }
  .drawer {
    position: fixed; top: 0; right: 0; height: 100vh; width: 620px; max-width: 94vw;
    background: #10151f; border-left: 1px solid var(--border-strong); z-index: 50;
    transform: translateX(100%); transition: transform .26s cubic-bezier(.4,0,.2,1);
    display: flex; flex-direction: column; box-shadow: -20px 0 60px -20px rgba(0,0,0,0.8);
  }
  .drawer.open { transform: translateX(0); }
  .drawer-head { padding: 24px 26px 18px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
  .drawer-head h2 { font-size: 19px; font-weight: 700; line-height: 1.3; letter-spacing: -0.3px; }
  .drawer-head .close { background: rgba(255,255,255,0.07); border: none; color: var(--muted); width: 34px; height: 34px; border-radius: 10px; cursor: pointer; font-size: 17px; flex: 0 0 auto; }
  .drawer-head .close:hover { color: var(--text); background: rgba(255,255,255,0.13); }
  .drawer-body { padding: 22px 26px; overflow-y: auto; flex: 1; }
  .meta-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; margin-bottom: 22px; }
  .meta-item { background: rgba(0,0,0,0.22); border: 1px solid var(--border); border-radius: 11px; padding: 12px 14px; }
  .meta-item .k { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted-dim); font-weight: 700; margin-bottom: 5px; }
  .meta-item .v { font-size: 14px; font-weight: 600; }
  .section-title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); font-weight: 700; margin: 22px 0 10px; }
  .desc { font-size: 14px; line-height: 1.65; color: #cfd8e6; white-space: pre-wrap; word-break: break-word; }
  .apply {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    margin-top: 26px; padding: 14px; border-radius: 12px; text-decoration: none;
    background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff;
    font-weight: 700; font-size: 14.5px; box-shadow: 0 10px 30px -10px var(--accent);
  }
  .apply:hover { filter: brightness(1.08); }
  .skeleton { background: linear-gradient(90deg, rgba(255,255,255,0.04), rgba(255,255,255,0.09), rgba(255,255,255,0.04)); background-size: 200% 100%; animation: shimmer 1.4s infinite; border-radius: 8px; }
  @keyframes shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }
  footer { margin-top: 20px; color: var(--muted-dim); font-size: 12px; text-align: center; }
  @media (max-width: 720px) {
    .hide-sm { display: none; }
    .jt { max-width: 200px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand">
      <div class="logo">🚨</div>
      <div><h1>Scraped Jobs</h1><div class="sub" id="subtitle">browse, search, filter</div></div>
    </div>
    <div class="nav">
      <a href="/">Status</a>
      <a href="/jobs" class="active">Jobs</a>
    </div>
  </header>

  <div class="toolbar">
    <div class="search">
      <span class="mag">🔍</span>
      <input id="q" type="text" placeholder="Search title, description, pay…" autocomplete="off">
    </div>
    <select id="type"><option value="">All types</option></select>
    <select id="sort">
      <option value="createdAt:desc">Newest scraped</option>
      <option value="createdAt:asc">Oldest scraped</option>
      <option value="jobDate:desc">Posting date ↓</option>
      <option value="jobDate:asc">Posting date ↑</option>
      <option value="jobId:desc">Job ID ↓</option>
      <option value="jobId:asc">Job ID ↑</option>
      <option value="jobTitle:asc">Title A–Z</option>
      <option value="jobTitle:desc">Title Z–A</option>
    </select>
    <select id="pageSize">
      <option value="20">20 / page</option>
      <option value="50">50 / page</option>
      <option value="100">100 / page</option>
    </select>
  </div>

  <div class="tablecard">
    <table>
      <thead>
        <tr>
          <th class="sortable" data-sort="jobTitle">Title</th>
          <th class="sortable hide-sm" data-sort="jobId">ID</th>
          <th class="hide-sm">Type</th>
          <th class="hide-sm">Pay</th>
          <th class="sortable hide-sm" data-sort="jobDate">Posted</th>
          <th class="sortable" data-sort="createdAt">Scraped</th>
        </tr>
      </thead>
      <tbody id="rows"><tr><td colspan="6" class="empty">Loading…</td></tr></tbody>
    </table>
  </div>

  <div class="pager">
    <div class="info" id="info">—</div>
    <div class="pages" id="pages"></div>
  </div>

  <footer>Click any row for full details · <a href="/" style="color:var(--accent)">status dashboard</a></footer>
</div>

<div class="overlay" id="overlay"></div>
<aside class="drawer" id="drawer">
  <div class="drawer-head">
    <h2 id="d-title">Job</h2>
    <button class="close" id="d-close">✕</button>
  </div>
  <div class="drawer-body" id="d-body"></div>
</aside>

<script>
  var state = { page: 1, pageSize: 20, q: '', type: '', sort: 'createdAt', dir: 'desc' };
  var qTimer = null;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]; }); }
  function relative(iso) {
    if (!iso) return '—';
    var secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 5) return 'just now';
    var u = [['y',31536000],['mo',2592000],['w',604800],['d',86400],['h',3600],['m',60],['s',1]];
    for (var i=0;i<u.length;i++){ var n=Math.floor(secs/u[i][1]); if(n>=1) return n+u[i][0]+' ago'; }
    return 'just now';
  }
  function human(iso) { return iso ? new Date(iso).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'; }
  function longDate(s) { return s ? new Date(s+'T00:00:00').toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'}) : '—'; }

  function qs() {
    var p = new URLSearchParams();
    p.set('page', state.page); p.set('pageSize', state.pageSize);
    if (state.q) p.set('q', state.q);
    if (state.type) p.set('type', state.type);
    p.set('sort', state.sort); p.set('dir', state.dir);
    return p.toString();
  }

  function renderRows(jobs) {
    var el = document.getElementById('rows');
    if (!jobs.length) { el.innerHTML = '<tr><td colspan="6" class="empty">No jobs match your filters.</td></tr>'; return; }
    el.innerHTML = jobs.map(function (j) {
      return '<tr data-id="' + j.jobId + '">' +
        '<td class="jt">' + esc(j.title || ('Job #' + j.jobId)) + '</td>' +
        '<td class="mono hide-sm">' + j.jobId + '</td>' +
        '<td class="hide-sm">' + (j.typeOfWork ? '<span class="tag">' + esc(j.typeOfWork) + '</span>' : '—') + '</td>' +
        '<td class="hide-sm">' + esc(j.compensation || '—') + '</td>' +
        '<td class="mono hide-sm">' + esc(j.jobDate || '—') + '</td>' +
        '<td class="mono" title="' + esc(human(j.createdAt)) + '">' + esc(relative(j.createdAt)) + '</td>' +
      '</tr>';
    }).join('');
    Array.prototype.forEach.call(el.querySelectorAll('tr[data-id]'), function (tr) {
      tr.addEventListener('click', function () { openJob(tr.getAttribute('data-id')); });
    });
  }

  function renderPages(data) {
    var el = document.getElementById('pages');
    var cur = data.page, tot = data.totalPages, html = '';
    function btn(label, p, dis, act) {
      return '<button ' + (dis ? 'disabled' : '') + ' class="' + (act ? 'active' : '') + '" data-p="' + p + '">' + label + '</button>';
    }
    html += btn('‹', cur - 1, cur <= 1, false);
    var start = Math.max(1, cur - 2), end = Math.min(tot, start + 4);
    start = Math.max(1, end - 4);
    if (start > 1) html += btn('1', 1, false, cur === 1) + (start > 2 ? '<button disabled>…</button>' : '');
    for (var p = start; p <= end; p++) html += btn(p, p, false, p === cur);
    if (end < tot) html += (end < tot - 1 ? '<button disabled>…</button>' : '') + btn(tot, tot, false, cur === tot);
    html += btn('›', cur + 1, cur >= tot, false);
    el.innerHTML = html;
    Array.prototype.forEach.call(el.querySelectorAll('button[data-p]'), function (b) {
      b.addEventListener('click', function () { state.page = parseInt(b.getAttribute('data-p'), 10); load(); });
    });
    var from = data.total === 0 ? 0 : (cur - 1) * data.pageSize + 1;
    var to = Math.min(cur * data.pageSize, data.total);
    document.getElementById('info').textContent = 'Showing ' + from + '–' + to + ' of ' + data.total + ' jobs';
  }

  function fillTypes(types) {
    var sel = document.getElementById('type');
    if (sel.options.length > 1) return;
    types.forEach(function (t) {
      var o = document.createElement('option'); o.value = t; o.textContent = t; sel.appendChild(o);
    });
  }

  function load() {
    fetch('/jobs.json?' + qs()).then(function (r) { return r.json(); }).then(function (data) {
      renderRows(data.jobs);
      renderPages(data);
      fillTypes(data.types || []);
      document.getElementById('subtitle').textContent = data.total + ' jobs indexed';
    }).catch(function () {
      document.getElementById('rows').innerHTML = '<tr><td colspan="6" class="empty">Failed to load jobs.</td></tr>';
    });
  }

  function openJob(id) {
    var drawer = document.getElementById('drawer');
    document.getElementById('overlay').classList.add('open');
    drawer.classList.add('open');
    document.getElementById('d-title').innerHTML = '<span class="skeleton" style="display:inline-block;width:260px;height:22px"></span>';
    document.getElementById('d-body').innerHTML = '<span class="skeleton" style="display:block;height:60px;margin-bottom:14px"></span><span class="skeleton" style="display:block;height:120px"></span>';
    history.replaceState(null, '', '/jobs?id=' + id);
    fetch('/job.json?id=' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) { document.getElementById('d-title').textContent = 'Not found'; document.getElementById('d-body').innerHTML = '<p class="desc">' + esc(j.error) + '</p>'; return; }
      document.getElementById('d-title').textContent = j.title || ('Job #' + j.jobId);
      var meta = '';
      meta += '<div class="meta-item"><div class="k">Job ID</div><div class="v">' + j.jobId + '</div></div>';
      meta += '<div class="meta-item"><div class="k">Status</div><div class="v ' + (j.isProcessed ? 'pill-ok' : 'pill-pending') + '">' + (j.isProcessed ? 'Processed' : 'Pending') + '</div></div>';
      meta += '<div class="meta-item"><div class="k">Type</div><div class="v">' + esc(j.typeOfWork || '—') + '</div></div>';
      meta += '<div class="meta-item"><div class="k">Pay</div><div class="v">' + esc(j.compensation || '—') + '</div></div>';
      meta += '<div class="meta-item"><div class="k">Hours / week</div><div class="v">' + esc(j.hoursPerWeek || '—') + '</div></div>';
      meta += '<div class="meta-item"><div class="k">Posted</div><div class="v">' + esc(longDate(j.jobDate)) + '</div></div>';
      var body = '<div class="meta-grid">' + meta + '</div>';
      if (j.skills) body += '<div class="section-title">Skills</div><div class="desc">' + esc(j.skills) + '</div>';
      body += '<div class="section-title">Description</div><div class="desc">' + esc(j.description || 'No description.') + '</div>';
      body += '<a class="apply" href="https://www.onlinejobs.ph/jobseekers/job/' + j.jobId + '" target="_blank" rel="noopener">View on OnlineJobs.ph →</a>';
      document.getElementById('d-body').innerHTML = body;
    }).catch(function () {
      document.getElementById('d-body').innerHTML = '<p class="desc">Failed to load job details.</p>';
    });
  }
  function closeDrawer() {
    document.getElementById('drawer').classList.remove('open');
    document.getElementById('overlay').classList.remove('open');
    history.replaceState(null, '', '/jobs');
  }
  document.getElementById('d-close').addEventListener('click', closeDrawer);
  document.getElementById('overlay').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

  document.getElementById('q').addEventListener('input', function (e) {
    clearTimeout(qTimer);
    var v = e.target.value;
    qTimer = setTimeout(function () { state.q = v; state.page = 1; load(); }, 300);
  });
  document.getElementById('type').addEventListener('change', function (e) { state.type = e.target.value; state.page = 1; load(); });
  document.getElementById('pageSize').addEventListener('change', function (e) { state.pageSize = parseInt(e.target.value, 10); state.page = 1; load(); });
  document.getElementById('sort').addEventListener('change', function (e) {
    var parts = e.target.value.split(':'); state.sort = parts[0]; state.dir = parts[1]; state.page = 1; load();
  });
  Array.prototype.forEach.call(document.querySelectorAll('th.sortable'), function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      state.dir = (state.sort === key && state.dir === 'desc') ? 'asc' : 'desc';
      state.sort = key; state.page = 1;
      document.getElementById('sort').value = key + ':' + state.dir;
      load();
    });
  });

  load();
  var initialId = new URLSearchParams(location.search).get('id');
  if (initialId) openJob(initialId);
</script>
</body>
</html>`;

export async function startStatus(): Promise<void> {
  if (!STATUS_ENABLED) {
    console.log('Status dashboard disabled via env');
    return;
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (req.method !== 'GET') {
        res.writeHead(405);
        return res.end('Method Not Allowed');
      }

      if (url.pathname === '/status.json') {
        try {
          const payload = await collectStatus();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(payload));
        } catch (err) {
          console.error('[status] db query failed:', err);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(
            JSON.stringify({
              up: true,
              jobsTotal: 0,
              jobsPending: 0,
              lastJobCreatedAt: null,
              lastJobDate: null,
              subscribers: 0,
              keywords: 0,
              newLastHour: 0,
              newLast24h: 0,
              daily: [],
              recent: [],
              db: { ok: false },
              stale: false,
            }),
          );
        }
      }

      if (url.pathname === '/healthz') {
        try {
          await db.select({ count: sql`COUNT(*)` }).from(jobPostings);
          res.writeHead(200);
          return res.end('OK');
        } catch {
          res.writeHead(503);
          return res.end('Service Unavailable');
        }
      }

      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(PAGE);
      }

      if (url.pathname === '/jobs') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(JOBS_PAGE);
      }

      if (url.pathname === '/jobs.json') {
        try {
          const data = await listJobs(url.searchParams);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(data));
        } catch (err) {
          console.error('[status] jobs query failed:', err);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(
            JSON.stringify({ page: 1, pageSize: 20, total: 0, totalPages: 1, jobs: [], types: [] }),
          );
        }
      }

      if (url.pathname === '/job.json') {
        const id = Number(url.searchParams.get('id'));
        if (!Number.isFinite(id) || id <= 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'invalid id' }));
        }
        try {
          const job = await getJob(id);
          if (!job) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'job not found' }));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(job));
        } catch (err) {
          console.error('[status] job query failed:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'query failed' }));
        }
      }

      res.writeHead(404);
      return res.end('Not Found');
    } catch (err) {
      console.error('[status] server error:', err);
      res.writeHead(500);
      return res.end('Server Error');
    }
  });

  server.listen(STATUS_PORT, () => {
    console.log(`Status dashboard listening on :${STATUS_PORT}`);
  });
}
