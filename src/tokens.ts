/**
 * Token counting.
 *
 * We deliberately avoid a tiktoken dependency: a QA probe must be runnable
 * before you have decided to trust a provider, and shipping a wasm blob to
 * count tokens is the wrong trade. The estimator below is a blend of the two
 * standard heuristics (chars/4 and words*1.33) rounded up.
 *
 * Where accuracy actually matters - the context probe - we bias high and then
 * apply a safety factor, because a false FAIL ("can't do 32k") is a visible,
 * explainable problem, whereas a false PASS ("handles 128k" when it doesn't)
 * silently misroutes traffic. The reported estimate is always included in the
 * metrics so a reader can judge.
 */

/** Per-message framing tokens: role, separators. */
const MESSAGE_OVERHEAD_TOKENS = 4;

const WORD_POOL = (
  'the quick analysis of a stable model routing layer requires careful review of ' +
  'latency distributions across many parallel requests and their measured token ' +
  'throughput under sustained load while respecting rate limits and context window ' +
  'constraints that vary between providers offering different capabilities within ' +
  'a single unified interface for application developers integrating inference ' +
  'services into production workloads expecting reliable behaviour and predictable ' +
  'outputs across evaluation suites and long context retrieval tasks'
).split(/\s+/);

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chars = text.length;
  const words = text.split(/\s+/).filter(Boolean).length;
  const byChars = chars / 4;
  const byWords = words * 1.33;
  // Blend rather than take the max: for prose the two agree within ~10%, and
  // the mean tracks real BPE counts better than either extreme.
  return Math.max(1, Math.round((byChars + byWords) / 2));
}

export function estimateMessageTokens(messages: Array<{ role: string; content: unknown }>): number {
  let total = 3; // reply priming
  for (const m of messages) {
    total += MESSAGE_OVERHEAD_TOKENS;
    if (typeof m.content === 'string') total += estimateTokens(m.content);
    else if (m.content !== undefined) total += estimateTokens(JSON.stringify(m.content));
  }
  return total;
}

/**
 * Tokens per word in WORD_POOL, measured once.
 *
 * Measuring per appended word instead would be O(n^2): at 128k tokens that is
 * ~115k iterations each re-scanning a growing half-megabyte buffer, which takes
 * longer than the request it is preparing.
 */
const WORDS_PER_TOKEN_RATIO = (() => {
  const sample = WORD_POOL.slice(0, 60).join(' ');
  return estimateTokens(sample) / Math.max(1, WORD_POOL.slice(0, 60).length);
})();

/**
 * Build a user message that is approximately `targetTokens` tokens.
 *
 * `safety` < 1 backs the target off so that estimator error does not push us
 * over the provider's real limit and produce a spurious failure.
 */
export function buildFillerMessage(targetTokens: number, safety = 0.9): string {
  const goal = Math.max(16, Math.floor(targetTokens * safety));
  const header = 'Below is filler text used to measure the usable context window. '
    + 'Acknowledge receipt with the single word OK.\n\n';

  // Linear in the target: size the word count up front, then correct once.
  const wordsNeeded = Math.ceil(goal / WORDS_PER_TOKEN_RATIO) + 8;
  const repeats = Math.ceil(wordsNeeded / WORD_POOL.length);
  let text = header + Array.from({ length: repeats }, () => WORD_POOL.join(' ')).join(' ');

  // Correct in one pass: trim words while over goal. Each iteration removes a
  // chunk, so this stays linear rather than re-measuring per word.
  let words = text.split(' ');
  while (words.length > 1 && estimateTokens(words.join(' ')) > goal) {
    words = words.slice(0, words.length - 64);
  }
  text = words.join(' ');
  if (!text.endsWith(' ')) text += ' ';

  // Guarantee we are at or under the goal even after the coarse trim.
  while (estimateTokens(text) > goal && text.length > header.length + 16) {
    text = text.slice(0, text.lastIndexOf(' '));
  }
  return text;
}

/** Exact-match / contains / regex scoring helper used by quality_smoke. */
export type MatchKind = 'exact' | 'contains' | 'regex' | 'not_contains';

export function matches(kind: MatchKind, expected: string, actual: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  switch (kind) {
    case 'exact':
      return norm(expected) === norm(actual);
    case 'contains':
      return norm(actual).includes(norm(expected));
    case 'not_contains':
      return !norm(actual).includes(norm(expected));
    case 'regex': {
      try {
        return new RegExp(expected, 'is').test(actual);
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}
