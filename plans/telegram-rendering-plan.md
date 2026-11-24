# Telegram rendering upgrade — implementation plan

Superseded for alert feedback buttons and the `fb:` callbacks by
`application-kit-plan.md`. The rendering rules, banner, and `/job` detail still
stand as implemented.

Companion to `ai-overview-plan.md`. Covers how alerts and `/job` are rendered.
No AI tokens are spent here. The overview is generated once and cached; this
layer only sends cached text, a generated banner, and buttons.

## Decisions

| Decision | Choice |
| --- | --- |
| Alert renderer | `sendPhoto` with a generated 4:1 banner and HTML caption |
| Banner size | 1200×300 PNG |
| Banner source | Employer logo plus employer name |
| Banner cache | Telegram `file_id` per employer, keyed by logo URL, 30-day refresh |
| Fallback | Text-only `sendMessage` |
| AI block | HTML `<blockquote>`, capped at 700 visible characters |
| Post preview | Sanitized 318–500 char excerpt, no AI tokens |
| Actions | Apply always; Full check and feedback only with AI |
| Callbacks | `job:<id>`, `fb:helpful:<id>`, `fb:unhelpful:<id>`, `fb:report:<id>` |
| Rich Messages | Deferred, global opt-in only, off by default |
| `/job` detail | Classic HTML with `<blockquote expandable>` |
| Colours, font sizes, headings | Not available in classic messages; not used |
| Link previews | Disabled on text fallback |

## Why a banner

Telegram has no image-size parameter. A square employer logo renders tall and
dominates the chat. A wide banner at 4:1 renders short: on a phone it takes
roughly one quarter of the old height.

`sendPhoto` accepts a URL, a `file_id`, or an upload. Generate the banner once
per employer, upload it, then reuse the returned `file_id`. No reprocessing per
alert and no AI tokens.

## Banner design

- Canvas: 1200×300 PNG.
- Background: dark navy gradient, `#0f172a` to `#1e293b`.
- Logo card: white rounded square, 240×240 at x=40, y=30, radius 32.
- Logo: fitted inside 180×180, centred in the card, alpha preserved.
- Employer name: 64px bold white at x=320, baseline around y=146.
- Accent line: `#38bdf8`, 160×3 at x=322, y=155.
- Label: `NEW JOB MATCH`, 28px, `#94a3b8`, x=322, baseline around y=198.
- Employer name XML-escaped and truncated to ~24 characters.

If the employer name is empty, omit the text and accent line. The logo-only
banner still works.

## Alert layout

Caption, `parse_mode: "HTML"`:

```html
<b>🔔 New job match</b>

<b>Amazon Launch &amp; Growth Specialist</b>
<i>Shakeplus · Part Time · 20h/week</i>

📝 <i>“We are a fast-growing e-commerce brand in health &amp; nutrition, selling meal replacement shakes in the Netherlands, Belgium, Germany and the UK. We run two brands and sell through our own Shopify stores. We are not on Amazon yet. In the coming months we want to launch on Amazon, and we want to do it right from day one.”</i>

💰 <b>$6–10/hr</b>
📊 <b>Market:</b> 🔥 High pay · vs Amazon hourly jobs

<blockquote>🤖 <b>AI overview</b>
<b>Bottom line:</b> Apply
<b>What:</b> Remote Amazon launch specialist for a Dutch supplement brand.
<b>Needs:</b> 3+ yrs Amazon, EU marketplaces, PPC.
<b>Legit:</b> ✅ Likely legit — OLJ paid active, 3 posts, no complaints.
<b>Watch:</b> Pay 2.3× median; no leave stated.
<b>Ask:</b> Is it full-time by month 3? Who owns Seller Central?</blockquote>
```

When AI is off or analysis failed, omit the blockquote. The rest of the card
stays the same.

The AI block is capped at 700 visible characters. Keep `Bottom line` and
`Legit`; trim `What`, `Needs`, `Watch`, and `Ask` first. The full fields remain
available in `/job`.

Rules:

- Real newlines only. Telegram HTML does not support `<br>`.
- Escape all job text with existing `escapeHtml`.
- Defang URLs in excerpts, AI text, and evidence: `hxxps://`, `[.]`. Only the
  Apply button and the official OLJ link stay clickable.
- Do not build the alert from model HTML. Render the validated JSON.
- No divider lines, no ASCII boxes. Blockquote is the separator.
- Keep `·` separators for compact metadata.

## Post preview

Show a short verbatim excerpt from the job description. It adds tone and
specificity that the AI summary can flatten. No model call, no tokens.

Source: `job_postings.job_description`.

Cleaning:

- Strip HTML tags, decode entities, collapse all whitespace. Prefer the text
  already extracted by the scraper; never inject raw HTML.
- Remove URLs, emails, and phone numbers, replace with `[contact removed]`.
  Telegram auto-links bare URLs; raw post links are a phishing risk.
- Remove contact placeholders such as `----------`.
- Escape the final text with `escapeHtml`.

Selection:

- Prefer the opening paragraph. Skip the title line if it duplicates the job
  title.
- Max 500 characters. Cut at a sentence boundary first, then a word boundary.
  Truncate on code points, not UTF-16 units, so emoji are not split.
- Add `…` only when truncated.
- Minimum 120 characters. Below that, omit the preview.

Budget:

- Compute the caption without the excerpt, including the capped AI block.
- `limit = 980 - visibleLength(captionWithoutExcerpt)`.
- Use `min(500, limit)`.
- If the limit is under 120, omit the preview.
- If the AI block alone leaves less than zero, trim the AI block to 700 first.
- Recheck the final caption and trim the excerpt first, never the pay line, AI
  `Bottom line`, or Apply button.

Measured with the sample AI block: a 318-character excerpt gave 774 visible
characters. A 500-character excerpt lands around 956, still under the 1024
caption limit. Longer AI blocks reduce the excerpt budget automatically.

Format:

```html
📝 <i>“Excerpt text…”</i>
```

It sits directly under the employer line, before pay. Italic only. Do not use a
blockquote; the AI block already uses one.

## Inline keyboard

Attach to the photo or the text fallback.

Row 1, always:

- `✅ Apply on OLJ` — URL button to
  `https://www.onlinejobs.ph/jobseekers/job/<jobId>`

Row 2, only when the AI block exists:

- `🔍 Full check` — callback `job:<jobId>`
- `👍 Helpful` — callback `fb:helpful:<jobId>`
- `👎` — callback `fb:unhelpful:<jobId>`
- `🚩` — callback `fb:report:<jobId>`

Callbacks:

- `job:<jobId>` replies with the `/job` detail message and answers the callback
  query with no text.
- `fb:` upserts `overview_feedback`, then calls `answerCallbackQuery` with a
  short toast. Keep the buttons in place; last vote wins.
- Always answer the callback, even when the DB write fails. Use a generic
  `Could not save feedback.` toast; never leave the spinner.
- Verify the chat has an alert for the job before acting.
- Unknown or stale job id: toast `Not available.` No crash.

Callback data stays under 64 bytes. The value form is fixed; do not mix
`fb:<jobId>:h` with `fb:helpful:<jobId>`.

## Sending strategy

1. Build the post preview within its caption budget, then confirm the caption is
   at most 1000 visible characters and a logo is present:
   - Cached `file_id`: call `sendPhoto` with the `file_id`.
   - No cache: download logo, render banner, upload buffer, store the largest
     returned `photo.file_id`.
2. No logo, no `employer_id`, or caption over 1000 characters: `sendMessage`.
3. `sendPhoto` returns a 400 for an invalid `file_id`: delete the cache, render
   and upload once more. Then fall back to text.
4. `sendPhoto` returns a 400 about the photo URL, caption, or banner upload:
   fall back to `sendMessage` with the same caption and keyboard.
5. Logo download or banner rendering fails: fall back to `sendMessage`. Do not
   retry the image on the same alert.
6. Telegram 400 `can't parse entities`: strip tags and send a plain-text
   fallback once. Log it.
7. Network error or timeout: do not resend. The photo may have landed.
   Resending can duplicate the alert. Log and continue.
8. Log every fallback with the Telegram description.

`sendPhoto` parameters:

```ts
{
  parse_mode: 'HTML',
  reply_markup: keyboard,
  show_caption_above_media: false,
}
```

Text fallback:

```ts
{
  parse_mode: 'HTML',
  reply_markup: keyboard,
  link_preview_options: { is_disabled: true },
}
```

Visible-length helper: strip tags, decode `&amp; &lt; &gt; &quot;`, count
characters. Count emoji as two UTF-16 units. Use 1000 as the safe cap under
Telegram's 1024 caption limit.

If the capped AI block alone still exceeds 1000 visible characters, send the
text fallback without a banner. Do not drop the AI block silently; trim its
long fields first.

Text limit is 4096 characters. Current alerts fit easily. If a future render
exceeds it, trim the AI block before sending. Never trim the pay line or the
Apply button.

## Banner generation

Module: `src/banner.ts`.

Functions:

- `fetchLogo(url): Promise<Buffer | null>` — HTTPS only, 5 second timeout,
  browser-like User-Agent, reject non-image content types and payloads over
  5 MB. Allow only `onlinejobs.ph` and its subdomains. Reject private IPs and
  redirects outside the allowlist. OLJ media returns 403 without a User-Agent.
- `renderBanner(logo: Buffer, employer: string): Promise<Buffer>` — sharp
  composite. Self-check with a generated SVG logo, assert 1200×300.
- `sendAlert(chatId, caption, job, keyboard): Promise<void>` — cache lookup,
  generation, upload, fallback, cache write. Cache only when the response
  contains `message.photo`.

Sharp settings:

- `limitInputPixels: 25_000_000` on untrusted logo input.
- `rotate()` to respect EXIF.
- `resize(180, 180, { fit: 'inside', withoutEnlargement: true })`.
- PNG output.

SVG text needs fonts. Add to the final Docker stage:

```dockerfile
RUN apk add --no-cache fontconfig ttf-dejavu
```

Use `font-family="DejaVu Sans, Arial, Helvetica, sans-serif"`. If text does not
render, the logo-only banner is still valid; do not fail the alert.

## `/job` detail

Classic `sendMessage`, `parse_mode: "HTML"`. No Rich Message. Structure:

- Header: title, employer, type, hours.
- Post excerpt: sanitized, up to 800 characters.
- Pay and market lines.
- AI block: bottom line, what, needs, legit, watch.
- `<blockquote expandable>` with risk signals and verbatim quotes.
- `<blockquote expandable>` with gaps.
- Employer record: found status, paid active, complaints, post count.
- Pay context: median, p95, ratio.
- URL button `✅ Apply on OLJ`.
- Footer: `AI estimate. Verify before sharing documents.`

Defang URLs in risk quotes and soft signals: replace `https://` with `hxxps://`
and `.` in hostnames with `[.]`. Disable link previews. The only clickable link
is the official Apply button and the original OLJ listing link.

Use `<blockquote expandable>` so long evidence does not dominate the chat. It
degrades to a normal quote on older clients.

Cap the detail at 3500 visible characters. Trim risk quotes and gaps first. If
it still exceeds 4096, send two messages: analysis first, evidence second. Never
send a truncated HTML tag or an unclosed blockquote.

## Rich Messages — deferred

Bot API 10.1+ `sendRichMessage` supports headings, lists, tables, collapsible
`<details>`, media, and buttons. Up to 32,768 characters.

Do not use it for alerts:

- Telegram Web, macOS desktop, and some third-party clients render a blank
  bubble or “This message is not supported”.
- The call returns `ok: true`, so the bot cannot detect the failure.
- There is no plaintext fallback.
- `sendRichMessageDraft` is for streaming; analysis is precomputed, so it is
  irrelevant here.

If it is added later:

- Global env flag `TELEGRAM_RICH_MESSAGES=false`, default off.
- Only for `/job`, never alerts.
- Upgrade grammY first. `package.json` is on `^1.32.0`; current versions expose
  `sendRichMessage`. Older versions can use `bot.api.raw.sendRichMessage`.
- Fall back to classic HTML only on API rejection, not on blank rendering.
- Test on Telegram Web and macOS desktop before enabling.

## Data

Add job columns:

```sql
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS employer text;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS employer_id bigint;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS employer_logo text;
```

Add the banner cache:

```sql
CREATE TABLE IF NOT EXISTS employer_banners (
  employer_id bigint PRIMARY KEY,
  file_id text NOT NULL,
  logo_url text,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE employer_banners ADD COLUMN IF NOT EXISTS logo_url text;
```

Regenerate when `logo_url` changes, `logo_url` is null, or `updated_at` is older
than 30 days. Telegram `file_id` is not permanent; the TTL also covers
invalidation.

Add the statements to `BOOTSTRAP_SQL` in `src/db.ts` and mirror them in
`src/schema.ts`.

Scraper extraction:

- `employer` — `.job__logo` text, whitespace collapsed.
- `employer_logo` — `.job__logo img` `src`. Prefix `https:` if protocol-relative.
  Reject anything outside `onlinejobs.ph`.
- `employer_id` — `const employerId = <n>;` in the job page script.

Existing jobs keep nulls and use the text path. No backfill.

## Files

- `src/banner.ts` — logo fetch, render, upload, `file_id` cache, fallback.
- `src/notifier.ts` — build caption, post preview, and keyboard; call
  `sendAlert`.
- `src/scraper.ts` — extract employer name, id, and logo.
- `src/schema.ts`, `src/db.ts` — new job columns and `employer_banners`.
- `src/utils.ts` — `visibleLength(html)`, `makeExcerpt(text, limit)`, and
  `stripHtml` helpers, with self-checks.
- `src/scripts/preview-banner.ts` — generate and send one sample banner.
- `Dockerfile` — font packages in the final stage.
- `package.json` — add `sharp`, plus `check:banner`.
- `ai-overview-plan.md` — cross-reference the new output block.

## Phases

1. Add `sharp`, font packages, and the `check:banner` script.
2. Add `employer`, `employer_id`, `employer_logo` columns and scraper
   extraction.
3. Add `employer_banners`, `logo_url`, and the `file_id` cache with TTL.
4. Build `banner.ts` with a renderer self-check.
5. Add `visibleLength`.
6. Add `makeExcerpt` and the caption budget.
7. Rewrite the alert renderer with HTML layout, post preview, blockquote, and
   Apply button.
8. Add `sendAlert` with cached `file_id`, SSRF guard, upload, and text fallback.
9. Add `/job` detail, length cap, and the `job:` / `fb:` callbacks.
10. Test matrix.
11. Docs.

## Test matrix

- Logo present, no cache: banner generated, uploaded, `file_id` stored.
- Same employer, next job: cached `file_id` used, no new upload.
- Missing logo: text fallback.
- Missing employer id: text fallback.
- Caption over 1000 visible chars: text fallback.
- Invalid cached `file_id`: cache cleared, one re-render, then text fallback.
- Broken logo URL: text fallback, no crash.
- Network timeout during upload: no duplicate text resend.
- AI on: caption with blockquote.
- AI off: caption without blockquote.
- AI block over 700 visible chars: long fields trimmed, Bottom line and Legit
  kept.
- AI block containing a URL: defanged, no clickable preview.
- 318-char excerpt: 774 visible characters.
- 500-char excerpt with the sample AI block: under 1024 visible characters.
- No caption room: preview omitted, pay and AI block intact.
- Excerpt over budget: cut at sentence, then word, with `…`.
- URL, email, and phone in description: replaced with `[contact removed]`.
- URL in `/job` risk quote: defanged, no clickable preview.
- HTML, entities, and `----------` placeholders cleaned and escaped.
- Callback names match exactly: `job:<id>`, `fb:helpful:<id>`,
  `fb:unhelpful:<id>`, `fb:report:<id>`.
- Logo URL outside `onlinejobs.ph`: rejected, text fallback.
- Cached banner with changed `logo_url` or older than 30 days: regenerated.
- `/job` over 4096: split or trimmed with valid HTML.
- Telegram 400 `can't parse entities`: plain-text fallback once, no duplicate.
- Telegram iOS, Android, Web, macOS desktop: all readable.
- Old client: expandable blockquote degrades to normal quote.

## Risks

- Logo quality varies. Transparent or white logos can disappear on the white
  card. The text fallback must always look complete.
- Many posts open with generic “We are looking for…” text. The preview then
  duplicates the AI `What` line. Check 10 real posts before keeping it.
- Excerpts can contain links, emails, phone numbers, or contact bait. Strip
  them before sending.
- Fonts may be missing in the container. Install them, and keep the logo-only
  banner as a valid result.
- Telegram can invalidate a cached `file_id`. Handle 400 once, then fall back.
  Refresh the cache after 30 days or when the logo URL changes.
- Logo URLs come from scraped HTML. Restrict to `onlinejobs.ph` and block
  private IPs to avoid SSRF.
- Resending after a timeout can duplicate the alert. Only fall back on definite
  400 errors.
- `/job` can exceed Telegram's 4096 limit with many quotes. Cap and split.
- `sharp` is a native dependency. Verify the Alpine build and Docker layer
  cache.
- Rich Messages remain a compatibility trap. Keep them off unless the audience
  is known to be mobile-only.
