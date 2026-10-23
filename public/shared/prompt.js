/**
 * shared/prompt.js
 *
 * Builds the Realtime tutor's instructions from the active profile.
 *
 * The exact string this module returns is what gets sent to the model AND what
 * the "Show Active Tutor Prompt" panel displays — there is only one code path,
 * so the preview can never drift from reality.
 *
 * WRITTEN FOR A SMALL MODEL. Three rules govern every line here:
 *
 *   1. State the rule, not the reason. Rationale is for the reader of the
 *      source, not for the model; it costs tokens and dilutes attention.
 *   2. Each rule has exactly ONE home. A rule repeated in three sections reads
 *      as three rules and gets followed like none of them.
 *   3. Stable first, volatile last. Every session.update invalidates cached
 *      input from the first changed byte, so anything that changes mid-lesson
 *      belongs at the end.
 *
 * The Lesson Skills Framework contributes only the last section, and only the
 * part of a lesson that applies right now. The full lesson definition goes to
 * the Lesson Director instead (src/director.js), never to the tutor.
 *
 * Dependency-free: runs unchanged in Node and the browser.
 */

import { coerceLevel, levelGuidance } from './levels.js';
import { normalizeVocabList, normalizeWeaknessList } from './vocab.js';
import { isJapanese } from './profile.js';
import { buildLessonSection, lessonSummaryLine, buildReferenceSection } from './lesson-prompt.js';

/**
 * Japanese output rules.
 *
 * Kept deliberately blunt and slightly redundant: this is a hard constraint the
 * model breaks under load, and the wrong/right pair is worth more than prose.
 * @returns {string}
 */
function japaneseRules() {
  return `# Japanese

- Write and speak Japanese in Hepburn romaji. No kanji, hiragana or katakana:
  the student reads romaji and nothing else. Do not say the word "romaji" to them.
- When you speak English, the language is called Japanese.
- Write long vowels out: ookii, arigatou, toukyou.`;
}

/**
 * How many vocabulary items the tutor is shown.
 *
 * The pool holds twenty, and all twenty are kept in the profile and merged
 * after every lesson. But the tutor is asked to reuse one to three of them, so
 * showing it the most recent dozen is enough — the rest is standing context it
 * pays for on every turn and never uses.
 */
const VOCAB_SHOWN = 12;

/**
 * @param {string[]} items
 * @param {string} label
 * @param {number} [max]
 * @returns {string}
 */
function inlineList(items, label, max = 0) {
  if (!items.length) return '';
  const shown = max > 0 && items.length > max ? items.slice(items.length - max) : items;
  return `${label}: ${shown.join('; ')}`;
}

/**
 * Compose the full tutor instruction string for a session.
 *
 * @param {Record<string, any>} profile the active config.json contents
 * @param {{catalog?: Record<string, any>[], skill?: Record<string, any>|null, state?: Record<string, any>}} [lesson]
 *        the lesson layer: the catalogue of Skills, plus the active Skill and
 *        its runtime state when one is running. Omit it entirely for the
 *        plain conversational prompt.
 * @returns {string}
 */
export function buildTutorPrompt(profile, lesson = null, { opening = true, directed = false } = {}) {
  const config = profile && typeof profile === 'object' ? profile : {};

  const tutorName = String(config.tutor_name || 'Tutor').trim() || 'Tutor';
  const targetLanguage = String(config.target_language || 'German').trim() || 'German';
  const userName = String(config.user_name || 'the student').trim() || 'the student';
  const level = coerceLevel(config.proficiency_level);
  const weaknesses = normalizeWeaknessList(config.known_weaknesses);
  const vocab = normalizeVocabList(config.recent_vocab);

  const sections = [];

  // The shape of this prompt follows OpenAI's guidance for the realtime
  // models: short labelled sections, bullets rather than paragraphs, and plain
  // statements rather than NEVER and ALWAYS. Three earlier versions were lists
  // of prohibitions in capitals, each added to stop the last thing the tutor
  // did wrong, and each produced a new tic in place of the old one — banning
  // praise produced a correction label on every turn; an example phrase for
  // "give the meaning" was read out, verbatim, in a lesson about something
  // else. So: no example phrases in the target language anywhere in here. The
  // model copies them.

  // --- Stable: who you are -------------------------------------------------
  sections.push(`# Role and Objective

You are ${tutorName}, a ${targetLanguage} tutor on a voice call with ${userName}. Their level is ${level}.
The call is a success if ${userName} ends it able to say a few useful things in ${targetLanguage} and knows what each one means.

At this level:
${levelGuidance(level)}
- stay at this level for the whole call. Only the student changes their level, in the app.`);

  // --- Stable: how you behave. Every behavioural rule lives here, once. ----
  // With a script in hand the tutor is told to follow it and nothing else about
  // how to structure a lesson: two sets of instructions for the same job is how
  // a small model ends up following neither.
  // When the app chooses the tutor's words (`directed`), a scripted reply is
  // asked for with instructions of its own, and these standing ones are only
  // consulted outside a script — so they stay the general ones.
  const scripted = !directed && Boolean(
    lesson && lesson.skill && Array.isArray(lesson.state?.script) && lesson.state.script.length &&
      !lesson.state.script_finished,
  );

  const teaching = scripted
    ? `# Teaching

- Under RIGHT NOW you are told what you last asked, what to say in each case, and the words of your next turn. The app keeps the place; your job is to say those words.
- Say them as they are written. Do not add an explanation, a grammar remark, an example or a second request.
- Your turn ends when they do.
- Everything they practise comes from RIGHT NOW. Do not bring in a word or phrase of your own for them to say.`
    : `# Teaching

Teach a few things at a time — three or four words or short phrases — and take each one through these moves, over several turns:

- New: say it, say what it means in English, and ask them to say it.
- Then, once they have said it right, your next turn is not another new thing. Give only the English and ask for the ${targetLanguage}, or ask a question they have to answer with it.
- When you ask for something from its English, the ${targetLanguage} does not appear in that turn: it is the answer.
- After three or four, tell them what they can now say, then start the next few.
- Then drill fast: "What is cabbage?" — a one-word answer is enough.

- Before you ask them to say anything in ${targetLanguage}, they have heard what it means on this call. If not, give the meaning in the same turn.
- Do not ask them to repeat something they have just said correctly.
- If they say why they are learning, or ask how to say something, take your next item from that.
- Vary your wording from turn to turn.`;

  sections.push(`# Personality and Tone

- A calm, direct coach: friendly, brief, no cheerleading.
- ${scripted
    ? 'When an answer is right, one word says so and you go straight on. RIGHT NOW gives the word.'
    : 'When an answer is right, your first words are the next step. Going on is how they know it was right.'}
- No praise: not nice, great, good, perfect, well done, or anything like them.

# Verbosity

- One or two short sentences per turn.
- Ask for one thing per turn, then stop and wait for the answer. A second request waits for your next turn.

# Preambles

Do not use preambles, and do not write in the commentary channel. Every reply is one message, and it goes straight to the point.

${teaching}

# Corrections

- If the meaning and the key words are right, the answer is right. A pause, a filler, an added polite word, a dropped particle, or a different order where the order is free is not a mistake. Go on.
- Correct only a mistake you clearly heard. Say the right version once, say which word or sound was different, and ask for it once more. Change only the part that was wrong.
- A beginner's accent is not a mistake.

# Unclear Audio

- If you did not hear them clearly, or they were cut off, ask them to say it again. Do not guess, and do not correct something you are not sure you heard.

# Accuracy

- Use only words, numbers and forms you are sure are real ${targetLanguage}. If unsure, use a simpler one.
- If they question something you said, check it. If they are right, say so in one sentence, give the correct version, and go on.

# When They Speak English

- Answer the question they asked, in English, with the specific fact, in a sentence or two. Then return to where you were.
- Give instructions, meanings and explanations in English.`);

  // --- Stable: language-specific hard constraints -------------------------
  if (isJapanese(targetLanguage)) {
    sections.push(japaneseRules());
  }

  // --- Semi-stable: what this student carries into the call ---------------
  const memory = [
    inlineList(weaknesses, 'Working on'),
    inlineList(vocab, 'Recent vocabulary', VOCAB_SHOWN),
  ].filter(Boolean);

  // Not while a script is running. The material has already been chosen with
  // this in view, and a tutor left a list of old vocabulary reaches for it the
  // moment it loses its place — one test session was taught "350 yen" and
  // "900 yen" as new, straight off this line.
  if (!scripted) {
    sections.push(`# What They Know

${memory.length ? memory.join('\n') : '(nothing on file yet — this is an early lesson)'}

Background from past calls, not a checklist. Use it to choose material; do not recite it.`);
  }

  // --- Reference facts the running lesson asked for -----------------------
  // Only the sections the lesson declares, and only when the language file has
  // them. This is the difference between the tutor composing a numeral from
  // memory and reading the rule.
  const reference = buildReferenceSection(lesson || {}, { directed });
  if (reference) sections.push(reference);

  // --- Volatile: the lesson layer, last, so the prefix above stays cached --
  // When reference facts are present they supersede the lesson's own material
  // list, which is written as English concepts ("the tens", "the currency and
  // its small unit") and is strictly worse than the real thing.
  const lessonLayer = buildLessonSection(lesson || {}, {
    hasReference: Boolean(reference),
    language: targetLanguage,
    directed,
  });
  if (lessonLayer) sections.push(lessonLayer);

  // Only on the instructions the call opens with. Every later rebuild is pushed
  // into a conversation already twenty minutes old, where an instruction to
  // greet the student and say what you will work on is at best noise and at
  // worst an invitation to start the lesson over.
  if (opening) {
    // In English, for anyone who could not follow the greeting otherwise. A
    // beginner greeted with a full sentence of the language — once, in kanji —
    // starts the call already lost.
    const inEnglish = /beginner/i.test(level) ? ' in English' : '';
    let how;
    if (scripted) how = `Greet them${inEnglish} in one short sentence, tell them in a few words what this part is about, then say the line given under RIGHT NOW.`;
    else if (lesson && lesson.skill) how = `Greet them briefly${inEnglish}, say what you will work on, and begin.`;
    else how = `Greet them briefly${inEnglish} and ask one simple question: what would they like to be able to say?`;
    sections.push(`# START\n\n${how}`);
  }

  return sections.join('\n\n');
}

/**
 * Short summary line used in the UI above the prompt preview.
 * @param {Record<string, any>} profile
 * @param {{catalog?: any[], skill?: any, state?: any}} [lesson]
 * @returns {string}
 */
export function promptSummary(profile, lesson = null) {
  const config = profile && typeof profile === 'object' ? profile : {};
  const weaknesses = normalizeWeaknessList(config.known_weaknesses).length;
  const vocab = normalizeVocabList(config.recent_vocab).length;
  const base = `${config.tutor_name || 'Tutor'} · ${config.target_language || '—'} · ${coerceLevel(
    config.proficiency_level,
  )} · ${weaknesses} weakness${weaknesses === 1 ? '' : 'es'} · ${vocab} vocab item${
    vocab === 1 ? '' : 's'
  }`;
  return lesson ? `${base} · ${lessonSummaryLine(lesson)}` : base;
}
