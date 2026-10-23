/**
 * src/reference.js
 *
 * Per-language reference facts.
 *
 * A small voice model composing "sixty-one" in Japanese while also teaching,
 * listening and staying in character will sometimes get the arithmetic wrong —
 * and say it with complete confidence. Observed: "nijuu juu is thirty" and
 * "rokujuu san ichi is 61". Neither is a language failure; both are the model
 * improvising a rule it half-remembers.
 *
 * So it stops improvising. A language file states the construction rules and
 * enough worked examples to check against, and the tutor is given only the
 * sections the running lesson actually needs.
 *
 * Lessons stay language-agnostic (PART 40): a lesson declares WHICH kind of
 * reference it needs — "numbers", "time", "money" — and the language file
 * supplies the content. A missing language file simply means no reference
 * section, which is how the app behaved before this existed.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { APP_ROOT } from './paths.js';

/** Where language reference files live. */
export const LANGUAGES_DIR = path.resolve(
  process.env.LANGUAGES_DIR ? process.env.LANGUAGES_DIR : path.join(APP_ROOT, 'Languages'),
);

/** @type {{languages: Record<string, Record<string, string>>, problems: {source: string, error: string}[], loadedAt: string}|null} */
let cache = null;

/** @param {unknown} value */
function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read every `Languages/*.json`.
 *
 * Never throws. A broken file costs that one language its reference data and
 * nothing else.
 * @param {string} [directory]
 */
export async function discoverReference(directory = LANGUAGES_DIR) {
  /** @type {Record<string, Record<string, string>>} */
  const languages = {};
  /** @type {Record<string, Record<string, string[]>>} */
  const topics = {};
  /** @type {{source: string, error: string}[]} */
  const problems = [];

  /** @type {string[]} */
  let entries = [];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (/** @type {any} */ (error)?.code !== 'ENOENT') {
      problems.push({ source: directory, error: `Could not read: ${/** @type {any} */ (error)?.message}` });
    }
    const empty = { languages, topics, problems, loadedAt: new Date().toISOString() };
    cache = empty;
    return empty;
  }

  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json') || entry.startsWith('.')) continue;
    const file = path.join(directory, entry);
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      const name = clean(parsed?.language) || entry.replace(/\.json$/, '');
      const source = parsed?.reference;
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        problems.push({ source: entry, error: 'No "reference" object.' });
        continue;
      }
      /** @type {Record<string, string>} */
      const reference = {};
      for (const [key, value] of Object.entries(source)) {
        const text = clean(value);
        if (text) reference[key] = text;
      }
      const key = name.toLowerCase();
      languages[key] = reference;

      // Optional. Lets a lesson whose subject is chosen mid-conversation —
      // "let's do food words" — pull the right reference section without the
      // engine knowing anything about food. A topic naming a section that does
      // not exist is dropped rather than failing the file.
      const declaredTopics = parsed?.topics;
      if (declaredTopics && typeof declaredTopics === 'object' && !Array.isArray(declaredTopics)) {
        /** @type {Record<string, string[]>} */
        const map = {};
        for (const [section, words] of Object.entries(declaredTopics)) {
          if (!reference[section]) {
            problems.push({ source: entry, error: `Topic "${section}" names no reference section.` });
            continue;
          }
          const list = (Array.isArray(words) ? words : [])
            .map((word) => clean(word).toLowerCase())
            .filter(Boolean);
          if (list.length) map[section] = list;
        }
        if (Object.keys(map).length) topics[key] = map;
      }
    } catch (error) {
      problems.push({ source: entry, error: `Malformed JSON: ${/** @type {any} */ (error)?.message}` });
    }
  }

  const library = { languages, topics, problems, loadedAt: new Date().toISOString() };
  cache = library;
  return library;
}

/** The reference library, loading it on first use. */
export async function getReferenceLibrary({ refresh = false } = {}) {
  if (!cache || refresh) return discoverReference();
  return cache;
}

/**
 * The reference sections one language offers.
 * @param {Record<string, Record<string, string>>} languages
 * @param {string} language
 * @returns {Record<string, string>}
 */
export function referenceFor(languages, language) {
  const key = clean(language).toLowerCase();
  return (languages && languages[key]) || {};
}

/**
 * The subject words that map onto one language's reference sections.
 * @param {Record<string, Record<string, string[]>>} topics
 * @param {string} language
 * @returns {Record<string, string[]>}
 */
export function topicsFor(topics, language) {
  const key = clean(language).toLowerCase();
  return (topics && topics[key]) || {};
}

/** Log what was found at startup. */
export function reportReference(library) {
  const names = Object.keys(library.languages);
  console.log(`  Reference      ${names.length} language${names.length === 1 ? '' : 's'}${names.length ? ` (${names.join(', ')})` : ''}`);
  for (const problem of library.problems) {
    console.warn(`  Reference problem ${problem.source}: ${problem.error}`);
  }
}
