/**
 * Keyword matching.
 *
 * Matching is deliberately limited to the subscriber's own keywords — we never
 * add related terms or synonyms on their behalf. We do make matching *truthful*:
 * - Normalization: `next.js`, `nextjs`, `next js` are the same term.
 * - Field awareness: a title hit is a strong match, a description hit is a
 *   weaker "possible" match. Both still match; the caller decides how to label.
 */

export type MatchField = 'title' | 'description';
export type MatchStrength = 'strong' | 'possible';

export type KeywordMatch = {
  keyword: string;
  fields: MatchField[];
  strength: MatchStrength;
};

/** Split text into lowercase words. Punctuation *between* alphanumerics is
 * treated as a joiner so `next.js` -> `nextjs`, `full-stack` -> `fullstack`,
 * while real separators (spaces, commas) still split. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/([a-z0-9])[.\-_+/]+(?=[a-z0-9])/g, '$1')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Compact a run of words: `next js` -> `nextjs`, `react` -> `react`. */
/**
 * Does the keyword occur in the text as whole words?
 * Handles punctuation/spacing equivalence: `next.js` == `nextjs` == `next js`,
 * `full-stack` == `full stack`, while `react` does not match `reactive`.
 */
function containsPhrase(textWords: string[], keyword: string): boolean {
  const kwWords = words(keyword);
  if (kwWords.length === 0) return false;
  const kw = kwWords.join('');

  // Try every window of consecutive words whose compacted length equals kw.
  for (let start = 0; start < textWords.length; start++) {
    let acc = '';
    for (let end = start; end < textWords.length; end++) {
      acc += textWords[end];
      if (acc === kw) return true;
      if (acc.length >= kw.length) break;
    }
  }
  return false;
}

/**
 * Match keywords against a job title and description.
 * Returns one entry per matched keyword with the fields it hit and a strength.
 * A title hit is strong; a description-only hit is possible.
 */
export function matchJob(
  title: string,
  description: string,
  keywords: string[],
): KeywordMatch[] {
  const titleWords = words(title ?? '');
  const descWords = words(description ?? '');
  const results: KeywordMatch[] = [];

  for (const keyword of keywords) {
    const raw = (keyword ?? '').trim();
    if (!raw || words(raw).length === 0) continue;

    const fields: MatchField[] = [];
    if (containsPhrase(titleWords, raw)) fields.push('title');
    if (containsPhrase(descWords, raw)) fields.push('description');

    if (fields.length === 0) continue;
    results.push({
      keyword: raw,
      fields,
      strength: fields.includes('title') ? 'strong' : 'possible',
    });
  }

  return results;
}

/**
 * Back-compat helper: the list of matched keywords.
 * Prefer `matchJob` when the match reason/strength is needed.
 */
export function matchKeywords(text: string, keywords: string[]): string[] {
  return matchJob('', text, keywords).map((m) => m.keyword);
}

/** Human summary of why a job matched, e.g. `react (title), typescript (desc)`. */
export function describeMatches(matches: KeywordMatch[]): string {
  return matches
    .map((m) => {
      const where = m.fields.includes('title') ? 'title' : 'desc';
      return `${m.keyword} (${where})`;
    })
    .join(', ');
}

// ---------------------------------------------------------------------------
// Self-check. Run: npx tsx src/match.ts
// ---------------------------------------------------------------------------
if (require.main === module) {
  let failed = 0;
  const check = (label: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failed++;
      console.error(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    }
  };

  // Normalization equivalence.
  check('next.js == nextjs', matchKeywords('We use Next.js daily', ['nextjs']).length, 1);
  check('nextjs == next js', matchKeywords('next js app', ['next.js']).length, 1);
  check('full-stack == full stack', matchKeywords('a full stack role', ['full-stack']).length, 1);
  check('node.js == nodejs', matchKeywords('Node.js backend', ['nodejs']).length, 1);

  // Field awareness.
  const m1 = matchJob('Senior React Developer', 'You will write code.', ['react']);
  check('title hit is strong', m1[0]?.strength, 'strong');
  check('title hit field', m1[0]?.fields, ['title']);

  const m2 = matchJob('SEO Expert', 'Work with our in-house developer on campaigns.', ['developer']);
  check('desc-only is possible', m2[0]?.strength, 'possible');
  check('desc-only field', m2[0]?.fields, ['description']);

  // No false partial match: 'react' must not match 'reactive'.
  check('no partial match', matchKeywords('reactive systems', ['react']).length, 0);

  // Plain still works.
  check('plain word', matchKeywords('We need a developer', ['developer']).length, 1);

  // Multiple keywords.
  const m3 = matchJob('TypeScript Engineer', 'React and Node required.', ['typescript', 'react', 'python']);
  check('multi matched count', m3.length, 2);
  check('multi describes reason', describeMatches(m3), 'typescript (title), react (desc)');

  if (failed === 0) console.log('match.ts self-check OK');
  else {
    console.error(`${failed} failures`);
    process.exit(1);
  }
}
