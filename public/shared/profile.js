/**
 * shared/profile.js
 *
 * Creation, migration and validation of `config.json` profiles.
 *
 * Migration rule (PART 30 / BUG 14): older configs must keep working. We only
 * ever ADD missing fields. Existing values are preserved verbatim — most
 * importantly `proficiency_level`, which is the user's property alone.
 *
 * Dependency-free: runs unchanged in Node and the browser.
 */

import { coerceLevel, DEFAULT_LEVEL } from './levels.js';
import { normalizeVocabList, normalizeWeaknessList } from './vocab.js';
import { sanitizeHistory, latestAssessedLevel } from './assessment.js';

/** The application's default language. */
export const DEFAULT_LANGUAGE = 'German';

/** Default tutor name per language. Anything else falls back to 'Tutor'. */
const DEFAULT_TUTOR_NAMES = Object.freeze({
  german: 'Franz',
  japanese: 'Tanaka-san',
  spanish: 'Sofía',
  french: 'Camille',
  italian: 'Giulia',
  portuguese: 'Mateus',
  dutch: 'Sanne',
  swedish: 'Elsa',
  norwegian: 'Ola',
  danish: 'Freja',
  polish: 'Zofia',
  russian: 'Dmitri',
  mandarin: 'Li Wei',
  chinese: 'Li Wei',
  korean: 'Min-ji',
  arabic: 'Layla',
  hebrew: 'Noa',
  hindi: 'Aarav',
  turkish: 'Deniz',
  greek: 'Eleni',
  finnish: 'Aino',
  czech: 'Tereza',
  vietnamese: 'Linh',
  thai: 'Ploy',
  indonesian: 'Putri',
});

/** Languages whose display must be romanised rather than shown in native script. */
export function isJapanese(language) {
  return typeof language === 'string' && language.trim().toLowerCase() === 'japanese';
}

/**
 * Suggested tutor name for a language.
 * @param {string} language
 * @returns {string}
 */
export function defaultTutorName(language) {
  const key = String(language || '').trim().toLowerCase();
  return DEFAULT_TUTOR_NAMES[key] || 'Tutor';
}

/**
 * Default script style for a language. Japanese uses Romaji-only output.
 * @param {string} language
 * @returns {string}
 */
export function defaultScriptStyle(language) {
  return isJapanese(language) ? 'Romaji' : 'Standard';
}

/**
 * Build a fresh profile for a user/language pair.
 *
 * @param {{userName: string, language: string, tutorName?: string, level?: string}} options
 * @returns {Record<string, any>}
 */
export function createDefaultProfile({ userName, language, tutorName, level }) {
  const targetLanguage = String(language || DEFAULT_LANGUAGE).trim() || DEFAULT_LANGUAGE;
  return {
    tutor_name: (tutorName && String(tutorName).trim()) || defaultTutorName(targetLanguage),
    target_language: targetLanguage,
    user_name: String(userName || '').trim(),
    script_style: defaultScriptStyle(targetLanguage),
    proficiency_level: coerceLevel(level ?? DEFAULT_LEVEL),
    known_weaknesses: [],
    recent_vocab: [],
    last_lesson_date: '',
    ai_assessed_level: '',
    assessment_history: [],
  };
}

/**
 * Bring a profile of any vintage up to the current shape without losing data.
 *
 * Returns `{ profile, changed }` so callers can avoid pointless disk writes.
 *
 * @param {unknown} raw parsed contents of config.json (may be anything)
 * @param {{userName: string, language: string}} context
 * @returns {{profile: Record<string, any>, changed: boolean}}
 */
export function migrateProfile(raw, { userName, language }) {
  const source =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? /** @type {Record<string, any>} */ (raw)
      : {};

  const before = JSON.stringify(source);
  const profile = { ...source };

  // --- Identity fields: keep what exists, fill what does not ---------------
  if (typeof profile.target_language !== 'string' || !profile.target_language.trim()) {
    profile.target_language = String(language || DEFAULT_LANGUAGE);
  }
  if (typeof profile.user_name !== 'string' || !profile.user_name.trim()) {
    profile.user_name = String(userName || '');
  }
  if (typeof profile.tutor_name !== 'string' || !profile.tutor_name.trim()) {
    profile.tutor_name = defaultTutorName(profile.target_language);
  }
  if (typeof profile.script_style !== 'string' || !profile.script_style.trim()) {
    profile.script_style = defaultScriptStyle(profile.target_language);
  }

  // --- User-controlled comfort level --------------------------------------
  // Preserved exactly when already valid; only coerced when missing/garbled.
  profile.proficiency_level = coerceLevel(profile.proficiency_level);

  // --- Memory pools --------------------------------------------------------
  // Normalised in place so a legacy config that stored objects stops rendering
  // as [object Object] the moment it is loaded.
  profile.known_weaknesses = normalizeWeaknessList(profile.known_weaknesses);
  profile.recent_vocab = normalizeVocabList(profile.recent_vocab);

  if (typeof profile.last_lesson_date !== 'string') {
    profile.last_lesson_date = '';
  }

  // --- Fields introduced after the first release ---------------------------
  profile.assessment_history = sanitizeHistory(profile.assessment_history);
  if (typeof profile.ai_assessed_level !== 'string') {
    profile.ai_assessed_level = '';
  }
  if (!profile.ai_assessed_level) {
    // Backfill from history when possible; otherwise leave it blank.
    profile.ai_assessed_level = latestAssessedLevel(profile.assessment_history);
  }

  return { profile, changed: JSON.stringify(profile) !== before };
}

/**
 * Human-readable one-line summary, used in the status bar.
 * @param {{user: string, language: string}} params
 * @returns {string}
 */
export function profileLabel({ user, language }) {
  if (!user && !language) return 'None selected';
  if (!language) return `${user} / —`;
  if (!user) return `— / ${language}`;
  return `${user} / ${language}`;
}

export { DEFAULT_LEVEL };
