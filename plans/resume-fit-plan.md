# Resume Fit Plan

Status: implemented.

## Goal

Let a subscriber paste a plain-text resume. When a resume is saved, each matching job alert also gets a 1-10 skills-fit score against that resume, plus two strengths and two gaps. The fit is produced by the same main AI call as the existing AI overview, not a separate fit call. The existing scam escalation pass is unchanged and may still add a second call. No resume means no fit, and behaviour stays exactly as today.

The fit score is a skills match only. It is never a scam or legitimacy verdict. The existing overview keeps that job.

## Decisions

- Input: one pasted text message. No file upload, no PDF parsing. Telegram caps a message at 4096 characters, so 4000 leaves a safe margin.
- Length: 200 to 4000 characters, measured after trimming. The limit is shown in `/resume`, the error message, `/resume status`, and `/mysubs`.
- Commands: `/resume` starts a pending paste, `/resume status` shows state, `/resume clear` removes text and fits.
- Storage: resume text stored raw in Postgres until `/resume clear`.
- Versioning: separate `FIT_VERSION`. Do not bump `AI_VERSION`, so shared overview caches are not invalidated.
- Cache: one combined overview+fit result per `(chat_id, job_id)`, invalidated when the resume changes.
- Timing: alerts wait up to 180 seconds for a fit. After that they send without it.
- Queue: fits use their own lane, concurrency 2, so shared job analysis never starves. Concurrency 1 was rejected: one job matched by several resume users would miss the 180-second window and most alerts would lose their fit.
- Failure: never lose an alert because a fit failed. Send without the fit block.
- Kill switch: `RESUME_FIT_ENABLED=false` disables fit generation and display. Resume text is kept.
- `/ai off` wins. If AI is off, no fit runs and none is shown, even with a saved resume.
- Alert detail: score, derived label, two strengths, two gaps. No long note in the alert; the note appears in `/job`.
- Fit label is derived from the score, not a model field: 1-3 Weak, 4-6 Partial, 7-8 Strong, 9-10 Excellent.
- Fit feedback: none in v1. Existing helpful/unhelpful buttons stay overview-only.
- Backfill: new alerts only. No model calls for already-sent alerts.
- Pending paste state: in bot memory with a 15-minute TTL. A restart loses it and the user repeats `/resume`. Any command other than `/resume` cancels the pending paste, so a later stray message is not swallowed as resume text.

Assumption to confirm: saving a resume turns AI overview on for that chat if it was off, with an explicit notice. After that, `/ai off` always wins. This matches "optional and off by default unless the user adds resume text".

## Architecture

Today the overview is job-only and cached once in `job_postings.ai_overview`, shared by every subscriber. A resume is per subscriber, so resume-aware output cannot use that cache.

Two paths:

1. No resume, or AI off: current behaviour. Shared job analysis, cached in `job_postings`, no fit.
2. Resume saved and AI on: one combined call per `(chat, job)`, cached in a new `job_fits` table. The job-level shared analysis is still produced for non-resume users, but the combined result is never written back to `job_postings`.

This means a resume user can cause two model calls for the same job: one shared overview, one combined overview+fit. Accepted for v1 to keep the existing shared path untouched. If every AI-enabled user has a resume, the shared call can later be skipped; not in v1.

## Data Model

`user_settings` gains:

- `resume_text text` nullable. Null means no resume.
- `resume_hash text` nullable. SHA-256 of the saved text, used to validate cached fits.
- `resume_updated_at timestamptz` nullable.

New `job_fits` table:

- `id serial primary key`
- `chat_id bigint not null`
- `job_id bigint not null` (OLJ job id, same id used by notifications and callbacks)
- `resume_hash text not null`
- `fit_version int not null`
- `analysis jsonb not null`
- `usage jsonb`
- `created_at timestamptz default now()`
- unique `(chat_id, job_id)`
- index on `job_id` for cleanup and per-job cache reads

Schema bootstrap goes in `BOOTSTRAP_SQL` in `src/db.ts`, additive only:

```sql
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS resume_text text;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS resume_hash text;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS resume_updated_at timestamptz;
CREATE TABLE IF NOT EXISTS job_fits (
  id serial PRIMARY KEY,
  chat_id bigint NOT NULL,
  job_id bigint NOT NULL,
  resume_hash text NOT NULL,
  fit_version int NOT NULL,
  analysis jsonb NOT NULL,
  usage jsonb,
  created_at timestamptz DEFAULT now(),
  UNIQUE (chat_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_job_fits_job_id ON job_fits(job_id);
```

On resume save or clear, delete every `job_fits` row for that chat. The hash check is a second guard against a stale row.

## Types and Parsing

Add to `src/overview.ts`:

```ts
export type FitAnalysis = {
  score: number | null;
  strengths: string[];
  gaps: string[];
  note: string;
};

export type JobAnalysis = {
  // existing fields...
  fit?: FitAnalysis | null;
};

export const FIT_VERSION = 1;
```

Parsing rules:

- `fit_score`: integer 1-10, or null when the job listing or the resume has too little skill detail to judge. Accept a numeric string like `"8"`, but reject floats and out-of-range values.
- `fit_strengths`: array, max 2, each cleaned, capped like other fields, and passed through `redactEmails` plus `redactPhones`.
- `fit_gaps`: array, max 2, same redaction.
- `fit_note`: one short sentence, same redaction.
- Parsing is lenient: ignore empty or invalid array entries instead of dropping the whole fit. A fit is usable when it has a numeric score or a non-empty note; arrays are optional. Drop the fit only when the score is null and the note is empty.
- Invalid or missing fit fields do not reject the overview. The overview still saves, with `fit: null`. Log one line.
- The display label is computed at render time from the score. It is not stored and cannot drift from the number.

## Combined AI Call

Extend `analyzeFields` with an options object:

```ts
analyzeFields(job, pay, employer, duplicate, {
  resume?: string,
  fetchImpl?: typeof fetch,
})
```

Existing callers in `src/scripts/eval-real.ts` and `src/scripts/eval-overview.ts` pass four arguments and keep working.

When `resume` is present:

- Build a fit variant of `SYSTEM_PROMPT`. The base line `Return ONLY a JSON object with exactly these fields` must be rewritten to include the four fit fields, otherwise the model will follow the old instruction and omit them. Add one short fit example to the examples block.
- Append a fit instruction block to the system prompt. The overview JSON fields stay exactly the same, plus flat `fit_score`, `fit_strengths`, `fit_gaps`, `fit_note` fields. Do not nest them under a `fit` object.
- Add `resume` and `fit_requirements` to the user JSON. `fit_requirements` is built from the full job description, not only the 2500-character overview excerpt: collect lines matching requirements, skills, qualifications, experience, tools, seniority, or years, dedupe, and cap at 1000 characters. This stops a long listing from hiding the must-haves beyond the excerpt.
- The resume is data, never instructions. Say so in the system prompt.
- Redact emails and phones with the existing `redactEmails` and `redactPhones` helpers before sending.
- Redact the model's fit strings again before storing. The model may echo a contact detail despite the rule.
- Include the same pay, employer, signals, and excerpt as the shared call.
- Keep the existing escalation pass unchanged. Escalation judges legitimacy only. Fit is not escalated.

Score anchors in the prompt:

- 1-3: misses most must-haves.
- 4-6: partial, some must-haves missing.
- 7-8: meets most must-haves, some nice-to-haves missing.
- 9-10: meets all must-haves and most nice-to-haves.
- null when the listing or the resume does not state enough skill detail to judge.

Rules to include:

- Skills only. Ignore pay, hours, and location for the score.
- Strengths and gaps must reference facts in the resume and the listing.
- Do not credit skills the resume does not state.
- Do not claim hiring odds. Fit is not a prediction of being hired.
- Never repeat contact details from the resume in the output.

## Fit Queue and Cache

Add a second queue in `src/overview.ts`, following the existing pattern:

- `enqueueFit(jobDbId, chatId, jobId, resumeHash)`
- `FIT_WAIT_MS = 180_000`
- concurrency 2, separate pending set and pump; two calls can run while the shared pump keeps its own two
- an active-key set keyed `chat:job` stays populated until the call finishes, so the next notifier tick cannot enqueue a duplicate while the first call is still running
- skips when `RESUME_FIT_ENABLED` is false, `OPENCODE_API_KEY` is missing, or AI is off for that chat
- reads the job and resume, then verifies the captured hash matches the chat's current `resume_hash`. If not, drop the request; the notifier enqueues a fresh one on the next tick.
- if a matching cached row exists with `fit_version = FIT_VERSION` and embedded `analysis.version = AI_VERSION`, do nothing
- otherwise calls `analyzeFields` with the resume, then writes into `job_fits`
- only writes when the result contains a non-null `fit`. A combined result with no valid fit is treated as a failed fit, so it retries inside the window instead of caching a fitless row
- logs `[fit]` with tokens and latency, same shape as `[overview]`

Refactor the shared job context building (pay insight, employer lookup, duplicate lookup, description hash) into one helper used by both `analyzeJobById` and the fit path. This avoids drift between the two calls.

Write race: a resume can change while a fit call is in flight. Before writing, open a transaction, lock the chat's `user_settings` row with `FOR UPDATE`, and re-read `resume_hash` and `ai_overview`. If either no longer matches, drop the result. Save and clear update that same row, so the lock serializes them with the fit write: a stale fit can neither insert after a clear nor overwrite a newer fit.

On resume save or clear, remove queued fit jobs for that chat from the in-memory queue as well as deleting stored rows. In-flight calls still finish, then drop on the hash check.

Failed or empty calls write nothing. The notifier can enqueue again on the next tick until the wait window closes. After that the job is sent and no further fit is attempted, because the job is marked processed. Add an in-memory last-attempt timestamp to avoid retrying the same chat and job every 20 seconds.

## Bot UX

Telegram caps a text message at 4096 characters. The resume cap is 4000, so one paste always fits with margin. The limit is stated before the user types, not only after a rejection.

The entire resume flow is private-chat only. In a group or channel, `/resume` replies `DM the bot to add a resume.` This prevents a resume from being pasted into a public chat.

Add one bot middleware that runs before command handlers: any command whose text is not `/resume...` cancels a pending paste. `/resume status` is exempt. This keeps `/help` or `/mysubs` from leaving a flag that later swallows a normal message.

`/resume` with no argument:

- Shows whether a resume is saved: character count out of 4000, and last-updated date. Never the text.
- Sets a pending paste flag for that chat.
- Replies: `Paste your resume as one message. 200-4000 characters. Send /resume clear to cancel.`

Text message while pending:

- Trim and validate 200 to 4000 characters.
- Too short or too long: reply `Resume must be 200-4000 characters. Yours is N. Paste a shorter version or /resume clear.` Keep the flag so the user can retry.
- Non-text message: reply `Send resume as text only.`
- Valid: compute SHA-256. If the hash matches the saved resume, keep existing fits and reply that the resume is unchanged.
- Otherwise save text, hash, and timestamp, delete that chat's `job_fits` rows, clear the flag, and reply with character count and the privacy note. Save and delete run in one transaction.
- If AI was off, turn `ai_overview` on and say so. `/ai off` still overrides later.
- If `OPENCODE_API_KEY` is missing, say the resume is saved but fit checks are unavailable until AI is configured.

`/resume status`:

- Saved or not: `Resume: saved (3,214/4,000 chars, 21 Nov 2026)` or `Resume: not set (max 4,000 chars)`.
- Whether fit is active (`AI ON`, resume saved, kill switch on).
- If a paste is pending: `Waiting for resume text (200-4,000 chars).`

`/resume clear`:

- Null the three resume columns, delete that chat's `job_fits`, clear the flag.
- Reply that the resume and saved fits are removed. Keep the AI setting unchanged.

`/mysubs` and `/help`:

- Add resume state to `/mysubs`: `Resume: saved (3,214/4,000 chars, 21 Nov 2026)` or `Resume: not set (max 4,000 chars)`.
- Add `/resume — add, view, or clear your resume (max 4,000 chars)` to help.
- `/ai` help line mentions that fit uses the saved resume when one exists.

Privacy note shown once on save:

> Resume saved. It is stored in the database until you run /resume clear, and it is sent to the AI model only for fit checks. Emails and phone numbers are removed before the model call. Your pasted message stays in this chat, so delete it if you want.

## Notifier Flow

In `runNotifier`:

1. Load AI-enabled chats as today.
2. Load resume chats separately: `ai_overview = true`, `resume_text is not null`, kill switch on.
3. For each job, recipients already carry `matches`. Split them into resume recipients and shared recipients.
4. Read cached fits for the job once: `select chat_id, analysis from job_fits where job_id = ... and fit_version = FIT_VERSION`. Parse and validate each row; a malformed row is treated as missing.
5. For each resume recipient without a valid cached fit, `enqueueFit(...)`.
6. Wait logic:
   - `shouldAwaitAi` receives only recipients that actually need the shared analysis, and returns false when the API key is missing. A resume recipient with a valid fit does not need it.
   - new `shouldAwaitFit` for recipients that need a fit and are inside the wait window. The window starts when the notifier first sees the job and fit for that chat, stored in an in-memory `firstSeen` map, not `job.createdAt`. A backlog or restart must still give a fit a chance to land. It returns false when the kill switch is off, the API key is missing, AI is off, or the fit is already ready.
   - hold only the recipients whose own lane is still waiting. Send ready recipients now and keep the job unprocessed for the rest. A pending resume fit never holds shared recipients, and a pending shared overview never holds resume recipients.
7. When sending each recipient:
   - resume recipient with a valid cached fit: use that analysis, including `fit`
   - resume recipient without a fit: fall back to the shared `job.aiAnalysis` if current, otherwise send with no AI block
   - non-resume recipient: current shared analysis
   - re-read the current resume and fit before rendering a resume alert, so a save or clear during the tick cannot show the old fit
8. Mark the job processed only after every recipient is sent or permanently failed.
9. Clear that job's `firstSeen` and last-attempt entries when the job is processed or no longer in the batch.

`shouldAwaitFit` is a pure function with self-checks, like `shouldAwaitAi`.

Edge case: a resume recipient's fit fails permanently. The alert still sends at the 180 second mark with the shared overview and no fit. `/job` will not regenerate it, because that would add unbudgeted cost. The next job gets a fresh chance.

## Alert Rendering

`buildAlertCaption` receives the analysis object, which may now contain `fit`. Its public signature stays the same; the internal `aiBlock` takes the fit as a second argument.

Render one compact block after the AI overview:

```
🎯 Resume fit: 8/10 Strong
+ React, 3 yrs e-commerce
- No Amazon experience, no PPC
```

When score is null:

```
🎯 Resume fit: not enough info
```

The derived label is fixed by the score bands, not generated. All fit strings are HTML-escaped and URL-defanged like the overview text.

Budget: overview block cap drops from 700 to 460 characters when a fit block is present. Fit block cap is 240 characters. Trim order: drop optional overview lines first, then the second gap, then the second strength. Keep the score line. The final caption must stay under the existing 1000 character check, which is the Telegram photo caption limit, not 4096.

No fit block when:

- no resume
- AI off
- kill switch off
- fit call not ready or failed
- parsed fit is null

`hasAi` and the keyboard stay driven by the AI block, as today.

## /job Detail

`buildJobDetail` should:

- ignore `job_fits` entirely when `RESUME_FIT_ENABLED` is false
- first look for a `job_fits` row for this chat and job with the current resume hash, `FIT_VERSION`, and embedded `analysis.version = AI_VERSION`
- use the shared `job.aiAnalysis` if no fit row exists
- keep the existing version check for shared analysis
- render a `🎯 Resume fit` section after the overview: score or "not enough info", derived label, strengths, gaps, note, and one line saying it uses the saved resume
- not trigger a new model call
- include the fit section in the `JOB_DETAIL_CAP` trimming loop, so a long fit cannot push the message past the cap

If neither a fit nor a current shared analysis exists, keep the current failure messages.

## Security and Privacy

- Resume text is stored in plain text in Postgres until the user clears it.
- Contact details are stripped before every model call, but the stored copy stays raw so future fit calls stay accurate.
- Model-authored fit strings are redacted before storage, because the model can echo contact details.
- The bot never echoes the resume text. Status shows character count and date only.
- The model receives the resume for fit checks. This is stated on save.
- The resume is untrusted input. The prompt must treat it as data and ignore instructions inside it.
- Do not log resume text or the full prompt. Hash and character count are safe to log.
- Resume write errors log a code or message only, never query parameters, because the parameter is the resume text.
- `/resume clear` deletes both text and cached fits in one flow.
- Database backups may retain old resume text until they age out. `/resume clear` cannot reach backups; this is disclosed in the plan, not promised away in the bot.

## Failure Handling

- Model timeout or invalid JSON: no fit row, retry on a later tick while inside the wait window.
- Model 429 or 5xx: same as timeout, retry within the window.
- Database write failure after a successful call: log and continue. The alert still sends without fit if the row is not stored.
- Kill switch or missing API key: no call, no fit, alerts use the shared path with no delay.
- Resume text changed mid-flight: the cached row fails the hash check, so it is ignored. The next tick re-enqueues.

## Cost

Per resume user per matched job: roughly 1k resume tokens, 250 requirement tokens, 700 job tokens, and 200 output tokens. One main call. The existing escalation pass can still add a second call when hard scam flags trigger; fit itself is never escalated. Cached per chat and job, so repeated `/job` taps are free.

Cost scales as resume users multiplied by matched jobs. There is no cap, by decision. `usage` is stored per fit and logged so real spend can be measured after launch. Shared and per-user calls can both run for the same job; that duplication is accepted in v1.

## Files to Change

- `src/schema.ts`: resume columns, `job_fits` table, types.
- `src/db.ts`: additive bootstrap SQL.
- `src/resume.ts` (new): validation, hashing, status text, privacy copy, self-check.
- `src/overview.ts`: `FIT_VERSION`, `FitAnalysis`, fit prompt, fit parsing, shared context helper, fit queue, cache read/write.
- `src/alert.ts`: fit block, budget trimming, self-checks.
- `src/notifier.ts`: resume chats, fit cache read, enqueue, wait logic, fallback.
- `src/bot.ts`: `/resume` commands, pending paste handling, `/mysubs`, help.
- `src/index.ts`: no change unless fit queue needs a startup sweep. Not in v1.
- `package.json`: add `check:resume` and include it in `test`.
- `.env.example`: `RESUME_FIT_ENABLED=true`.
- `README.md`: commands and env note.

## Tests

No framework. Use the existing self-check pattern.

- `src/resume.ts`: trim, 200/4000 bounds, over-limit rejection keeps pending, hash stability, status text hides text, non-private chat rejection.
- `src/overview.ts`: parse a valid fit, reject bad score, accept a numeric-string score, allow null score with a note, cap oversized arrays, confirm the fit prompt contains the anchors, confirm no fit when resume is absent, redact echoed contact details, ignore a cached fit from another `FIT_VERSION` or `AI_VERSION`.
- `src/alert.ts`: fit block renders with strengths and gaps and derived label, null score renders the no-info line, caption stays under 1000, fit disappears when absent, long fit is trimmed before the score line.
- `src/notifier.ts`: `shouldAwaitFit` for fresh, stale, ready, API-key-missing, and disabled cases; `shouldAwaitAi` for a missing key; resume recipients are excluded from `shouldAwaitAi`; a held resume fit or shared overview does not block the other lane; an active fit key is not enqueued twice.
- `npm run build` for type checking.
- Manual test with a real key: save a 4000-character resume, trigger one matching job, check one call in logs, alert shows fit, `/job` shows the note, `/resume clear` hides it.

## Rollout

1. Deploy schema and code with `RESUME_FIT_ENABLED=false`. No behaviour change; verify startup and shared alerts still work. The flag is read as `process.env.RESUME_FIT_ENABLED !== 'false'`, so unset means enabled after rollout.
2. Run the self-checks and a build.
3. Enable the flag. Test with one chat and one matching job.
4. Before announcing, run one synthetic resume against five real job fixtures. Check that scores follow the anchors, that null appears for thin listings, and that no contact details leak. This is a quality gate, not a unit test.
5. Watch `[fit]` logs for token use, latency, and failure rate.
6. Announce `/resume` in help.

## Audit Findings Resolved

1. Telegram caps one text message at 4096 characters. A 6000-character target was unreachable in one paste. Final decision: cap at 4000, single paste, and show the limit in the UI.
2. The earlier multi-part design would have needed a buffer, a fourth command, and partial-resume handling. The lower cap removes all three.
3. Alert captions cap at 1000 characters, not 4096. The budget drops the overview block to 460 and the fit block to 240.
4. `/job` did not account for the fit section in its 3500-character trimming. Fixed by including fit lines in the trim loop.
5. Resume recipients were about to be passed into `shouldAwaitAi`, which would delay their alerts for a shared overview they do not need. Wait logic now splits recipient types.
6. Cached fit rows did not check `AI_VERSION`, so a prompt bump would render stale overview text from a fit row. Added the embedded version check.
7. A resume change during an in-flight call could overwrite a newer fit. The write now runs in a transaction that locks the chat's settings row, so save, clear, and fit writes serialize.
8. Model output could echo resume contact details. Fit strings are redacted before storage, not only before the call.
9. Concurrency 1 would miss the 180-second window when several resume users match the same job. Raised the fit lane to concurrency 2.
10. A malformed `job_fits` row could crash the notifier or `/job`. Cached analysis is parsed and validated; malformed rows are ignored.
11. A 15-minute TTL and command cancellation prevent a stale pending flag from swallowing a later message.
12. Fits were described without a verdict word. Added a derived label from fixed score bands, matching the "score plus verdict" choice.
13. The wait window was tied to `job.createdAt`. A backlog or restart would have sent old jobs with no fit immediately. The window now starts at first sighting in the notifier.
14. A combined result with no parseable fit would have been cached as a fitless row, preventing retries. Now it is treated as a failure and retried inside the window.
15. Strict array parsing would drop a whole fit over one empty strength. Parsing is now lenient per entry.
16. Clearing a resume left queued fit jobs alive. They now drop from the queue, and in-flight results fail the post-call checks.
17. The queue only de-duplicated pending fits, not in-flight ones. A 45-second call with a 20-second notifier tick could start the same fit twice. Added an active-key set.
18. Resume users would have waited 180 seconds for a fit when `OPENCODE_API_KEY` was missing. `shouldAwaitFit` now returns false in that case.
19. `/resume` in a group would have exposed private resume text. The flow is now private-chat only.
20. A command sent after `/resume` could leave a pending flag that swallowed the next normal message. A bot middleware cancels pending on any other command.
21. Save and fit deletion were separate writes. They now share a transaction so a stale fit cannot remain visible after a save.
22. A numeric-string score like `"8"` would have dropped an otherwise valid fit. Parsing accepts it while rejecting floats and out-of-range values.
23. The base prompt says "exactly these fields", so appending fit fields to the same prompt would have made the model omit them. The fit variant rewrites that line and adds a fit example.
24. The overview excerpt stops at 2500 characters, so must-have skills later in a long listing would be invisible to the fit. The fit call adds a dedicated 1000-character requirements excerpt from the full description.
25. Resume write errors could log query values. Resume errors log a code or name only, never the text or parameters. The privacy note also says the pasted messages stay in the chat.
26. A pending resume fit held the whole job, delaying non-resume and non-AI subscribers. The notifier now holds only the waiting lane and sends ready recipients.
27. Saving a resume without an API key made fresh alerts wait 120 seconds for a shared overview that could never arrive. `shouldAwaitAi` now returns false without a key.
28. `/resume` told users to cancel a paste with `/resume clear`, which deletes the saved resume. The copy now points at `/help` for cancel and reserves clear for deletion.
29. Re-pasting an unchanged resume turned AI back on after `/ai off`. Unchanged pastes now leave the AI setting alone.
30. A resume save or clear during a notifier tick could render the old fit. The send path re-reads the current resume and fit.
31. Cached fits were hidden from alerts when the key was missing but shown in `/job`. Both paths now show cached fits; generation and the fit wait still require a key.
32. Error logs could include a resume-bearing request body. Request, fit, and resume errors log a code or name only.
33. A resume starting with an unknown slash word could not be pasted, and an unknown `/resume` subcommand left a pending paste alive. Known commands are matched explicitly; the pending flag is dropped on a bad subcommand.
34. The title-only `developer`/`frontend` filter changed non-resume alerting. It was removed so the resume feature stays additive.

## Open Decisions

1. Saving a resume auto-enables `/ai`. Re-pasting an unchanged resume does not change the setting. Confirmed by the product requirements.
2. Score wording in the alert: `8/10` versus `8 out of 10`. Plan uses `8/10`.
3. Fit note is excluded from the alert to save caption space and included in `/job`. Confirm.
