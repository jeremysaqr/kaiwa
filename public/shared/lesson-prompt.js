/**
 * shared/lesson-prompt.js
 *
 * The Skill layer of the tutor prompt.
 *
 * A lesson definition is large — objectives with ids, every phase, adaptation
 * advice, completion rules, vocabulary lists. Almost none of it is true RIGHT
 * NOW, and a small model asked to hold all of it holds none of it.
 *
 * So the split is:
 *
 *   the tutor   gets the current phase and the live state. Nothing else.
 *   the Director (src/director.js, on a cheap text model) gets the full
 *               definition, and does the bookkeeping the tutor used to be
 *               asked to do with tools.
 *
 * Everything here is therefore either the current phase's own instructions or a
 * fact about the last few minutes. Sections appear only when they apply: no
 * completion criteria until the lesson is nearly done, no adaptation advice
 * until there is something to adapt to.
 *
 * Dependency-free: runs unchanged in Node and the browser.
 */

/** Most instructions shown for the current phase. */
const MAX_PHASE_INSTRUCTIONS = 3;

/** Most vocabulary items offered as material. */
const MAX_MATERIAL_ITEMS = 8;

import { toDisplayText } from './romaji.js';
import { renderScript } from './script.js';

/** Most adaptation bullets shown when the student is struggling or flying. */
const MAX_ADAPTATION = 2;

/** Successful items, with no struggles, before the tutor is told to push. */
const CONFIDENT_AFTER = 3;

/**
 * Most reference sections shown at once. A lesson may declare more than this
 * across its whole run; each phase should narrow it to what that part needs.
 */
const MAX_REFERENCE_SECTIONS = 2;

/** @param {unknown} value @returns {string} */
function clean(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** @param {unknown} list @param {number} max @returns {string[]} */
function take(list, max) {
  return (Array.isArray(list) ? list : []).map(clean).filter(Boolean).slice(0, max);
}

/**
 * The headword an entry is about, for comparing two renderings of one word.
 *
 * The Director writes the same item several ways over a lesson — "gyuuniku",
 * "gyuuniku \u2014 beef", "buta niku \u2014 pork" against "butaniku \u2014 pork" — and a
 * list carrying all of them reads as a list of different words.
 * @param {string} text
 * @returns {string}
 */
function headword(text) {
  const head = text.split(/\s+[\u2014\u2013-]\s+|\s*\(/u)[0] || text;
  return head.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Keep the first rendering of each distinct headword, dropping anything whose
 * headword is already spoken for.
 * @param {string[]} list
 * @param {Set<string>} [exclude] headwords to drop entirely
 * @returns {string[]}
 */
function distinct(list, exclude = new Set()) {
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const key = headword(entry) || entry.toLowerCase();
    if (!key || seen.has(key) || exclude.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** @param {number} value */
function percent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

/**
 * The catalogue, shown only when no lesson is running.
 *
 * Its whole job is to let the tutor say yes gracefully. It does NOT start
 * lessons — the app does that, from what the student actually said — so there
 * is nothing here about how or when to start one beyond not pre-empting it.
 *
 * @param {Record<string, any>[]} skills
 * @returns {string}
 */
export function buildLessonCatalogSection(skills) {
  const list = Array.isArray(skills) ? skills : [];
  if (!list.length) return '';

  return `# LESSONS

Structured lessons are available: ${list.map((skill) => skill.name).join(', ')}.

If the student clearly asks for one, say yes in a sentence — it starts by
itself. If they only mention the subject in passing, just talk with them about
it; do not offer a lesson.`;
}

/**
 * What the tutor needs for the next few minutes, and nothing else.
 *
 * @param {Record<string, any>} skill the validated Skill
 * @param {Record<string, any>} state a LessonRuntime snapshot
 * @returns {string}
 */
export function buildActiveLessonSection(skill, state, { hasReference = false, language = '', directed = false } = {}) {
  if (!skill || typeof skill !== 'object') return '';
  const snapshot = state && typeof state === 'object' ? state : {};

  const phases = Array.isArray(skill.phases) ? skill.phases : [];
  const index = phases.findIndex((phase) => phase.id === snapshot.phase);
  const phase = index >= 0 ? phases[index] : phases[0] || null;

  const lines = ['# RIGHT NOW', ''];

  // --- Where we are --------------------------------------------------------
  const position = phase && phases.length > 1 ? ` — part ${index + 1} of ${phases.length}: ${phase.name}` : '';
  lines.push(`Lesson: ${skill.name}${position}`);
  if (phase && phase.purpose) lines.push(`Aim: ${clean(phase.purpose)}`);

  // --- A scripted part: what was last asked, and the one line to say next ---
  // Everything below this block — the lesson's own prose, the material list,
  // the lists of what is settled and what is hard — was the tutor being asked
  // to design the lesson as it went, which is the job it could not do. With a
  // script in hand none of it is shown, and nor is the script: only its next
  // line. The app keeps the place.
  const script = Array.isArray(snapshot.script) ? snapshot.script : [];
  if (script.length && !snapshot.script_finished && directed) {
    // The app asks for each reply in this part with instructions of its own,
    // written once the student has spoken. These standing instructions are
    // not consulted for them, so they say only that.
    lines.push('');
    lines.push('For this part you are given the words of each turn as you go.');
    lines.push('If you are ever asked to speak without being given them, your whole turn is — One moment.');
    return lines.join('\n');
  }
  if (script.length && !snapshot.script_finished) {
    lines.push('');
    lines.push(
      renderScript(script, {
        language: language || 'the language',
        current: snapshot.script_current ?? -1,
        misses: snapshot.script_misses ?? 0,
      }),
    );
    lines.push('');
    lines.push('Answers to their questions are in English.');
    lines.push(
      'Do not say the words lesson, phase, step, script, line, objective or progress to them, and do not ' +
        'read out any heading or label from these instructions.',
    );
    return lines.join('\n');
  }

  // --- A part whose material is still being written -----------------------
  // A tutor asked to begin before it has anything to teach begins by making
  // something up, and made-up material is what the plan exists to replace.
  if (snapshot.plan_pending) {
    lines.push('');
    lines.push('The material for this part is being prepared and will be with you in a few seconds.');
    lines.push('- If they speak before it arrives, your whole turn is — One moment.');
    lines.push('- Do not teach or ask for anything until it arrives.');
    return lines.join('\n');
  }

  // --- How to run this part ------------------------------------------------
  // A part that is taught from a script keeps its notes for the planner, not
  // the tutor: "the role-play is the waiter taking the order" is advice about
  // what to write, and reads as nonsense mid-conversation. Without a script
  // (the planner failed, or has not finished) the tutor falls back on its
  // general teaching rules and the part's aim.
  const scriptedMode = phase && (phase.mode === 'teach' || phase.mode === 'roleplay' || phase.mode === 'review');
  const instructions = scriptedMode ? [] : take(phase?.instructions, MAX_PHASE_INSTRUCTIONS);
  if (instructions.length) {
    lines.push('');
    for (const instruction of instructions) lines.push(`- ${instruction}`);
  }

  // --- Anything the lesson still needs settled -----------------------------
  const pending = Array.isArray(snapshot.pending_inputs) ? snapshot.pending_inputs : [];
  if (pending.length) {
    lines.push('');
    for (const input of pending) {
      const ask = input.prompt ? ` Ask like this: "${clean(input.prompt)}"` : '';
      const choice = input.allow_tutor_choice ? ' If they say you choose, pick one and begin.' : '';
      lines.push(`Not settled yet — ${input.name}.${ask}${choice}`);
    }
  }

  const values = snapshot.runtime_inputs && typeof snapshot.runtime_inputs === 'object'
    ? Object.values(snapshot.runtime_inputs).map((value) => (Array.isArray(value) ? value.join(', ') : String(value)))
    : [];
  const settledInputs = values.map(clean).filter(Boolean);
  if (settledInputs.length) {
    // "Working on" is the weaknesses line in the base prompt; this is the
    // lesson's own subject and must not read as the same thing.
    if (!pending.length) lines.push('');
    lines.push(`Subject: ${settledInputs.join('; ')}`);
  }

  // --- Material, only while there is still teaching left to do -------------
  const material = take(skill.content?.target_vocabulary, MAX_MATERIAL_ITEMS);
  if (material.length && !hasReference && percent(snapshot.progress) < 60) {
    lines.push('');
    // Expressed in English in the lesson file; the tutor renders them in the
    // language it is already teaching.
    lines.push(`Useful here: ${material.join(', ')}`);
  }

  // --- Live state. This is what stops the lesson going round in circles. ---
  // A word cannot be both finished with and still hard. When the Director has
  // reported both — which it does, because a word practised twice and got wrong
  // twice is genuinely both — "still hard" wins: telling the tutor never to ask
  // again for the very word the student cannot say is how a lesson ends up
  // drilling it anyway, in defiance of a rule that contradicted itself.
  //
  // Rendered in the script the tutor is required to use. The Director reads the
  // student's transcripts, so these come back as the student was heard —
  // "トマト — tomato", "鶏肉 — chicken" — and a prompt that says "never katakana"
  // four sections earlier then hands the model katakana to work with. It also
  // made one word look like two: `tomato` and `トマト` each took a slot in a
  // list capped at twelve. This is the same conversion the on-screen transcript
  // has always used.
  const render = (entry) => (language ? toDisplayText(entry, language) : entry);
  const struggling = distinct(take(snapshot.struggled_vocab, 12).map(render)).slice(0, 6);
  const blocked = new Set(struggling.map((entry) => headword(entry)));
  const settled = distinct(take(snapshot.settled_vocab, 24).map(render), blocked).slice(0, 12);
  if (settled.length || struggling.length) lines.push('');
  // Said correctly twice. These used to be listed as "do not ask for these
  // again", which stopped the echo loop but threw the material away. They are
  // in fact the only items ready to be asked for in the OTHER direction, which
  // is the difference between recognising a phrase and knowing it.
  if (settled.length) lines.push(`Ready for Recall — give only the English: ${settled.join(', ')}`);
  if (struggling.length) lines.push(`Still hard — give the meaning again: ${struggling.join(', ')}`);

  // --- Adaptation, only when there is something to adapt to ----------------
  const adaptation = skill.adaptation || {};
  const successes = Array.isArray(snapshot.successful_vocab) ? snapshot.successful_vocab.length : 0;
  if (struggling.length) {
    const advice = take(adaptation.if_struggling, MAX_ADAPTATION);
    if (advice.length) {
      lines.push('');
      lines.push('They are struggling:');
      for (const item of advice) lines.push(`- ${item}`);
    }
  } else if (successes >= CONFIDENT_AFTER) {
    const advice = take(adaptation.if_succeeding, MAX_ADAPTATION);
    if (advice.length) {
      lines.push('');
      lines.push('They are doing well:');
      for (const item of advice) lines.push(`- ${item}`);
    }
  }

  // --- The one rule that outranks everything above -------------------------
  lines.push('');
  lines.push(
    'The student outranks this lesson. If they ask a question, want something ' +
      'easier or harder, want to skip ahead or want to stop, follow them.',
  );
  lines.push('Do not say the words lesson, phase, objective or progress to them.');

  return lines.join('\n');
}

/**
 * The language facts the running lesson asked for.
 *
 * A lesson names the KIND of reference it needs; the language supplies the
 * content. Nothing is included that the lesson did not ask for, and nothing at
 * all when no lesson is running — a tutor that is chatting does not need the
 * yen counter rules in front of it.
 *
 * @param {{skill?: Record<string, any>|null, reference?: Record<string, string>, state?: Record<string, any>}} [lesson]
 * @returns {string}
 */
export function buildReferenceSection(lesson = {}, { directed = false } = {}) {
  const { blocks, scripted } = selectReference(lesson, { directed });
  if (!blocks.length) return '';

  // While a script runs, the reference is where the tutor went shopping when
  // it lost its place: salad, tomato and apple for a student who asked for
  // meats and vegetables; the waiter's lines handed to the diner to say. It
  // was invited to — the block said "teach these as written" and "before
  // asking the student to say something, build it with these rules". With a
  // script the reference has one use, and says so.
  if (scripted) {
    const facts = blocks.map((block) => block.replace(/\s*Teach these as written\./g, '')).join('\n\n');
    return `# REFERENCE — for answering their questions, and nothing else

${facts}

What they practise comes from RIGHT NOW, not from here. Do not teach, quiz or ask them to say anything from this list.
If they ask about something that is here, answer with the matching fact, in these words.`;
  }

  return `# REFERENCE — these are facts, not suggestions

${blocks.join('\n\n')}

Use these exactly. If something you are about to say disagrees with this, this is right.
Before asking the student to say something, build it with these rules and check it exists.`;
}

/**
 * The same facts as plain text, for a reply whose instructions the app writes
 * itself: no heading, and no invitation to teach from them.
 * @param {Parameters<typeof buildReferenceSection>[0]} [lesson]
 * @returns {string}
 */
export function referenceFacts(lesson = {}) {
  // The part's own section first, and then what else the lesson draws on:
  // "why is it yon here and not shi?" was asked in the part about prices, and
  // the answer is in the section about numbers.
  const blocks = [...selectReference(lesson, { directed: true, limit: 2 }).blocks];
  const { skill = null, reference = {} } = lesson || {};
  for (const key of Array.isArray(skill?.reference) ? skill.reference : []) {
    const text = typeof reference?.[key] === 'string' ? reference[key].trim() : '';
    if (text && !blocks.includes(text) && blocks.length < 3) blocks.push(text);
  }
  return blocks.map((block) => block.replace(/\s*Teach these as written\./g, '')).join('\n\n');
}

/**
 * Which reference sections bear on the lesson as it stands.
 * @param {Parameters<typeof buildReferenceSection>[0]} [lesson]
 * @param {{directed?: boolean, limit?: number}} [options]
 * @returns {{blocks: string[], scripted: boolean}}
 */
export function selectReference(lesson = {}, { directed = false, limit: cap = 0 } = {}) {
  const { skill = null, reference = {}, state = {}, topics = {} } = lesson || {};
  if (!skill || !reference || typeof reference !== 'object') return { blocks: [], scripted: false };

  // The PHASE decides what the tutor sees. The lesson-level list is the set a
  // lesson may draw on across its whole run — useful to the Director, too much
  // for a tutor mid-conversation — so a phase that declares nothing gets
  // nothing. Only a lesson with no phases at all falls back to its own list.
  const phases = Array.isArray(skill.phases) ? skill.phases : [];
  const phase = phases.find((entry) => entry.id === state?.phase) || null;
  // Normalised skills always carry an array here; a hand-written lesson.json
  // read straight off disk may not, and a missing key must not take the prompt
  // down with it.
  const declared = phases.length ? phase?.reference : skill.reference;
  const wanted = Array.isArray(declared) ? [...declared] : [];

  // A lesson whose subject is settled in conversation cannot declare what it
  // needs in advance. Vocabulary Builder is the whole lesson: the student says
  // "ingredients, meats and vegetables", and the tutor is then left composing
  // food words from memory — which is how a real session taught "onion" and
  // "potato" as the Japanese for onion and potato. The language file maps
  // subject words onto its own sections, so the engine matches without knowing
  // anything about food.
  for (const value of Object.values(state?.runtime_inputs || {})) {
    const subject = ` ${String(Array.isArray(value) ? value.join(' ') : value ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()} `;
    if (subject.trim().length < 2) continue;
    for (const [section, words] of Object.entries(topics || {})) {
      if (wanted.includes(section) || !Array.isArray(words)) continue;
      if (words.some((word) => subject.includes(` ${word} `))) wanted.push(section);
    }
  }

  // With a script in hand the material is already vetted, so the reference is
  // only there for the questions a student asks off-script. One section — the
  // part's own subject — is enough for that, and half the cost. When the app
  // is choosing the tutor's words the standing instructions are only used
  // outside a script, so they carry the full set.
  const running = Array.isArray(state?.script) && state.script.length > 0 && !state.script_finished;
  const scripted = running && !directed;
  const limit = cap || (scripted ? 1 : MAX_REFERENCE_SECTIONS);

  const blocks = [];
  for (const key of wanted) {
    const text = typeof reference[key] === 'string' ? reference[key].trim() : '';
    if (text) blocks.push(text);
    if (blocks.length >= limit) break;
  }
  return { blocks, scripted };
}

/**
 * The whole lesson layer: catalogue when idle, the current phase when running.
 *
 * @param {{catalog?: Record<string, any>[], skill?: Record<string, any>|null, state?: Record<string, any>}} [lesson]
 * @returns {string}
 */
export function buildLessonSection(lesson = {}, options = {}) {
  const { catalog = [], skill = null, state = {} } = lesson || {};
  if (skill) return buildActiveLessonSection(skill, state, options);
  return buildLessonCatalogSection(catalog);
}

/**
 * One line describing lesson state, for the prompt-preview header and the
 * status strip.
 * @param {{skill?: Record<string, any>|null, state?: Record<string, any>, catalog?: Record<string, any>[]}} [lesson]
 * @returns {string}
 */
export function lessonSummaryLine(lesson = {}) {
  const { skill = null, state = {}, catalog = [] } = lesson || {};
  if (!skill) {
    const count = Array.isArray(catalog) ? catalog.length : 0;
    return `Normal conversation · ${count} lesson${count === 1 ? '' : 's'} available`;
  }
  const phase = state?.phase_name ? ` · ${state.phase_name}` : '';
  return `${skill.name}${phase} · ${percent(state?.progress)}%`;
}
