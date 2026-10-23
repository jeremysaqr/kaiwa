/**
 * shared/levels.js
 *
 * The six Lesson Comfort Levels, plus helpers for comparing them.
 *
 * IMPORTANT SEMANTICS (see PART 10 / PART 37 of the spec):
 *   - `proficiency_level`  = the USER-CONTROLLED Lesson Comfort Level.
 *                            Only the user may ever change this.
 *   - `ai_assessed_level`  = what the AI *believes* the student demonstrated.
 *                            Advisory only. Never written into proficiency_level
 *                            without explicit user approval.
 *
 * This module is dependency-free and runs unchanged in Node and the browser.
 */

export const COMFORT_LEVELS = Object.freeze([
  'Absolute Beginner',
  'Beginner',
  'Beginner-Intermediate',
  'Intermediate',
  'Upper Intermediate',
  'Advanced',
]);

export const DEFAULT_LEVEL = 'Absolute Beginner';

/** Aliases the AI might plausibly emit, mapped onto our canonical six. */
const LEVEL_ALIASES = Object.freeze({
  'absolute beginner': 'Absolute Beginner',
  'complete beginner': 'Absolute Beginner',
  'total beginner': 'Absolute Beginner',
  'a0': 'Absolute Beginner',
  'beginner': 'Beginner',
  'a1': 'Beginner',
  'novice': 'Beginner',
  'beginner-intermediate': 'Beginner-Intermediate',
  'beginner intermediate': 'Beginner-Intermediate',
  'high beginner': 'Beginner-Intermediate',
  'lower intermediate': 'Beginner-Intermediate',
  'pre-intermediate': 'Beginner-Intermediate',
  'a2': 'Beginner-Intermediate',
  'intermediate': 'Intermediate',
  'b1': 'Intermediate',
  'upper intermediate': 'Upper Intermediate',
  'upper-intermediate': 'Upper Intermediate',
  'high intermediate': 'Upper Intermediate',
  'b2': 'Upper Intermediate',
  'advanced': 'Advanced',
  'c1': 'Advanced',
  'c2': 'Advanced',
  'fluent': 'Advanced',
  'proficient': 'Advanced',
});

/**
 * Coerce arbitrary text into one of the six canonical levels.
 * Returns `null` when the input cannot be understood — callers decide the
 * fallback rather than silently getting "Absolute Beginner".
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeLevel(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const exact = COMFORT_LEVELS.find(
    (level) => level.toLowerCase() === trimmed.toLowerCase(),
  );
  if (exact) return exact;

  const alias = LEVEL_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;

  // Last resort: does the string *contain* a known level name?
  const contained = COMFORT_LEVELS.find((level) =>
    trimmed.toLowerCase().includes(level.toLowerCase()),
  );
  return contained || null;
}

/**
 * Index of a level within COMFORT_LEVELS, or -1 when unknown.
 * @param {unknown} value
 * @returns {number}
 */
export function levelIndex(value) {
  const normalized = normalizeLevel(value);
  return normalized === null ? -1 : COMFORT_LEVELS.indexOf(normalized);
}

/**
 * Guarantee a usable level. Unknown input falls back to DEFAULT_LEVEL.
 * @param {unknown} value
 * @returns {string}
 */
export function coerceLevel(value) {
  return normalizeLevel(value) ?? DEFAULT_LEVEL;
}

/**
 * Short teaching guidance appended to the tutor prompt for the given level.
 * @param {string} level
 * @returns {string}
 */
export function levelGuidance(level) {
  switch (coerceLevel(level)) {
    case 'Absolute Beginner':
      return [
        '- use extremely simple vocabulary',
        '- use short sentences',
        '- introduce one concept at a time',
        '- revisit the same handful of words rather than widening the set',
        '- avoid assuming grammar terminology',
        '- give the student many opportunities to answer',
      ].join('\n');
    case 'Beginner':
      return [
        '- use high-frequency everyday vocabulary',
        '- keep sentences short and predictable',
        '- use the present tense as the backbone of the conversation',
        '- explain grammar in plain language, not with technical terms',
      ].join('\n');
    case 'Beginner-Intermediate':
      return [
        '- use common everyday vocabulary with occasional new words',
        '- mix present and past tense naturally',
        '- ask follow-up questions that need more than a one-word answer',
        '- introduce simple connectors so answers become sentences',
      ].join('\n');
    case 'Intermediate':
      return [
        '- speak at a natural but unhurried pace',
        '- use a range of tenses and everyday idioms',
        '- ask open questions about opinions and experiences',
        '- expect multi-sentence answers and gently extend them',
      ].join('\n');
    case 'Upper Intermediate':
      return [
        '- speak at a natural pace with normal contractions and reductions',
        '- use nuanced vocabulary and common idiomatic expressions',
        '- push for precision, register, and nuance rather than basic accuracy',
        '- discuss abstract or hypothetical topics',
      ].join('\n');
    case 'Advanced':
      return [
        '- speak as you would to a fluent adult',
        '- use idiomatic, colloquial, and register-specific language',
        '- correct only meaningful subtleties: nuance, naturalness, collocation',
        '- discuss complex, abstract, or specialised topics',
      ].join('\n');
    default:
      return '';
  }
}
