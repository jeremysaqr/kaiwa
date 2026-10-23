/**
 * src/lessons.js
 *
 * Lesson Skill discovery.
 *
 * Skills live in `Lessons/<id>/lesson.json` at the project root. This module
 * walks that directory, validates every candidate through the shared schema,
 * and keeps the result in memory.
 *
 * PART 49 / PART 50 in one sentence: a broken lesson file must cost you that
 * one lesson and nothing else. Discovery never throws, a malformed file is
 * reported with its reason, and every other Skill stays available.
 *
 * PART 4: the five initial lessons are not referenced anywhere in this file.
 * Dropping `Lessons/cafe/lesson.json` on disk is all it takes to add one.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { APP_ROOT } from './paths.js';
import { registerLessons, lessonSummary } from '../public/shared/lesson-schema.js';

/** Where Skills live. Configurable so tests can point at a fixture directory. */
export const LESSONS_DIR = path.resolve(
  process.env.LESSONS_DIR ? process.env.LESSONS_DIR : path.join(APP_ROOT, 'Lessons'),
);

/** The definition file inside each Skill directory. */
const LESSON_FILE = 'lesson.json';

/**
 * @typedef {Object} LessonLibrary
 * @property {Record<string, any>[]} skills validated, registered Skills
 * @property {{id: string, source: string, errors: string[]}[]} problems
 * @property {{id: string, source: string, warnings: string[]}[]} warnings
 * @property {string} directory where we looked
 * @property {string} loadedAt ISO timestamp
 */

/** @type {LessonLibrary|null} */
let cache = null;

/**
 * Read every `Lessons/<id>/lesson.json` and validate it.
 *
 * @param {string} [directory]
 * @returns {Promise<LessonLibrary>}
 */
export async function discoverLessons(directory = LESSONS_DIR) {
  /** @type {{raw: unknown, expectedId: string, source: string}[]} */
  const candidates = [];
  /** @type {{id: string, source: string, errors: string[]}[]} */
  const readProblems = [];

  /** @type {string[]} */
  let entries = [];
  try {
    entries = await readdir(directory);
  } catch (error) {
    // No Lessons directory at all is a legitimate state: the app simply has no
    // lessons, and normal conversation is unaffected (PART 52).
    if (/** @type {any} */ (error)?.code !== 'ENOENT') {
      readProblems.push({
        id: '',
        source: directory,
        errors: [`Could not read the lessons directory: ${/** @type {any} */ (error)?.message}`],
      });
    }
    const empty = {
      skills: [],
      problems: readProblems,
      warnings: [],
      directory,
      loadedAt: new Date().toISOString(),
    };
    cache = empty;
    return empty;
  }

  for (const entry of entries.sort()) {
    if (entry.startsWith('.') || entry.startsWith('_')) continue;

    const lessonDir = path.join(directory, entry);
    try {
      const info = await stat(lessonDir);
      if (!info.isDirectory()) continue;
    } catch {
      continue;
    }

    const file = path.join(lessonDir, LESSON_FILE);
    const source = `${entry}/${LESSON_FILE}`;

    /** @type {string} */
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') {
        readProblems.push({
          id: entry,
          source,
          errors: [`No ${LESSON_FILE} in this folder.`],
        });
      } else {
        readProblems.push({
          id: entry,
          source,
          errors: [`Could not read the file: ${/** @type {any} */ (error)?.message}`],
        });
      }
      continue;
    }

    try {
      candidates.push({ raw: JSON.parse(text), expectedId: entry, source });
    } catch (error) {
      // Malformed JSON is the most common authoring mistake, so say exactly
      // what the parser objected to.
      readProblems.push({
        id: entry,
        source,
        errors: [`Malformed JSON: ${/** @type {any} */ (error)?.message}`],
      });
    }
  }

  const { skills, problems, warnings } = registerLessons(candidates);

  const library = {
    skills,
    problems: [...readProblems, ...problems],
    warnings,
    directory,
    loadedAt: new Date().toISOString(),
  };

  cache = library;
  return library;
}

/**
 * The library, loading it on first use.
 * @param {{refresh?: boolean}} [options]
 * @returns {Promise<LessonLibrary>}
 */
export async function getLessonLibrary({ refresh = false } = {}) {
  if (!cache || refresh) return discoverLessons();
  return cache;
}

/**
 * The synchronously available library, or an empty one if nothing has been
 * loaded yet. Used where an await would be awkward, such as building a session
 * config; every request path warms the cache first.
 * @returns {LessonLibrary}
 */
export function getCachedLibrary() {
  return (
    cache || {
      skills: [],
      problems: [],
      warnings: [],
      directory: LESSONS_DIR,
      loadedAt: '',
    }
  );
}

/**
 * One Skill by id.
 * @param {string} id
 * @returns {Promise<Record<string, any>|null>}
 */
export async function getLesson(id) {
  const library = await getLessonLibrary();
  return library.skills.find((skill) => skill.id === id) || null;
}

/**
 * The catalogue in the compact form the browser needs to render a selector.
 * @param {LessonLibrary} library
 */
export function catalogueOf(library) {
  return library.skills.map((skill) => lessonSummary(skill));
}

/** Log a one-line summary at startup, and the reason for any failure. */
export function reportLessonLibrary(library) {
  const count = library.skills.length;
  console.log(
    `  Lessons        ${count} loaded${count ? ` (${library.skills.map((s) => s.id).join(', ')})` : ''}`,
  );
  for (const problem of library.problems) {
    console.warn(`  Lesson problem ${problem.source}: ${problem.errors.join(' ')}`);
  }
  for (const warning of library.warnings) {
    console.warn(`  Lesson notice  ${warning.source}: ${warning.warnings.join(' ')}`);
  }
}
