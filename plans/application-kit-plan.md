# Application Kit Plan

Status: implemented in `src/kit.ts` (v1, one message). Paginated output
follow-up: `kit-pagination-plan.md`.

## Goal

Turn an alert into an application. A subscriber taps `✍️ Kit` on an alerted job
and gets a short, resume-grounded kit: the listing's own application
instructions, a subject line, required links or files, what to lead with, a
first-person application message, likely screening questions with answer angles,
questions to ask the employer, and claims to avoid.

The kit must obey the listing before it writes anything. If the post asks for a
specific subject, word, phrase, file, link, or format, the kit repeats that
instruction exactly and marks it. If the post asks for nothing, the kit suggests
a subject line.

On demand only. Never generated for every alert. Never sent to the employer.

This is the highest-value AI feature because it acts on intent. Usage grows when
people apply, not when the scraper finds jobs.

## Decisions

- Entry points: `✍️ Kit` button on the alert, `kit:<jobId>` callback (treated as
  `apply`), section callbacks `kit:<jobId>:<apply|msg|prep>`, and
  `/kit <jobId>`.
- V1 renders one message. The follow-up `kit-pagination-plan.md` splits it into
  three screens edited in place. The callback parser supports both forms:
  `kit:<jobId>` and `kit:<jobId>:<section>`.
- `hasKit` is true when the chat has AI on. A missing resume does not hide the
  button; the tap teaches `/resume`. AI off hides the button.
- Requires `OPENCODE_API_KEY`, `/ai on`, and a saved resume for generation. No
  generic fallback in v1. A kit without a resume is a generic cover letter,
  which is worse than nothing. A cached kit still renders without a key.
- `/ai off` wins. The kit is an AI feature and follows the same switch.
- Authorization: the chat must have a `notifications` row for the job. Same
  rule as `/job`.
- Private chat only, same as `/resume`. A kit contains resume-derived text, so a
  group tap replies `DM the bot to use /kit.` and runs no model call.
- Cache is per `(chat_id, job_id)` because the resume is personal. Never shared
  across chats.
- One normal model call per generation, plus one retry only when a required word
  or phrase is missing from the message. Main model, `reasoning_effort: low`,
  `max_tokens: 1800`.
- Separate `KIT_VERSION`. Do not bump `AI_VERSION`; shared overview cache must
  stay valid.
- Kit never blocks an alert. Alerts do not wait for kits and do not show a kit
  block.
- No kit feedback buttons in v1. Manual review of the first 20 kits is the
  quality gate. Do not add write-only feedback.
- The alert feedback buttons (`👍`, `👎`, `🚩`) are removed as a prerequisite.
  They are write-only and the report button promises action that does not
  happen.
- English only in v1.
- No PDF, no file upload, no tone picker, no auto-apply.
- Listing instructions are extracted twice: deterministic regex pre-pass, then
  the model. Every extracted instruction needs a verbatim quote from the job
  text. Unverified instruction dropped.
- Extraction reads the full description, capped at 6,000 characters. When the
  description is longer, add the final 1,500 characters as a tail window.
  Application instructions often sit at the end.
- The application channel (email or form) is extracted from the raw job text by
  code. It is never sent to the model and never model-written. The email or form
  URL is replaced with `[application channel]` in the text sent to the model.
- Job text and resume are redacted with the existing email and phone redaction
  before the model call. Resume links are extracted before redaction, by code.
- A specified subject or required phrase wins over a generated one. Exact text,
  no paraphrase.
- No specified subject: build one deterministically as
  `Application — <job title>`, cut to 10 words. No model call, no invented
  words.
- Required links, files, references, and samples are extracted as requirements.
  Code marks each `have` or `missing` by matching links already in the resume.
  Never invent a link.
- Messaging-only application channels (Telegram, WhatsApp) show a warning, not
  the handle. The existing contact risk signal stays the source of truth.
- Form channels add a `📝 Open form` URL button to the kit reply, because
  `✅ Apply on OLJ` may not be the route the listing accepts.
- Kill switch: `KIT_ENABLED=false` hides the button and stops generation. A
  cached `job_kits` row still renders for `/kit` and old message buttons; no
  model calls.

## User Flow

Prerequisite: AI on and resume saved.

1. Alert arrives. Keyboard:
   - Row 1: `✅ Apply on OLJ`
   - Row 2: `🔍 Full check` · `✍️ Kit`
2. User taps `✍️ Kit`.
3. Bot answers the callback at once: `Building your kit…`.
4. Bot sends `✍️ Building your application kit. This takes up to 45 seconds.`
5. Bot edits that message into the finished kit.
   If the edit fails because the user deleted the placeholder, send the kit as a
   new message instead. Never leave the user with only the placeholder.
6. User copies the message, adds their name, and sends it on OnlineJobs.ph.
7. If the application channel is a form, the kit reply also has a
   `📝 Open form` URL button.

Failure replies:

- Not alerted: `I have no alert for that job in this chat.`
- Group chat: `DM the bot to use /kit.`
- AI off: `Application kit needs AI on. Send /ai on.`
- No resume: `Save your resume first with /resume. The kit uses it to avoid generic text.`
- No API key and no cached kit: `Application kit is not available right now.`
  A cached kit still opens without a key.
- Model timeout or bad JSON: `Could not build the kit. Try again in a minute.`
- Daily cap: `Daily kit limit reached. Saved kits still open.`
- Double tap while building: `Still building…` No second call.

## Output

Total under 3,800 visible characters. Split at section boundaries if Telegram
still rejects it.

```
✍️ Application kit
Job: Amazon Launch Specialist

How to apply
• Subject (required): "Amazon VA — [Your Name]"
• Start your message with the word "BANANA".
• Send to: hiring@brand.com
• Deadline: Jun 30

Provide
• Portfolio — have: https://jane.dev
• Loom intro video — missing; record before applying
• 3 references — missing

Lead with
• 5 yrs React and TypeScript
• Built e-commerce dashboards
• Managed PPC campaigns

Message
Hi, I'm applying for the Amazon Launch Specialist role.
I have five years of React and TypeScript experience...
[90-120 words, first person, no placeholders]

Likely questions
1. Walk me through your Amazon experience.
   Angle: dashboard work, not Seller Central.
2. How do you handle PPC?
   Angle: campaign work in your last role.
...

Ask them
• Is this full-time by month 3?
• Who owns Seller Central day to day?

Don't claim
• Amazon Seller Central — not in your resume.
• EU marketplace experience — not in your resume.

Draft. Check facts before sending.
```

When the listing names no subject:

```
How to apply
• Subject (suggested): "Application — Amazon Launch Specialist"
```

Field rules:

- `How to apply`: max 5 lines, each max 120 visible characters. Merge
  `Deadline` into `Send to` when both fit. When there is no instruction and no
  channel, show only the suggested subject line. The block never disappears.
  Priority order: required subject, required phrase, channel/deadline, format,
  other. Drop `other` first. If more than 5 remain, add
  `+N more — read the post`.
- Required subject, word, phrase, format, and deadline are copied from the
  listing. Exact text, no paraphrase, no cleanup. A required subject may wrap to
  a second line; never truncate it. If it exceeds 240 characters, show
  `Subject (required): see post` instead of a broken subject.
- Suggested subject is deterministic: `Application — <job title>`, cut to 10
  words. No model-written subject when the listing names none.
- `Provide`: max 4 items. Each is a link, file, video, sample, or reference the
  applicant must supply. Mark `have` only when the resume contains a matching
  link or item. Otherwise `missing`. A URL longer than 200 characters renders as
  `link in resume` to stay inside the message cap. If more than 4 items remain,
  add `+N more — read the post`.
- `Lead with`: max 3 bullets, each max 20 words.
- `Message`: 90-120 words, first person, no invented employers, dates, or
  metrics. No `[name]` placeholder. End without a signature; the footer tells
  the user to add their name. If the listing demands a word or phrase for the
  message, the message must contain it exactly.
- `Likely questions`: 5, each with one-line answer angle.
- `Ask them`: 2 questions drawn from the job's gaps.
- `Don't claim`: max 3 job requirements absent from the resume.
- Buttons on the kit reply: `✅ Apply on OLJ`, plus `📝 Open form` when a form
  channel exists. No feedback buttons.
- HTML escaped. Model-written text has URLs defanged. Required URLs from the
  resume and the application channel stay exact and are wrapped in `<code>`, so
  the user can copy them and Telegram does not auto-link them. Only `http` and
  `https` URLs render. Any other scheme is dropped.
- An external form not on the employer's own domain adds
  `⚠️ Verify the employer before entering personal data.` to the `Send to` line.

When the rendered kit exceeds 3,800 visible characters, trim in this order:

1. `Likely questions` from 5 to 3.
2. `Ask them` from 2 to 1.
3. `Lead with` from 3 to 2.
4. `Don't claim` from 3 to 2.

Never trim `How to apply`, `Provide`, `Message`, or a safety warning. If it
still will not fit, split at a section boundary and put the buttons on the last
part.


## Application Instructions

The listing often contains hard requirements that a generic cover letter misses:

- `Use the subject line "Amazon VA — [Your Name]"`.
- `Start your application with the word BANANA`.
- `Send your resume and portfolio to hiring@brand.com`.
- `Include a 2-minute Loom video and 3 references`.
- `Apply only through this Google Form: ...`.
- `Answers must be in PDF`.

Extraction has two passes:

1. Deterministic pre-pass over the raw description:
   - application email in a sentence with an application verb: `apply`, `send`,
     `email`, `resume`, or `portfolio`. If several match, prefer the one nearest
     `send` or `apply`; if none is clearly an application address, no channel;
   - form hosts: `docs.google.com/forms`, `forms.gle`, `typeform.com`,
     `jotform.com`, `airtable.com`;
   - quoted phrases near `subject`, `start`, `include`, `mention`, `use the
     word`, or `first line`, but only in a sentence that also mentions an
     application artifact: `apply`, `application`, `email`, `resume`, `subject`,
     `cover letter`, `portfolio`, `video`, `form`, or `interview`. This stops
     `include benefits` from becoming a requirement;
   - deadline phrases near `apply`, `before`, `by`, or a date.
2. Model output for instructions the regex misses, with the same
   application-artifact rule.

Verification:

- Every instruction needs `quote`, an exact substring of the redacted job text
  sent to the model. Whitespace is normalized before comparison. Unverified
  instruction is dropped. An instruction that names the application channel is
  compared with that channel replaced by `[application channel]` on both sides.
- Instruction `kind`: `subject | phrase | format | deadline | other`. A phrase
  also has `target: subject | message`. A phrase without a target defaults to
  `message`.
- For a required subject or phrase, the rendered text must be a substring of
  `quote`. The model may not rewrite it. A required subject passes the same
  quote check as an instruction.
- A required phrase with `target: subject` must appear in the subject line. If
  the listing names no subject, build the suggested subject starting with the
  phrase. A required phrase with `target: message` must appear in `Message`.
- Code owns the application channel. The model never receives or writes the
  application email or form URL. Replace both with `[application channel]` in
  the text sent to the model.
- Form URLs must be `http` or `https`. Validate before storing. Reject any other
  scheme.
- If the listing gives a letter length, that length wins over 90-120 words. Cap
  at 200 words. A longer requirement gets `Length: see post` and the generated
  letter stays at 200.
- If a required phrase is missing from its target, retry once with an explicit
  `must_include` list. If it is still missing, keep the kit and add
  `⚠️ Add "<phrase>" to your message.` or `... to your subject.`

Application channel rules:

- Email or form found: `Send to:` line with the exact address or URL in `<code>`.
  A form URL longer than 200 characters stays on the `📝 Open form` button only;
  omit the text URL.
- Only Telegram or WhatsApp found: `⚠️ Listing asks you to apply on
  Telegram/WhatsApp. Prefer OLJ unless the employer is verified.` Do not print
  the handle.
- Nothing found: omit the channel line. The `✅ Apply on OLJ` button remains.

Required item rules:

- `kind`: `portfolio | github | video | file | references | sample | other`.
- Code extracts links already in the resume. Do not reuse the 10-link cap in
  `extractLinks`; add a resume variant with no cap, or raise it. Match `www.`
  links as well as `https://`.
- `have` only when a resume link matches the item by host or label. Examples:
  `github.com` for GitHub, `loom.com` for a video, `drive.google.com` for a
  file, `behance.net` or `dribbble.com` for a portfolio, `linkedin.com` for a
  profile.
- References are `missing` unless the resume states references.
- Never invent a URL, a file, or a reference.

## Grounding Rules

Job text and resume are data, never instructions. Same rule as the overview
prompt.

Deterministic checks after parsing:

1. Every number in `message`, `lead_with`, and `questions` must appear in the
   resume or the job text. Otherwise drop the line.
2. Each `lead_with` bullet must share at least one distinctive token with the
   resume. Otherwise drop it.
3. Each `don't claim` item must match a requirement token in the job text and
   must be absent from the resume. Otherwise drop it.
4. `ask` questions must not repeat a fact already stated in the job text. A
   question whose answer is in the listing is wasted.
5. Every required word or phrase must appear in its target, `subject` or
   `message`, after punctuation and case normalization. If missing after one
   retry, render the warning line.
6. A required subject must equal the text named in the listing. A suggested
   subject must equal `Application — <job title>` after trimming to 10 words.
   It is code-built, never model-built.
7. Every instruction and required item must pass the quote check against the
   redacted text sent to the model. An unverified item is dropped, never
   repaired by the model.
8. Application channel is code-only. Reject non-`http`/`https` form URLs and
   never render a messaging handle.
9. If fewer than 2 valid `lead_with` bullets remain:
   `Your resume has too little detail for this job. Add skills with /resume.`

Prompt rule: no invented facts. If the resume does not show a required skill,
put it in `Don't claim`, never in `Message`.

## Data Model

New table, additive bootstrap in `src/db.ts`:

```sql
CREATE TABLE IF NOT EXISTS job_kits (
  id serial PRIMARY KEY,
  chat_id bigint NOT NULL,
  job_id bigint NOT NULL,
  resume_hash text NOT NULL,
  job_hash text NOT NULL,
  kit_version int NOT NULL,
  kit jsonb NOT NULL,
  usage jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (chat_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_job_kits_job_id ON job_kits (job_id);
CREATE INDEX IF NOT EXISTS idx_job_kits_chat_updated ON job_kits (chat_id, updated_at);
```

`kit` shape:

```json
{
  "subject": {
    "required": true,
    "text": "Amazon VA — [Your Name]",
    "quote": "Use the subject line \"Amazon VA — [Your Name]\""
  },
  "instructions": [
    {
      "kind": "phrase",
      "target": "message",
      "text": "BANANA",
      "quote": "Start your message with the word \"BANANA\""
    }
  ],
  "required_items": [
    {
      "label": "Portfolio",
      "kind": "portfolio",
      "quote": "Include a link to your portfolio",
      "status": "have",
      "url": "https://jane.dev"
    }
  ],
  "application_channel": {
    "kind": "email | form | messaging | none",
    "value": "hiring@brand.com",
    "warning": null
  },
  "lead_with": ["fact from resume", "fact from resume"],
  "message": "90-120 words",
  "questions": [{ "q": "question", "angle": "one line from resume" }],
  "ask": ["question", "question"],
  "dont_claim": ["requirement absent from resume"]
}
```

`subject`, `instructions`, and model-extracted `required_items` start as
unverified model output. `status`, `url`, `application_channel`, and the final
`subject.required` flag are resolved by code before storage.

Cache rules:

- All of `resume_hash`, `job_hash`, `kit_version` match: return row. Zero model
  calls.
- Any mismatch: regenerate, replace the row, and set `updated_at = now()`.
- `/resume` save deletes that chat's `job_kits` rows in the same transaction as
  the resume update.
- `/resume clear` deletes `job_fits` and `job_kits`.
- A resume save or clear also removes that chat's queued and in-flight kit keys.
  Before writing a result, re-read `resume_hash`; if it changed, discard the
  result. A slow call must not write a kit for an old resume.

`job_hash` is SHA-256 of the description, title, employer name, and normalized
pay fields. Do not use `description_hash` alone; a title edit would leave a stale
subject line and message.

## Privacy

- The kit sends the redacted resume and job text to the model provider. Same
  provider and rules as the existing fit check.
- Application email or form URL is stripped before the model call.
- Model-written fields are redacted again after parsing. Any email or phone the
  model echoes becomes `[email]` or `[phone]`.
- The stored kit contains resume-derived facts, an application email, and resume
  links. It is deleted on `/resume clear` and on `/resume` save.
- The bot never echoes the full resume, never sends the kit to the employer, and
  never auto-applies.
- Kit generation logs never contain resume text, the request body, or the
  application email.

## Queue and Limits

- Own lane, concurrency 2, separate from shared analysis and resume fits.
- One in-flight generation per `(chat_id, job_id)`. A second request awaits the
  same promise.
- Max 20 new generations per chat per 24 hours. Env: `KIT_DAILY_LIMIT`.
  Count `job_kits.updated_at`, so a regeneration counts and a cache hit does
  not. Check the cache before the cap: a cache hit always returns, even at the
  cap. Use an in-memory per-chat counter in front of the DB count; two
  simultaneous taps must not both pass the last slot. Best-effort, not a
  billing guarantee.
- Retry network errors, 429, and 5xx twice with backoff, same as overview.
  Timeouts, bad JSON, and other 4xx fail once. A missing required phrase has one
  extra model retry, not a network retry.
- Log line: `[kit] chat=<id> job=<id> cached=<bool> prompt=<n> completion=<n> latency=<ms>`.
  Never log resume text, the request body, or the application email.
- Kill switch: `KIT_ENABLED=false`. Hide the button and stop generation. A
  cached row still renders for `/kit` and old message buttons; no model calls.
  Read as `!== 'false'`; deploy with `KIT_ENABLED=false` first.

## Files

- `src/kit.ts` new: prompt, parse, verify, cache, queue, self-check.
- `src/schema.ts`: `jobKits`.
- `src/bot.ts`: `/kit`, `kit:<id>` callback, help text, add `kit` to
  `KNOWN_COMMAND`, remove `fb:` handler and `overviewFeedback` import, and pass
  `hasKit` into `buildJobDetail`/`sendJobDetail` so the `/job` keyboard matches
  the alert.
- `src/alert.ts`: keyboard takes a `hasKit` flag and an optional form URL.
  Remove the three feedback buttons. Update the keyboard test.
- `src/overview.ts`: export `callModel` or add a small shared `callJson` wrapper.
- `src/db.ts`: `job_kits` bootstrap.
- `src/signals.ts`: export `extractLinks` or add an uncapped resume-link
  variant with `www.` support.
- `package.json`: add `check:kit` to the `test` chain.
- `.env.example`: add `KIT_ENABLED`, `KIT_DAILY_LIMIT`.
- `README.md`: `/kit`, privacy note, env vars. Remove the feedback sentence.
- `plans/ai-overview-plan.md` and `plans/telegram-rendering-plan.md`: remove the
  `fb:` buttons and callbacks from the implemented design, or mark them
  superseded by this plan.

## Self-Checks

No test framework. Use the existing self-check pattern.

- Parser accepts a valid kit, rejects missing fields, trims oversized arrays.
- Number check drops an invented metric.
- Lead-with check drops a bullet absent from the resume.
- Don't-claim check drops a skill the resume actually has.
- Required phrase is copied exactly into its target, message or subject, or the
  warning appears.
- Required subject is used verbatim; suggested subject is the deterministic
  `Application — <title>` form.
- Unverified instruction quote is dropped.
- An instruction without an application artifact in its sentence is not
  extracted. `include benefits` must not become a requirement.
- Application email is rendered exactly and is replaced with
  `[application channel]` in the model input.
- A `javascript:` form URL is rejected.
- Messaging-only channel renders the warning and no handle.
- Form channel adds `📝 Open form`.
- Required portfolio is `have` when the resume has a matching link, `missing`
  when it does not.
- Message word count is 90-120 after generation, or the kit is rejected. An
  explicit listing length overrides the range up to 200 words.
- Cache hit makes zero model calls.
- Regeneration updates `updated_at` and counts toward the daily cap.
- A resume change during an in-flight generation discards the result.
- Resume change invalidates the kit.
- Model-echoed email or phone is redacted in stored fields.
- `/kit` rejects a job not in `notifications`.
- `/kit` in a group makes no model call.
- Keyboard renders Apply, Full check, Kit; no feedback buttons.
- Output stays under 3,800 visible characters after escaping, and trims in the
  documented order.
- `npm run build` and `npm test`.

## Rollout

1. Remove the alert feedback buttons first. Separate small release, confirm
   nothing reads `overview_feedback`.
2. Deploy `job_kits` and `/kit` behind `KIT_ENABLED=false`.
3. Run `npm test` and `npm run build`.
4. Enable for one test chat with a real resume. Generate kits for five real
   jobs. Check facts, tone, length, and that no invented claim appears.
5. Test one listing with a required subject, one with a required word, one with
   a portfolio link already in the resume, one with a missing Loom link, and one
   with a Google Form.
6. Confirm a group chat gets the DM message and no model call.
7. Manual quality gate: 20 kits across five job types before announcing.
8. Watch `[kit]` logs for token use, latency, failure rate, and cache hit rate.
9. Announce `/kit` in `/help` and `/start`.

## Metrics

- Kits generated per 100 alerts sent.
- Cache hit rate.
- Failure rate by cause.
- Repeat use per chat.
- Manual review notes for invented facts.

## Out of Scope

- Auto-apply or auto-message the employer.
- PDF or DOCX export.
- Tone picker.
- Tagalog output.
- Mock interview.
- Kit history.
- Regenerate button. A resume change regenerates; otherwise the cache stands.

## Review Findings Resolved

1. A kit in a group chat would expose resume-derived text. Private chat only.
2. Editing the placeholder can fail if the user deletes it. Fall back to a new
   message.
3. The suggested-subject rule contradicted its own example by banning words
   like "Application". Subject is now code-built.
4. "Channel never sent to the model" was false unless the email or form URL is
   replaced in the model input. Added `[application channel]`.
5. Instructions often sit at the end of long posts. Extraction now reads the
   full description plus a tail window.
6. `max_tokens: 1200` was tight once instructions and required items were added.
   Raised to 1800, with one phrase-only retry.
7. The daily cap could be bypassed by regeneration and raced by double taps.
   `updated_at` counts regenerations; an in-memory counter guards the last slot.
8. Four lines at 90 characters could not hold a subject, phrase, channel,
   deadline, and format. Raised to five at 120, with overflow.
9. Form-only listings still showed `Apply on OLJ` as the only action. Added
   `📝 Open form`.
10. A resume change during an in-flight call could write a stale kit. Queue
    cancellation plus a pre-write hash check.
11. The model could echo an email or phone. Model fields are redacted again
    after parsing.
12. `description_hash` alone leaves a stale title or pay in the kit. `job_hash`
    now covers description, title, employer, and pay.
13. `include benefits` could be mistaken for an application instruction.
    Instructions now need an application artifact in the same sentence.
14. A required phrase can target the subject, not only the message. Added
    `target`.
15. `extractLinks` caps at 10 and misses `www.`. Added an uncapped resume
    variant.
16. URL schemes were not validated. Only `http` and `https` render.
17. Output trimming had no order. Added a fixed trim order that never drops
    compliance or safety lines.
18. Feedback removal left stale references in README and sibling plans. Files
    list now includes them.

## Open Decisions

1. Message length: 90-120 words is the plan. Confirm.
2. Daily cap: 20 per chat. Confirm.
3. Should `/kit` also work when AI overview is off but a resume exists? Plan says
   no, `/ai off` wins. Confirm.
4. Remove all three alert feedback buttons, or keep one `👎 Not helpful`? Plan
   says remove all three.
5. Show the deterministic suggested subject even when the listing has no email or
   form channel and the user will apply on OLJ? Plan says yes, because the user
   may message the employer. Could hide it for OLJ-only jobs to reduce clutter.
6. Required item matching by host and label. `https://jane.dev` matches a
   portfolio requirement. Confirm this is good enough before adding an
   AI classification pass.
7. Form listings show both `✅ Apply on OLJ` and `📝 Open form`. Confirm this is
   better than replacing the OLJ button, which would hide the source listing.
