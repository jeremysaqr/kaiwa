/**
 * src/director.js
 *
 * The Lesson Director.
 *
 * The Realtime tutor used to be given five function tools and asked to do its
 * own bookkeeping mid-conversation: tick objectives, log vocabulary, change
 * phase. It never did. Voice models in the middle of a sentence do not stop to
 * file paperwork, and the tool definitions alone cost about a thousand tokens
 * of standing context on every single turn.
 *
 * So the job moved. This runs the SAME model that already does memory
 * extraction (gpt-4o-mini), out of band, over the last few turns of the
 * transcript. It is cheap, it is not in the conversation's way, and unlike the
 * tutor it actually answers.
 *
 * What it may decide:  which objectives are met, what vocabulary was
 *                      introduced/practised/struggled with, what a runtime
 *                      input was settled as, whether to change phase, whether
 *                      the lesson's work is done.
 * What it may NOT do:  touch the student's Lesson Comfort Level, or write
 *                      anything to persistent memory. Both live elsewhere and
 *                      neither is reachable from here.
 *
 * Its output is advisory. The client applies it through the same LessonRuntime
 * the UI uses, with the same guards.
 */

import { MEMORY_MODEL } from './config.js';
import { chatJson, OpenAIError } from './openai.js';

/** Only the most recent part of a lesson is worth judging. */
const MAX_TRANSCRIPT_CHARS = 6000;

/** Never let a model response introduce an unbounded number of items. */
const MAX_ITEMS = 12;

/**
 * The lesson, described for a judge rather than for a teacher.
 *
 * This is where the full definition goes — every objective with its id and
 * success indicators, the phase list, the completion rules. None of it reaches
 * the Realtime tutor.
 *
 * @param {Record<string, any>} skill
 * @param {Record<string, any>} state a LessonRuntime snapshot
 */
export function describeLesson(skill, state) {
  const objectives = skill.objectives
    .map((objective) => {
      const status = state.objectives?.[objective.id] || 'pending';
      const indicators = objective.success_indicators.length
        ? ` (met when: ${objective.success_indicators.join('; ')})`
        : '';
      return `- ${objective.id} [${status}] ${objective.description}${indicators}`;
    })
    .join('\n');

  const phases = skill.phases
    .map((phase, index) => {
      const here = phase.id === state.phase ? '  <- current' : '';
      return `- ${phase.id} (${index + 1}/${skill.phases.length}) ${phase.name}: ${phase.purpose}${here}`;
    })
    .join('\n');

  const inputs = skill.runtime_inputs
    .map((input) => {
      const value = state.runtime_inputs?.[input.id];
      const has = value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0);
      return `- ${input.id} (${input.name}, ${input.type}): ${has ? JSON.stringify(value) : 'NOT SET'}`;
    })
    .join('\n');

  const advance = skill.phases
    .filter((phase) => phase.advancement_guidance.length)
    .map((phase) => `- leave ${phase.id} when: ${phase.advancement_guidance.join('; ')}`)
    .join('\n');

  return [
    `LESSON: ${skill.name} (${skill.type})`,
    skill.description ? skill.description : '',
    '',
    'OBJECTIVES',
    objectives || '(none)',
    '',
    'PHASES',
    phases || '(none)',
    advance ? `\n${advance}` : '',
    inputs ? `\nSETTINGS THIS LESSON NEEDS\n${inputs}` : '',
    skill.completion.criteria.length
      ? `\nTHE LESSON'S WORK IS DONE WHEN\n${skill.completion.criteria.map((c) => `- ${c}`).join('\n')}`
      : '',
  ]
    .filter((part) => part !== '')
    .join('\n');
}

/** The judging instructions. Terse on purpose; this model is doing one job. */
export function buildDirectorPrompt({ language, level, lesson, turnsInPhase, reference }) {
  return `You observe a live ${language} lesson and record what has happened. You do not
teach and you do not talk to the student. Return JSON only.

The student's level is "${level}". They have spoken ${turnsInPhase} time(s) in the current part.
${reference ? `\nFACTS ABOUT ${language.toUpperCase()} — the tutor was given these too.\n\n${reference}\n` : ''}
${lesson}

Return exactly this shape:

{
  "completed_objectives": [],
  "partial_objectives": [],
  "introduced_vocabulary": [],
  "practiced_vocabulary": [],
  "successful_vocabulary": [],
  "struggled_vocabulary": [],
  "runtime_inputs": {},
  "phase_id": null,
  "phase_reason": "",
  "should_complete": false,
  "tutor_errors": [],
  "unglossed": [],
  "note": ""
}

RULES

completed_objectives / partial_objectives
- Objective ids only, from the list above. Complete means the student
  demonstrated it, not that the tutor covered it.
- Do not repeat ids already marked complete.
- Judge against the objective's own "met when". Do not hold out for a better
  performance than it asks for. If the student has done what it describes,
  even imperfectly, it is complete.
- An objective still [pending] after many turns in this part is the thing to
  look hardest at. A lesson where nothing is ever marked is a lesson that never
  moves, and the student sits watching a frozen progress bar.
- When you are unsure between pending and complete, return it as partial.
  Silence is the one answer that is always wrong.

vocabulary
- Plain strings, "word — meaning". The word as the tutor gave it.
- introduced: newly presented this excerpt.
- practiced: the student attempted it.
- successful: the student produced it correctly without being given it first.
- struggled: the student could not produce it, or got it wrong twice.
- Never list individual numbers, times or prices. Use one category instead:
  "numbers 1-20", "numbers up to 100", "numbers in the hundreds",
  "numbers in the thousands", "telling the time".

runtime_inputs
- Fill in any setting the lesson needs once the transcript settles it. Use the
  id as the key. If the student let the tutor choose, record what the tutor
  chose.
- For a subject or topic, keep the student's own words and everything they
  named ("meats and vegetables on a restaurant menu"). Do not summarise it into
  something broader ("food vocabulary"): the lesson is written from this line.

phase_id
- Null, almost always. The app moves the lesson from one part to the next when
  the part's material has been worked through; that is not your decision.
- Set it only when the STUDENT asks to skip ahead or to go back, and say that
  in phase_reason ("the student asked to skip ahead").

should_complete
- True only when the student says they want to stop the lesson, or the last
  part is plainly finished. Otherwise false.

tutor_errors
- Things the TUTOR said that are factually wrong about the language: a number
  built incorrectly, a wrong translation, a form that does not exist.
- Each entry: {"said": "<what the tutor said>", "correct": "<the right version>"}.
- Only when you are certain, and only when it contradicts the facts above or is
  plainly wrong. Style, phrasing and teaching choices are NOT errors.
- ASKING the student to say something that is not a real word or number is
  itself an error, and you must report it EVEN IF the tutor corrected itself a
  turn later. The student was already made to say it; the correction does not
  undo that, and it will happen again unless it is reported.
- What you may skip is a slip the tutor caught within the SAME turn, before the
  student responded.
- Empty is the normal answer.

unglossed
- Phrases the tutor asked the student to SAY without ever telling them what the
  phrase means. List the phrase as the tutor gave it.
- A student repeating sounds they cannot translate is learning nothing, so this
  matters even though nothing factually wrong was said.
- It does not count if the meaning was given earlier in this excerpt, or if the
  student clearly already knows it.
- Asking a settled phrase FROM the English ("say 'half past three' in Japanese")
  is the correct behaviour, not an omission.
- Empty is the right answer when every phrase came with its meaning.

note
- One short sentence about the student's performance, or "".

Report only what the excerpt actually shows. Empty lists are the right answer
when nothing happened.`;
}

/** @param {unknown} value @returns {string[]} */
function stringList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const text = typeof entry === 'string' ? entry.replace(/\s+/g, ' ').trim() : '';
    if (text) out.push(text);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/**
 * Constrain the model's answer to ids and shapes the lesson actually has.
 *
 * The runtime rejects unknown ids anyway, but filtering here keeps the client's
 * log clean and means a confused Director cannot fill it with noise.
 *
 * @param {unknown} raw
 * @param {Record<string, any>} skill
 */
export function sanitizeDirection(raw, skill) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  const objectiveIds = new Set(skill.objectives.map((objective) => objective.id));
  const phaseIds = new Set(skill.phases.map((phase) => phase.id));
  const inputIds = new Set(skill.runtime_inputs.map((input) => input.id));

  const onlyKnown = (value) => stringList(value).filter((id) => objectiveIds.has(id));

  /** @type {Record<string, string>} */
  const inputs = {};
  const rawInputs = source.runtime_inputs;
  if (rawInputs && typeof rawInputs === 'object' && !Array.isArray(rawInputs)) {
    for (const [key, value] of Object.entries(rawInputs)) {
      if (!inputIds.has(key)) continue;
      const text = Array.isArray(value)
        ? value.map((entry) => String(entry).trim()).filter(Boolean).join(', ')
        : String(value ?? '').trim();
      if (text) inputs[key] = text;
    }
  }

  const phaseId = typeof source.phase_id === 'string' ? source.phase_id.trim() : '';

  /** @type {{said: string, correct: string}[]} */
  const errors = [];
  /** @type {string[]} */
  const unglossed = [];
  if (Array.isArray(source.unglossed)) {
    for (const entry of source.unglossed.slice(0, 5)) {
      const text = String(entry ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (text) unglossed.push(text);
    }
  }

  if (Array.isArray(source.tutor_errors)) {
    for (const entry of source.tutor_errors.slice(0, 3)) {
      if (!entry || typeof entry !== 'object') continue;
      const said = String(entry.said ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const correct = String(entry.correct ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
      // Both halves are required: "you were wrong" with no correction is worse
      // than saying nothing, because the tutor will invent the fix.
      // And the two halves have to differ. A "correction" that repeats what
      // was said tells the tutor a true statement was false.
      const same = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (said && correct && same(said) !== same(correct) && !same(correct).includes(same(said))) {
        errors.push({ said, correct });
      }
    }
  }

  return {
    completed_objectives: onlyKnown(source.completed_objectives),
    partial_objectives: onlyKnown(source.partial_objectives),
    introduced_vocabulary: stringList(source.introduced_vocabulary),
    practiced_vocabulary: stringList(source.practiced_vocabulary),
    successful_vocabulary: stringList(source.successful_vocabulary),
    struggled_vocabulary: stringList(source.struggled_vocabulary),
    runtime_inputs: inputs,
    phase_id: phaseIds.has(phaseId) ? phaseId : '',
    phase_reason: typeof source.phase_reason === 'string' ? source.phase_reason.trim().slice(0, 200) : '',
    should_complete: source.should_complete === true,
    tutor_errors: errors,
    unglossed,
    note: typeof source.note === 'string' ? source.note.trim().slice(0, 200) : '',
  };
}

/** An answer that changes nothing. Used whenever the Director cannot run. */
export function emptyDirection() {
  return {
    completed_objectives: [],
    partial_objectives: [],
    introduced_vocabulary: [],
    practiced_vocabulary: [],
    successful_vocabulary: [],
    struggled_vocabulary: [],
    runtime_inputs: {},
    phase_id: '',
    phase_reason: '',
    should_complete: false,
    tutor_errors: [],
    unglossed: [],
    note: '',
  };
}

/**
 * Render the excerpt the Director judges.
 * @param {unknown} transcript
 */
export function renderExcerpt(transcript) {
  const lines = [];
  if (Array.isArray(transcript)) {
    for (const entry of transcript) {
      if (typeof entry === 'string') {
        if (entry.trim()) lines.push(entry.trim());
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;
      const role = String(entry.role || '').toLowerCase();
      const speaker = role === 'assistant' || role === 'tutor' ? 'Tutor' : 'Student';
      const text = String(entry.text ?? '').trim();
      if (text) lines.push(`${speaker}: ${text}`);
    }
  } else if (typeof transcript === 'string') {
    lines.push(transcript.trim());
  }
  const joined = lines.join('\n').trim();
  return joined.length > MAX_TRANSCRIPT_CHARS ? joined.slice(joined.length - MAX_TRANSCRIPT_CHARS) : joined;
}

/**
 * Judge a slice of a lesson.
 *
 * Never throws. A Director that cannot run leaves the lesson exactly as it was,
 * which is the same outcome the old tool-based version produced when the tutor
 * declined to call anything — only now it is the exception rather than the rule.
 *
 * @param {{skill: Record<string, any>, state: Record<string, any>, transcript: unknown, language?: string, level?: string}} params
 * @returns {Promise<{ok: boolean, direction: ReturnType<typeof emptyDirection>, error: string|null, skipped?: boolean}>}
 */
export async function directLesson({
  skill,
  state,
  transcript,
  language = 'the target language',
  level = 'Beginner',
  reference = {},
}) {
  if (!skill || typeof skill !== 'object') {
    return { ok: false, direction: emptyDirection(), error: 'No lesson is running.' };
  }

  const excerpt = renderExcerpt(transcript);
  if (excerpt.length < 40) {
    return { ok: true, skipped: true, direction: emptyDirection(), error: null };
  }

  try {
    const answer = await chatJson({
      model: MEMORY_MODEL,
      temperature: 0,
      maxTokens: 600,
      timeoutMs: 20000,
      messages: [
        {
          role: 'system',
          content: buildDirectorPrompt({
            language,
            level,
            lesson: describeLesson(skill, state || {}),
            turnsInPhase: Number(state?.turns_in_phase) || 0,
            reference: Object.values(reference || {}).filter(Boolean).join('\n\n'),
          }),
        },
        { role: 'user', content: `Recent conversation:\n\n${excerpt}` },
      ],
    });

    return { ok: true, skipped: false, direction: sanitizeDirection(answer, skill), error: null };
  } catch (error) {
    return {
      ok: false,
      direction: emptyDirection(),
      error: error instanceof OpenAIError ? error.message : 'The lesson director could not run.',
    };
  }
}
