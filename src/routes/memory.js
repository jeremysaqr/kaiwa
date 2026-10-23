/**
 * src/routes/memory.js
 *
 * POST /api/memory/extract
 *
 * Takes the raw transcript of a finished lesson plus the profile that was
 * active during it, and returns the profile fields to save.
 *
 * The merge happens HERE, using the same shared modules the browser uses, so
 * there is exactly one implementation of the rules that matter:
 *
 *   - old weaknesses + new weaknesses -> deduplicate -> save
 *   - old vocabulary + new vocabulary -> normalize -> deduplicate -> save
 *   - the user's Lesson Comfort Level is copied through UNTOUCHED
 *   - the model's proficiency guess becomes `ai_assessed_level` and is
 *     appended to `assessment_history` — never written to `proficiency_level`
 *
 * Lesson Skills feed into THIS route and no other (PART 45, PART 46). There is
 * no separate lesson memory and no separate lesson assessment: what happened
 * during a lesson is appended to the same transcript, judged by the same model,
 * and merged into the same two pools. Vocabulary met in a lesson is simply
 * vocabulary; a difficulty seen in a lesson is simply a weakness.
 */

import { Router } from 'express';
import { MEMORY_MODEL } from '../config.js';
import { chatJson, OpenAIError } from '../openai.js';
import { COMFORT_LEVELS, coerceLevel, normalizeLevel } from '../../public/shared/levels.js';
import { mergeVocab, mergeWeaknesses, normalizeVocabList, normalizeWeaknessList, vocabKey } from '../../public/shared/vocab.js';
import { appendAssessment, evaluateRecommendation, sanitizeHistory } from '../../public/shared/assessment.js';

const router = Router();

/** Transcripts longer than this are trimmed to the most recent portion. */
const MAX_TRANSCRIPT_CHARS = 24000;

/** Lesson notes are small, but a pathological payload should still be bounded. */
const MAX_LESSON_NOTE_CHARS = 6000;

/**
 * Instructions for the extractor model.
 * @param {{language: string, level: string, existingVocab: string[], existingWeaknesses: string[]}} context
 */
function buildExtractorPrompt({ language, level, existingVocab, existingWeaknesses, hadLesson }) {
  return `You analyse a language-lesson transcript and return structured JSON.

The lesson was in ${language}. The student's selected Lesson Comfort Level is "${level}".
${
  hadLesson
    ? `
The call may include both ordinary conversation and one or more structured
lesson activities. Judge the whole call together — a single holistic view of
what the student can do. Do not weight the lesson section differently from the
conversation, and do not produce a separate score for it.
`
    : ''
}
Return a JSON object with exactly these keys:

{
  "known_weaknesses": [],
  "recent_vocab": [],
  "proficiency_level": "..."
}

RULES

known_weaknesses
- Specific, observable difficulties that name the word, sound or pattern:
  "mixes up shichi and hachi", "leaves ka off the end of a question",
  "German article gender", "Particle ni vs de".
- Never a subject area or a general skill. "Understanding of vegetable names",
  "Use of vocabulary in context" and "Pronunciation of vocabulary" say nothing
  anyone could act on: leave them out. So is a word said a sound off ("kiro"
  for kiiro, "awi" for aoi): that is accent, or the recogniser.
- The student's lines are a speech recogniser's guess at a beginner's speech,
  and are often wrong when the student was right. A correction by the tutor is
  not evidence on its own. Count a difficulty only if the student missed the
  same thing at least twice, or said themselves that they find it hard.
- 0-2 items, and an empty list is the usual result. Short noun phrases, not
  sentences.
- Do NOT repeat weaknesses already on file unless the student struggled again
  today. Already on file: ${existingWeaknesses.length ? JSON.stringify(existingWeaknesses) : '(none)'}

recent_vocab
- Genuinely useful vocabulary from TODAY's session: words or short phrases that
  were newly introduced or meaningfully reinforced.
- Return 5-12 items whenever the transcript contains identifiable vocabulary.
- Do NOT return an empty list when useful vocabulary clearly appeared.
- Prefer plain strings, e.g. "der Bahnhof (train station)".
- Spell each word as the TUTOR did, never as the student's line has it.
- If you return objects, use {"word":"...","romaji":"...","meaning":"..."}.
- NEVER list individual numbers, times or prices. One number is not vocabulary.
  Instead return at most ONE category line covering the range that was
  practised: "numbers 1-20", "numbers up to 100", "numbers in the hundreds",
  "numbers in the thousands", or "telling the time".
- Already on file (avoid repeating unless genuinely re-taught today):
  ${existingVocab.length ? JSON.stringify(existingVocab) : '(none)'}

proficiency_level
- This is an ASSESSMENT ONLY of the ability the student demonstrated today.
- It has no effect on the lesson difficulty and never changes the student's
  selected level.
- Choose exactly one of: ${COMFORT_LEVELS.map((l) => `"${l}"`).join(', ')}.
- Judge what they actually demonstrated, not what level they are studying at.

Return only the JSON object.`;
}

/**
 * Reduce a transcript array/string into the plain text we send to the model.
 * @param {unknown} transcript
 * @returns {string}
 */
function renderTranscript(transcript) {
  /** @type {string[]} */
  const lines = [];

  if (Array.isArray(transcript)) {
    for (const entry of transcript) {
      if (typeof entry === 'string') {
        if (entry.trim()) lines.push(entry.trim());
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;
      const role = String(/** @type {any} */ (entry).role || '').toLowerCase();
      const speaker = role === 'assistant' || role === 'tutor' ? 'Tutor' : 'Student';
      const text = String(/** @type {any} */ (entry).text ?? '').trim();
      if (text) lines.push(`${speaker}: ${text}`);
    }
  } else if (typeof transcript === 'string') {
    lines.push(transcript.trim());
  }

  const joined = lines.join('\n').trim();
  return joined.length > MAX_TRANSCRIPT_CHARS
    ? joined.slice(joined.length - MAX_TRANSCRIPT_CHARS)
    : joined;
}

/**
 * Turn the runtime summaries of any lessons run during this call into plain
 * text appended to the transcript.
 *
 * This is the whole of the lesson-to-memory integration. Nothing here creates a
 * new field, a new file, or a new pool — it hands the extractor more evidence
 * about the same student (PART 12, PART 46).
 *
 * @param {unknown} lessons
 * @returns {string}
 */
export function renderLessonNotes(lessons) {
  if (!Array.isArray(lessons) || lessons.length === 0) return '';

  /** @type {string[]} */
  const blocks = [];

  for (const entry of lessons) {
    if (!entry || typeof entry !== 'object') continue;
    const lesson = /** @type {any} */ (entry);
    const name = String(lesson.name || lesson.id || 'a lesson').trim();
    if (!name) continue;

    /** @type {string[]} */
    const lines = [];
    const status = lesson.completed
      ? 'completed'
      : `not completed (${String(lesson.end_reason || 'stopped')})`;
    lines.push(`Lesson: ${name} — ${status}.`);

    const inputs = lesson.runtime_inputs && typeof lesson.runtime_inputs === 'object'
      ? Object.entries(lesson.runtime_inputs)
          .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
          .filter(Boolean)
      : [];
    if (inputs.length) lines.push(`Focus chosen for the lesson: ${inputs.join('; ')}.`);

    /** @param {string} label @param {unknown} list */
    const add = (label, list) => {
      const items = Array.isArray(list) ? list.map((x) => String(x).trim()).filter(Boolean) : [];
      if (items.length) lines.push(`${label}: ${items.join('; ')}.`);
    };

    add('Objectives the student met', lesson.objectives_complete);
    add('Objectives only partly met', lesson.objectives_partial);
    add('Vocabulary introduced during the lesson', lesson.introduced_vocab);
    add('Vocabulary practised', lesson.practiced_vocab);
    add('Vocabulary the student used correctly and unprompted', lesson.successful_vocab);
    add('Vocabulary or structures the student struggled with', lesson.struggled_vocab);
    add('Structures this lesson targeted', lesson.target_grammar);
    add('Tutor observations', lesson.notes);

    blocks.push(lines.join('\n'));
  }

  if (!blocks.length) return '';

  const joined = [
    'Structured lesson activity during this call:',
    '',
    blocks.join('\n\n'),
  ].join('\n');

  return joined.length > MAX_LESSON_NOTE_CHARS
    ? `${joined.slice(0, MAX_LESSON_NOTE_CHARS)}\n(truncated)`
    : joined;
}

/**
 * How many entries of `after` were not in `before`, compared by `key`.
 * @param {string[]} before @param {string[]} after @param {(text: string) => string} key
 */
function countNew(before, after, key) {
  const had = new Set(before.map(key));
  return after.filter((text) => !had.has(key(text))).length;
}

/**
 * Build the saved profile from the previous profile plus extractor output.
 * Pure function — unit-testable and used for the empty-transcript path too.
 *
 * @param {Record<string, any>} profile
 * @param {{known_weaknesses?: unknown, recent_vocab?: unknown, proficiency_level?: unknown}} extracted
 * @param {string} [now] ISO timestamp
 */
export function applyExtraction(profile, extracted, now = new Date().toISOString()) {
  const base = profile && typeof profile === 'object' ? profile : {};

  // The user's level is authoritative and is copied through unchanged.
  const comfortLevel = coerceLevel(base.proficiency_level);

  // A student who reads only romaji has no weakness written in kana: "mixes up
  // haiiro and ハイロー" is the recogniser's spelling, not something they said.
  const romaji = String(base.script_style || '').toLowerCase() === 'romaji';
  const observed = normalizeWeaknessList(extracted?.known_weaknesses)
    .filter((text) => !romaji || !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text));
  const mergedWeaknesses = mergeWeaknesses(base.known_weaknesses, observed);
  const mergedVocab = mergeVocab(base.recent_vocab, extracted?.recent_vocab);

  // The model's guess is an assessment, nothing more.
  const assessed = normalizeLevel(extracted?.proficiency_level);
  const history = assessed
    ? appendAssessment(base.assessment_history, assessed, now)
    : sanitizeHistory(base.assessment_history);

  const updated = {
    ...base,
    proficiency_level: comfortLevel, // <- never overwritten by the AI
    known_weaknesses: mergedWeaknesses,
    recent_vocab: mergedVocab,
    last_lesson_date: now,
    ai_assessed_level: assessed || String(base.ai_assessed_level || ''),
    assessment_history: history,
  };

  return {
    profile: updated,
    recommendation: evaluateRecommendation(comfortLevel, history),
    // What is new, counted as new. The difference in length said "0 new vocab
    // items" for eleven colours, because the full list dropped eleven old ones.
    added: {
      weaknesses: countNew(normalizeWeaknessList(base.known_weaknesses), mergedWeaknesses, (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')),
      vocab: countNew(normalizeVocabList(base.recent_vocab), mergedVocab, (text) => vocabKey(text) || text.toLowerCase()),
    },
  };
}

router.post('/memory/extract', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const profile = body.profile && typeof body.profile === 'object' ? body.profile : {};
  const conversation = renderTranscript(body.transcript);
  const lessonNotes = renderLessonNotes(body.lessons);
  const transcriptText = lessonNotes ? `${conversation}\n\n${lessonNotes}`.trim() : conversation;

  const language = String(profile.target_language || 'the target language');
  const level = coerceLevel(profile.proficiency_level);

  // Empty transcript: nothing to learn from, but still return a coherent
  // profile so the client can finish its save/update cycle cleanly. Lesson
  // notes alone are not enough — without speech there is nothing to assess.
  if (!conversation || conversation.length < 20) {
    const result = applyExtraction(profile, {});
    res.status(200).json({
      ok: true,
      skipped: true,
      reason: 'The transcript was too short to assess, so memory was left unchanged.',
      ...result,
    });
    return;
  }

  try {
    const extracted = await chatJson({
      model: MEMORY_MODEL,
      timeoutMs: 45000,
      messages: [
        {
          role: 'system',
          content: buildExtractorPrompt({
            language,
            level,
            existingVocab: normalizeVocabList(profile.recent_vocab),
            existingWeaknesses: normalizeWeaknessList(profile.known_weaknesses),
            hadLesson: Boolean(lessonNotes),
          }),
        },
        {
          role: 'user',
          content: `Lesson transcript:\n\n${transcriptText}`,
        },
      ],
    });

    const result = applyExtraction(profile, extracted);
    res.status(200).json({ ok: true, skipped: false, ...result });
  } catch (error) {
    // A failed extraction must not cost the user their existing memory. Return
    // the untouched profile alongside the error so the client can still save
    // the lesson date and show an actionable message.
    const fallback = applyExtraction(profile, {});
    const status = error instanceof OpenAIError ? error.status : 500;
    const message =
      error instanceof OpenAIError
        ? error.message
        : 'Memory extraction failed unexpectedly.';

    res.status(status >= 400 && status < 600 ? status : 500).json({
      ok: false,
      error: message,
      // Existing memory, preserved exactly.
      ...fallback,
    });
  }
});

export default router;
