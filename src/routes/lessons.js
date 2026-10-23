/**
 * src/routes/lessons.js
 *
 * GET  /api/lessons           the catalogue plus the full definitions
 * GET  /api/lessons/:id       one Skill
 * POST /api/lessons/refresh   re-read the directory from disk
 * POST /api/lessons/direct    judge a slice of a running lesson
 *
 * The browser gets the full definitions because the lesson prompt layer is
 * composed client-side, next to the profile, so that "Show Active Tutor Prompt"
 * keeps showing the real thing.
 *
 * Problems are part of a successful response, not an error. A broken lesson
 * file is information the UI should display, not a reason for the request to
 * fail (PART 49, PART 51).
 */

import { Router } from 'express';
import { getLessonLibrary, catalogueOf } from '../lessons.js';
import { directLesson, emptyDirection } from '../director.js';
import { getReferenceLibrary, referenceFor, topicsFor } from '../reference.js';
import { planPhase } from '../planner.js';
import { judgeAnswer } from '../judge.js';
import { coerceLevel } from '../../public/shared/levels.js';
import { MAX_VOCAB } from '../../public/shared/vocab.js';

const router = Router();

/**
 * @param {import('../lessons.js').LessonLibrary} library
 * @param {Record<string, Record<string, string>>} reference
 * @param {Record<string, Record<string, string[]>>} [topics]
 */
function payload(library, reference, topics = {}) {
  return {
    ok: true,
    lessons: library.skills,
    catalogue: catalogueOf(library),
    // Language reference facts, keyed by lowercase language name. The browser
    // picks the one matching the active profile.
    reference,
    // Subject words that map onto those sections, so a lesson whose topic is
    // chosen mid-conversation can pull the right facts.
    topics,
    problems: library.problems,
    warnings: library.warnings,
    loadedAt: library.loadedAt,
  };
}

router.get('/lessons', async (_req, res) => {
  try {
    const [library, reference] = await Promise.all([getLessonLibrary(), getReferenceLibrary()]);
    res.status(200).json(payload(library, reference.languages, reference.topics));
  } catch (error) {
    // Discovery is written not to throw, so reaching here means something
    // unexpected. The app must still work, so answer with an empty library.
    console.error('[kaiwa] Lesson discovery failed:', error?.message || error);
    res.status(200).json({
      ok: false,
      lessons: [],
      catalogue: [],
      reference: {},
      topics: {},
      problems: [{ id: '', source: 'Lessons/', errors: ['The lesson library could not be read.'] }],
      warnings: [],
      loadedAt: new Date().toISOString(),
    });
  }
});

router.get('/lessons/:id', async (req, res) => {
  const library = await getLessonLibrary();
  const lesson = library.skills.find((skill) => skill.id === req.params.id);
  if (!lesson) {
    const problem = library.problems.find((entry) => entry.id === req.params.id);
    res.status(404).json({
      ok: false,
      error: problem
        ? `That lesson could not be loaded: ${problem.errors.join(' ')}`
        : 'That lesson does not exist.',
    });
    return;
  }
  res.status(200).json({ ok: true, lesson });
});

/**
 * POST /api/lessons/direct
 *
 * The bookkeeping the Realtime tutor used to be asked to do with tools, moved
 * to a cheap text model that will actually do it.
 *
 * A failure here is not an error the student should ever notice: the lesson
 * simply carries on unchanged, exactly as it did when the tutor ignored its
 * tools. So this always answers 200 with a direction that changes nothing.
 */
router.post('/lessons/direct', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const library = await getLessonLibrary();
  const skill = library.skills.find((entry) => entry.id === String(body.lessonId || ''));

  if (!skill) {
    res.status(200).json({
      ok: false,
      error: 'That lesson is not available.',
      direction: emptyDirection(),
    });
    return;
  }

  const language = String(body.language || 'the target language');
  const reference = await getReferenceLibrary();

  const result = await directLesson({
    skill,
    state: body.state && typeof body.state === 'object' ? body.state : {},
    transcript: body.transcript,
    language,
    level: coerceLevel(body.level),
    // Judged against exactly the facts the tutor was given, so a disagreement
    // means the tutor drifted rather than the two of them differing.
    reference: referenceFor(reference.languages, language),
  });

  res.status(200).json({
    ok: result.ok,
    skipped: Boolean(result.skipped),
    error: result.error,
    direction: result.direction,
  });
});

/**
 * POST /api/lessons/plan
 *
 * Write the material for one part of a lesson: a handful of things worth being
 * able to say, with their meanings, and a short role-play that needs them. The
 * browser turns the answer into the script the tutor follows.
 *
 * Always answers 200. With no plan the tutor falls back to its general
 * teaching rules, so a failure here costs the script and nothing else.
 */
router.post('/lessons/plan', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const library = await getLessonLibrary();
  const skill = library.skills.find((entry) => entry.id === String(body.lessonId || ''));
  if (!skill) {
    res.status(200).json({ ok: false, plan: null, error: 'That lesson is not available.' });
    return;
  }

  const language = String(body.language || 'the target language');
  const reference = await getReferenceLibrary();
  const list = (value, max) =>
    (Array.isArray(value) ? value : []).slice(0, max).filter((entry) => entry && (typeof entry === 'string' || typeof entry === 'object'));

  const result = await planPhase({
    skill,
    phaseId: String(body.phaseId || ''),
    state: {
      phase: String(body.phaseId || ''),
      runtime_inputs: body.runtimeInputs && typeof body.runtimeInputs === 'object' ? body.runtimeInputs : {},
    },
    language,
    level: coerceLevel(body.level),
    reference: referenceFor(reference.languages, language),
    topics: topicsFor(reference.topics, language),
    taught: list(body.taught, 60),
    // The newest of them: the oldest thirty, taken from the front, left out
    // every word saved since — the very ones a lesson on them should know.
    known: (Array.isArray(body.known) ? body.known : []).slice(-MAX_VOCAB).filter(Boolean).map((entry) => String(entry)),
    requests: list(body.requests, 4).map((entry) => String(entry).slice(0, 200)),
    scenes: list(body.scenes, 12).map((entry) => String(entry).slice(0, 160)),
    // A drill's words: the student's own, from their saved list and this call.
    candidates: (Array.isArray(body.candidates) ? body.candidates : []).slice(-80).filter((entry) => entry && typeof entry === 'object'),
  });

  res.status(200).json({ ok: result.ok, plan: result.plan, error: result.error });
});

/**
 * POST /api/lessons/judge
 *
 * Was the student's answer the one the lesson was waiting for? Asked only when
 * the browser could not tell from the transcript itself.
 *
 * Always answers 200. With no verdict the browser lets the tutor decide.
 */
router.post('/lessons/judge', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const result = await judgeAnswer({
    language: String(body.language || ''),
    kind: String(body.kind || ''),
    say: String(body.say || ''),
    meaning: String(body.meaning || ''),
    also: Array.isArray(body.also) ? body.also.slice(0, 4).map((entry) => String(entry)) : [],
    asked: String(body.asked || ''),
    transcript: String(body.transcript || ''),
    taught: Array.isArray(body.taught) ? body.taught.slice(-12) : [],
    line: String(body.line || ''),
    lineMeaning: String(body.lineMeaning || ''),
    // For the other question asked here: which part of the lesson they want.
    parts: Array.isArray(body.parts) ? body.parts.slice(0, 12) : [],
    current: body.current && typeof body.current === 'object' ? body.current : {},
    before: String(body.before || ''),
  });
  res.status(200).json(result);
});

router.post('/lessons/refresh', async (_req, res) => {
  const [library, reference] = await Promise.all([
    getLessonLibrary({ refresh: true }),
    getReferenceLibrary({ refresh: true }),
  ]);
  res.status(200).json(payload(library, reference.languages, reference.topics));
});

export default router;
