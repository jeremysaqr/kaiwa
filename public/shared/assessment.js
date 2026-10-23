/**
 * shared/assessment.js
 *
 * AI proficiency assessment history and level-change recommendations.
 *
 * The single most important rule in this file (PART 10 / PART 12 / BUG 11):
 * nothing here EVER mutates `proficiency_level`. It only produces advice.
 * Applying that advice is an explicit, user-initiated action in the UI.
 *
 * Dependency-free: runs unchanged in Node and the browser.
 */

import { COMFORT_LEVELS, levelIndex, coerceLevel, normalizeLevel } from './levels.js';

/** How many assessments we keep on file. */
export const MAX_ASSESSMENTS = 10;

/** How many assessments must exist before we say anything at all. */
export const MIN_ASSESSMENTS_FOR_RECOMMENDATION = 3;

/**
 * Append a new AI assessment to the history, keeping only the most recent
 * MAX_ASSESSMENTS entries. Returns a NEW array; the input is not mutated.
 *
 * @param {unknown} history existing assessment_history
 * @param {unknown} level the AI's assessed level for the session just finished
 * @param {string} [date] ISO timestamp; defaults to now
 * @returns {{date: string, level: string}[]}
 */
export function appendAssessment(history, level, date = new Date().toISOString()) {
  const normalized = normalizeLevel(level);
  const existing = sanitizeHistory(history);
  if (!normalized) return existing; // Unparseable assessment: record nothing.

  const next = [...existing, { date, level: normalized }];
  return next.length > MAX_ASSESSMENTS
    ? next.slice(next.length - MAX_ASSESSMENTS)
    : next;
}

/**
 * Drop malformed entries from a stored assessment history.
 * @param {unknown} history
 * @returns {{date: string, level: string}[]}
 */
export function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  /** @type {{date: string, level: string}[]} */
  const out = [];
  for (const entry of history) {
    if (!entry || typeof entry !== 'object') continue;
    const level = normalizeLevel(/** @type {any} */ (entry).level);
    if (!level) continue;
    const rawDate = /** @type {any} */ (entry).date;
    const date = typeof rawDate === 'string' && rawDate ? rawDate : '';
    out.push({ date, level });
  }
  return out.length > MAX_ASSESSMENTS ? out.slice(out.length - MAX_ASSESSMENTS) : out;
}

/**
 * @typedef {Object} Recommendation
 * @property {'insufficient-data'|'steady'|'step-up'|'step-down'} status
 * @property {string} message Text shown in the Active Student Profile Memory card.
 * @property {string|null} suggestedLevel Level the Apply button would set, or null.
 * @property {string|null} actionLabel Button label, or null when no button shows.
 */

/**
 * Decide whether to suggest a Lesson Comfort Level change.
 *
 * Rules:
 *   - Never act on a single conversation. At least 3 assessments are required.
 *   - Only the most recent 3 assessments are considered.
 *   - A recommendation needs a consistent trend: all three must sit on the
 *     same side of the current level.
 *   - Mixed or on-level results produce "Current level looks appropriate."
 *   - Nothing is ever applied automatically.
 *
 * @param {unknown} currentLevel the user's selected Lesson Comfort Level
 * @param {unknown} history assessment_history
 * @returns {Recommendation}
 */
export function evaluateRecommendation(currentLevel, history) {
  const current = coerceLevel(currentLevel);
  const currentIdx = levelIndex(current);
  const entries = sanitizeHistory(history);

  if (entries.length < MIN_ASSESSMENTS_FOR_RECOMMENDATION) {
    const remaining = MIN_ASSESSMENTS_FOR_RECOMMENDATION - entries.length;
    return {
      status: 'insufficient-data',
      message:
        entries.length === 0
          ? 'No lessons assessed yet. Complete a few sessions and the tutor will comment on your level.'
          : `${remaining} more assessed ${remaining === 1 ? 'lesson' : 'lessons'} needed before the tutor suggests a level change.`,
      suggestedLevel: null,
      actionLabel: null,
    };
  }

  const lastThree = entries.slice(-MIN_ASSESSMENTS_FOR_RECOMMENDATION);
  const indices = lastThree.map((entry) => levelIndex(entry.level));

  const allAbove = indices.every((idx) => idx > currentIdx);
  const allBelow = indices.every((idx) => idx < currentIdx);

  if (allAbove) {
    // Step up conservatively: to the *lowest* of the three assessed levels,
    // and never by more than one level at a time.
    const target = Math.min(Math.min(...indices), currentIdx + 1);
    const suggestedLevel = COMFORT_LEVELS[target];
    return {
      status: 'step-up',
      message: `You may be ready to try ${suggestedLevel}.`,
      suggestedLevel,
      actionLabel: `Apply ${suggestedLevel}`,
    };
  }

  if (allBelow) {
    // Never downgrade automatically, and never propose a drop of more than one
    // level. Phrased as an option, not a verdict.
    const target = Math.max(Math.max(...indices), currentIdx - 1);
    const suggestedLevel = COMFORT_LEVELS[target];
    return {
      status: 'step-down',
      message: `Recent lessons looked demanding. Consider staying at ${suggestedLevel} for now.`,
      suggestedLevel,
      actionLabel: `Apply ${suggestedLevel}`,
    };
  }

  return {
    status: 'steady',
    message: 'Current level looks appropriate.',
    suggestedLevel: null,
    actionLabel: null,
  };
}

/**
 * Most recent AI assessment, or '' when there is none.
 * @param {unknown} history
 * @returns {string}
 */
export function latestAssessedLevel(history) {
  const entries = sanitizeHistory(history);
  return entries.length ? entries[entries.length - 1].level : '';
}
