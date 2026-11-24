/**
 * Resume text handling: validation, hashing, and status copy. The text is never
 * logged, echoed, or put in an error message.
 */
import { createHash } from 'crypto';

export const RESUME_MIN = 200;
export const RESUME_MAX = 4000;

const fmt = (n: number) => n.toLocaleString('en-US');

export const RESUME_PRIVACY_NOTE =
  'Resume saved. It is stored in the database until you run /resume clear, and it is sent to the AI model only for fit checks and application kits. Emails and phone numbers are removed before the model call. Your pasted message stays in this chat, so delete it if you want.';

/** Normalize line endings and trim; the paste is stored as sent otherwise. */
export function trimResume(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').trim();
}

export type ResumeValidation = { ok: true; text: string } | { ok: false; length: number };

export function validateResume(raw: string): ResumeValidation {
  const text = trimResume(raw);
  const length = text.length;
  return length >= RESUME_MIN && length <= RESUME_MAX ? { ok: true, text } : { ok: false, length };
}

export function resumeHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Character count and date only. Never the text. */
export function resumeStateText(text: string | null, updatedAt: Date | null): string {
  if (!text) return `Resume: not set (max ${fmt(RESUME_MAX)} chars)`;
  const date = updatedAt
    ? updatedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : 'unknown date';
  return `Resume: saved (${fmt(text.length)}/${fmt(RESUME_MAX)} chars, ${date})`;
}

/** Resume is private: only a direct message may carry it. */
export function isPrivateChat(type: string | undefined): boolean {
  return type === 'private';
}

// ---------------------------------------------------------------------------
// Self-check. Run: npx tsx src/resume.ts
// ---------------------------------------------------------------------------
if (require.main === module) {
  let failed = 0;
  const check = (label: string, ok: boolean) => {
    if (!ok) {
      failed++;
      console.error(`FAIL ${label}`);
    }
  };

  check('trims whitespace', trimResume('  hello \n') === 'hello');
  check('normalizes crlf', trimResume('a\r\nb') === 'a\nb');
  check('accepts 200', validateResume('x'.repeat(200)).ok);
  check('accepts 4000', validateResume('x'.repeat(4000)).ok);
  check('rejects 199', !validateResume('x'.repeat(199)).ok);
  check('rejects 4001', !validateResume('x'.repeat(4001)).ok);
  check('length ignores surrounding whitespace', validateResume(`  ${'x'.repeat(200)}  `).ok);
  check('hash is stable', resumeHash('abc') === resumeHash('abc'));
  check('hash changes with text', resumeHash('abc') !== resumeHash('abd'));
  check('hash is sha-256', resumeHash('abc').length === 64);

  const saved = resumeStateText('secret resume text', new Date('2026-11-21T00:00:00Z'));
  check('status hides text', !saved.includes('secret'));
  check('status shows saved state', saved.startsWith('Resume: saved (18/4,000 chars'));
  check('status shows not set', resumeStateText(null, null) === 'Resume: not set (max 4,000 chars)');
  check('private chat accepted', isPrivateChat('private'));
  check('group chat rejected', !isPrivateChat('group'));
  check('channel chat rejected', !isPrivateChat('channel'));

  if (failed === 0) console.log('resume.ts self-check OK');
  else {
    console.error(`${failed} failures`);
    process.exit(1);
  }
}
