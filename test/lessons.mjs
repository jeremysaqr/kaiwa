/**
 * test/lessons.mjs
 *
 * The Lesson Skills Framework, checked against the testing requirements in
 * PART 59 and the acceptance criteria in PART 60.
 *
 * Run with:  npm run test:lessons   (npm test runs this and verify.mjs)
 *
 * No test framework, no dependencies — just node.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { validateLesson, SKILL_TYPES } from '../public/shared/lesson-schema.js';
import { LessonRuntime } from '../public/shared/lesson-runtime.js';
import {
  classifyActivationIntent,
  resolveSkillReference,
  isDeactivationRequest,
  isAffirmation,
  isRefusal,
  topicRequest,
  drillRequest,
  openingTopic,
} from '../public/shared/lesson-activation.js';
import {
  sanitizeDirection, describeLesson, emptyDirection, renderExcerpt, buildDirectorPrompt,
} from '../src/director.js';
import {
  buildLessonSection,
  buildActiveLessonSection,
  buildReferenceSection,
  referenceFacts,
} from '../public/shared/lesson-prompt.js';
import { buildTutorPrompt } from '../public/shared/prompt.js';
import { LessonConductor } from '../public/shared/conductor.js';
import {
  alsoRight, answersStep, buildScript, dropStep, lineFor, renderScript, locateStep, sanitizePlan, taughtSoFar,
  variantKeys, wantsToMoveOn, asksHowToSay, looksLikeQuestion, turnFor, renderTurn, confusedWith, wentOn, givesUp,
  correctionFor, nearMiss, fitsScene, asksForPart, requestParts, requestThing, remainderOf, saysPhrases,
  japaneseNumber, freshPrices, soundKey, soundsLike, pronunciationOf, declinesToGoOn, objectsToMoving,
  bareYes, earPrompt, hearsYes, isCount, meaningNear, soundGap, thingsNamed, orderWord, fold,
} from '../public/shared/script.js';
import { StudentTurns, trailsOff, joinSpeech } from '../public/shared/turns.js';
import { buildJudgePrompt, buildPartPrompt } from '../src/judge.js';
import { buildDrillPrompt, buildPlanPrompt, longVowelFixes, planDrill, planPhase, proofread, relevantReference } from '../src/planner.js';
import { discoverLessons } from '../src/lessons.js';
import { discoverReference, referenceFor, topicsFor } from '../src/reference.js';
import { applyExtraction, renderLessonNotes } from '../src/routes/memory.js';
import { vocabItems } from '../public/shared/vocab.js';
import { toDisplayText, toRomaji } from '../public/shared/romaji.js';
import { COMFORT_LEVELS } from '../public/shared/levels.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'lessons');

let passed = 0;
let failed = 0;

/** @param {string} name @param {() => void|Promise<void>} fn */
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`      ${error?.message?.split('\n')[0] || error}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** The real, shipped library. Loaded once and reused. */
const library = await discoverLessons(path.join(ROOT, 'Lessons'));
const SKILLS = library.skills;

const REFERENCE_LIBRARY = await discoverReference(path.join(ROOT, 'Languages'));
const JAPANESE_REFERENCE = referenceFor(REFERENCE_LIBRARY.languages, 'Japanese');
const JAPANESE_TOPICS = topicsFor(REFERENCE_LIBRARY.topics, 'Japanese');

/** A profile to build prompts against. */
function profileFor(language = 'German') {
  return {
    tutor_name: language === 'Japanese' ? 'Tanaka-san' : 'Franz',
    target_language: language,
    user_name: 'Jeremy',
    script_style: language === 'Japanese' ? 'Romaji' : 'Standard',
    proficiency_level: 'Beginner',
    known_weaknesses: ['Article gender'],
    recent_vocab: ['der Bahnhof (train station)'],
    last_lesson_date: '',
    ai_assessed_level: '',
    assessment_history: [],
  };
}

/** Start a runtime on one of the shipped Skills. */
function runtimeOn(id) {
  const runtime = new LessonRuntime();
  const skill = SKILLS.find((entry) => entry.id === id);
  assert.ok(skill, `skill ${id} should exist`);
  runtime.activate(skill, { reason: 'test' });
  return { runtime, skill };
}

const { LessonLibrary } = await import('../public/js/lessons.js');

/** A library primed with the shipped Skills, without going near the network. */
function libraryWithSkills() {
  const library = new LessonLibrary();
  library.skills = SKILLS;
  library.loaded = true;
  return library;
}

/** A plan as the planner returns it, for a part about arriving at a restaurant. */
const SAMPLE_PLAN = Object.freeze({
  items: [
    { say: 'sumimasen', meaning: 'excuse me', note: 'to call the waiter', known: false },
    { say: 'futari desu', meaning: 'two people', note: '', known: false },
    { say: 'menyuu o onegaishimasu', meaning: 'the menu, please', note: '', known: false },
  ],
  scene: {
    setup: "I'm the waiter and you have just walked in.",
    lines: [
      { tutor: 'Irasshaimase. Nanmei-sama desu ka?', meaning: 'Welcome. How many people?', expect: 'futari desu' },
    ],
  },
});

/**
 * A LessonConductor on a real LessonLibrary, with everything it touches
 * recorded. The Director is replaced by a canned answer.
 * @param {Record<string, any>} direction what the Director will report
 */
function conductorRig(direction, options = {}) {
  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });
  library.runDirector = async () => ({
    ok: true,
    error: null,
    applied: library.applyDirection({ ...emptyDirection(), ...direction }),
  });
  /** @type {string[]} */
  const planned = [];
  library.fetchPlan = async (phaseId) => {
    planned.push(phaseId);
    return { ok: true, plan: JSON.parse(JSON.stringify(SAMPLE_PLAN)), error: null };
  };
  const rig = {
    library,
    planned,
    /** @type {{text: string, speak: boolean}[]} */ nudges: [],
    /** @type {{text: string, kind: string}[]} */ notes: [],
    /** @type {{type: string, payload: any}[]} */ logs: [],
    /** @type {{instructions: string, fresh: boolean, say: string, after: boolean}[]} */ replies: [],
    /** @type {{role: string, text: string}[]} */ transcript: [],
    syncs: 0,
    conductor: /** @type {any} */ (null),
  };
  rig.conductor = new LessonConductor({
    lessons: library,
    getProfile: () => profileFor('Japanese'),
    getTranscript: () => rig.transcript,
    nudge: (text, options) => rig.nudges.push({ text, speak: Boolean(options?.speak) }),
    respond: (instructions, opts) => rig.replies.push({
      instructions, fresh: Boolean(opts?.fresh), say: String(opts?.say || ''), after: Boolean(opts?.after),
    }),
    getReference: () => 'Onion tamanegi. Potato jagaimo.',
    ...options,
    syncPrompt: () => { rig.syncs += 1; },
    log: (type, payload) => rig.logs.push({ type, payload }),
    note: (text, kind) => rig.notes.push({ text, kind }),
    delayMs: 0,
  });
  return rig;
}

/** @param {string[]} files */
async function readAll(files) {
  return (await Promise.all(files.map((file) => readFile(path.join(ROOT, file), 'utf8')))).join('\n');
}

section('Skill discovery (PART 50)');

await test('all six initial Skills are discovered automatically', () => {
  assert.deepEqual(SKILLS.map((skill) => skill.id).sort(), [
    'hotel_front_desk',
    'numbers_time_money',
    'restaurant',
    'train_station',
    'vocabulary_builder',
    'word_drill',
  ]);
});

await test('the shipped Skills load with no errors and no warnings', () => {
  assert.deepEqual(library.problems, []);
  assert.deepEqual(library.warnings, []);
});

await test('every Skill declares a supported type', () => {
  for (const skill of SKILLS) {
    assert.ok(SKILL_TYPES.includes(skill.type), `${skill.id} has type ${skill.type}`);
  }
});

await test('the initial Skills use the types the spec assigns them', () => {
  const byId = Object.fromEntries(SKILLS.map((skill) => [skill.id, skill.type]));
  assert.equal(byId.restaurant, 'scenario');
  assert.equal(byId.train_station, 'scenario');
  assert.equal(byId.hotel_front_desk, 'scenario');
  assert.equal(byId.vocabulary_builder, 'instructional');
  assert.equal(byId.word_drill, 'drill');
  assert.ok(['instructional', 'drill'].includes(byId.numbers_time_money));
});

await test('no lesson id is hard-coded in the engine or the UI', async () => {
  const engine = await readAll([
    'src/lessons.js',
    'src/routes/lessons.js',
    'public/js/lessons.js',
    'public/js/app.js',
    'public/shared/lesson-runtime.js',
    'public/shared/lesson-prompt.js',
    'public/shared/lesson-schema.js',
    'public/language_tutor.html',
  ]);
  for (const id of SKILLS.map((skill) => skill.id)) {
    // A quoted id, an id used as a property, or a hard-coded lessons path would
    // all be the engine knowing about a specific lesson. Prose that happens to
    // contain a topic word — the "I ate at a restaurant" example the tutor is
    // taught to ignore — is not.
    for (const pattern of [
      new RegExp(`['"\`]${id}['"\`]`),
      new RegExp(`\\b${id}\\s*:`),
      new RegExp(`Lessons/${id}`),
    ]) {
      assert.ok(!pattern.test(engine), `${id} must not be referenced by the engine (${pattern})`);
    }
  }
});

await test('the lesson names are not hard-coded into the selector markup', async () => {
  const html = await readAll(['public/language_tutor.html']);
  for (const skill of SKILLS) {
    assert.ok(!html.includes(skill.name), `${skill.name} must not be written into the HTML`);
  }
});

await test('a lesson dropped into a directory is discovered without code changes', async () => {
  const fixture = await discoverLessons(FIXTURES);
  assert.ok(fixture.skills.some((skill) => skill.id === 'good_lesson'));
});

section('Invalid Skills (PART 49, PART 51)');

const broken = await discoverLessons(FIXTURES);

await test('a directory full of broken Skills does not throw', () => {
  assert.ok(Array.isArray(broken.skills));
  assert.ok(Array.isArray(broken.problems));
});

await test('the one valid Skill survives alongside the broken ones', () => {
  assert.deepEqual(broken.skills.map((skill) => skill.id), ['good_lesson']);
  assert.ok(broken.problems.length >= 6, 'every broken Skill is reported');
});

await test('malformed JSON is reported by name and reason', () => {
  const problem = broken.problems.find((entry) => entry.id === 'broken_json');
  assert.ok(problem);
  assert.match(problem.errors.join(' '), /Malformed JSON/);
});

await test('a missing id is fatal and explained', () => {
  const problem = broken.problems.find((entry) => entry.id === 'missing_id');
  assert.match(problem.errors.join(' '), /Missing "id"/);
});

await test('an invalid type is fatal and lists the valid ones', () => {
  const problem = broken.problems.find((entry) => entry.id === 'bad_type');
  assert.match(problem.errors.join(' '), /Invalid type/);
  assert.match(problem.errors.join(' '), /scenario/);
});

await test('duplicate phase and objective ids are caught', () => {
  const text = broken.problems.find((entry) => entry.id === 'duplicate_phases').errors.join(' ');
  assert.match(text, /Duplicate phase id "warmup"/);
  assert.match(text, /Duplicate objective id "same"/);
});

await test('an invalid runtime input type is caught', () => {
  const problem = broken.problems.find((entry) => entry.id === 'bad_input_type');
  assert.match(problem.errors.join(' '), /invalid type "telepathy"/);
});

await test('a folder with no lesson.json is reported, not crashed on', () => {
  const problem = broken.problems.find((entry) => entry.id === 'no_definition');
  assert.match(problem.errors.join(' '), /No lesson\.json/);
});

await test('a duplicate Skill id is refused and the first one keeps the id', () => {
  const clash = broken.problems.find((entry) => entry.errors.join(' ').includes('Duplicate Skill id'));
  assert.ok(clash, 'the clash is reported');
  assert.equal(broken.skills.find((skill) => skill.id === 'good_lesson').name, 'A Perfectly Fine Lesson');
});

await test('a Skill from a future schema version is refused', () => {
  const result = validateLesson({ schema_version: 99, id: 'x', name: 'X', type: 'review' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /schema_version 99/);
});

await test('a phase referencing an unknown objective is refused', () => {
  const result = validateLesson({
    id: 'x',
    name: 'X',
    type: 'review',
    objectives: [{ id: 'real', description: 'Real.' }],
    phases: [{ id: 'p', name: 'P', objectives: ['imaginary'] }],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /unknown objective "imaginary"/);
});

await test('validation never throws, whatever it is given', () => {
  for (const garbage of [null, undefined, 42, 'text', [], [1, 2], { objectives: 'no' }, { phases: 7 }]) {
    const result = validateLesson(garbage);
    assert.equal(typeof result.ok, 'boolean');
    assert.ok(Array.isArray(result.errors));
  }
});

await test('discovery of a directory that does not exist returns an empty library', async () => {
  const missing = await discoverLessons(path.join(ROOT, 'no', 'such', 'place'));
  assert.deepEqual(missing.skills, []);
  assert.deepEqual(missing.problems, []);
});

section('Voice activation (PART 20, PART 21, PART 56)');

await test('an explicit request starts the Restaurant Roleplay lesson', () => {
  const verdict = classifyActivationIntent("Let's do the Restaurant Roleplay lesson.", SKILLS);
  assert.equal(verdict.intent, 'activate');
  assert.equal(verdict.skillId, 'restaurant');
});

await test('an explicit request starts the Train Station lesson', () => {
  const verdict = classifyActivationIntent("I'd like to practice the train station lesson.", SKILLS);
  assert.equal(verdict.intent, 'activate');
  assert.equal(verdict.skillId, 'train_station');
});

await test('"Let\'s do a vocabulary lesson." starts Vocabulary Builder', () => {
  const verdict = classifyActivationIntent("Let's do a vocabulary lesson.", SKILLS);
  assert.equal(verdict.intent, 'activate');
  assert.equal(verdict.skillId, 'vocabulary_builder');
});

await test('every Skill can be started by at least one spoken phrase', () => {
  for (const skill of SKILLS) {
    const phrase = `Let's do the ${skill.name} lesson.`;
    const verdict = classifyActivationIntent(phrase, SKILLS);
    assert.equal(verdict.intent, 'activate', `"${phrase}" should start ${skill.id}`);
    assert.equal(verdict.skillId, skill.id);
  }
});

await test('ordinary conversation activates NOTHING', () => {
  for (const utterance of [
    'I ate at a restaurant yesterday.',
    'I went to a restaurant.',
    'There is a good restaurant near my house.',
    'The restaurant was closed, so we went home.',
    'My brother works in a hotel.',
    'I took the train to work this morning.',
    'I need to change some money before the trip.',
    'I learned some new vocabulary from a film.',
    'We stayed in a hotel by the train station.',
    'What time does the train leave?',
  ]) {
    const verdict = classifyActivationIntent(utterance, SKILLS);
    assert.equal(verdict.intent, 'none', `"${utterance}" must not activate anything`);
  }
});

await test('an ambiguous request asks for confirmation instead of guessing', () => {
  const verdict = classifyActivationIntent('Can we practice restaurants?', SKILLS);
  assert.equal(verdict.intent, 'confirm');
  assert.equal(verdict.skillId, 'restaurant');
});

await test('a request frame with no lesson reference activates nothing', () => {
  assert.equal(classifyActivationIntent("Let's practice a bit more.", SKILLS).intent, 'none');
});

await test('a topic word inside a longer word does not match', () => {
  assert.equal(classifyActivationIntent("Let's practice my training routine.", SKILLS).intent, 'none');
});

await test('stop requests are recognised, and ordinary speech is not', () => {
  for (const utterance of [
    "Let's stop the lesson.",
    "Let's just chat.",
    "I don't want to do this exercise anymore.",
    'Can we go back to normal conversation?',
  ]) {
    assert.equal(isDeactivationRequest(utterance), true, `"${utterance}" should stop the lesson`);
  }
  for (const utterance of ['The train stopped at the station.', 'We chatted for an hour.']) {
    assert.equal(isDeactivationRequest(utterance), false, `"${utterance}" should not stop anything`);
  }
});

await test('a Skill can be resolved by id, by name or by alias', () => {
  assert.equal(resolveSkillReference('restaurant', SKILLS)?.id, 'restaurant');
  assert.equal(resolveSkillReference('Restaurant Roleplay', SKILLS)?.id, 'restaurant');
  assert.equal(resolveSkillReference('Numbers, Time & Money', SKILLS)?.id, 'numbers_time_money');
  assert.equal(resolveSkillReference('hotel front desk', SKILLS)?.id, 'hotel_front_desk');
  assert.equal(resolveSkillReference('nonsense', SKILLS), null);
  assert.equal(resolveSkillReference('', SKILLS), null);
});

section('One active Skill, one activation path (PART 18, PART 22, PART 51)');

await test('every Skill can be activated', () => {
  for (const skill of SKILLS) {
    const runtime = new LessonRuntime();
    assert.equal(runtime.activate(skill, { reason: 'ui' }).ok, true);
    assert.equal(runtime.skillId, skill.id);
  }
});

await test('activating the running Skill again changes nothing', () => {
  const { runtime, skill } = runtimeOn('restaurant');
  runtime.setPhase('guided_ordering');
  const again = runtime.activate(skill, { reason: 'voice' });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false, 'no restart');
  assert.equal(runtime.phaseId, 'guided_ordering', 'progress is not thrown away');
});

await test('starting a second Skill retires the first', () => {
  const { runtime } = runtimeOn('restaurant');
  runtime.activate(SKILLS.find((skill) => skill.id === 'train_station'));
  assert.equal(runtime.skillId, 'train_station');
  assert.equal(runtime.callSummary().length, 2, 'the retired lesson is still available to memory');
});

await test('a failed activation leaves no half-active lesson', () => {
  const { runtime } = runtimeOn('restaurant');
  const result = runtime.activate(null);
  assert.equal(result.ok, false);
  assert.equal(runtime.skill, null);
  assert.equal(runtime.isActive, false);
});

await test('the Realtime session declares no tools at all', async () => {
  const realtime = await readAll(['src/routes/realtime.js']);
  assert.ok(!/\btools\b\s*:/.test(realtime), 'no tools key in the session config');
  assert.ok(!realtime.includes('tool_choice'), 'and no tool_choice');
  assert.ok(!realtime.includes('lessonToolDefinitions'));

  const client = await readAll(['public/js/realtime.js']);
  assert.ok(!client.includes('function_call'), 'and no tool-call plumbing in the browser');
  assert.ok(!client.includes('dispatchToolCall'));
});

await test('the tool module is gone, not merely unused', async () => {
  const { access } = await import('node:fs/promises');
  let exists = true;
  try {
    await access(path.join(ROOT, 'public/shared/lesson-tools.js'));
  } catch {
    exists = false;
  }
  assert.equal(exists, false, 'lesson-tools.js should have been deleted');

  const shipped = await readAll([
    'public/js/app.js',
    'public/js/lessons.js',
    'public/js/realtime.js',
    'src/routes/realtime.js',
  ]);
  assert.ok(!shipped.includes('lesson-tools'), 'nothing still imports it');
});

await test('a confused Director answer cannot corrupt the lesson', () => {
  const skill = SKILLS.find((entry) => entry.id === 'vocabulary_builder');
  const out = sanitizeDirection(
    {
      completed_objectives: ['choose_topic', 'not_a_real_id', 42],
      partial_objectives: 'nope',
      introduced_vocabulary: ['nabe — pot', '  ', null, 'reizouko — fridge'],
      practiced_vocabulary: Array(30).fill('x — y'),
      runtime_inputs: { topic: 'kitchen vocabulary', bogus: 'ignored' },
      phase_id: 'atlantis',
      should_complete: 'yes',
      note: 'x'.repeat(400),
    },
    skill,
  );
  assert.deepEqual(out.completed_objectives, ['choose_topic'], 'unknown ids dropped');
  assert.deepEqual(out.partial_objectives, [], 'a non-array becomes empty');
  assert.deepEqual(out.introduced_vocabulary, ['nabe — pot', 'reizouko — fridge']);
  assert.equal(out.practiced_vocabulary.length, 12, 'lists are capped');
  assert.deepEqual(out.runtime_inputs, { topic: 'kitchen vocabulary' }, 'unknown inputs dropped');
  assert.equal(out.phase_id, '', 'an unknown phase is refused');
  assert.equal(out.should_complete, false, 'only a real boolean counts');
  assert.equal(out.note.length, 200, 'the note is bounded');
});

await test('an empty direction changes nothing at all', () => {
  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });
  const before = JSON.stringify(library.runtime.snapshot());
  const applied = library.applyDirection(emptyDirection());
  assert.deepEqual(applied.objectives, 0);
  assert.equal(applied.phaseChanged, false);
  assert.equal(applied.completed, false);
  assert.equal(JSON.stringify(library.runtime.snapshot()), before);
});

await test('the Director is shown the full lesson the tutor never sees', () => {
  const skill = SKILLS.find((entry) => entry.id === 'vocabulary_builder');
  const { runtime } = runtimeOn('vocabulary_builder');
  const brief = describeLesson(skill, runtime.snapshot());

  // Everything the tutor's prompt no longer carries lives here instead.
  assert.match(brief, /OBJECTIVES/);
  assert.match(brief, /choose_topic \[pending\]/, 'objective ids with their state');
  assert.match(brief, /met when:/, 'and their success indicators');
  assert.match(brief, /PHASES/);
  assert.match(brief, /<- current/);
  assert.match(brief, /SETTINGS THIS LESSON NEEDS/);
  assert.match(brief, /THE LESSON'S WORK IS DONE WHEN/);

  const tutorPrompt = buildActiveLessonSection(skill, runtime.snapshot());
  assert.ok(!tutorPrompt.includes('choose_topic'), 'the tutor sees no objective ids');
  assert.ok(!tutorPrompt.includes('met when:'));
});

await test('the transcript excerpt is rendered and bounded', () => {
  assert.equal(renderExcerpt([]), '');
  assert.equal(renderExcerpt(null), '');
  const rendered = renderExcerpt([
    { role: 'assistant', text: 'Ohayou.' },
    { role: 'user', text: 'Ohayou gozaimasu.' },
  ]);
  assert.equal(rendered, 'Tutor: Ohayou.\nStudent: Ohayou gozaimasu.');

  const huge = Array(2000).fill({ role: 'user', text: 'a very long turn indeed' });
  assert.ok(renderExcerpt(huge).length <= 6000, 'long lessons are trimmed to the recent part');
});

section('Runtime inputs (PART 8, PART 9, PART 34)');

await test('Vocabulary Builder asks for a topic before it is under way', () => {
  const { runtime } = runtimeOn('vocabulary_builder');
  const pending = runtime.pendingInputs();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, 'topic');
  assert.equal(pending[0].ask_user, true);
});

await test('the topic prompt is a question the tutor can actually say', () => {
  const skill = SKILLS.find((entry) => entry.id === 'vocabulary_builder');
  const topic = skill.runtime_inputs.find((input) => input.id === 'topic');
  assert.match(topic.prompt, /what kind of vocabulary/i);
  assert.equal(topic.allow_tutor_choice, true);
});

await test('a student-chosen topic records source "user"', () => {
  const { runtime } = runtimeOn('vocabulary_builder');
  runtime.setInput('topic', 'sports verbs', 'user');
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.runtime_inputs.topic, 'sports verbs');
  assert.equal(snapshot.runtime_input_sources.topic, 'user');
  assert.deepEqual(runtime.pendingInputs(), []);
});

await test('a tutor-chosen topic records source "tutor"', () => {
  const { runtime } = runtimeOn('vocabulary_builder');
  runtime.setInput('topic', 'kitchen vocabulary', 'tutor');
  assert.equal(runtime.snapshot().runtime_input_sources.topic, 'tutor');
});

await test('the Skill tells the tutor how to choose a topic well', () => {
  const skill = SKILLS.find((entry) => entry.id === 'vocabulary_builder');
  const guidance = skill.teaching_philosophy.join(' ').toLowerCase();
  for (const signal of ['weakness', 'recent vocabulary', 'coherent']) {
    assert.ok(guidance.includes(signal), `topic selection should consider ${signal}`);
  }
});

await test('an unset topic is surfaced to the tutor in the prompt', () => {
  const { runtime, skill } = runtimeOn('vocabulary_builder');
  const before = buildActiveLessonSection(skill, runtime.snapshot());
  assert.match(before, /Not settled yet — Vocabulary topic/);
  assert.match(before, /Ask like this: "What kind of vocabulary/);
  runtime.setInput('topic', 'sports verbs', 'user');
  const after = buildActiveLessonSection(skill, runtime.snapshot());
  assert.match(after, /Subject: sports verbs/);
  assert.ok(!after.includes('Not settled yet'));
});

await test('an unknown input id is refused with a readable message', () => {
  const { runtime } = runtimeOn('vocabulary_builder');
  const result = runtime.setInput('nonsense', 'x');
  assert.equal(result.ok, false);
  assert.match(result.error, /no input called/);
});

await test('runtime inputs never become profile fields', () => {
  const { runtime } = runtimeOn('vocabulary_builder');
  runtime.setInput('topic', 'weather adjectives', 'user');
  const profile = profileFor();
  const before = JSON.stringify(profile);
  buildTutorPrompt(profile, { catalog: SKILLS, skill: runtime.skill, state: runtime.snapshot() });
  assert.equal(JSON.stringify(profile), before, 'building the prompt does not mutate the profile');
  assert.ok(!('topic' in profile));
});

await test('a select input coerces and a number input validates', () => {
  const { runtime } = runtimeOn('numbers_time_money');
  assert.equal(runtime.setInput('focus', 'prices', 'user').ok, true);
  assert.equal(runtime.snapshot().runtime_inputs.focus, 'prices');
});

section('Adaptive phases and progress (PART 13, PART 14, PART 15, PART 27)');

await test('a lesson starts in its first phase', () => {
  const { runtime, skill } = runtimeOn('restaurant');
  assert.equal(runtime.phaseId, skill.phases[0].id);
});

await test('phases can advance, repeat, skip ahead and go back', () => {
  const { runtime } = runtimeOn('restaurant');
  assert.equal(runtime.setPhase('useful_vocabulary').ok, true, 'advance');
  assert.equal(runtime.setPhase('useful_vocabulary').changed, false, 'repeat is a no-op');
  assert.equal(runtime.setPhase('challenge').ok, true, 'skip ahead');
  assert.equal(runtime.setPhase('guided_ordering').ok, true, 'go back');
  assert.equal(runtime.phaseId, 'guided_ordering');
});

await test('an unknown phase is refused without disturbing the lesson', () => {
  const { runtime } = runtimeOn('restaurant');
  runtime.setPhase('guided_ordering');
  assert.equal(runtime.setPhase('nowhere').ok, false);
  assert.equal(runtime.phaseId, 'guided_ordering');
});

await test('progress rises with objectives and phases, and never reaches 100 while running', () => {
  const { runtime, skill } = runtimeOn('restaurant');
  assert.equal(runtime.progress(), 5, 'a lesson that has started is not 0%');
  for (const objective of skill.objectives) runtime.setObjective(objective.id, 'complete');
  runtime.setPhase(skill.phases[skill.phases.length - 1].id);
  const full = runtime.progress();
  assert.ok(full > 0);
  assert.ok(full <= 99, 'completion is a judgement, not arithmetic');
});

await test('a partly met objective counts for less than a completed one', () => {
  const a = runtimeOn('restaurant');
  const b = runtimeOn('restaurant');
  a.runtime.setObjective('order_food', 'partial');
  b.runtime.setObjective('order_food', 'complete');
  assert.ok(a.runtime.progress() < b.runtime.progress());
});

await test('progress is 0 with no lesson and 100 in the record once complete', () => {
  assert.equal(new LessonRuntime().progress(), 0, 'no lesson means no progress at all');
  const { runtime } = runtimeOn('restaurant');
  runtime.setObjective('order_food', 'complete');
  runtime.complete({ summary: 'Good work.' });
  assert.equal(runtime.snapshot().progress, 0, 'no lesson is running afterwards');
  assert.equal(runtime.callSummary()[0].progress, 100);
});

await test('every Skill describes adaptation in both directions', () => {
  for (const skill of SKILLS) {
    assert.ok(skill.adaptation.if_struggling.length >= 3, `${skill.id} says what to do when struggling`);
    assert.ok(skill.adaptation.if_succeeding.length >= 3, `${skill.id} says what to do when succeeding`);
  }
});

await test('no Skill is duplicated per comfort level', () => {
  const names = SKILLS.map((skill) => `${skill.id} ${skill.name}`.toLowerCase());
  for (const level of COMFORT_LEVELS) {
    assert.ok(!names.some((name) => name.includes(level.toLowerCase())), `no Skill is specialised for ${level}`);
  }
});

section('Completion, override and no resume (PART 17, PART 23, PART 24, PART 25, PART 26)');

await test('a completed lesson returns to normal conversation', () => {
  const { runtime } = runtimeOn('restaurant');
  assert.equal(runtime.complete({ summary: 'You ordered a whole meal.' }).ok, true);
  assert.equal(runtime.skill, null, 'the active lesson is cleared');
  assert.equal(runtime.isActive, false);
});

await test('completion is recorded for memory but not persisted anywhere', () => {
  const { runtime } = runtimeOn('restaurant');
  runtime.setObjective('order_food', 'complete');
  runtime.complete({ summary: 'Nice work.' });
  const summary = runtime.callSummary();
  assert.equal(summary.length, 1);
  assert.equal(summary[0].completed, true);
  assert.deepEqual(summary[0].objectives_complete, ['Order a dish appropriately.']);
});

await test('the student can stop a lesson at any point', () => {
  const { runtime } = runtimeOn('hotel_front_desk');
  runtime.setPhase('problem_scenario');
  runtime.deactivate({ reason: 'student request' });
  assert.equal(runtime.isActive, false);
  assert.equal(runtime.callSummary()[0].end_reason, 'student request');
  assert.equal(runtime.callSummary()[0].completed, false);
});

await test('every Skill tells the tutor the student outranks it', () => {
  for (const skill of SKILLS) {
    const text = buildActiveLessonSection(skill, { progress: 0, objectives: {} });
    assert.match(text, /The student outranks this lesson/, skill.id);
    assert.match(text, /want to stop, follow them/, skill.id);
  }
});

await test('completion criteria are pedagogical, never about elapsed time', () => {
  for (const skill of SKILLS) {
    const text = skill.completion.criteria.join(' ').toLowerCase();
    assert.ok(text.length > 0, `${skill.id} defines completion criteria`);
    for (const forbidden of ['minute', 'second', 'elapsed']) {
      assert.ok(!text.includes(forbidden), `${skill.id} does not complete on time`);
    }
  }
});

await test('the completion floor is honoured when the Skill sets one', () => {
  const { runtime, skill } = runtimeOn('restaurant');
  assert.equal(runtime.meetsCompletionFloor(), false);
  const required = skill.objectives.filter((objective) => objective.required);
  for (const objective of required.slice(0, skill.completion.min_required_objectives)) {
    runtime.setObjective(objective.id, 'complete');
  }
  assert.equal(runtime.meetsCompletionFloor(), true);
});

await test('an unfinished lesson starts fresh next time', () => {
  const { runtime, skill } = runtimeOn('train_station');
  runtime.setPhase('station_roleplay');
  runtime.setObjective('buy_ticket', 'complete');
  runtime.noteVocabulary({ introduced: ['der Bahnsteig — platform'] });
  runtime.deactivate({ reason: 'call ended' });

  runtime.activate(skill, { reason: 'ui' });
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.phase, skill.phases[0].id, 'back to the first phase');
  assert.equal(snapshot.objectives.buy_ticket, 'pending', 'objectives are reset');
  assert.deepEqual(snapshot.introduced_vocab, [], 'vocabulary observations are reset');
});

await test('clearing the call history does not disturb a chosen lesson', () => {
  const { runtime } = runtimeOn('restaurant');
  runtime.setPhase('guided_ordering');
  runtime.clearHistory();
  assert.equal(runtime.skillId, 'restaurant', 'a lesson picked before the call survives');
  assert.equal(runtime.phaseId, 'guided_ordering');
  assert.deepEqual(runtime.finishedLessons, []);
});

section('Memory integration (PART 12, PART 45, PART 46)');

await test('lesson observations render into the transcript the extractor reads', () => {
  const { runtime } = runtimeOn('vocabulary_builder');
  runtime.setInput('topic', 'sports verbs', 'user');
  runtime.setObjective('produce_words', 'complete');
  runtime.noteVocabulary({
    introduced: ['werfen — to throw'],
    successful: ['laufen — to run'],
    struggled: ['schwimmen — to swim'],
  });
  runtime.addNote('Hesitated on separable verbs.');

  const notes = renderLessonNotes(runtime.callSummary());
  assert.match(notes, /Vocabulary Builder/);
  assert.match(notes, /sports verbs/);
  assert.match(notes, /werfen/);
  assert.match(notes, /laufen/);
  assert.match(notes, /schwimmen/);
  assert.match(notes, /separable verbs/);
});

await test('no lesson notes at all when no lesson ran', () => {
  assert.equal(renderLessonNotes([]), '');
  assert.equal(renderLessonNotes(null), '');
  assert.equal(renderLessonNotes([null, 'nonsense']), '');
});

await test('lesson vocabulary merges into the ordinary pools, keeping what was there', () => {
  const { profile: saved } = applyExtraction(profileFor(), {
    recent_vocab: ['werfen — to throw', 'laufen — to run'],
    known_weaknesses: ['Separable verbs'],
    proficiency_level: 'Beginner',
  });
  assert.ok(saved.recent_vocab.includes('werfen — to throw'));
  assert.ok(saved.recent_vocab.includes('der Bahnhof (train station)'), 'existing vocabulary is kept');
  assert.ok(saved.known_weaknesses.includes('Separable verbs'));
  assert.ok(saved.known_weaknesses.includes('Article gender'), 'existing weaknesses are kept');
});

await test('there is no parallel lesson memory anywhere in the codebase', async () => {
  const code = await readAll([
    'public/shared/lesson-runtime.js',
    'public/shared/lesson-schema.js',
    'public/js/lessons.js',
    'src/lessons.js',
    'src/routes/lessons.js',
    'src/routes/memory.js',
    'public/js/app.js',
  ]);
  for (const forbidden of ['lesson_vocab', 'restaurant_vocab', 'lesson_weaknesses', 'lesson_history']) {
    assert.ok(!code.includes(forbidden), `${forbidden} must not exist`);
  }
});

await test('the saved profile gains no lesson fields', () => {
  const { profile: saved } = applyExtraction(profileFor(), { proficiency_level: 'Intermediate' });
  assert.deepEqual(Object.keys(saved).sort(), [
    'ai_assessed_level',
    'assessment_history',
    'known_weaknesses',
    'last_lesson_date',
    'proficiency_level',
    'recent_vocab',
    'script_style',
    'target_language',
    'tutor_name',
    'user_name',
  ]);
});

await test('there is exactly one memory endpoint and one assessment', async () => {
  const backend = await readAll(['src/routes/memory.js', 'src/routes/lessons.js']);
  const posts = [...backend.matchAll(/router\.post\(\s*'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(posts.sort(), ['/lessons/direct', '/lessons/judge', '/lessons/plan', '/lessons/refresh', '/memory/extract']);
  assert.ok(!/assessment_history/.test(await readAll(['src/routes/lessons.js'])));
});

section('Comfort level is untouchable (PART 16)');

await test('no Skill even names the comfort-level field', () => {
  for (const skill of SKILLS) {
    assert.ok(!JSON.stringify(skill).toLowerCase().includes('proficiency_level'), `${skill.id}`);
  }
});

await test('the base prompt tells the tutor the level is not its to change', () => {
  const prompt = buildTutorPrompt(profileFor());
  assert.match(prompt, /Only the student changes their level/);
  const { runtime, skill } = runtimeOn('restaurant');
  assert.ok(!/level/i.test(buildActiveLessonSection(skill, runtime.snapshot())),
    'and not restated in the lesson layer');
});

await test('a lesson does not change the comfort level, only the advisory assessment', () => {
  const { runtime } = runtimeOn('restaurant');
  runtime.setObjective('order_food', 'complete');
  runtime.complete({ summary: 'Great.' });

  const { profile: saved, recommendation } = applyExtraction(profileFor(), {
    proficiency_level: 'Advanced',
  });
  assert.equal(saved.proficiency_level, 'Beginner', 'the comfort level is untouched');
  assert.equal(saved.ai_assessed_level, 'Advanced', 'the assessment is advisory only');
  assert.equal(recommendation.status, 'insufficient-data');
});

await test('the runtime has no method that could reach the profile', () => {
  const runtime = new LessonRuntime();
  for (const method of Object.getOwnPropertyNames(Object.getPrototypeOf(runtime))) {
    assert.ok(!/profile|proficien|comfort/i.test(method), `${method} must not exist on the runtime`);
  }
});

section('Prompt composition (PART 3, PART 41, PART 42, PART 43, PART 44)');

await test('no lesson file contains a finished prompt', () => {
  for (const skill of SKILLS) {
    assert.ok(!('prompt' in skill), `${skill.id} has no prompt field`);
    assert.ok(!/You are [A-Z]/.test(JSON.stringify(skill)), `${skill.id} does not impersonate the tutor`);
  }
});

await test('the base prompt carries no lesson layer when none is passed', () => {
  const bare = buildTutorPrompt(profileFor());
  for (const absent of ['# RIGHT NOW', '# LESSONS']) {
    assert.ok(!bare.includes(absent), `${absent} must not appear`);
  }
  assert.match(bare, /# Role and Objective/);
  assert.match(bare, /# Teaching/);
  assert.match(bare, /# START/);
  assert.match(bare, /ask one simple question/);
});

await test('the catalogue appears when Skills exist but none is running', () => {
  const prompt = buildTutorPrompt(profileFor(), { catalog: SKILLS, skill: null, state: {} });
  assert.match(prompt, /# LESSONS/);
  assert.match(prompt, /Restaurant Roleplay/);
  assert.match(prompt, /do not offer a lesson/, 'and is told not to pre-empt one');
  assert.ok(!prompt.includes('# RIGHT NOW'));
});

await test('the catalogue is a few lines, not a manual', () => {
  const section = buildLessonSection({ catalog: SKILLS });
  assert.ok(section.length < 500, `the catalogue is ${section.length} chars, expected under 500`);
});

await test('the active lesson layer replaces the catalogue', () => {
  const { runtime, skill } = runtimeOn('restaurant');
  const prompt = buildTutorPrompt(profileFor(), { catalog: SKILLS, skill, state: runtime.snapshot() });
  assert.match(prompt, /# RIGHT NOW/);
  assert.ok(!prompt.includes('# LESSONS'));
});

await test('the base tutor rules survive underneath an active lesson', () => {
  const { runtime, skill } = runtimeOn('restaurant');
  const prompt = buildTutorPrompt(profileFor(), { catalog: SKILLS, skill, state: runtime.snapshot() });
  for (const heading of ['# Role and Objective', '# Teaching', '# When They Speak English', '# What They Know']) {
    assert.ok(prompt.includes(heading), `${heading} is still present`);
  }
  assert.match(prompt, /Article gender/, 'known weaknesses still reach the tutor');
  assert.match(prompt, /der Bahnhof/, 'recent vocabulary still reaches the tutor');
  assert.match(prompt, /Only the student changes their level/);
});

await test('removing the lesson removes its influence entirely', () => {
  const { runtime, skill } = runtimeOn('restaurant');
  runtime.setPhase('guided_ordering');
  const during = buildTutorPrompt(profileFor(), { catalog: SKILLS, skill, state: runtime.snapshot() });
  runtime.deactivate({ reason: 'stopped' });
  const after = buildTutorPrompt(profileFor(), {
    catalog: SKILLS,
    skill: runtime.skill,
    state: runtime.snapshot(),
  });
  assert.match(during, /Asking and declining/);
  assert.ok(!after.includes('# RIGHT NOW'));
  assert.ok(!after.includes('Asking and declining'));
  assert.match(after, /# LESSONS/, 'back to the catalogue');
});

await test('the student outranks the lesson, said once, in the lesson layer', () => {
  const { runtime, skill } = runtimeOn('restaurant');
  const prompt = buildTutorPrompt(profileFor(), { catalog: SKILLS, skill, state: runtime.snapshot() });
  const mentions = (prompt.match(/outranks this lesson/g) || []).length;
  assert.equal(mentions, 1, 'stated exactly once — a rule repeated is a rule diluted');
});

await test('only the current phase reaches the tutor', () => {
  const { runtime, skill } = runtimeOn('restaurant');
  runtime.setPhase('challenge');
  const text = buildActiveLessonSection(skill, runtime.snapshot());
  assert.match(text, /part 5 of 6: The whole visit/);
  assert.match(text, /Aim: One visit from walking in to paying/);

  // The other five phases are not in there at all.
  for (const phase of skill.phases.filter((entry) => entry.id !== 'challenge')) {
    assert.ok(!text.includes(phase.name), `${phase.name} must not be in the prompt`);
  }
});

await test('objective ids never reach the tutor', () => {
  for (const skill of SKILLS) {
    const { runtime } = runtimeOn(skill.id);
    runtime.setObjective(skill.objectives[0].id, 'complete');
    const text = buildActiveLessonSection(skill, runtime.snapshot());
    for (const objective of skill.objectives) {
      assert.ok(!text.includes(objective.id), `${skill.id}: ${objective.id} leaked into the prompt`);
    }
  }
});

await test('the tutor is told never to speak the internal vocabulary', () => {
  const { runtime, skill } = runtimeOn('restaurant');
  assert.match(
    buildActiveLessonSection(skill, runtime.snapshot()),
    /Do not say the words lesson, phase, objective or progress/,
  );
});

await test('an empty lesson layer produces no section at all', () => {
  assert.equal(buildLessonSection({}), '');
  assert.equal(buildLessonSection({ catalog: [] }), '');
});

await test('a pre-selected lesson changes the greeting line', () => {
  const { runtime, skill } = runtimeOn('restaurant');
  const prompt = buildTutorPrompt(profileFor(), { catalog: SKILLS, skill, state: runtime.snapshot() });
  assert.match(prompt, /say what you will work on, and begin/);
});

section('Language agnosticism and Japanese (PART 40)');

await test('no Skill is specialised to a language', () => {
  for (const skill of SKILLS) {
    for (const language of ['german', 'japanese', 'spanish', 'french', 'italian']) {
      assert.ok(!skill.id.includes(language), `${skill.id} is language-neutral`);
      assert.ok(!skill.name.toLowerCase().includes(language), `${skill.name} is language-neutral`);
    }
  }
});

await test('a Japanese profile keeps the Romaji rules with a lesson running', () => {
  const { runtime, skill } = runtimeOn('restaurant');
  const prompt = buildTutorPrompt(profileFor('Japanese'), {
    catalog: SKILLS,
    skill,
    state: runtime.snapshot(),
  });
  assert.match(prompt, /# Japanese/);
  assert.match(prompt, /Hepburn romaji/);
  assert.match(prompt, /# RIGHT NOW/);
});

await test('the Japanese rules come before the lesson, so the lesson cannot override them', () => {
  const { runtime, skill } = runtimeOn('restaurant');
  const prompt = buildTutorPrompt(profileFor('Japanese'), {
    catalog: SKILLS,
    skill,
    state: runtime.snapshot(),
  });
  assert.ok(prompt.indexOf('# JAPANESE') < prompt.indexOf('# RIGHT NOW'));
});

await test('a German profile still gets no Japanese rules with a lesson running', () => {
  const { runtime, skill } = runtimeOn('restaurant');
  const prompt = buildTutorPrompt(profileFor('German'), {
    catalog: SKILLS,
    skill,
    state: runtime.snapshot(),
  });
  assert.ok(!prompt.includes('# JAPANESE'));
});

section('Future Lesson Editor compatibility (PART 47, PART 48)');

await test('every objective, phase, activity, scenario and input has a stable id', () => {
  for (const skill of SKILLS) {
    for (const objective of skill.objectives) assert.ok(objective.id, `${skill.id} objective id`);
    for (const phase of skill.phases) {
      assert.ok(phase.id, `${skill.id} phase id`);
      for (const activity of phase.activities) assert.ok(activity.id, `${skill.id} activity id`);
    }
    for (const scenario of skill.content.scenarios) assert.ok(scenario.id, `${skill.id} scenario id`);
    for (const input of skill.runtime_inputs) assert.ok(input.id, `${skill.id} input id`);
  }
});

await test('a normalised Skill round-trips through validation unchanged', () => {
  for (const skill of SKILLS) {
    const again = validateLesson(JSON.parse(JSON.stringify(skill)), { expectedId: skill.id });
    assert.equal(again.ok, true, `${skill.id} revalidates`);
    assert.deepEqual({ ...again.lesson, source: '' }, { ...skill, source: '' }, `${skill.id} is stable`);
  }
});

await test('every section an editor would render is present on every Skill', () => {
  for (const skill of SKILLS) {
    for (const key of [
      'id', 'name', 'description', 'version', 'type', 'activation', 'prerequisites',
      'runtime_inputs', 'objectives', 'teaching_philosophy', 'content', 'phases',
      'adaptation', 'progress', 'completion', 'memory',
    ]) {
      assert.ok(key in skill, `${skill.id} has ${key}`);
    }
    for (const key of ['suggested_vocabulary', 'target_vocabulary', 'target_grammar', 'scenarios']) {
      assert.ok(key in skill.content, `${skill.id} content has ${key}`);
    }
  }
});

await test('an editor can write a minimal Skill and have it validate', () => {
  const result = validateLesson({ id: 'new_skill', name: 'New Skill', type: 'drill' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.lesson.objectives, []);
  assert.deepEqual(result.lesson.phases, []);
  assert.ok(result.warnings.length, 'but it is told what is thin');
});

await test('no lesson file contains executable JavaScript', () => {
  for (const skill of SKILLS) {
    const serialised = JSON.stringify(skill);
    for (const forbidden of ['function(', '=>', 'eval(', 'require(']) {
      assert.ok(!serialised.includes(forbidden), `${skill.id} contains no code`);
    }
  }
});

await test('importance is one of the three documented levels', () => {
  for (const skill of SKILLS) {
    const items = [...skill.content.scenarios, ...skill.phases.flatMap((phase) => phase.activities)];
    for (const item of items) {
      assert.ok(
        ['required', 'suggested', 'optional'].includes(item.importance),
        `${skill.id}: ${item.id} has importance ${item.importance}`,
      );
    }
  }
});

section('No regression in existing behaviour (PART 58)');

await test('the browser cannot put anything but instructions into a session', async () => {
  const realtime = await readAll(['src/routes/realtime.js']);
  assert.ok(!/body\.tools/.test(realtime), 'no tools from the request body');
  assert.ok(!/\btools\b\s*:/.test(realtime), 'and none from anywhere else');
});

await test('the lesson API never touches the API key', async () => {
  const routes = await readAll(['src/routes/lessons.js', 'src/lessons.js']);
  for (const forbidden of ['OPENAI_API_KEY', 'apiKey', 'Authorization', 'client_secret']) {
    assert.ok(!routes.includes(forbidden), `${forbidden} must not appear in the lesson code`);
  }
});

await test('lesson modules are dependency-free and run in Node and the browser alike', async () => {
  for (const file of [
    'public/shared/lesson-schema.js',
    'public/shared/lesson-runtime.js',
    'public/shared/lesson-activation.js',
    'public/shared/lesson-prompt.js',
  ]) {
    const code = await readFile(path.join(ROOT, file), 'utf8');
    for (const specifier of [...code.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1])) {
      assert.ok(specifier.startsWith('./'), `${file} imports only siblings, not ${specifier}`);
    }
    assert.ok(!/\bdocument\.|\bwindow\.|localStorage/.test(code), `${file} touches no DOM`);
    assert.ok(!/'node:/.test(code), `${file} uses no node built-ins`);
  }
});

await test('no placeholders anywhere in the lesson framework', async () => {
  const files = [
    'public/shared/lesson-schema.js',
    'public/shared/lesson-runtime.js',
    'public/shared/lesson-activation.js',
    'public/shared/lesson-prompt.js',
    'public/js/lessons.js',
    'src/lessons.js',
    'src/routes/lessons.js',
  ];
  for (const entry of await readdir(path.join(ROOT, 'Lessons'))) {
    files.push(`Lessons/${entry}/lesson.json`);
  }
  for (const file of files) {
    const code = await readFile(path.join(ROOT, file), 'utf8');
    for (const marker of ['TODO', 'FIXME', 'IMPLEMENT THIS', 'placeholder', 'XXX']) {
      assert.ok(!code.includes(marker), `${file} contains "${marker}"`);
    }
  }
});

await test('the lesson strip and selector are wired to real elements', async () => {
  const html = await readAll(['public/language_tutor.html']);
  const app = await readAll(['public/js/app.js']);
  for (const id of [
    'lessonSelect', 'lessonHint', 'lessonProblems', 'refreshLessonsBtn',
    'lessonStrip', 'lessonStripName', 'lessonStripPhase',
    'lessonProgressBar', 'lessonProgressValue', 'endLessonBtn',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `${id} exists in the HTML`);
    assert.ok(app.includes(`'${id}'`), `${id} is looked up by app.js`);
  }
});

section('The Lesson Director, end to end (PART 22, PART 26)');

await test('a whole lesson runs through the Director', () => {
  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });

  const first = library.applyDirection({
    ...emptyDirection(),
    runtime_inputs: { topic: 'sports verbs' },
    completed_objectives: ['choose_topic'],
    phase_id: 'first_pass',
    phase_reason: 'the topic is settled',
  });
  assert.equal(first.inputs, 1);
  assert.equal(first.objectives, 1);
  assert.equal(first.phaseChanged, true);
  assert.equal(first.phaseName, 'First set');

  const second = library.applyDirection({
    ...emptyDirection(),
    introduced_vocabulary: ['werfen — to throw'],
    successful_vocabulary: ['laufen — to run'],
    struggled_vocabulary: ['schwimmen — to swim'],
    note: 'Hesitated on separable verbs.',
  });
  assert.equal(second.vocabulary, 1);

  const snapshot = library.runtime.snapshot();
  assert.equal(snapshot.runtime_inputs.topic, 'sports verbs');
  assert.deepEqual(snapshot.introduced_vocab, ['werfen — to throw']);
  assert.deepEqual(snapshot.struggled_vocab, ['schwimmen — to swim']);
  assert.ok(library.runtime.progress() > 5, 'and progress actually moves');
});

await test('the Director cannot invent objectives, phases or inputs', () => {
  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });
  const applied = library.applyDirection({
    ...emptyDirection(),
    completed_objectives: ['not_an_objective'],
    phase_id: 'atlantis',
    runtime_inputs: { nonsense: 'x' },
  });
  assert.equal(applied.objectives, 0);
  assert.equal(applied.phaseChanged, false);
  assert.equal(applied.inputs, 0);
  assert.equal(library.runtime.phaseId, 'choose_topic', 'nothing moved');
});

await test('a direction that arrives after the lesson ended does nothing', () => {
  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });
  library.deactivate({ reason: 'student request' });
  const applied = library.applyDirection({
    ...emptyDirection(),
    completed_objectives: ['choose_topic'],
    phase_id: 'first_pass',
  });
  assert.equal(applied.objectives, 0);
  assert.equal(applied.phaseChanged, false);
  assert.equal(library.isActive, false);
});

await test('the Director can finish a lesson that has done its work', () => {
  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });
  library.applyDirection({
    ...emptyDirection(),
    phase_id: 'recall',
    completed_objectives: ['choose_topic', 'meet_the_set'],
  });
  const applied = library.applyDirection({ ...emptyDirection(), should_complete: true, note: 'Good work.' });
  assert.equal(applied.completed, true);
  assert.equal(applied.completedName, 'Vocabulary Builder');
  assert.equal(library.isActive, false, 'back to normal conversation');
  assert.equal(library.callSummary()[0].completed, true);
});

await test('but it cannot finish one that has barely started', () => {
  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });
  const applied = library.applyDirection({ ...emptyDirection(), should_complete: true });
  assert.equal(applied.completed, false, 'the premature guard still applies');
  assert.equal(library.isActive, true);
});

await test('a lesson started from the sidebar and one started by voice are the same lesson', () => {
  const viaUi = libraryWithSkills();
  viaUi.activate('restaurant', { reason: 'ui' });

  const viaVoice = libraryWithSkills();
  viaVoice.observeStudentTurn("Let's do the Restaurant Roleplay lesson.");

  assert.equal(viaUi.activeId, viaVoice.activeId);
  assert.equal(viaUi.runtime.phaseId, viaVoice.runtime.phaseId);
});

await test('the Director request carries no secrets and survives a failure', async () => {
  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });

  const originalFetch = globalThis.fetch;
  /** @type {any} */
  let sentBody = null;
  globalThis.fetch = async (_url, options) => {
    sentBody = JSON.parse(options.body);
    throw new Error('offline');
  };
  try {
    const result = await library.runDirector([{ role: 'user', text: 'hello there' }], {
      language: 'Japanese',
      level: 'Beginner',
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /offline/);
    assert.equal(library.isActive, true, 'the lesson carries on unchanged');
    assert.deepEqual(Object.keys(sentBody).sort(), ['language', 'lessonId', 'level', 'state', 'transcript']);
    assert.ok(!JSON.stringify(sentBody).includes('sk-'), 'and nothing key-shaped goes out');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('two Director passes cannot overlap', async () => {
  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Promise((resolve) => {
      setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({ ok: true, direction: emptyDirection() }) }), 60);
    });
  try {
    const first = library.runDirector([{ role: 'user', text: 'hello there' }]);
    const second = await library.runDirector([{ role: 'user', text: 'hello there' }]);
    assert.equal(second.ok, false);
    assert.match(second.error, /Already running/);
    await first;
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('the safety net activates on a clear request and ignores conversation', () => {
  const library = libraryWithSkills();
  assert.equal(library.observeStudentTurn('I ate at a restaurant yesterday.').action, 'none');
  assert.equal(library.isActive, false);

  const started = library.observeStudentTurn("Let's do the Train Station lesson.");
  assert.equal(started.action, 'activated');
  assert.equal(library.activeId, 'train_station');

  const stopped = library.observeStudentTurn("Let's just chat.");
  assert.equal(stopped.action, 'ended');
  assert.equal(library.isActive, false);
});

await test('an ambiguous request is confirmed, and a yes then starts it', () => {
  const library = libraryWithSkills();
  const asked = library.observeStudentTurn('Can we practice restaurants?');
  assert.equal(asked.action, 'none', 'nothing is activated on a guess');
  assert.equal(asked.suggestion.intent, 'confirm');
  assert.equal(library.pendingSuggestion.skillId, 'restaurant');

  const confirmed = library.observeStudentTurn('Yes please.');
  assert.equal(confirmed.action, 'activated', 'the answer to the question is honoured');
  assert.equal(library.activeId, 'restaurant');
});

await test('a no clears the suggestion, and a bare yes on its own does nothing', () => {
  const declined = libraryWithSkills();
  declined.observeStudentTurn('Can we practice restaurants?');
  assert.equal(declined.observeStudentTurn('No, not now.').action, 'none');
  assert.equal(declined.isActive, false);
  assert.equal(declined.pendingSuggestion, null);

  const unprompted = libraryWithSkills();
  assert.equal(unprompted.observeStudentTurn('Yes.').action, 'none', 'a yes to nothing starts nothing');
  assert.equal(unprompted.isActive, false);
});

await test('an unrelated answer lets the suggestion lapse', () => {
  const library = libraryWithSkills();
  library.observeStudentTurn('Can we practice restaurants?');
  assert.equal(library.observeStudentTurn('My brother is visiting tomorrow.').action, 'none');
  assert.equal(library.pendingSuggestion, null, 'the moment has passed');
  assert.equal(library.observeStudentTurn('Yes.').action, 'none', 'and a later yes means nothing');
});

await test('affirmations and refusals are short answers, not sentences', () => {
  for (const yes of ['yes', 'Yes please.', 'sure', 'okay', "let's do it", 'sounds good']) {
    assert.equal(isAffirmation(yes), true, `"${yes}"`);
  }
  for (const no of ['no', 'Nope.', 'not now', "I'd rather not"]) {
    assert.equal(isRefusal(no), true, `"${no}"`);
  }
  for (const neither of [
    'Yes, I went to the station yesterday and bought a ticket for the morning train',
    'I said no to my brother about the hotel',
  ]) {
    assert.equal(isAffirmation(neither), false, `"${neither}"`);
    assert.equal(isRefusal(neither), false, `"${neither}"`);
  }
});

section('Regressions found in review');

await test('a bad lesson reference mid-lesson does not destroy the running lesson', () => {
  const library = libraryWithSkills();
  library.activate('restaurant', { reason: 'ui' });
  library.runtime.setPhase('guided_ordering');

  const result = library.activate('cafe', { reason: 'voice' });
  assert.equal(result.ok, false);
  assert.equal(library.activeId, 'restaurant', 'the running lesson survives');
  assert.equal(library.runtime.phaseId, 'guided_ordering', 'and keeps its place');
});

await test('an empty lesson reference stops the lesson, deliberately', () => {
  const library = libraryWithSkills();
  library.activate('restaurant', { reason: 'ui' });

  // '' is how the sidebar says "Normal Conversation", so it must end the
  // lesson rather than error.
  const result = library.activate('', { reason: 'ui' });
  assert.equal(result.ok, true);
  assert.equal(library.isActive, false);
});

await test('nothing sends the lesson definition back through the conversation', async () => {
  // There is no tool channel at all now, so the only route into the session is
  // instructions and short nudges.
  const client = await readAll(['public/js/realtime.js']);
  assert.ok(!client.includes('function_call_output'));

  const app = await readAll(['public/js/app.js']);
  for (const nudge of app.match(/nudge\(\s*`[^`]*`/g) || []) {
    assert.ok(nudge.length < 500, `a nudge of ${nudge.length} chars is too long to be a nudge`);
  }
});

await test('a phase change is announced to the student and noted to the tutor', async () => {
  const rig = conductorRig({ phase_id: 'first_pass' });
  await rig.conductor.runDirector();
  assert.deepEqual(rig.notes.map((entry) => entry.text), ['Moving on to: First set.']);
  assert.equal(rig.nudges.length, 1);
  assert.match(rig.nudges[0].text, /The lesson has moved on to First set/);
  assert.equal(rig.syncs, 1, 'and the prompt is rebuilt for the new part');
});

await test('reloading the library stops a lesson it no longer contains', () => {
  const library = libraryWithSkills();
  library.activate('restaurant', { reason: 'ui' });
  library.skills = SKILLS.filter((skill) => skill.id !== 'restaurant');
  const outcome = library.reconcileActiveLesson();
  assert.equal(outcome.dropped, true);
  assert.equal(outcome.name, 'Restaurant Roleplay');
  assert.equal(library.isActive, false, 'no orphaned lesson still shaping the prompt');
});

await test('a lesson still in the catalogue survives a reload', () => {
  const library = libraryWithSkills();
  library.activate('restaurant', { reason: 'ui' });
  library.runtime.setPhase('challenge');
  assert.deepEqual(library.reconcileActiveLesson(), { dropped: false, name: '' });
  assert.equal(library.runtime.phaseId, 'challenge');
});

await test('the student can stop a lesson even when the catalogue is empty', () => {
  const library = libraryWithSkills();
  library.activate('restaurant', { reason: 'ui' });
  library.skills = [];
  const outcome = library.observeStudentTurn("Let's just chat.");
  assert.equal(outcome.action, 'ended', 'the verbal escape hatch still works');
  assert.equal(library.isActive, false);
});

await test('talking about a lesson never starts one', () => {
  for (const utterance of [
    'My friend works at the hotel front desk.',
    'That restaurant lesson we did last week was really fun.',
    'I do not want to do the restaurant roleplay today.',
    "I don't want to do the restaurant roleplay today.",
    'Please never give me a vocabulary drill again.',
    'Is the numbers lesson hard?',
    'Maybe tomorrow we could do the vocabulary builder, but not now.',
    'We already did the train station lesson.',
    'The hotel roleplay was harder than I expected.',
  ]) {
    const verdict = classifyActivationIntent(utterance, SKILLS);
    assert.equal(verdict.intent, 'none', `"${utterance}" must not activate anything`);
  }
});

await test('a bare answer naming a lesson does start it', () => {
  for (const [utterance, id] of [
    ['the restaurant lesson', 'restaurant'],
    ['restaurant roleplay', 'restaurant'],
    ['vocabulary lesson, please', 'vocabulary_builder'],
    ['okay, the train station lesson', 'train_station'],
  ]) {
    const verdict = classifyActivationIntent(utterance, SKILLS);
    assert.equal(verdict.intent, 'activate', `"${utterance}" should start a lesson`);
    assert.equal(verdict.skillId, id);
  }
});

await test('stopping is not confused with talking about stopping', () => {
  for (const utterance of [
    'I want to finish this lesson properly',
    'I had to cancel the lesson at school',
    'we should stop the lesson plan discussion',
    'The train stopped at the station.',
    'We chatted for an hour.',
    'My last lesson ended early.',
  ]) {
    assert.equal(isDeactivationRequest(utterance), false, `"${utterance}" must not stop the lesson`);
  }
  for (const utterance of [
    "Let's stop the lesson.",
    'Can we stop this exercise?',
    "Let's just chat.",
    "I don't want to do this exercise anymore.",
    'Can we go back to normal conversation?',
    'No more drills for today.',
  ]) {
    assert.equal(isDeactivationRequest(utterance), true, `"${utterance}" should stop the lesson`);
  }
});

await test('a single-phase lesson can still reach full progress', () => {
  const lesson = validateLesson({
    id: 'one_phase',
    name: 'One Phase',
    type: 'drill',
    objectives: [{ id: 'a', description: 'A.', required: true }],
    phases: [{ id: 'only', name: 'Only' }],
  }).lesson;
  const runtime = new LessonRuntime();
  runtime.activate(lesson);
  runtime.setObjective('a', 'complete');
  assert.equal(runtime.progress(), 99, 'objectives carry the whole estimate when there is one phase');
});

await test('a select input refuses a value outside its options', () => {
  const { runtime } = runtimeOn('numbers_time_money');
  const bad = runtime.setInput('focus', 'interpretive dance');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Choose from: numbers, prices/);
  assert.equal(runtime.setInput('focus', 'prices').ok, true);
});

await test('the completion floor is the app\u2019s business, not the tutor\u2019s', () => {
  const { runtime, skill } = runtimeOn('restaurant');
  const text = buildActiveLessonSection(skill, runtime.snapshot());
  assert.ok(!/\d+ .*objectives?\b/.test(text), 'the tutor is not asked to count anything');
  assert.ok(!text.includes('minimum'), 'and is given no floor to reason about');
  assert.equal(runtime.meetsCompletionFloor(), false);
  for (const objective of skill.objectives.filter((entry) => entry.required).slice(0, 4)) {
    runtime.setObjective(objective.id, 'complete');
  }
  assert.equal(runtime.meetsCompletionFloor(), true, 'but it still governs completion');
});

await test('a lesson that forbids early completion says so', () => {
  const lesson = validateLesson({
    id: 'thorough',
    name: 'Thorough',
    type: 'drill',
    completion: { allow_early_completion: false },
    phases: [{ id: 'p', name: 'P' }],
  }).lesson;
  assert.equal(lesson.completion.allow_early_completion, false, 'kept for the Director to honour');
});

await test('a turn is never requested while one is already running', async () => {
  const code = await readAll(['public/js/realtime.js']);
  assert.match(code, /case 'response\.created':/, 'the session tracks when a turn is active');
  assert.match(code, /case 'response\.done':/, 'and when it ends');

  // The student stopping speaking means a response is coming, whether or not
  // response.created has reached us yet. Without this, a turn requested from
  // the transcription callback fires straight into a live response.
  assert.match(code, /case 'input_audio_buffer\.speech_stopped':/);
  assert.match(code, /flushPendingTurn\(\) \{[\s\S]*?if \(this\.responseActive \|\| inFlight \|\| this\.earBusy \|\| held\) \{/);

  // Every route to a spoken reply goes through the queue. (The third is a
  // question put to the model outside the conversation, answered in text: it
  // is never sent while a reply is running or waiting, and a reply waits
  // behind it.)
  const creates = [...code.matchAll(/type: 'response\.create'/g)].length;
  assert.equal(creates, 3, 'once to open the call, once from flushPendingTurn, once to ask its ear');
  assert.match(code, /if \(this\.earBusy \|\| this\.responseActive \|\| this\.turnInFlight \|\| this\.turnPending\) return none;/);
});

await test('losing the turn race is recovered from, not shown to the student', async () => {
  const code = await readAll(['public/js/realtime.js']);
  assert.match(code, /function isActiveResponseCollision\(code, message\)/);
  assert.match(code, /conversation_already_has_active_response/);

  const errorCase = code.slice(code.indexOf("case 'error': {"), code.indexOf('default:'));
  assert.match(errorCase, /if \(isActiveResponseCollision\(code, message\)\) \{/);
  assert.ok(
    errorCase.indexOf('isActiveResponseCollision') < errorCase.indexOf('this.emitError(message'),
    'the collision is handled before anything reaches the transcript',
  );
  assert.match(errorCase, /this\.responseActive = true;/, 'and the queued turn waits properly');
});

await test('a Director pass that finds nothing tells the tutor nothing', async () => {
  const rig = conductorRig({});
  await rig.conductor.runDirector();
  assert.equal(rig.nudges.length, 0);
  assert.equal(rig.syncs, 0, 'and the prompt is left alone');
});

await test('a failed offer releases the microphone', async () => {
  const code = await readAll(['public/js/realtime.js']);
  const offerBlock = code.slice(code.indexOf('let offer;'), code.indexOf('let answerSdp;'));
  assert.match(offerBlock, /try \{/);
  assert.match(offerBlock, /await this\.stop\(\);/, 'teardown runs before the error propagates');
});

section('Pacing and UI, from live-session feedback');

await test('the hidden attribute actually hides things', async () => {
  const css = await readAll(['public/styles.css']);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);

  // Anything the app toggles with .hidden that also sets its own display would
  // otherwise be permanently visible — which is how an empty red banner ended
  // up pinned across the top of the page.
  const app = await readAll(['public/js/app.js']);
  const toggled = [...app.matchAll(/el\.([A-Za-z]+)\.hidden\s*=/g)].map((match) => match[1]);
  assert.ok(toggled.includes('banner'), 'the banner is toggled this way');
  assert.ok(toggled.includes('lessonStrip'), 'so is the lesson strip');
});

await test('a single user is properly selected, not just displayed', async () => {
  const app = await readAll(['public/js/app.js']);
  const refresh = app.slice(
    app.indexOf('async function refreshProfiles'),
    app.indexOf('function renderUserSelect'),
  );
  assert.match(refresh, /await selectUser\(autoPicked\);/, 'the selection path actually runs');
  assert.ok(
    refresh.indexOf('await selectUser(autoPicked)') < refresh.indexOf('if (state.currentUser && state.currentLanguage)'),
    'and runs before the fallback branch',
  );
});

await test('the call timer exists, starts with the call and stops with it', async () => {
  const html = await readAll(['public/language_tutor.html']);
  assert.match(html, /id="callTimer"/);
  const app = await readAll(['public/js/app.js']);
  assert.match(app, /startCallTimer\(\);/);
  assert.match(app, /stopCallTimer\(\);/);
  const startCall = app.slice(app.indexOf('async function startCall'), app.indexOf('async function endCall'));
  assert.match(startCall, /startCallTimer\(\)/, 'started when the call starts');
  const endCall = app.slice(app.indexOf('async function endCall'), app.indexOf('async function runMemoryExtraction'));
  assert.match(endCall, /stopCallTimer\(\)/, 'stopped when the call ends');
});

await test('student turns are counted, and reset when the phase changes', () => {
  const { runtime } = runtimeOn('vocabulary_builder');
  for (let i = 0; i < 5; i += 1) runtime.noteStudentTurn();
  assert.equal(runtime.snapshot().turns_in_phase, 5);
  assert.equal(runtime.snapshot().turns_in_lesson, 5);

  runtime.setPhase('first_pass');
  assert.equal(runtime.snapshot().turns_in_phase, 0, 'a new phase is a fresh start');
  assert.equal(runtime.snapshot().turns_in_lesson, 5, 'but the lesson total keeps running');
});

await test('a dragging phase is tracked, but never nagged at the tutor', () => {
  const { runtime, skill } = runtimeOn('vocabulary_builder');
  for (let i = 0; i < 5; i += 1) runtime.noteStudentTurn();
  assert.equal(runtime.snapshot().phase_is_dragging, false, 'five turns is not yet a problem');

  runtime.noteStudentTurn();
  assert.equal(runtime.snapshot().phase_is_dragging, true, 'the app knows');

  // The app acts on this by advancing the phase itself. The tutor is never
  // handed a paragraph about pacing to hold onto.
  const section = buildActiveLessonSection(skill, runtime.snapshot());
  assert.ok(!section.includes('long time'), 'no nag in the prompt');
  assert.ok(!section.includes('turns'), 'and no turn counters either');
});

await test('a word said correctly twice is turned round and asked from the English', () => {
  const { runtime, skill } = runtimeOn('vocabulary_builder');
  runtime.noteVocabulary({ practiced: ['ohayou gozaimasu — good morning'] });
  assert.deepEqual(runtime.snapshot().settled_vocab, [], 'once is not enough');

  runtime.noteVocabulary({ successful: ['ohayou gozaimasu — good morning'] });
  assert.deepEqual(runtime.snapshot().settled_vocab, ['ohayou gozaimasu — good morning']);
  assert.match(
    buildActiveLessonSection(skill, runtime.snapshot(), { language: 'Japanese' }),
    /Ready for Recall — give only the English: ohayou gozaimasu/,
  );
});

await test('struggling with a word does not mark it finished', () => {
  const { runtime } = runtimeOn('vocabulary_builder');
  runtime.noteVocabulary({ struggled: ['osusume'] });
  runtime.noteVocabulary({ struggled: ['osusume'] });
  runtime.noteVocabulary({ introduced: ['osusume'] });
  assert.deepEqual(runtime.snapshot().settled_vocab, [], 'a word that keeps failing needs more, not less');
});

await test('the pacing prompt only changes when the advice changes', () => {
  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });

  let refreshes = 0;
  for (let i = 0; i < 9; i += 1) {
    if (library.noteStudentTurn().needsPromptRefresh) refreshes += 1;
  }
  assert.ok(refreshes >= 1, 'the tutor is told when things go stale');
  assert.ok(refreshes <= 4, `expected a handful of refreshes over nine turns, got ${refreshes}`);
});

await test('Vocabulary Builder is a topic, three scripted sets and a review', () => {
  const skill = SKILLS.find((entry) => entry.id === 'vocabulary_builder');
  assert.deepEqual(skill.phases.map((phase) => `${phase.id}:${phase.mode}`), [
    'choose_topic:talk',
    'first_pass:teach',
    'recall:teach',
    'in_context:teach',
    'wrap_up:review',
  ]);
  const topic = skill.phases.find((phase) => phase.id === 'choose_topic');
  assert.match(topic.instructions.join(' '), /teach nothing in that turn/i, 'the topic is settled before anything is taught');
});

await test('Vocabulary Builder no longer instructs the tutor to keep coming back', () => {
  const skill = SKILLS.find((entry) => entry.id === 'vocabulary_builder');
  const everything = JSON.stringify(skill);
  assert.ok(!everything.includes('Return here repeatedly'), 'the loop instruction is gone');
  assert.match(skill.teaching_philosophy.join(' '), /spread out, never three in a row/i);
  assert.match(skill.teaching_philosophy.join(' '), /Five words, at most six/);
});

await test('the student can move the lesson on without asking the tutor', () => {
  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });
  assert.equal(library.runtime.phaseId, 'choose_topic');

  const first = library.advancePhase();
  assert.equal(first.ok, true);
  assert.equal(first.phaseName, 'First set');
  assert.equal(library.runtime.phaseId, 'first_pass');

  // ...all the way to the end, where it stops rather than wrapping around.
  while (library.advancePhase().ok) { /* walk to the last phase */ }
  assert.equal(library.runtime.phaseId, 'wrap_up');
  assert.equal(library.advancePhase().last, true);
});

await test('Move on is wired to a real button and tells the tutor', async () => {
  const html = await readAll(['public/language_tutor.html']);
  assert.match(html, /id="nextPhaseBtn"/);
  const app = await readAll(['public/js/app.js']);
  assert.match(app, /el\.nextPhaseBtn\.addEventListener/);
  const handler = app.slice(app.indexOf('el.nextPhaseBtn.addEventListener'));
  assert.match(handler, /conductor\.beginPart\(/, 'the tutor is given a turn, once the part has its material');
  const conductor = await readAll(['public/shared/conductor.js']);
  const begin = conductor.slice(conductor.indexOf('async beginPart('), conductor.indexOf('handleTutorTurn(text) {'));
  assert.match(begin, /this\.nudge\(announcement, \{ speak: true \}\)/, 'and speaks: nobody else is talking');
});

section('The lesson must not stall, and must not end early');

await test('the Director cannot finish a lesson that has barely started', () => {
  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });

  const applied = library.applyDirection({ ...emptyDirection(), should_complete: true, note: 'Nice sentence.' });
  assert.equal(applied.completed, false);
  assert.equal(library.isActive, true, 'the lesson is still running');
  assert.equal(library.runtime.isCompletionPremature(), true);
});

await test('the guard lifts as soon as the lesson has done something', () => {
  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });
  assert.equal(library.runtime.isCompletionPremature(), true);

  library.applyDirection({ ...emptyDirection(), completed_objectives: ['choose_topic'] });
  assert.equal(library.runtime.isCompletionPremature(), false, 'a real objective is enough');
});

await test('reaching the last phase also lifts the guard', () => {
  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });
  while (library.advancePhase().ok) { /* walk to the end */ }
  assert.equal(library.runtime.isCompletionPremature(), false, 'the lesson ran its course');

  const applied = library.applyDirection({ ...emptyDirection(), should_complete: true });
  assert.equal(applied.completed, true);
});

await test('a lesson that has done real work can finish immediately', () => {
  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });
  library.applyDirection({
    ...emptyDirection(),
    phase_id: 'recall',
    completed_objectives: ['choose_topic', 'meet_the_set'],
  });
  const applied = library.applyDirection({ ...emptyDirection(), should_complete: true, note: 'Good work.' });
  assert.equal(applied.completed, true, 'no guard once the lesson has actually moved');
});

await test('the guard applies afresh to each new lesson', () => {
  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });
  library.applyDirection({ ...emptyDirection(), completed_objectives: ['choose_topic'] });
  assert.equal(library.runtime.isCompletionPremature(), false);

  library.activate('restaurant', { reason: 'ui' });
  assert.equal(library.runtime.isCompletionPremature(), true, 'the next lesson gets the same protection');
});

await test('the app advances the phase itself when the tutor never does', () => {
  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });
  assert.equal(library.runtime.phaseId, 'choose_topic');

  let advanced = null;
  for (let i = 0; i < 10; i += 1) {
    const outcome = library.noteStudentTurn();
    if (outcome.autoAdvanced) advanced = outcome.autoAdvanced;
  }

  assert.ok(advanced, 'ten silent turns is enough');
  assert.equal(advanced.from, 'Choosing a topic');
  assert.equal(advanced.to, 'First set');
  assert.equal(library.runtime.phaseId, 'first_pass');
  assert.ok(library.runtime.progress() > 5, 'and the progress bar finally moves');
});

await test('a lesson the Director IS driving is left alone by auto-advance', () => {
  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });

  for (let i = 0; i < 20; i += 1) {
    // A Director genuinely running the lesson: objectives land, the phase
    // moves. Nothing here needs taking over.
    if (i === 4) {
      library.applyDirection({ ...emptyDirection(), completed_objectives: ['choose_topic'] });
    }
    if (i === 9) library.applyDirection({ ...emptyDirection(), phase_id: 'first_pass' });
    if (i === 14) {
      library.applyDirection({ ...emptyDirection(), completed_objectives: ['meet_the_set'] });
    }
    const outcome = library.noteStudentTurn();
    assert.equal(outcome.autoAdvanced, null, `turn ${i} must not be hijacked`);
  }
  assert.equal(library.runtime.phaseId, 'first_pass', 'the Director keeps control');
});

await test('noting vocabulary is not progress and does not hold off auto-advance', () => {
  // Regression, from a real 23-minute session. The Director ran 27 times and
  // noted vocabulary on 24 of them — which is exactly its job — but changed the
  // phase twice and completed two objectives in the whole call. Because any
  // vocabulary report reset the progress clock, the clock never reached the
  // threshold, so neither the staleness nudge nor the automatic advance could
  // ever fire. The lesson sat in one phase for 54 turns asking for the same
  // four words, and the progress bar froze at 39%.
  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });

  let advanced = null;
  for (let i = 0; i < 20 && !advanced; i += 1) {
    library.applyDirection({
      ...emptyDirection(),
      practiced_vocabulary: [`word_${i} — meaning`],
    });
    advanced = library.noteStudentTurn().autoAdvanced;
  }

  assert.ok(advanced, 'a lesson going nowhere is moved on regardless of vocabulary');
  assert.equal(library.runtime.phaseId, 'first_pass');
});

await test('a phase that moves resets the clock that would move it again', () => {
  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });
  for (let i = 0; i < 9; i += 1) library.noteStudentTurn();

  library.applyDirection({ ...emptyDirection(), phase_id: 'first_pass' });
  const outcome = library.noteStudentTurn();
  assert.equal(outcome.autoAdvanced, null, 'the app does not advance twice in two turns');
});

await test('auto-advance stops at the last phase rather than ending the lesson', () => {
  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });
  while (library.advancePhase().ok) { /* walk to the end */ }
  assert.equal(library.runtime.phaseId, 'wrap_up');

  for (let i = 0; i < 30; i += 1) {
    assert.equal(library.noteStudentTurn().autoAdvanced, null);
  }
  assert.equal(library.isActive, true, 'the app never finishes a lesson on its own');
});

await test('a started lesson never reports 0%', () => {
  for (const skill of SKILLS) {
    const { runtime } = runtimeOn(skill.id);
    assert.ok(runtime.progress() >= 5, `${skill.id} shows it has begun`);
    assert.ok(runtime.snapshot().progress >= 5, `${skill.id} snapshot agrees`);
  }
  assert.equal(new LessonRuntime().progress(), 0, 'and no lesson still means 0');
});

await test('starting a lesson is announced once, with its real name', async () => {
  const app = await readAll(['public/js/app.js']);
  const handler = app.slice(app.indexOf('function setActiveLesson'), app.indexOf("el.lessonSelect.addEventListener"));
  assert.match(handler, /if \(announce && result\.changed\)/, 'a no-op start is not announced');
  assert.match(handler, /Lesson started: \$\{result\.skill\.name\}/);
});

await test('activation reports whether it actually changed anything', () => {
  const library = libraryWithSkills();
  const first = library.activate('restaurant', { reason: 'ui' });
  assert.equal(first.changed, true);
  assert.equal(first.skill.name, 'Restaurant Roleplay');

  const again = library.activate('restaurant', { reason: 'voice' });
  assert.equal(again.changed, false, 'the second call started nothing');
  assert.equal(again.ok, true);
});

await test('the voice net and the sidebar cannot double-start a lesson', () => {
  const library = libraryWithSkills();
  const viaVoice = library.observeStudentTurn("Let's do a vocab lesson.");
  assert.equal(viaVoice.action, 'activated');

  const viaUi = library.activate('vocabulary_builder', { reason: 'ui' });
  assert.equal(viaUi.changed, false, 'the sidebar selection is then a no-op');
});

section('The tutor must never go silent after starting a lesson');

await test('starting a lesson from the sidebar mid-call prompts the tutor to begin', async () => {
  const app = await readAll(['public/js/app.js']);
  const setActive = app.slice(app.indexOf('function setActiveLesson'), app.indexOf("el.lessonSelect.addEventListener"));
  assert.match(setActive, /if \(result\.changed && state\.callActive\)/);
  assert.match(setActive, /Begin it now/);
  assert.match(setActive, /ended the lesson from the app/);
});

await test('a lesson started by the student’s own words is noted, and planned, without a second turn', async () => {
  // The tutor is already answering the request. Forcing another turn stacked
  // two openings on top of each other: "Today we will learn…" then, at once,
  // "Sanji han desu ka? It means…".
  const rig = conductorRig({});
  rig.library.deactivate({ reason: 'test' });
  rig.nudges.length = 0;
  rig.planned.length = 0;
  rig.conductor.handleStudentTurn('Can we do the restaurant lesson please?');
  assert.equal(rig.library.activeId, 'restaurant');
  assert.equal(rig.nudges.length, 1);
  assert.match(rig.nudges[0].text, /From your next turn, follow the lesson instructions/);
  assert.equal(rig.nudges[0].speak, false);
  await rig.conductor.idle();
  assert.deepEqual(rig.planned, ['introduction'], 'and its first part is written while the tutor replies');
  assert.ok(rig.library.runtime.snapshot().script.length > 0);
});

await test('a nudge queues a turn rather than firing one blindly', async () => {
  const code = await readAll(['public/js/realtime.js']);
  const nudge = code.slice(code.indexOf('nudge(instruction, {'), code.indexOf('armSilenceWatchdog() {'));
  assert.match(nudge, /if \(sent && speak\) this\.requestTurn\(\);/);
  assert.ok(!nudge.includes("type: 'response.create'"), 'never sent directly from nudge');
});

await test('every route that changes the lesson also tells the tutor', async () => {
  const app = await readAll(['public/js/app.js']);
  const conductor = await readAll(['public/shared/conductor.js']);
  // The sidebar and the Move on button, from the page...
  assert.ok((app.match(/session\?\.nudge\(/g) || []).length >= 2);
  // ...and the student's own words, auto-advance and the Director, from the conductor.
  assert.ok((conductor.match(/this\.nudge\(/g) || []).length >= 3);
});

section('A part of a lesson is a script, not an improvisation');

/** What the tutor says when it walks SAMPLE_PLAN's script, line by line. */
const SAMPLE_WALK = [
  '"sumimasen" means excuse me. Say it.',
  '"futari desu" means two people. Say it.',
  'How do you say "excuse me"?',
  '"menyuu o onegaishimasu" means the menu, please. Say it.',
  'What does "futari desu" mean?',
  'How do you say "the menu, please"?',
  "Let's try it for real. I'm the waiter and you have just walked in. \"Irasshaimase. Nanmei-sama desu ka?\" — that means \"Welcome. How many people?\" What do you say?",
  'In Japanese you can now say: "excuse me", "two people" and "the menu, please". Ready for the next part?',
];


await test('a plan becomes teach, recall, recognise, role-play, finish — interleaved', () => {
  const steps = buildScript(sanitizePlan(SAMPLE_PLAN));
  assert.deepEqual(steps.map((step) => step.kind), [
    'teach', 'teach', 'recall', 'teach', 'recognise', 'recall', 'scene', 'wrap',
  ]);
  // Each item comes back one or two steps after it is taught, and in both
  // directions: from the English, and from the Japanese.
  assert.equal(steps[2].say, 'sumimasen');
  assert.equal(steps[4].say, 'futari desu');
  assert.equal(steps[5].say, 'menyuu o onegaishimasu');
  assert.deepEqual(steps.map((step) => lineFor(step, 'Japanese')), SAMPLE_WALK);
});

await test('the line that asks for something never contains the answer', () => {
  // The first version listed "Ready for Recall: gyuuniku — beef", and the
  // tutor read it out: "Beef. Say it in Japanese: gyuuniku."
  const steps = buildScript(sanitizePlan(SAMPLE_PLAN));
  for (const step of steps.filter((entry) => entry.kind === 'recall')) {
    assert.ok(!lineFor(step, 'Japanese').includes(step.say), `the answer is not in: ${lineFor(step, 'Japanese')}`);
  }
  const scene = steps.find((entry) => entry.kind === 'scene');
  assert.ok(!lineFor(scene, 'Japanese').includes(scene.expect), 'nor in the role-play line');
  const shown = renderScript(steps, { language: 'Japanese', current: 1 });
  assert.match(shown, /Your next turn, word for word:\nHow do you say "excuse me"\?/);
  assert.match(shown, /The answer will be "sumimasen"\. It is not part of your turn: do not say it/);
});

await test('the tutor is shown one line, not the script', () => {
  // Shown all twelve steps and told "you have just asked step 6", the small
  // model skipped five of eight recall steps and improvised between the rest.
  const steps = buildScript(sanitizePlan(SAMPLE_PLAN));
  const shown = renderScript(steps, { language: 'Japanese', current: 0 });
  assert.match(shown, /You last asked them to say "sumimasen" \(excuse me\)\./);
  assert.match(shown, /"futari desu" means two people\. Say it\./, 'the next line');
  assert.ok(!shown.includes('menyuu'), 'and nothing from further on');
  assert.ok(!/^\d+\./m.test(shown), 'no numbered list to work through');
});

await test('a right answer is defined generously, before the tutor has to judge it', () => {
  // "biiru o kudasai" was marked wrong; so was "rokujuu yon desu", for the desu.
  const shown = renderScript(buildScript(sanitizePlan(SAMPLE_PLAN)), { language: 'Japanese', current: 1 });
  assert.match(shown, /still right with a pause or a filler, with a polite word added, with o, wa or ga left out, or with a little extra/);
  assert.match(shown, /If it is right: say "Hai\." and then the line below\. Nothing else\./);
  assert.match(shown, /If it is wrong: say in a few words which word or sound was different, but only if you are sure which\. Then say "futari desu" and ask for it once more/);
});

await test('a role-play line tells the student what to say, and only takes answers they were taught', () => {
  // "That is not the answer I'm looking for" — said to a student about their
  // own age, because the script expected 79 and never told them.
  const plan = sanitizePlan({
    items: [{ say: 'futari desu', meaning: 'two people' }, { say: 'sumimasen', meaning: 'excuse me' }],
    scene: {
      setup: "I'm the waiter.",
      lines: [
        { tutor: 'Nanmei-sama desu ka?', meaning: 'How many people?', expect: 'futari desu' },
        { tutor: 'Otoshi wa?', meaning: 'How old are you?', expect: 'nanajuu kyuu' },
      ],
    },
  });
  const scenes = buildScript(plan).filter((step) => step.kind === 'scene');
  assert.equal(scenes.length, 1, 'a line whose answer was never taught is not asked');
  // Asked the first time, what to answer is theirs to work out; the English of
  // it is the help they get if they need it.
  assert.match(lineFor(scenes[0], 'Japanese'), /— that means "How many people\?" What do you say\?$/);
  assert.equal(lineFor(scenes[0], 'Japanese', { hint: true }), 'That meant "How many people?" In Japanese, say: two people.');
  assert.equal(lineFor(scenes[0], 'Japanese', { again: true }), '"Nanmei-sama desu ka?" — that means "How many people?" What do you say?', 'after a question the line is said again, not answered for them');
});

await test('the closing line is built from what was taught, not improvised', () => {
  // The tutor's own summary claimed things the student never said.
  const steps = buildScript(sanitizePlan(SAMPLE_PLAN));
  assert.equal(
    lineFor(steps[steps.length - 1], 'Japanese'),
    'In Japanese you can now say: "excuse me", "two people" and "the menu, please". Ready for the next part?',
  );
});

await test('every taught item carries its meaning, or it is not taught', () => {
  const plan = sanitizePlan({
    items: [
      { say: 'sumimasen', meaning: 'excuse me' },
      { say: 'oki', meaning: '' },
      { say: '', meaning: 'two people' },
      { say: 'sumimasen', meaning: 'sorry' },
    ],
  });
  assert.deepEqual(plan.items.map((item) => item.say), ['sumimasen'], 'no meaning, no item; and no duplicates');
});

await test('something the student already knows is asked for, not taught again', () => {
  // A returning student was started on "ichi", then "ni".
  const steps = buildScript(sanitizePlan({
    items: [
      { say: 'yonjuu nana', meaning: '47', known: true },
      { say: 'sanbyaku', meaning: '300', known: false },
    ],
  }));
  assert.ok(!steps.some((step) => step.kind === 'teach' && step.say === 'yonjuu nana'));
  assert.ok(steps.some((step) => step.kind === 'recall' && step.say === 'yonjuu nana'));
  assert.ok(steps.some((step) => step.kind === 'teach' && step.say === 'sanbyaku'));
});

await test('where the tutor has got to is read off what it said', () => {
  const steps = buildScript(sanitizePlan(SAMPLE_PLAN));
  SAMPLE_WALK.forEach((line, index) => {
    assert.equal(locateStep(steps, line, index - 1), index, line);
  });
  assert.equal(locateStep(steps, 'It is "sumimasen". Try once more.', 2), -1, 'a correction is not a new step');
  assert.equal(locateStep(steps, 'Welcome. How many people? Answer in Japanese.', 5), 6, 'the role-play line given only in English still counts');
  assert.equal(locateStep(steps, 'Not quite: futari desu. Try again.', 6), -1, 'a retry of the last step is not the finish');
  assert.equal(locateStep(steps, 'You can now say excuse me and two people. Ready to go on?', 6), 7);
});

await test('the script moves one line at a time, or not at all', () => {
  const steps = buildScript(sanitizePlan(SAMPLE_PLAN));
  assert.equal(locateStep(steps, SAMPLE_WALK[3], 0), -1, 'a line two ahead is not accepted from here');
  assert.equal(locateStep(steps, SAMPLE_WALK[0], 2), -1, 'nor one already behind');
});

await test('an answer is only ever judged certainly right, never wrong, from a transcript', () => {
  const steps = buildScript(sanitizePlan(SAMPLE_PLAN));
  assert.equal(answersStep(steps[1], 'um, futari desu'), true);
  assert.equal(answersStep(steps[1], 'Futari desu.'), true);
  assert.equal(answersStep(steps[1], 'futa desu'), false, 'not certain, so not claimed');
  assert.equal(answersStep(steps[4], 'it means two people'), true, 'a recognise step is answered in English');
  assert.equal(answersStep(undefined, 'anything'), false);
});

await test('the runtime follows the tutor through a script and knows when it ends', () => {
  const { runtime } = runtimeOn('restaurant');
  assert.equal(runtime.needsPlan(), true);
  runtime.setPlan('introduction', sanitizePlan(SAMPLE_PLAN));
  assert.equal(runtime.needsPlan(), false);
  assert.equal(runtime.snapshot().script.length, 8);

  for (const line of SAMPLE_WALK.slice(0, 7)) {
    const result = runtime.noteTutorTurn(line);
    assert.equal(result.moved, true, line);
    assert.equal(result.complete, false);
  }
  assert.equal(runtime.snapshot().script_current, 6);
  assert.deepEqual(runtime.taught.map((item) => item.say), ['sumimasen', 'futari desu', 'menyuu o onegaishimasu']);

  const end = runtime.noteTutorTurn(SAMPLE_WALK[7]);
  assert.equal(end.complete, true);
  assert.equal(runtime.snapshot().script_finished, true);
});

await test('a part with a script is never ended by a turn count', () => {
  // The automatic advance swapped the script out from under an open question:
  // asked for "900 yen", a student answered correctly and was told the answer
  // was "300 yen" — the first line of the next part.
  const library = libraryWithSkills();
  library.activate('restaurant', { reason: 'ui' });
  library.runtime.setPlan('introduction', sanitizePlan(SAMPLE_PLAN));
  library.runtime.noteTutorTurn(SAMPLE_WALK[0]);
  for (let i = 0; i < 25; i += 1) {
    assert.equal(library.noteStudentTurn().autoAdvanced, null, `turn ${i}`);
  }
  assert.equal(library.runtime.phaseId, 'introduction');
});

await test('the place moves on the tutor\'s own words and on nothing else', () => {
  // The app used to "unstick" a script by assuming the next line had been
  // said. It fired five or six times a session, and each time the tutor was
  // then told it had asked something nobody had spoken: "you last asked them
  // to say hassen en".
  const { runtime } = runtimeOn('restaurant');
  runtime.setPlan('introduction', sanitizePlan(SAMPLE_PLAN));
  runtime.noteTutorTurn(SAMPLE_WALK[0]);
  for (const said of ['sumimasen', 'what?', 'hello?', 'are you there?', 'sumimasen', 'well?']) {
    runtime.noteStudentAnswer(said);
  }
  assert.equal(runtime.snapshot().script_current, 0, 'six student turns move nothing');
  assert.equal(typeof runtime.unstick, 'undefined', 'and the thing that did is gone');
});

await test('a tutor that does not say its line is told more firmly each time', () => {
  const { runtime, skill } = runtimeOn('restaurant');
  runtime.setPlan('introduction', sanitizePlan(SAMPLE_PLAN));
  runtime.noteTutorTurn(SAMPLE_WALK[0]);
  const shown = () => buildActiveLessonSection(skill, runtime.snapshot(), { language: 'Japanese' });
  assert.match(shown(), /You last asked them to say "sumimasen"/);

  // One turn that is not the line: a correction, or an answered question.
  const first = runtime.noteTutorTurn('It\'s "sumimasen". Say it once more.');
  assert.equal(first.moved, false);
  assert.equal(first.offScript, false, 'a correction is about what was asked');
  assert.match(shown(), /you have since corrected it or asked again/);
  assert.match(shown(), /Do not ask for it again\. If it is still wrong, start your turn with — It's "sumimasen"\. — and go straight on to the line below/);

  // Two: it is simply told to say the line.
  runtime.noteTutorTurn('Once more: "sumimasen".');
  assert.match(shown(), /Whatever they have just said, your whole next turn is the line below\. Do not ask for anything else first\./);
  assert.match(shown(), /"futari desu" means two people\. Say it\./);
  assert.equal(runtime.snapshot().script_current, 0, 'and the place has still not been moved for it');
});

await test('asking for something that is not in the script is caught at once', () => {
  // "Let's keep it up. Say: osusume wa nan desu ka?" — no meaning, not in the
  // plan, lifted from the reference list.
  const rig = conductorRig({});
  rig.library.activate('restaurant', { reason: 'ui' });
  rig.library.runtime.setPlan('introduction', sanitizePlan(SAMPLE_PLAN));
  rig.conductor.handleTutorTurn(SAMPLE_WALK[0]);
  rig.conductor.handleStudentTurn('sumimasen');
  const before = rig.syncs;
  rig.conductor.handleTutorTurn('Let\'s keep it up. Say: "osusume wa nan desu ka?"');
  rig.conductor.stop();
  assert.ok(rig.logs.some((entry) => entry.type === 'script.offScript'));
  assert.ok(rig.syncs > before, 'the tutor\'s instructions are rebuilt');
  assert.equal(rig.library.runtime.snapshot().script_misses, 2, 'straight to "say the line"');
  assert.equal(rig.library.runtime.snapshot().script_current, 0);
});

await test('a line the tutor will not say is taken out, with everything that depended on it', () => {
  // The alternative — assume it was said — quizzed a student on "cabbage" and
  // then told them they could now say it.
  const { runtime } = runtimeOn('restaurant');
  runtime.setPlan('introduction', sanitizePlan(SAMPLE_PLAN));
  runtime.noteTutorTurn(SAMPLE_WALK[0]);
  const dropped = [];
  for (let i = 0; i < 3; i += 1) dropped.push(...(runtime.noteTutorTurn('Say: "kore o kudasai".').dropped || []));
  assert.deepEqual(dropped.map((step) => step.kind).sort(), ['recognise', 'scene', 'teach']);
  const script = runtime.snapshot().script;
  assert.ok(!script.some((step) => step.say === 'futari desu' || step.expect === 'futari desu'));
  assert.equal(runtime.snapshot().script_current, 0, 'what was last asked is still what was last asked');
  assert.deepEqual(script[script.length - 1].items, ['excuse me', 'the menu, please'], 'and the closing line does not claim it');
  assert.ok(!runtime.taught.some((item) => item.say === 'futari desu'), 'nor is it credited as taught');
});

await test('dropStep leaves a script that still reads true', () => {
  const steps = buildScript(sanitizePlan(SAMPLE_PLAN));
  assert.deepEqual(dropStep(steps, steps.length - 1), [], 'the closing line is never dropped');
  const removed = dropStep(steps, 2);
  assert.deepEqual(removed.map((step) => step.kind), ['recall'], 'a question goes alone');
  assert.equal(steps.length, 7);
});

await test('a tutor that corrects a right answer is caught, and told to go on', () => {
  const rig = conductorRig({});
  rig.library.activate('restaurant', { reason: 'ui' });
  rig.library.runtime.setPlan('introduction', sanitizePlan(SAMPLE_PLAN));
  rig.conductor.handleTutorTurn(SAMPLE_WALK[0]);
  rig.conductor.handleTutorTurn(SAMPLE_WALK[1]);
  rig.nudges.length = 0;

  rig.conductor.handleStudentTurn('um, futari desu');
  rig.conductor.handleTutorTurn('Close. Drop the "um". Say: futari desu.');
  rig.conductor.stop();
  assert.ok(rig.logs.some((entry) => entry.type === 'script.falseCorrection'));
  assert.equal(rig.library.runtime.snapshot().script_misses, 2, 'its next turn is the line, whatever they say');
  assert.equal(rig.nudges.length, 0, 'through its instructions, not a note left in the conversation');

  rig.logs.length = 0;
  rig.conductor.handleStudentTurn('futari desu');
  rig.conductor.handleTutorTurn(`Hai. ${SAMPLE_WALK[2]}`);
  rig.conductor.stop();
  assert.equal(rig.library.runtime.snapshot().script_current, 2);
  assert.equal(rig.library.runtime.snapshot().script_misses, 0);
  assert.ok(!rig.logs.some((entry) => entry.type === 'script.falseCorrection'), 'and one that goes on is left alone');
});

await test('an answer in other words that are just as right is right', () => {
  // "menyuu o kudasai" was rejected, then "menyuu onegaishimasu", because the
  // plan said "menyuu o onegaishimasu". "shichi juu hachi" likewise.
  const menu = { kind: 'recall', say: 'menyuu o onegaishimasu', meaning: 'the menu, please' };
  assert.equal(answersStep(menu, 'menyuu o kudasai'), true);
  assert.equal(answersStep(menu, 'menyuu onegaishimasu'), true);
  assert.equal(answersStep(menu, 'menyu o onegaishimasu'), true, 'a long vowel the transcript shortened');
  assert.equal(answersStep({ kind: 'recall', say: 'nanajuu hachi', meaning: '78' }, 'shichi juu hachi'), true);
  assert.equal(answersStep({ kind: 'teach', say: 'omizu o kudasai', meaning: 'water, please' }, 'mizu o onegaishimasu'), true);
  assert.equal(answersStep({ kind: 'teach', say: 'ebi', meaning: 'prawn' }, 'ebu'), false, 'a different word is still not claimed');
  assert.equal(answersStep({ kind: 'teach', say: 'kore o kudasai', meaning: 'this one, please' }, 'kore wa kudasai'), false);
  assert.ok(variantKeys('menyuu o onegaishimasu').includes('menyuu kudasai'));
  assert.deepEqual(alsoRight('menyuu o onegaishimasu'), ['menyuu o kudasai']);
  assert.deepEqual(alsoRight('nanajuu hachi'), ['shichijuu hachi']);
  assert.deepEqual(alsoRight('sumimasen'), []);
});

await test('the tutor is told which other answers are right before it has to judge', () => {
  const steps = buildScript(sanitizePlan(SAMPLE_PLAN));
  const shown = renderScript(steps, { language: 'Japanese', current: 5 });
  assert.match(shown, /The answer is "menyuu o onegaishimasu"\. Also right: "menyuu o kudasai"\./);
});

await test('the tutor teaching the other wording has still taught the item', () => {
  // Planned "omizu o kudasai", said "omizu o onegaishimasu": the step was not
  // counted, and the app's place fell behind the conversation.
  const steps = buildScript(sanitizePlan({
    items: [{ say: 'omizu o kudasai', meaning: 'water, please' }, { say: 'kore o kudasai', meaning: 'this one, please' }],
  }));
  assert.equal(locateStep(steps, '"omizu o onegaishimasu" means water, please. Say it.', -1), 0);
});

await test('a question is not an answer, even with the word in it', () => {
  // "Did I say ebi right just now?" was taken as a right answer, and the
  // tutor was told so.
  const { runtime } = runtimeOn('restaurant');
  runtime.setPlan('introduction', sanitizePlan(SAMPLE_PLAN));
  runtime.noteTutorTurn(SAMPLE_WALK[0]);
  assert.equal(runtime.noteStudentAnswer('did I say sumimasen right just now?'), false);
  assert.equal(runtime.noteStudentAnswer('um, sumimasen?'), true, 'a rising tone is not a question');
  assert.equal(looksLikeQuestion('Sorry, what does that mean?'), true);
  assert.equal(looksLikeQuestion('kore wa nan desu ka'), false);
});

await test('every branch is written as words to say, not left to the tutor to phrase', () => {
  // Left to phrase a correction itself it said "kyuu gives the hundreds",
  // "toriniku means beef" and "the timing is wrong".
  const steps = buildScript(sanitizePlan(SAMPLE_PLAN));
  const recognise = renderScript(steps, { language: 'Japanese', current: 4 });
  assert.match(recognise, /If it is wrong, or they do not know: start your turn with — "futari desu" means two people\. — and go straight on to the line below/);
  const recall = renderScript(steps, { language: 'Japanese', current: 2 });
  assert.match(recall, /If they ask a question instead: answer it in a sentence or two, then say again — How do you say "excuse me"\?/);
  assert.match(recall, /If they say they already know this, or ask to skip it or move on: your whole turn is — OK\./);
  assert.ok(!/NEXT LINE/.test(recall), 'and there is no capitalised label for it to read out');
});

await test('a note is a sentence the tutor says, not a bracket it reads out', () => {
  // "kyabetsu means cabbage (loanword; normal word). Say it."
  // And it is said once they have repeated the phrase, not before: with the
  // note in between, "Say it" followed a sentence about something else.
  const steps = buildScript(sanitizePlan({
    items: [{ say: 'sanbyaku en', meaning: '300 yen', note: 'the h becomes b' }, { say: 'sen en', meaning: '1000 yen' }],
  }));
  assert.equal(lineFor(steps[0], 'Japanese'), '"sanbyaku en" means 300 yen. Say it.');
  assert.equal(
    turnFor(steps, { language: 'Japanese', current: 0, heard: 'sanbyaku en' }).line,
    'The h becomes b. Next: "sen en" means 1000 yen. Say it.',
  );
});

await test('a phrase is asked for as the moment it is needed in, when the plan gives one', () => {
  const steps = buildScript(sanitizePlan({
    items: [
      { say: 'sumimasen', meaning: 'excuse me', use: 'You want the waiter to come over.' },
      { say: 'futari desu', meaning: 'two people' },
    ],
  }));
  const recall = steps.find((step) => step.kind === 'recall');
  assert.equal(lineFor(recall, 'Japanese'), 'You want the waiter to come over. What do you say?');
  assert.equal(locateStep(steps, 'Hai. You want the waiter to come over. What do you say?', 1), 2);
  assert.equal(locateStep(steps, 'How do you say "excuse me"?', 1), 2, 'and the plain form still counts');
});

await test('a role-play line that contains its own answer is not asked', () => {
  // "Kore wa anata no bangou desu: nanajuu hachi — Answer in Japanese: 78."
  const steps = buildScript(sanitizePlan({
    items: [{ say: 'nanajuu hachi', meaning: '78' }, { say: 'yonjuu nana', meaning: '47' }],
    scene: {
      setup: "I'm at the counter.",
      lines: [
        { tutor: 'Kore wa anata no bangou desu: nanajuu hachi', meaning: 'This is your number: 78', expect: 'nanajuu hachi' },
        { tutor: 'Oheya wa nan-ban desu ka?', meaning: 'What is your room number?', expect: 'yonjuu nana' },
      ],
    },
  }));
  const scenes = steps.filter((step) => step.kind === 'scene');
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].expect, 'yonjuu nana');
  assert.match(lineFor(scenes[0], 'Japanese'), /— that means "What is your room number\?" What do you say\?/);
});

await test('nothing new is not announced as an achievement', () => {
  // "In Japanese you can now say: 47, 93, 64 and 78" — to someone who could.
  const steps = buildScript(sanitizePlan({
    items: [{ say: 'yonjuu nana', meaning: '47', known: true }, { say: 'kyuujuu san', meaning: '93', known: true }],
  }));
  assert.deepEqual(steps.map((step) => step.kind), ['recall', 'recall', 'wrap']);
  assert.equal(lineFor(steps[2], 'Japanese'), 'You already have these. Ready for the next part?');
  assert.equal(locateStep(steps, 'You already have these. Ready for the next part?', 1), 2);
});

await test('a student who asks to move on is moved on', async () => {
  // "I already know the numbers up to a hundred. Can we move on to something
  // I will actually use, like paying for things?" — "I'm going to continue
  // with the lesson."
  const rig = conductorRig({});
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan();
  rig.conductor.handleTutorTurn(SAMPLE_WALK[0]);
  rig.nudges.length = 0;
  rig.planned.length = 0;

  const said = 'I already know these. Can we move on to something I will actually use, like paying?';
  assert.equal(wantsToMoveOn(said), true);
  rig.conductor.handleStudentTurn(said);
  rig.conductor.handleTutorTurn('OK.');
  await rig.conductor.idle();
  rig.conductor.stop();

  assert.equal(rig.library.runtime.phaseId, 'useful_vocabulary', 'one part on, not two');
  assert.ok(rig.logs.some((entry) => entry.type === 'script.skip'));
  assert.deepEqual(rig.library.runtime.requests, [said], 'and what they asked for is kept, in their words');
  assert.ok(rig.planned.includes('useful_vocabulary'), 'the next part is written after the request, not before');
  const spoken = rig.nudges.filter((nudge) => nudge.speak);
  assert.equal(spoken.length, 1, 'and the tutor starts it: nobody else is about to speak');
  assert.match(spoken[0].text, /They asked to move on/);
});

await test('the tutor judging that they asked to move on counts too, once', async () => {
  const rig = conductorRig({});
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan();
  rig.conductor.handleTutorTurn(SAMPLE_WALK[0]);
  rig.conductor.handleStudentTurn('honestly this is baby stuff for me');
  assert.equal(wantsToMoveOn('honestly this is baby stuff for me'), false, 'the app\'s own check misses it');
  rig.conductor.handleTutorTurn('OK.');
  await rig.conductor.idle();
  rig.conductor.handleTutorTurn('OK.');
  await rig.conductor.idle();
  rig.conductor.stop();
  assert.equal(rig.library.runtime.phaseId, 'useful_vocabulary');
});

await test('what the student asks for is written into the parts still to come', async () => {
  // Onion and potato were asked for by name, answered, and never taught.
  const rig = conductorRig({});
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan();
  await rig.conductor.ensurePlan('useful_vocabulary');
  assert.ok(rig.library.runtime.scripts.useful_vocabulary, 'the next part was already written');
  rig.planned.length = 0;

  assert.equal(asksHowToSay('How do I ask how much something costs?'), true);
  rig.conductor.handleStudentTurn('sumimasen. Quick question, how do I ask how much something costs?');
  await rig.conductor.idle();
  rig.conductor.stop();
  assert.deepEqual(rig.planned, ['useful_vocabulary'], 'so it is written again, with the request in view');
  assert.ok(rig.library.runtime.scripts.introduction, 'and the part in progress is left alone');

  const prompt = buildPlanPrompt({
    language: 'Japanese', level: 'Beginner', skill: SKILLS.find((skill) => skill.id === 'restaurant'),
    phase: SKILLS.find((skill) => skill.id === 'restaurant').phases[1], mode: 'teach', subject: '',
    facts: [], taught: [], known: [], requests: ['how do I ask how much something costs?'],
  });
  assert.match(prompt, /DURING THE CALL THE STUDENT SAID/);
  assert.match(prompt, /- "how do I ask how much something costs\?"/);
});

await test('a part whose material is not written yet makes the tutor wait, not improvise', async () => {
  const rig = conductorRig({});
  rig.library.activate('restaurant', { reason: 'ui' });
  let release;
  rig.library.fetchPlan = () => new Promise((resolve) => {
    release = () => resolve({ ok: true, plan: JSON.parse(JSON.stringify(SAMPLE_PLAN)), error: null });
  });
  const pending = rig.conductor.ensurePlan();
  const skill = rig.library.runtime.skill;
  const waiting = buildActiveLessonSection(skill, rig.library.runtime.snapshot(), { language: 'Japanese' });
  assert.match(waiting, /If they speak before it arrives, your whole turn is — One moment\./);

  rig.conductor.handleTutorTurn('One moment.');
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  release();
  await pending;
  rig.conductor.stop();
  const ready = rig.nudges.find((nudge) => /material for this part is ready/.test(nudge.text));
  assert.ok(ready && ready.speak, 'the student was told to wait, so the tutor is the one to start');
  assert.ok(!/One moment/.test(buildActiveLessonSection(skill, rig.library.runtime.snapshot(), { language: 'Japanese' })));
});

await test('progress is how much of the scripts has been said', () => {
  // It read 5%, then 7% after a whole part of six, then went backwards.
  const { runtime } = runtimeOn('restaurant');
  runtime.setPlan('introduction', sanitizePlan(SAMPLE_PLAN));
  const parts = runtime.skill.phases.length;
  let last = runtime.progress();
  for (const line of SAMPLE_WALK) {
    runtime.noteTutorTurn(line);
    assert.ok(runtime.progress() >= last, 'it never goes backwards');
    last = runtime.progress();
  }
  assert.equal(last, Math.round(100 / parts), 'one part of them done');
});

await test('the next line is what the tutor is shown, and the old prose is not', () => {
  const { runtime, skill } = runtimeOn('restaurant');
  runtime.setPlan('introduction', sanitizePlan(SAMPLE_PLAN));
  runtime.noteVocabulary({ practiced: ['sumimasen — excuse me'], successful: ['sumimasen — excuse me'] });
  const text = buildActiveLessonSection(skill, runtime.snapshot(), { language: 'Japanese' });
  assert.match(text, /Your next turn, word for word:\n"sumimasen" means excuse me\. Say it\./);
  assert.ok(!/Ready for Recall/.test(text), 'no list of answers to read out');
  assert.ok(!/Useful here/.test(text), 'no English material list to translate from memory');
  assert.ok(!/role-play is walking in/.test(text), 'and none of the notes written for the planner');
  assert.match(text, /do not read out any heading or label from these instructions/);

  runtime.noteTutorTurn(SAMPLE_WALK[0]);
  runtime.noteTutorTurn(SAMPLE_WALK[1]);
  assert.match(
    buildActiveLessonSection(skill, runtime.snapshot(), { language: 'Japanese' }),
    /You last asked them to say "futari desu" \(two people\)\./,
    'and it is told what it last asked, because its view of the call is trimmed',
  );
});

await test('finishing a script moves the lesson on, with no second model involved', async () => {
  const rig = conductorRig({});
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan();
  rig.nudges.length = 0;
  rig.notes.length = 0;
  const syncsBefore = rig.syncs;

  for (const line of SAMPLE_WALK) rig.conductor.handleTutorTurn(line);
  await rig.conductor.idle();

  assert.equal(rig.library.runtime.phaseId, 'useful_vocabulary', 'the next part');
  assert.deepEqual(rig.notes.map((entry) => entry.text), ['Moving on to: Ordering.']);
  assert.ok(rig.planned.includes('useful_vocabulary'), 'whose material was written ahead of time');
  assert.ok(rig.nudges.every((entry) => entry.speak === false), 'and the tutor is told without being made to speak');
  assert.ok(rig.syncs - syncsBefore >= SAMPLE_WALK.length, 'its instructions are rebuilt at every line, since they hold only one');
  assert.ok(rig.library.runtime.progress() > 5);
});

await test('finishing the last part finishes the lesson', async () => {
  const rig = conductorRig({});
  rig.library.activate('restaurant', { reason: 'ui' });
  rig.library.runtime.taught.push({ say: 'sumimasen', meaning: 'excuse me' }, { say: 'futari desu', meaning: 'two people' });
  rig.library.runtime.setPhase('review');
  assert.equal(rig.library.runtime.snapshot().script.length, 3, 'a review needs no planner: it is what was taught');
  rig.conductor.handleTutorTurn('How do you say "excuse me"?');
  rig.conductor.handleTutorTurn('How do you say "two people"?');
  rig.conductor.handleTutorTurn('In Japanese you can now say: "excuse me" and "two people". Ready for the next part?');
  assert.equal(rig.library.isActive, false);
  assert.ok(rig.notes.some((entry) => /Lesson complete/.test(entry.text)));
});

await test('a part that only settles the subject ends when the subject is settled', async () => {
  const rig = conductorRig({ runtime_inputs: { topic: 'ingredients' } });
  assert.equal(rig.library.runtime.phaseId, 'choose_topic');
  assert.equal(rig.library.runtime.needsPlan(), false, 'nothing is planned before the subject is known');
  await rig.conductor.runDirector();
  await rig.conductor.idle();
  assert.equal(rig.library.runtime.phaseId, 'first_pass');
  assert.deepEqual(rig.planned, ['first_pass'], 'and the first set is planned for that subject');
});

await test('the Director cannot yank a running script somewhere else', () => {
  // One real session went dates, money, prices, dates.
  const library = libraryWithSkills();
  library.activate('restaurant', { reason: 'ui' });
  library.runtime.setPlan('introduction', sanitizePlan(SAMPLE_PLAN));
  const moved = library.applyDirection({ ...emptyDirection(), phase_id: 'challenge', phase_reason: 'the part seems done' });
  assert.equal(moved.phaseChanged, false);
  assert.equal(library.runtime.phaseId, 'introduction');
  const asked = library.applyDirection({ ...emptyDirection(), phase_id: 'useful_vocabulary', phase_reason: 'the student asked to skip ahead' });
  assert.equal(asked.phaseChanged, true, 'unless the student asked');
});

await test('the planner is told who says what, and to take its words from the reference', () => {
  const skill = SKILLS.find((entry) => entry.id === 'restaurant');
  const prompt = buildPlanPrompt({
    language: 'Japanese',
    level: 'Beginner',
    skill,
    phase: skill.phases[0],
    mode: 'teach',
    subject: '',
    facts: relevantReference(skill, { phase: 'introduction' }, JAPANESE_REFERENCE, JAPANESE_TOPICS),
    taught: [{ say: 'sumimasen', meaning: 'excuse me' }],
    known: ['numbers up to 100'],
  });
  assert.match(prompt, /"items" are the STUDENT's lines/);
  assert.match(prompt, /Staff do not ask for the menu, the bill or a ticket/);
  assert.match(prompt, /Exactly 4 items/);
  assert.match(prompt, /nanmei-sama desu ka/, 'the verified phrasebook is in front of it');
  assert.match(prompt, /- sumimasen = excuse me/, 'with what the lesson has already taught');
  assert.match(prompt, /No placeholders such as X/);
});

await test('the planner reads every reference the lesson draws on, not just two', () => {
  const skill = SKILLS.find((entry) => entry.id === 'restaurant');
  const facts = relevantReference(skill, { phase: 'guided_ordering' }, JAPANESE_REFERENCE, JAPANESE_TOPICS);
  assert.equal(facts.length, 3, 'restaurant, food and money');
  const vocab = SKILLS.find((entry) => entry.id === 'vocabulary_builder');
  assert.equal(relevantReference(vocab, { phase: 'first_pass', runtime_inputs: { topic: 'train travel' } }, JAPANESE_REFERENCE, JAPANESE_TOPICS).length, 1);
});

await test('the phrasebook does not contain the words the tutor once invented', () => {
  assert.match(JAPANESE_REFERENCE.station, /Platform hoomu \(never "platformu"\)/);
  assert.match(JAPANESE_REFERENCE.station, /Tickets are counted with -mai/);
  assert.match(JAPANESE_REFERENCE.restaurant, /"kono wa" is not Japanese/);
  assert.match(JAPANESE_REFERENCE.restaurant, /There is no o before nuki/);
  assert.match(JAPANESE_REFERENCE.time, /-pun after 1, 3, 4, 6, 8, 10/);
  assert.match(JAPANESE_REFERENCE.numbers, /200 nihyaku/);
});

section('When the API refuses to reply');

const { retryDelayMs, contextLimitEvent } = await import('../public/js/realtime.js');

await test('a refused reply is asked for again, after the wait the API names', async () => {
  // "Rate limit reached … TPM: Limit 40000, Used 38400 … Please try again in
  // 1.855s." The reply never came, and the tutor simply said nothing.
  assert.equal(retryDelayMs('Rate limit reached. Please try again in 1.855s. Visit …'), 2155);
  assert.equal(retryDelayMs('Please try again in 949ms.'), 1249);
  assert.equal(retryDelayMs('something else entirely'), 1800);
  assert.ok(retryDelayMs('Please try again in 90s.') <= 8000, 'never an absurd wait');
});

await test('the tutor does not go silent on a rate limit', async () => {
  const { RealtimeSession: Session } = await import('../public/js/realtime.js');
  const sent = [];
  const events = [];
  const session = new Session({ onTurnEvent: (detail) => events.push(detail) });
  session.active = true;
  session.dc = { readyState: 'open', send: (json) => sent.push(JSON.parse(json).type) };
  const feedTo = (type, extra = {}) => session.handleServerEvent({ data: JSON.stringify({ type, ...extra }) });

  feedTo('response.created', { response: { id: 'r1' } });
  feedTo('response.done', {
    response: { id: 'r1', status: 'failed', status_details: { error: { message: 'Rate limit reached. Please try again in 20ms.' } } },
  });
  assert.equal(sent.filter((type) => type === 'response.create').length, 0, 'not instantly');
  await new Promise((resolve) => { setTimeout(resolve, 900); });
  assert.equal(sent.filter((type) => type === 'response.create').length, 1, 'but it does ask again');
  assert.ok(events.some((entry) => entry.event === 'retry'), 'and the log says so');
  await session.stop();
});

await test('after two refusals in a row the student is told, once', async () => {
  const { RealtimeSession: Session } = await import('../public/js/realtime.js');
  const errors = [];
  const session = new Session({ onError: ({ message }) => errors.push(message) });
  session.active = true;
  session.dc = { readyState: 'open', send: () => {} };
  const fail = () => {
    session.handleServerEvent({ data: JSON.stringify({ type: 'response.created', response: { id: 'r' } }) });
    session.handleServerEvent({ data: JSON.stringify({
      type: 'response.done',
      response: { id: 'r', status: 'failed', status_details: { error: { message: 'Rate limit reached. Please try again in 5s.' } } },
    }) });
  };
  fail(); fail();
  assert.equal(errors.length, 0);
  fail();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /rate limit/i);
  await session.stop();
});

await test('the conversation the model carries is capped', () => {
  // Every reply re-sends the whole call, and in a voice call that is audio. An
  // uncapped call grows until the account's tokens-per-minute limit refuses it.
  const event = contextLimitEvent();
  assert.equal(event.type, 'session.update');
  assert.equal(event.session.truncation.type, 'retention_ratio');
  assert.ok(event.session.truncation.token_limits.post_instructions <= 6000);
  assert.ok(event.session.truncation.retention_ratio < 1, 'cut back in one go, not a sliver every turn');
});

section('Turn-taking against the live session (PART 51)');

const { RealtimeSession } = await import('../public/js/realtime.js');

/** A session wired to a fake data channel, so events can be replayed offline. */
function fakeSession(onError) {
  /** @type {string[]} */
  const sent = [];
  const session = new RealtimeSession(onError ? { onError } : {});
  session.active = true;
  session.dc = { readyState: 'open', send: (json) => sent.push(JSON.parse(json).type) };
  return { session, sent };
}

const feed = (session, type, extra = {}) =>
  session.handleServerEvent({ data: JSON.stringify({ type, ...extra }) });
const settle = (ms = 40) => new Promise((resolve) => { setTimeout(resolve, ms); });
const turns = (sent) => sent.filter((type) => type === 'response.create').length;

await test('a turn requested in the VAD window waits for the response it cannot see', async () => {
  const { session, sent } = fakeSession();

  // The student stops speaking. The server begins a response immediately, but
  // response.created has not reached us; meanwhile the transcription callback
  // fires and the lesson auto-advances, which nudges the tutor.
  feed(session, 'input_audio_buffer.speech_stopped');
  session.nudge('The student pressed Move on.', { speak: true });
  await settle();
  assert.equal(turns(sent), 0, 'nothing is fired into the live response');
  assert.ok(sent.includes('conversation.item.create'), 'but the instruction is delivered');

  feed(session, 'response.created');
  feed(session, 'response.done');
  await settle();
  assert.equal(turns(sent), 1, 'and exactly one turn follows');
});

await test('a student turn the server never answers is rescued', async () => {
  // The hang, reproduced. semantic_vad does not detect silence, it judges
  // whether a thought is finished — and when it judges wrong the server commits
  // the audio and then waits forever for a continuation. In a real session this
  // cost 17 seconds of dead air, ended only by the student speaking again.
  const { session, sent } = fakeSession();
  /** @type {any[]} */
  const rescues = [];
  session.callbacks.onSilentTurn = (detail) => rescues.push(detail);
  session.silentTurnMs = 30;

  feed(session, 'input_audio_buffer.speech_stopped');
  feed(session, 'input_audio_buffer.committed');
  await settle(80);

  assert.equal(turns(sent), 1, 'the client asks for the turn itself');
  assert.equal(rescues.length, 1, 'and says so, so the log shows it happened');
});

await test('a response that does arrive is never pre-empted', async () => {
  const { session, sent } = fakeSession();
  session.silentTurnMs = 30;

  feed(session, 'input_audio_buffer.speech_stopped');
  feed(session, 'response.created');
  await settle(80);
  assert.equal(turns(sent), 0, 'the server is answering; leave it alone');

  feed(session, 'response.done');
  await settle(80);
  assert.equal(turns(sent), 0, 'and a finished turn is not a missing one');
});

await test('a student still talking is not interrupted by the rescue', async () => {
  const { session, sent } = fakeSession();
  session.silentTurnMs = 30;

  feed(session, 'input_audio_buffer.speech_stopped');
  feed(session, 'input_audio_buffer.speech_started');
  await settle(80);
  assert.equal(turns(sent), 0, 'they carried on speaking, so there is no gap to fill');
});

await test('an unanswered turn does not leave every later turn queued behind a ghost', async () => {
  // responseActive is set optimistically when the student stops speaking. If
  // the server never creates a response, only the rescue can clear it —
  // otherwise every nudge for the rest of the call waits out the full retry
  // budget before firing.
  const { session, sent } = fakeSession();
  session.silentTurnMs = 30;

  feed(session, 'input_audio_buffer.speech_stopped');
  await settle(80);
  assert.equal(session.responseActive, false, 'the ghost response is cleared');

  feed(session, 'response.created');
  feed(session, 'response.done');
  sent.length = 0;
  session.nudge('The student pressed Move on.', { speak: true });
  await settle(40);
  assert.equal(turns(sent), 1, 'a later nudge goes out at once');
});

await test('turn-taking is written to the log, since none of it is visible', async () => {
  const { session } = fakeSession();
  /** @type {any[]} */
  const events = [];
  session.callbacks.onTurnEvent = (detail) => events.push(detail);

  feed(session, 'response.created', { response: { id: 'resp_1' } });
  feed(session, 'response.done', {
    response: { id: 'resp_1', status: 'cancelled', status_details: { reason: 'turn_detected' } },
  });
  await settle();

  assert.deepEqual(events.map((entry) => entry.event), ['created', 'done']);
  assert.equal(events[1].status, 'cancelled');
  assert.equal(events[1].reason, 'turn_detected', 'why a turn ended is the whole diagnosis');
});

await test('a nudge is passive unless it is told to speak', async () => {
  // Measured in a real session: the tutor answered the student, then the
  // lesson auto-advanced and nudged it, which forced a second turn straight
  // after the first. Two questions in a row and no chance to answer either.
  const { session, sent } = fakeSession();
  feed(session, 'response.created');
  feed(session, 'response.done');
  session.nudge('The lesson has moved on to Larger numbers.');
  await settle(40);
  assert.ok(sent.includes('conversation.item.create'), 'the instruction is delivered');
  assert.equal(turns(sent), 0, 'and the tutor is not made to speak again');

  session.nudge('The student pressed Move on.', { speak: true });
  await settle(40);
  assert.equal(turns(sent), 1, 'a button press, with nobody talking, does get a turn');
});

await test('several requests inside one response collapse into a single turn', async () => {
  const { session, sent } = fakeSession();
  feed(session, 'response.created');
  session.requestTurn();
  session.requestTurn();
  session.nudge('and another thing', { speak: true });
  await settle();
  assert.equal(turns(sent), 0, 'none of them interrupt');

  feed(session, 'response.done');
  await settle();
  assert.equal(turns(sent), 1);
});

await test('losing the race anyway is hidden from the student and retried', async () => {
  /** @type {string[]} */
  const errors = [];
  const { session, sent } = fakeSession(({ message }) => errors.push(message));

  session.requestTurn();
  await settle();
  assert.equal(turns(sent), 1, 'nothing looked active, so it went out');

  feed(session, 'error', {
    error: {
      code: 'conversation_already_has_active_response',
      message: 'Conversation already has an active response in progress: resp_ABC.',
    },
  });
  assert.deepEqual(errors, [], 'the student sees no red bar in the transcript');

  feed(session, 'response.done');
  await settle();
  assert.equal(turns(sent), 2, 'and the turn we owed is delivered afterwards');
});

await test('the same collision reported without a code is still recognised', async () => {
  /** @type {string[]} */
  const errors = [];
  const { session } = fakeSession(({ message }) => errors.push(message));
  feed(session, 'error', {
    error: { message: 'Conversation already has an active response in progress: resp_XYZ.' },
  });
  assert.deepEqual(errors, []);
});

await test('a genuine error still reaches the student', async () => {
  /** @type {string[]} */
  const errors = [];
  const { session } = fakeSession(({ message }) => errors.push(message));
  feed(session, 'error', {
    error: { code: 'invalid_request_error', message: 'Something actually went wrong.' },
  });
  assert.deepEqual(errors, ['Something actually went wrong.']);
});

await test('an idle session gets its turn straight away', async () => {
  const { session, sent } = fakeSession();
  session.requestTurn();
  await settle();
  assert.equal(turns(sent), 1, 'no waiting when nothing is running');
});

await test('teardown cancels a queued turn rather than firing it later', async () => {
  const { session, sent } = fakeSession();
  feed(session, 'response.created');
  session.requestTurn();
  await session.stop();
  await settle(120);
  assert.equal(turns(sent), 0, 'a stopped session asks for nothing');
  assert.equal(session.turnPending, false);
  assert.equal(session.turnTimer, null);
});

section('Prompt budget — the tutor runs on a small model');

/**
 * A rough token estimate. Deliberately crude: the point is a tripwire that
 * fires when the prompt grows by a third, not an exact billing figure.
 */
const estimateTokens = (text) => Math.round(text.length / 3.6);

/** A heavy but realistic profile: full vocabulary pool, several weaknesses. */
function heavyProfile() {
  return {
    ...profileFor('Japanese'),
    known_weaknesses: [
      'Particle wa vs ga', 'Te-form verbs', 'Counters', 'Long vowels', 'Polite vs plain',
    ],
    recent_vocab: Array.from({ length: 20 }, (_, i) => `word${i} — a reasonably long meaning`),
  };
}

await test('the base prompt stays under 1200 tokens', () => {
  // Raised twice, each time to buy a rule the small model will not infer.
  //
  // 900 -> 1000: a session in which 73% of the tutor's turns opened with praise
  // ("Sugoi!" 36 times in 23 minutes) and the average turn ran to 31 words
  // against a prompt asking for one or two sentences. Brevity advice does not
  // read as "stop complimenting me"; the words have to be banned by name.
  //
  // 1000 -> 1200: the session after that. 72% of 105 turns were "Next, say X",
  // only 14% carried any English, and the student asked what something meant
  // ten times — once in so many words: "I'm saying them, but I'm not getting
  // anything out of this." Hence the rule that a phrase is never asked for
  // without its meaning, and the reversal into English-to-Japanese once an item
  // is settled.
  //
  // The pre-refactor prompt was around 5,000 tokens and had none of these.
  const tokens = estimateTokens(buildTutorPrompt(heavyProfile()));
  assert.ok(tokens < 1200, `base prompt is ~${tokens} tokens`);
});

await test('every lesson, in every part, stays inside its token budget', () => {
  // Two cases. With a script — the normal one — the tutor carries the script
  // and a single reference section. Without one, because the planner failed,
  // it carries two reference sections and its general teaching rules; that is
  // the fallback, and it is allowed to be heavier. The pre-refactor prompt was
  // about 5,000 tokens.
  const fullPlan = {
    items: Array.from({ length: 5 }, (_, i) => ({
      say: `kore wa item number ${i} desu ka`, meaning: `a reasonably long meaning ${i}`, note: 'a short note here', known: false,
    })),
    scene: {
      setup: 'You are the waiter at a ramen shop; the student has just sat down.',
      lines: Array.from({ length: 4 }, (_, i) => ({
        tutor: `tutor line number ${i} desu ka`, meaning: `what the line means ${i}`, expect: `kore wa item number ${i} desu ka`,
      })),
    },
  };
  const scripted = { tokens: 0, where: '' };
  const fallback = { tokens: 0, where: '' };
  for (const skill of SKILLS) {
    for (const phase of skill.phases) {
      for (const withPlan of [true, false]) {
        const runtime = new LessonRuntime();
        runtime.activate(skill);
        runtime.setPhase(phase.id);
        if (withPlan) runtime.setPlan(phase.id, fullPlan);
        runtime.noteVocabulary({
          introduced: Array.from({ length: 10 }, (_, i) => `intro${i} — meaning`),
          practiced: Array.from({ length: 10 }, (_, i) => `prac${i} — meaning`),
          successful: Array.from({ length: 10 }, (_, i) => `ok${i} — meaning`),
          struggled: Array.from({ length: 10 }, (_, i) => `hard${i} — meaning`),
        });
        const tokens = estimateTokens(buildTutorPrompt(heavyProfile(), {
          catalog: SKILLS,
          skill,
          state: runtime.snapshot(),
          reference: JAPANESE_REFERENCE,
        }));
        const bucket = withPlan && runtime.snapshot().script.length ? scripted : fallback;
        if (tokens > bucket.tokens) { bucket.tokens = tokens; bucket.where = `${skill.id}/${phase.id}`; }
      }
    }
  }
  assert.ok(scripted.tokens < 2100, `with a script the worst case is ~${scripted.tokens} tokens at ${scripted.where}`);
  // (Raised from 2300 when the restaurant facts gained what staff say back.)
  assert.ok(fallback.tokens < 2500, `without one the worst case is ~${fallback.tokens} tokens at ${fallback.where}`);
});

await test('a lesson with no reference to carry stays under 1450 tokens', () => {
  const skill = SKILLS.find((entry) => entry.id === 'vocabulary_builder');
  const runtime = new LessonRuntime();
  runtime.activate(skill);
  let worst = 0;
  for (const phase of skill.phases) {
    runtime.setPhase(phase.id);
    worst = Math.max(
      worst,
      estimateTokens(
        buildTutorPrompt(heavyProfile(), {
          catalog: SKILLS,
          skill,
          state: runtime.snapshot(),
          reference: JAPANESE_REFERENCE,
        }),
      ),
    );
  }
  assert.ok(worst < 1450, `worst case is ~${worst} tokens`);
});

await test('the session carries no tool definitions at all', async () => {
  const realtime = await readAll(['src/routes/realtime.js']);
  assert.ok(!/\btools\b\s*:/.test(realtime));
  assert.ok(!realtime.includes('tool_choice'));
});

await test('no rule is stated in more than one place', () => {
  const { runtime, skill } = runtimeOn('vocabulary_builder');
  const prompt = buildTutorPrompt(profileFor(), { catalog: SKILLS, skill, state: runtime.snapshot() });

  // Each of these used to appear between six and twenty-one times.
  const once = [
    [/outranks this lesson/g, 'the student outranks the lesson'],
    [/at most twice in a row/g, 'the repetition cap'],
    [/Only the student changes their level/g, 'the comfort-level rule'],
    [/one or two sentences/gi, 'the turn-length rule'],
  ];
  for (const [pattern, label] of once) {
    const count = (prompt.match(pattern) || []).length;
    assert.ok(count <= 1, `${label} appears ${count} times; it should be said once`);
  }
});

await test('the volatile part of the prompt comes last, so the prefix stays cached', () => {
  const { runtime, skill } = runtimeOn('restaurant');
  const prompt = buildTutorPrompt(profileFor(), { catalog: SKILLS, skill, state: runtime.snapshot() });

  const stable = ['# YOU', '# HOW YOU TEACH', '# IF THEY SPEAK ENGLISH', '# WHAT THEY KNOW'];
  const volatile = prompt.indexOf('# RIGHT NOW');
  assert.ok(volatile > -1);
  for (const heading of stable) {
    assert.ok(prompt.indexOf(heading) < volatile, `${heading} must come before the volatile section`);
  }
});

await test('changing phase changes only the tail of the prompt', () => {
  const { runtime, skill } = runtimeOn('restaurant');
  const before = buildTutorPrompt(profileFor(), { catalog: SKILLS, skill, state: runtime.snapshot() });
  runtime.setPhase('challenge');
  const after = buildTutorPrompt(profileFor(), { catalog: SKILLS, skill, state: runtime.snapshot() });

  let shared = 0;
  while (shared < before.length && shared < after.length && before[shared] === after[shared]) shared += 1;
  const ratio = shared / before.length;
  assert.ok(ratio > 0.6, `only ${(ratio * 100).toFixed(0)}% of the prompt is a shared prefix`);
});

section('Getting the language right, not just fluent');

await test('the language reference files load', () => {
  assert.deepEqual(REFERENCE_LIBRARY.problems, []);
  assert.deepEqual(Object.keys(REFERENCE_LIBRARY.languages).sort(), ['german', 'japanese']);
  assert.ok(JAPANESE_REFERENCE.numbers, 'Japanese has a numbers section');
});

await test('the Japanese numbers reference answers both observed hallucinations', () => {
  const numbers = JAPANESE_REFERENCE.numbers;
  // "try nijuu juu, which is thirty"
  assert.match(numbers, /Never chain two tens words/);
  assert.match(numbers, /"nijuu juu" is not a number/);
  assert.match(numbers, /Thirty is sanjuu/);
  // "nijuu juu is twenty-nine"
  assert.match(numbers, /nijuu is exactly 20, never 29/);
  // "rokujuu san ichi. That's 61"
  assert.match(numbers, /61 rokujuu ichi/);
  assert.match(numbers, /63 rokujuu san/);
});

await test('the reference reaches the tutor when the phase needs it', () => {
  const skill = SKILLS.find((entry) => entry.id === 'numbers_time_money');
  const runtime = new LessonRuntime();
  runtime.activate(skill);
  runtime.setPhase('numbers');

  const prompt = buildTutorPrompt(profileFor('Japanese'), {
    catalog: SKILLS,
    skill,
    state: runtime.snapshot(),
    reference: JAPANESE_REFERENCE,
  });
  assert.match(prompt, /# REFERENCE — these are facts, not suggestions/);
  assert.match(prompt, /rokujuu ichi/);
  assert.match(prompt, /this is right\./);
});

await test('and stays out of the way when it does not', () => {
  const skill = SKILLS.find((entry) => entry.id === 'vocabulary_builder');
  const runtime = new LessonRuntime();
  runtime.activate(skill);
  const prompt = buildTutorPrompt(profileFor('Japanese'), {
    catalog: SKILLS,
    skill,
    state: runtime.snapshot(),
    reference: JAPANESE_REFERENCE,
  });
  assert.ok(!prompt.includes('# REFERENCE'), 'a vocabulary lesson needs no numerals');
});

await test('no reference at all during ordinary conversation', () => {
  const prompt = buildTutorPrompt(profileFor('Japanese'), {
    catalog: SKILLS,
    skill: null,
    state: {},
    reference: JAPANESE_REFERENCE,
  });
  assert.ok(!prompt.includes('# REFERENCE'));
});

await test('a language with no file simply gets no reference', () => {
  const skill = SKILLS.find((entry) => entry.id === 'numbers_time_money');
  const runtime = new LessonRuntime();
  runtime.activate(skill);
  runtime.setPhase('numbers');
  const prompt = buildTutorPrompt(profileFor('Spanish'), {
    catalog: SKILLS,
    skill,
    state: runtime.snapshot(),
    reference: referenceFor(REFERENCE_LIBRARY.languages, 'Spanish'),
  });
  assert.ok(!prompt.includes('# REFERENCE'), 'and nothing breaks');
});

await test('lessons stay language-agnostic — they name the kind, not the facts', () => {
  for (const skill of SKILLS) {
    const serialised = JSON.stringify(skill);
    for (const leak of ['rokujuu', 'nijuu', 'einundzwanzig', 'juu']) {
      assert.ok(!serialised.includes(leak), `${skill.id} must not contain ${leak}`);
    }
    for (const key of skill.reference) {
      assert.ok(
        ['numbers', 'time', 'money', 'counting', 'food', 'restaurant', 'station', 'hotel'].includes(key),
        `${skill.id} declares an unknown reference kind "${key}"`,
      );
    }
  }
});

await test('at most two reference sections are ever shown at once', () => {
  const skill = SKILLS.find((entry) => entry.id === 'numbers_time_money');
  const runtime = new LessonRuntime();
  runtime.activate(skill);
  const withEverything = { ...skill, phases: [], reference: ['numbers', 'time', 'money', 'counting'] };
  const section = buildReferenceSection({
    skill: withEverything,
    state: runtime.snapshot(),
    reference: JAPANESE_REFERENCE,
  });
  const blocks = section.split('\n\n').filter((block) => /^[A-Z]/.test(block)).length;
  assert.ok(blocks <= 4, 'the cap keeps a greedy lesson from blowing the budget');
  assert.ok(!section.includes(JAPANESE_REFERENCE.counting), 'the fourth section is dropped');
});

await test('vocabulary in the prompt is written in the script the tutor must use', () => {
  // The Director reads the student's transcripts, so its vocabulary comes back
  // as the student was heard. A prompt that says "never katakana" four sections
  // earlier then handed the model "トマト — tomato" to work with — and tomato
  // and トマト each took a slot in a list capped at twelve.
  const { runtime, skill } = runtimeOn('vocabulary_builder');
  runtime.setPhase('in_context');
  for (const item of ['トマト — tomato', 'tomato — tomato', '鶏肉 — chicken']) {
    runtime.noteVocabulary({ practiced: [item], successful: [item] });
  }
  runtime.noteVocabulary({ struggled: ['recommendation — おすすめ'] });

  const prompt = buildTutorPrompt(profileFor('Japanese'), {
    catalog: SKILLS,
    skill,
    state: runtime.snapshot(),
  });
  const lists = prompt.split('# RIGHT NOW')[1] || '';
  assert.ok(!/[\u3040-\u30ff\u4e00-\u9fff]/.test(lists), `script leaked: ${lists}`);
  const settled = (/Ready for Recall[^:]*: (.*)/.exec(lists)?.[1] || '')
    .split(', ')
    .filter(Boolean);
  assert.equal(settled.length, 2, `one word written two ways is one word: ${settled}`);
});

await test('a topic chosen mid-conversation pulls the facts that match it', () => {
  // The real failure: Vocabulary Builder cannot declare what it needs in
  // advance, because the subject is settled by the student in conversation. On
  // "ingredients" the tutor was left composing food words from memory, and
  // taught "onion" and "potato" as the Japanese for onion and potato.
  const skill = SKILLS.find((entry) => entry.id === 'vocabulary_builder');
  const runtime = new LessonRuntime();
  runtime.activate(skill);
  runtime.setPhase('first_pass');
  runtime.setInput('topic', 'ingredients');

  const section = buildReferenceSection({
    skill,
    state: runtime.snapshot(),
    reference: JAPANESE_REFERENCE,
    topics: JAPANESE_TOPICS,
  });
  assert.match(section, /tamanegi onion/);
  assert.match(section, /jagaimo potato/);
});

await test('an unrelated topic pulls nothing, and pays nothing', () => {
  const skill = SKILLS.find((entry) => entry.id === 'vocabulary_builder');
  const runtime = new LessonRuntime();
  runtime.activate(skill);
  runtime.setPhase('first_pass');
  runtime.setInput('topic', 'daily greetings');

  assert.equal(
    buildReferenceSection({
      skill,
      state: runtime.snapshot(),
      reference: JAPANESE_REFERENCE,
      topics: JAPANESE_TOPICS,
    }),
    '',
  );
});

await test('a language with no topic map behaves exactly as before', () => {
  const skill = SKILLS.find((entry) => entry.id === 'vocabulary_builder');
  const runtime = new LessonRuntime();
  runtime.activate(skill);
  runtime.setInput('topic', 'ingredients');
  assert.equal(
    buildReferenceSection({ skill, state: runtime.snapshot(), reference: JAPANESE_REFERENCE }),
    '',
    'topics are optional; a language file without them loses nothing else',
  );
});

await test('the food facts say when the loanword IS the right answer', () => {
  // A blanket "always teach the native word" rule would be wrong about tomato,
  // which has no native alternative in use. The distinction has to be in the
  // data, because the small model gets it wrong in both directions.
  const food = JAPANESE_REFERENCE.food;
  assert.match(food, /tamanegi onion/, 'the native word where it wins');
  assert.match(food, /ARE the normal word/, 'and the exceptions, named');
  assert.match(food, /tomato/);
  assert.match(food, /Onion is tamanegi and potato is jagaimo: the English words are not used/);
});

await test('the tutor is told to check itself rather than bluff', () => {
  const prompt = buildTutorPrompt(profileFor());
  assert.match(prompt, /Use only words, numbers and forms you are sure are real German/);
  assert.match(prompt, /If they question something you said, check it/);
});

await test('the Director is given the same facts it judges against', async () => {
  const code = await readAll(['src/director.js']);
  assert.match(code, /FACTS ABOUT \$\{language\.toUpperCase\(\)\}/);
  assert.match(code, /the tutor was given these too/);

  const route = await readAll(['src/routes/lessons.js']);
  assert.match(route, /reference: referenceFor\(reference\.languages, language\)/);
});

await test('the Director can report a mistake the tutor made', () => {
  const skill = SKILLS.find((entry) => entry.id === 'numbers_time_money');
  const out = sanitizeDirection(
    {
      tutor_errors: [
        { said: 'rokujuu san ichi is 61', correct: '61 is rokujuu ichi; rokujuu san is 63' },
      ],
    },
    skill,
  );
  assert.equal(out.tutor_errors.length, 1);
  assert.equal(out.tutor_errors[0].correct, '61 is rokujuu ichi; rokujuu san is 63');
});

await test('a claim with no correction attached is dropped', () => {
  const skill = SKILLS.find((entry) => entry.id === 'numbers_time_money');
  const out = sanitizeDirection(
    { tutor_errors: [{ said: 'that was wrong' }, { correct: 'orphan' }, 'nonsense'] },
    skill,
  );
  assert.deepEqual(out.tutor_errors, [], 'telling the tutor it erred without saying how is worse than silence');
});

await test('a correction reaches the tutor and the lesson record', () => {
  const library = libraryWithSkills();
  library.activate('numbers_time_money', { reason: 'ui' });
  const applied = library.applyDirection({
    ...emptyDirection(),
    tutor_errors: [{ said: 'nijuu juu is thirty', correct: 'thirty is sanjuu' }],
  });
  assert.equal(applied.errors.length, 1);
  assert.match(library.runtime.snapshot().notes[0], /Tutor said "nijuu juu is thirty"/);
});

await test('the correction note is authoritative and specific', async () => {
  const rig = conductorRig({
    tutor_errors: [{ said: 'nijuu juu is thirty', correct: 'thirty is sanjuu' }],
  });
  await rig.conductor.runDirector();
  assert.equal(rig.nudges.length, 1);
  assert.match(rig.nudges[0].text, /You said "nijuu juu is thirty"\. That is wrong\. The correct version is: thirty is sanjuu\./);
  assert.match(rig.nudges[0].text, /Trust this over what you said before/);
  assert.equal(rig.nudges[0].speak, false);
});

await test('everything the Director finds reaches the tutor as one passive note', async () => {
  // Each finding used to be its own nudge, and each nudge forced a turn: an
  // error, an unglossed phrase and a phase change meant three extra turns
  // stacked on the one the tutor had just taken.
  const rig = conductorRig({
    tutor_errors: [{ said: 'nijuu juu is thirty', correct: 'thirty is sanjuu' }],
    unglossed: ['sanbyaku'],
    phase_id: 'first_pass',
  });
  await rig.conductor.runDirector();
  assert.equal(rig.nudges.length, 1, 'one note, not three');
  assert.equal(rig.nudges[0].speak, false, 'and it does not make the tutor speak');
  assert.match(rig.nudges[0].text, /thirty is sanjuu/);
  assert.match(rig.nudges[0].text, /"sanbyaku" without saying what it means/);
  assert.match(rig.nudges[0].text, /moved on to First set/);
});

await test('an automatic advance is noted passively too', () => {
  const rig = conductorRig({});
  for (let i = 0; i < 12 && !rig.nudges.length; i += 1) rig.conductor.handleStudentTurn('hai');
  rig.conductor.stop();
  assert.equal(rig.nudges.length, 1);
  assert.equal(rig.nudges[0].speak, false);
  assert.match(rig.nudges[0].text, /The lesson has moved on to/);
});

section('Hearing the student, and checking before asking');

const { buildTranscriptionPrompt } = await import('../public/shared/transcription.js');

await test('the transcription hint is a single ISO language code, not an array', async () => {
  const realtime = await readAll(['src/routes/realtime.js']);
  assert.match(realtime, /const language = code && code !== 'en' \? code : 'en';/);
  assert.match(realtime, /transcription: \{[\s\S]*?language,/, 'the singular field is sent');
  assert.ok(!/languages,/.test(realtime), 'the array form is gone — it was silently ignored');
});

await test('the hint names the sounds the student is about to make', () => {
  const prompt = buildTranscriptionPrompt({
    profile: {
      target_language: 'Japanese',
      proficiency_level: 'Beginner',
      script_style: 'Romaji',
      recent_vocab: ['oishii — delicious', 'mizu — water'],
    },
    reference: JAPANESE_REFERENCE,
  });
  // The exact words that came back as Korean in a real session.
  for (const word of ['rokujuu', 'sanjuu', 'ichi', 'sanbyaku', 'sanzen', 'hyaku']) {
    assert.ok(prompt.includes(word), `${word} is offered to the transcriber`);
  }
  assert.match(prompt, /romaji only/, 'and the fact that they read romaji');
  assert.match(prompt, /also ask questions in English/, 'and that they switch to English');
  assert.match(prompt, /oishii, mizu/, 'plus what they have practised before');
});

await test('the hint carries sounds, never English descriptions', () => {
  const skill = SKILLS.find((entry) => entry.id === 'numbers_time_money');
  const prompt = buildTranscriptionPrompt({
    profile: { target_language: 'Japanese', proficiency_level: 'Beginner', script_style: 'Romaji', recent_vocab: [] },
    skill,
    reference: JAPANESE_REFERENCE,
  });
  // A lesson's target_vocabulary is English concepts by design — useless to a
  // transcriber, which needs to know what a sound will be.
  for (const noise of ['the tens', 'the currency', 'days of the week', 'numbers zero to twenty']) {
    assert.ok(!prompt.includes(noise), `"${noise}" must not be in a transcription hint`);
  }
  assert.ok(!/\bnumbers,/.test(prompt), 'and the word "numbers" is not a sound');
});

await test('accented languages survive extraction intact', () => {
  const german = referenceFor(REFERENCE_LIBRARY.languages, 'German');
  const prompt = buildTranscriptionPrompt({
    profile: { target_language: 'German', proficiency_level: 'Intermediate', script_style: 'Standard', recent_vocab: [] },
    reference: german,
  });
  for (const word of ['fünf', 'zwölf', 'dreißig', 'einundsechzig']) {
    assert.ok(prompt.includes(word), `${word} survives`);
  }
  for (const fragment of [' nf,', ' lf,', ' ig,']) {
    assert.ok(!prompt.includes(fragment), `"${fragment.trim()}" is a broken umlaut, not a word`);
  }
  assert.match(prompt, /^An intermediate/, 'and the article agrees');
});

await test('the hint is bounded and degrades to nothing gracefully', () => {
  const huge = buildTranscriptionPrompt({
    profile: {
      target_language: 'Japanese',
      proficiency_level: 'Beginner',
      script_style: 'Romaji',
      recent_vocab: Array.from({ length: 200 }, (_, i) => `word${i} — a long meaning here`),
    },
    reference: JAPANESE_REFERENCE,
  });
  assert.ok(huge.length <= 900, `hint is ${huge.length} chars`);
  assert.equal(typeof buildTranscriptionPrompt(), 'string', 'no arguments is fine');
  assert.equal(typeof buildTranscriptionPrompt({ profile: null, reference: null }), 'string');
});

await test('the transcription config actually sent is logged', async () => {
  const app = await readAll(['public/js/app.js']);
  assert.match(app, /sessionLog\.event\('transcription\.hint'/);
  assert.match(app, /onTranscriptionConfig: \(config\) => sessionLog\.event\('transcription\.config', config\)/);
  const realtime = await readAll(['src/routes/realtime.js']);
  assert.match(realtime, /transcription: sessionConfig\.audio\.input\.transcription/, 'echoed by the server');
});

await test('the beginner guidance no longer asks for parroting', () => {
  // "repeat key phrases so the student can imitate them" was in the level
  // guidance, directly contradicting the rule above.
  const base = buildTutorPrompt(profileFor('Japanese'));
  assert.ok(!/imitate them/.test(base), 'the contradicting bullet is gone');
});

await test('the prompt is laid out the way the realtime guide asks', () => {
  const base = buildTutorPrompt(profileFor('Japanese'));
  for (const heading of [
    '# Role and Objective', '# Personality and Tone', '# Verbosity', '# Preambles',
    '# Teaching', '# Corrections', '# Unclear Audio', '# Accuracy',
  ]) {
    assert.ok(base.includes(heading), `${heading} is a labelled section`);
  }
  assert.equal(
    (base.match(/\b(NEVER|ALWAYS|MUST|ONLY)\b/g) || []).length,
    0,
    'no shouted constraints: three versions built from them each traded one tic for another',
  );
});

await test('the base prompt contains no phrase the tutor could parrot', () => {
  // An example of "give the meaning" — a time phrase — was read out verbatim in
  // a lesson about plain numbers, and an example correction label ended up on
  // turns with nothing to correct. The small model copies examples, so the
  // rules are stated without target-language samples.
  const base = buildTutorPrompt(profileFor('Japanese'));
  const rules = base.slice(0, base.indexOf('# Japanese'));
  for (const leaked of ['sanji', 'watashi', 'toriniku', 'osusume', 'Particle:', 'Word order:']) {
    assert.ok(!rules.includes(leaked), `"${leaked}" is not in the rules to be copied`);
  }
});

await test('one ask per turn, and no preamble before it', () => {
  const base = buildTutorPrompt(profileFor('Japanese'));
  assert.match(base, /Ask for one thing per turn, then stop and wait/);
  assert.match(base, /Do not use preambles, and do not write in the commentary channel/);
});

await test('with no script, the tutor is still told: meaning first, then recall from English', () => {
  const base = buildTutorPrompt(profileFor('Japanese'));
  const teaching = base.slice(base.indexOf('# Teaching'), base.indexOf('# Corrections'));
  assert.match(teaching, /say it, say what it means in English, and ask them to say it/);
  assert.match(teaching, /your next turn is not another new thing\. Give only the English and ask for the Japanese/);
  assert.match(teaching, /the Japanese does not appear in that turn: it is the answer/);
  assert.match(teaching, /Do not ask them to repeat something they have just said correctly/);
});

await test('with a script, the tutor is told to follow it and nothing else about structure', () => {
  const { runtime, skill } = runtimeOn('restaurant');
  runtime.setPlan('introduction', SAMPLE_PLAN);
  const prompt = buildTutorPrompt(profileFor('Japanese'), { catalog: SKILLS, skill, state: runtime.snapshot() });
  const teaching = prompt.slice(prompt.indexOf('# Teaching'), prompt.indexOf('# Corrections'));
  assert.match(teaching, /you are told what you last asked, what to say in each case, and the words of your next turn/);
  assert.match(teaching, /Do not bring in a word or phrase of your own for them to say/);
  assert.match(teaching, /Do not add an explanation, a grammar remark, an example or a second request/);
  assert.ok(!/three or four words/.test(teaching), 'two sets of instructions for one job is how neither gets followed');
  assert.match(prompt, /then say the line given under RIGHT NOW/);
  assert.ok(!prompt.includes('# What They Know'), 'and old vocabulary is not left lying around to improvise from');
});

await test('a right answer is not corrected, and an unclear one is asked for again', () => {
  // The tutor told a student who had said "san yon go" that he had made a word
  // order mistake, and to say "san, yon, go". Every turn had a correction slot,
  // so every turn got a correction.
  const base = buildTutorPrompt(profileFor('Japanese'));
  assert.match(base, /If the meaning and the key words are right, the answer is right/);
  assert.match(base, /a dropped particle, or a different order where the order is free is not a mistake/);
  assert.match(base, /Correct only a mistake you clearly heard/);
  assert.match(base, /ask them to say it again\. Do not guess/);
  assert.match(base, /No praise: not nice, great, good, perfect, well done/);
});

await test('only the opening instructions tell the tutor to greet the student', () => {
  const profile = profileFor('Japanese');
  assert.match(buildTutorPrompt(profile), /# START/);
  assert.ok(
    !buildTutorPrompt(profile, null, { opening: false }).includes('# START'),
    'a prompt pushed into a call already under way does not restart it',
  );
});

await test('a word cannot be both finished with and still hard', () => {
  // Both lists are built from what the Director reported, and a word practised
  // twice and got wrong twice lands in both. The prompt then said "do not ask
  // for toriniku again" and "toriniku is still hard" in consecutive lines.
  const { runtime, skill } = runtimeOn('vocabulary_builder');
  runtime.setPhase('in_context');
  runtime.noteVocabulary({ practiced: ['toriniku — chicken'], successful: ['toriniku — chicken'] });
  runtime.noteVocabulary({ struggled: ['toriniku — chicken'] });

  const prompt = buildTutorPrompt(profileFor('Japanese'), {
    catalog: SKILLS,
    skill,
    state: runtime.snapshot(),
  });
  const settled = /Ready for Recall[^:]*: (.*)/.exec(prompt)?.[1] || '';
  assert.ok(!settled.includes('toriniku'), 'still hard wins');
  assert.match(prompt, /Still hard — give the meaning again: .*toriniku/);
});

await test('one word written two ways is listed once', () => {
  const { runtime, skill } = runtimeOn('vocabulary_builder');
  runtime.setPhase('in_context');
  for (const item of ['gyuuniku', 'gyuuniku — beef', 'Gyuuniku (beef)']) {
    runtime.noteVocabulary({ practiced: [item], successful: [item] });
  }
  const prompt = buildTutorPrompt(profileFor('Japanese'), {
    catalog: SKILLS,
    skill,
    state: runtime.snapshot(),
  });
  const settled = /Ready for Recall[^:]*: (.*)/.exec(prompt)?.[1] || '';
  assert.equal(
    settled.toLowerCase().split('gyuuniku').length - 1,
    1,
    `three renderings of one word read as three words: ${settled}`,
  );
});

await test('the tutor is told to check a target before asking for it', () => {
  const base = buildTutorPrompt(profileFor());
  assert.match(base, /Use only words, numbers and forms you are sure are real/);

  const { runtime, skill } = runtimeOn('numbers_time_money');
  runtime.setPhase('numbers');
  const withReference = buildTutorPrompt(profileFor('Japanese'), {
    catalog: SKILLS,
    skill,
    state: runtime.snapshot(),
    reference: JAPANESE_REFERENCE,
  });
  assert.match(withReference, /build it with these rules and check it exists/);
});

await test('reference facts replace the lesson\u2019s English material list', () => {
  const { runtime, skill } = runtimeOn('numbers_time_money');
  runtime.setPhase('numbers');

  const withReference = buildTutorPrompt(profileFor('Japanese'), {
    catalog: SKILLS, skill, state: runtime.snapshot(), reference: JAPANESE_REFERENCE,
  });
  assert.ok(!withReference.includes('Useful here:'), 'the real numbers beat a list of concepts');

  const withoutReference = buildTutorPrompt(profileFor('Japanese'), {
    catalog: SKILLS, skill, state: runtime.snapshot(), reference: {},
  });
  assert.match(withoutReference, /Useful here:/, 'but it is still there when nothing better exists');
});

await test('the Director watches for phrases asked without a meaning', () => {
  const prompt = buildDirectorPrompt({
    language: 'Japanese',
    level: 'Beginner',
    lesson: 'LESSON: x',
    turnsInPhase: 3,
    reference: '',
  });
  assert.match(prompt, /"unglossed": \[\]/, 'the field is in the shape it must return');
  assert.match(prompt, /without ever telling them what the\s+phrase means/);
  assert.match(
    prompt,
    /FROM the English[\s\S]{0,60}correct behaviour/,
    'the reversed direction must not be reported as an omission',
  );
});

await test('unglossed phrases survive sanitising and reach the lesson', () => {
  const skill = SKILLS.find((entry) => entry.id === 'numbers_time_money');
  const direction = sanitizeDirection(
    { unglossed: ['sanji han', '  rokuji han  ', '', 42, 'x'.repeat(200)] },
    skill,
  );
  assert.deepEqual(direction.unglossed.slice(0, 2), ['sanji han', 'rokuji han']);
  assert.ok(direction.unglossed.every((entry) => entry.length <= 80));

  const library = libraryWithSkills();
  library.activate('vocabulary_builder', { reason: 'ui' });
  const applied = library.applyDirection({ ...emptyDirection(), unglossed: ['sanji han'] });
  assert.deepEqual(applied.unglossed, ['sanji han']);
});

await test('an empty direction reports no unglossed phrases', () => {
  const skill = SKILLS.find((entry) => entry.id === 'numbers_time_money');
  assert.deepEqual(sanitizeDirection({}, skill).unglossed, []);
  assert.deepEqual(emptyDirection().unglossed, []);
});

await test('the Director must report a bad ask even when the tutor walks it back', async () => {
  const code = await readAll(['src/director.js']);
  assert.match(code, /ASKING the student to say something that is not a real word or number is\s+itself an error/);
  assert.match(code, /EVEN IF the tutor corrected itself a\s+turn later/);
  assert.match(code, /caught within the SAME turn, before the\s+student responded/, 'with one narrow exception');
});

section('The app chooses the tutor\'s words');

// Round four: shown "if right say this, if wrong say that, then the next
// line", the small model said its line in full four times in twenty-five. It
// cut '"futari desu" means two people. Say it.' down to "Hai. futari desu",
// read "RIGHT NOW" aloud, and corrected "menyuu o kudasai" three times
// running. So the choice is made by the app, after the student has spoken, and
// the tutor is asked for one reply with the words of it.

/** The steps of SAMPLE_PLAN, and a helper to ask what the next turn is. */
const sampleSteps = () => buildScript(sanitizePlan(SAMPLE_PLAN));
const nextTurn = (options) => turnFor(sampleSteps(), { language: 'Japanese', ...options });

await test('a right answer gets one word and the next line', () => {
  const turn = nextTurn({ current: 2, heard: 'um, sumimasen' });
  assert.deepEqual(
    { mode: turn.mode, line: turn.line, advances: turn.advances },
    { mode: 'exact', line: `Hai. ${SAMPLE_WALK[3]}`, advances: true },
  );
  // Repeating a phrase straight after hearing it earns no comment: going on
  // says it was fine, and the word keeps its meaning for when it is earned.
  // What it does earn is the note about it, said now that the word has been in their mouth.
  assert.equal(nextTurn({ current: 0, heard: 'um, sumimasen' }).line, `To call the waiter. Next: ${SAMPLE_WALK[1]}`);
  assert.equal(nextTurn({ current: 1, heard: 'futari desu' }).line, SAMPLE_WALK[2], 'and with no note, the next line alone');
});

await test('a part that is starting gets its first line', () => {
  const turn = nextTurn({ current: -1, heard: 'yes, ready' });
  assert.equal(turn.mode, 'exact');
  assert.equal(turn.line, SAMPLE_WALK[0]);
});

await test('a different taught word is named, and the right one given', () => {
  // "How do you say beef?" — "kyabetsu" — "Hai."
  const first = nextTurn({ current: 2, heard: 'futari desu' });
  assert.equal(first.mode, 'exact');
  assert.equal(first.line, '"futari desu" is two people. Excuse me is "sumimasen". Say it once more.');
  assert.equal(first.advances, false);
  // For a phrase, a start rather than the whole thing: the second try is
  // still a recall, not an echo.
  const phrase = nextTurn({ current: 5, heard: 'sumimasen' });
  assert.equal(phrase.line, '"sumimasen" is excuse me. The menu, please starts "menyuu…". Try again.');
  // The second time it is given and the lesson goes on.
  const second = nextTurn({ current: 2, heard: 'futari desu', tries: 1 });
  assert.equal(second.line, `"futari desu" is two people. It's "sumimasen". Next: ${SAMPLE_WALK[3]}`, 'and a new item is announced as one');
  assert.equal(second.advances, true);
  assert.equal(confusedWith(sampleSteps()[2], 'sumimasen', [{ say: 'futari desu', meaning: 'two people' }]), null, 'a right answer is not a mix-up');
});

await test('a wrong meaning is put right in one sentence, and the lesson goes on', () => {
  // "toriniku means beef, not pork."
  const turn = nextTurn({ current: 4, heard: 'excuse me' });
  assert.equal(turn.mode, 'exact');
  // ("futari desu means two people. You want to see the menu. What do you
  // say?" — "futari desu?": a sentence stands between the two.)
  assert.equal(turn.line, `Not quite. "futari desu" means two people, not excuse me. Now a different one. ${SAMPLE_WALK[5]}`, 'without the other word\'s Japanese: it may be the next thing asked');
  assert.equal(turn.advances, true);
});

await test('"I don\'t know" is given the answer, not marked wrong', () => {
  assert.equal(givesUp('um, I do not remember'), true);
  const turn = nextTurn({ current: 2, heard: "I don't remember that one" });
  assert.deepEqual({ line: turn.line, advances: turn.advances }, { line: 'It\'s "sumimasen". Say it.', advances: false });
  const meaning = nextTurn({ current: 4, heard: 'no idea' });
  assert.equal(meaning.line, `"futari desu" means two people. Now a different one. ${SAMPLE_WALK[5]}`);
});

await test('a question is answered, and the same thing asked again in the same words', () => {
  const turn = nextTurn({ current: 2, heard: 'wait, what is the o for?' });
  assert.equal(turn.mode, 'question');
  assert.equal(turn.after, 'How do you say "excuse me"?');
  assert.equal(turn.advances, false);
  const { instructions, say } = renderTurn(turn, { tutor: 'Aiko', student: 'Jeremy', language: 'Japanese', reference: 'Onion tamanegi.' });
  assert.equal(say, '', 'the answer is the one thing the tutor composes');
  assert.match(instructions, /You had asked them how to say "excuse me" in Japanese\./, 'it is told what it had asked: "which meat?" could not be answered without');
  assert.match(instructions, /Instead of answering, they said: "wait, what is the o for\?"/);
  assert.match(instructions, /do not tell them to say or repeat anything: what they are asked next comes separately/);
  assert.match(instructions, /One opener, never two, and never "Say"/, 'told "Say: okaikei onegaishimasu", a student said it and was marked wrong');
  assert.match(instructions, /Phrases taught so far: sumimasen = excuse me; futari desu = two people\./, 'so that "the menu one" can be answered');
  assert.match(instructions, /Facts about Japanese:\nOnion tamanegi\./);
  assert.ok(!/RIGHT NOW|NEXT LINE|^#/m.test(instructions), 'nothing in it is a label to read out');
  // The plain form the second time: a cue that confused them is not repeated.
  const cue = turnFor(buildScript(sanitizePlan({
    items: [{ say: 'sumimasen', meaning: 'excuse me', use: 'You want the waiter to come over.' }, { say: 'futari desu', meaning: 'two people' }],
  })), { language: 'Japanese', current: 2, heard: 'sorry, what do you want me to say?' });
  assert.equal(cue.after, 'How do you say "excuse me"?');
});

await test('an answer the app cannot place is put to a judge, not guessed at', () => {
  const turn = nextTurn({ current: 1, heard: 'futa desu' });
  assert.equal(turn.mode, 'judge');
  assert.equal(turn.say, 'futari desu');
  // With a verdict, the turn is exact again.
  const wrong = nextTurn({ current: 1, heard: 'futa desu', verdict: { verdict: 'wrong', heard: 'futa desu' } });
  assert.deepEqual(
    { mode: wrong.mode, line: wrong.line, advances: wrong.advances },
    { mode: 'exact', line: 'Not quite. It\'s "futari", not "futa": "futari desu". Say it once more.', advances: false },
  );
  const again = nextTurn({ current: 1, heard: 'futa desu', tries: 1, verdict: { verdict: 'wrong', heard: 'futa desu' } });
  // With a sentence between the answer and the next thing asked: "It's futari
  // desu. How do you say excuse me?" invited "futari desu".
  assert.equal(again.line, `It's "futari desu". Let's keep going. ${SAMPLE_WALK[2]}`, 'one more go, then on: never a third');
  assert.equal(again.advances, true);
  const right = nextTurn({ current: 1, heard: '二人です', verdict: { verdict: 'right', heard: 'futari desu' } });
  assert.equal(right.line, SAMPLE_WALK[2]);
  const noise = nextTurn({ current: 1, heard: '...', verdict: { verdict: 'unclear', heard: '' } });
  assert.equal(noise.line, 'Once more: "futari desu".');
});

await test('a correction names what was different, and never contradicts itself', () => {
  // "I specifically need to know what was wrong." And, from a kanji answer:
  // "Not quite. I heard fukuro wa irimasen. It's fukuro wa irimasen."
  assert.equal(correctionFor('biiru wa kudasai', 'biiru o kudasai'), 'Not quite. It\'s "o", not "wa": "biiru o kudasai". Say it once more.');
  assert.equal(correctionFor('um, sumisen', 'sumimasen'), 'Not quite. You left out "ma": "sumimasen". Say it once more.', 'their hesitation is not read back to them');
  assert.equal(correctionFor('gyuuni', 'gyuuniku'), 'Not quite. You left off "ku": "gyuuniku". Say it once more.');
  assert.equal(correctionFor('hourenzou', 'hourensou'), 'Not quite. It\'s "sou", not "zou": "hourensou". Say it once more.');
  assert.equal(correctionFor('roku hyaku go juu en', 'roppyaku gojuu en'), 'Not quite. The word is "roppyaku": "roppyaku gojuu en". Say it once more.');
  assert.equal(correctionFor('poteto', 'jagaimo'), 'Not quite. I heard "poteto". It\'s "jagaimo". Say it once more.', 'a different word altogether is simply both');
  assert.equal(correctionFor('fukuro wa irimasen', 'fukuro wa irimasen'), 'Once more: "fukuro wa irimasen".');
  // What the judge heard is checked again: if it is the answer, it is right.
  const step = { kind: 'recall', say: 'fukuro wa irimasen', meaning: 'no bag needed' };
  const turn = turnFor([step, { kind: 'wrap', items: [] }], {
    language: 'Japanese', current: 0, heard: '袋はいりません', verdict: { verdict: 'wrong', heard: 'fukuro wa irimasen' },
  });
  assert.equal(turn.reason, 'right');
});

await test('other words a native speaker would use are right, and the planned ones are heard too', () => {
  // "fukuro wa kekkou desu" was corrected to "fukuro wa irimasen".
  const turn = nextTurn({ current: 1, heard: 'futari', verdict: { verdict: 'alternative', heard: 'futari' } });
  assert.equal(turn.reason, 'right', 'here the words are the answer already');
  const other = turnFor([{ kind: 'recall', say: 'fukuro wa irimasen', meaning: 'no bag needed' }, { kind: 'wrap', items: [] }], {
    language: 'Japanese', current: 0, heard: 'fukuro wa kekkou desu', verdict: { verdict: 'alternative', heard: 'fukuro wa kekkou desu' },
  });
  assert.match(other.line, /^Hai\. That works too\. I had "fukuro wa irimasen"\./);
  assert.equal(other.advances, true);
});

await test('something that reads like a question but could be the answer is looked at properly', () => {
  // "What does omizu o kudasai mean?" — "Um, can I have some water?" — and it
  // was answered as a question.
  const steps = [{ kind: 'recognise', say: 'omizu o kudasai', meaning: 'water, please' }, { kind: 'wrap', items: [] }];
  assert.equal(turnFor(steps, { language: 'Japanese', current: 0, heard: 'Um, can I have some water?' }).mode, 'judge');
  assert.equal(nextTurn({ current: 0, heard: 'is it sumimasen?' }).mode, 'judge', 'likewise an answer with a question mark on it');
  assert.equal(nextTurn({ current: 0, heard: 'what does that mean?' }).mode, 'question', 'a plain question is still a question');
  assert.equal(nextTurn({ current: 0, heard: 'is it sumimasen?', verdict: { verdict: 'right', heard: 'sumimasen' } }).reason, 'right');
  const asked = nextTurn({
    current: 0, heard: 'what is the difference between sumimasen and gomen',
    verdict: { verdict: 'question', heard: 'what is the difference between sumimasen and gomen' },
  });
  assert.equal(asked.mode, 'question', 'and a question with the word in it stays a question');
});

await test('an answer written in the language\'s own script is recognised without asking anyone', () => {
  // In real calls the transcriber wrote seven answers in ten in Japanese script.
  const step = { kind: 'teach', say: 'menyuu o onegaishimasu', meaning: 'the menu, please', script: 'メニューをお願いします' };
  assert.equal(answersStep(step, 'メニューをお願いします。'), true);
  assert.equal(answersStep(step, 'メニュー を お願いします'), true);
  assert.equal(answersStep(step, '水をください'), false);
  const plan = sanitizePlan({ items: [{ say: 'futari desu', script: '二人です', meaning: 'two people' }, { say: 'sumimasen', meaning: 'excuse me' }] });
  assert.equal(buildScript(plan)[0].script, '二人です', 'the plan carries it to the step');
});

await test('if no judge answers, the tutor chooses between two written-out turns', () => {
  const turn = nextTurn({ current: 1, heard: 'futa desu' });
  const { instructions } = renderTurn(turn, { tutor: 'Aiko', student: 'Jeremy', language: 'Japanese' });
  assert.match(instructions, /The right answer is "futari desu"\./);
  assert.match(instructions, /If their answer was right:\nHow do you say "excuse me"\?/);
  assert.match(instructions, /If it was not:\nNot quite\. I heard "…"\. It's "futari desu"\. Say it once more\./);
});

await test('a line to say is handed over as text to read, not as a turn to take', () => {
  // Told "your turn is these words", the tutor treated a line that ended in a
  // question as a question to it: "What do you say? すみません".
  // Measured over eighteen lines, three times each: 54 of 54 word for word.
  const { instructions, say, examples } = renderTurn(nextTurn({ current: 1, heard: 'futari desu' }), { tutor: 'Aiko', student: 'Jeremy', language: 'Japanese' });
  assert.equal(say, SAMPLE_WALK[2], 'the line is the text it is given');
  assert.match(instructions, /Repeat the user's message back word for word/);
  assert.match(instructions, /Do not answer it\./);
  assert.ok(!instructions.includes('excuse'), 'and the instructions are only about repeating');
  assert.ok(instructions.length < 900, 'short: the repeating, how to say what is not English, and nothing else');
  assert.equal(examples.length, 3, 'with three lines shown as already repeated, so the pattern is plain');
  assert.equal(wentOn('Hai. futari desu means two people. Say it.', SAMPLE_WALK[1]), true, 'said without the quotation marks still counts');
  assert.equal(wentOn('Hai. futari desu', SAMPLE_WALK[1]), false, 'a line cut short does not');
  assert.equal(
    wentOn('People usually specify: gyuuniku beef, butaniku pork, toriniku chicken, or ramu lamb. What do you say?', '"toriniku" means chicken. Say it.'),
    false,
    'nor does an answer that happens to mention the next word',
  );
});

await test('the conductor decides the reply once the student has spoken', async () => {
  const rig = conductorRig({}, { directed: true });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  rig.replies.length = 0;

  const opening = rig.conductor.openingTurn();
  assert.equal(opening.say, 'Hi Jeremy. "sumimasen" means excuse me. Say it.', 'straight to the first thing to say');
  rig.conductor.handleTutorTurn('Hi Jeremy. sumimasen means excuse me. Say it.');
  assert.equal(rig.library.runtime.snapshot().script_current, 0, 'the place moves when the tutor has said it');

  const decided = await rig.conductor.answerStudent('sumimasen');
  assert.equal(decided.fresh, true, 'asked for without the conversation in view');
  assert.equal(decided.say, `To call the waiter. Next: ${SAMPLE_WALK[1]}`);
  rig.conductor.handleTutorTurn(decided.say);
  assert.equal(rig.library.runtime.snapshot().script_current, 1);
  rig.conductor.stop();
  assert.equal(rig.nudges.length, 0, 'and nothing is left in the conversation to steer it by');
});

await test('a question does not move the lesson, whatever the answer happens to mention', async () => {
  // Asked "which meat?", the tutor listed four — and the app took that for
  // the line teaching the next one.
  const rig = conductorRig({}, { directed: true });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  rig.conductor.openingTurn();
  rig.conductor.handleTutorTurn(SAMPLE_WALK[0]);
  rig.replies.length = 0;

  const decided = await rig.conductor.answerStudent('wait, what is that word for?');
  assert.equal(decided.turn.mode, 'question');
  assert.equal(decided.then.say, '"sumimasen" means excuse me. Say it.', 'what had been asked follows, as a turn of its own');
  rig.conductor.speak(decided);
  assert.deepEqual(rig.replies.map((reply) => reply.after), [false, true], 'two replies, the second behind the first');

  rig.conductor.handleTutorTurn(`It means excuse me. ${SAMPLE_WALK[1]}`);
  assert.equal(rig.library.runtime.snapshot().script_current, 0, 'still where it was');
  rig.conductor.stop();
});

await test('a line the tutor cut short is asked for again, once', async () => {
  // After "Yes, I'm ready": "biiru o kudasai". No meaning, no request — and
  // then silence, until the student asked what it meant.
  const rig = conductorRig({}, { directed: true });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  rig.conductor.openingTurn();
  rig.conductor.handleTutorTurn(SAMPLE_WALK[0]);
  const decided = await rig.conductor.answerStudent('sumimasen');
  rig.replies.length = 0;

  rig.conductor.handleTutorTurn('futari desu');
  assert.ok(rig.logs.some((entry) => entry.type === 'script.offScript'));
  assert.equal(rig.replies.length, 1);
  assert.equal(rig.replies[0].say, decided.say, 'the same line, whole');
  rig.conductor.handleTutorTurn('futari desu');
  assert.equal(rig.replies.length, 1, 'but not for ever');
  rig.conductor.stop();
});

await test('a judge is asked only when the transcript does not settle it, and one retry is all', async () => {
  /** @type {any[]} */
  const asked = [];
  const rig = conductorRig({}, {
    directed: true,
    judge: async (question) => { asked.push(question); return { ok: true, verdict: 'wrong', heard: 'futa desu', other: '' }; },
  });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  rig.conductor.openingTurn();
  rig.conductor.handleTutorTurn(SAMPLE_WALK[0]);

  await rig.conductor.answerStudent('sumimasen');
  assert.equal(asked.length, 0, 'a plain right answer costs nothing');
  rig.conductor.handleTutorTurn(`Hai. ${SAMPLE_WALK[1]}`);

  const first = await rig.conductor.answerStudent('futa desu');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].say, 'futari desu');
  assert.equal(asked[0].transcript, 'futa desu');
  assert.equal(first.say, 'Not quite. It\'s "futari", not "futa": "futari desu". Say it once more.');
  rig.conductor.handleTutorTurn('Not quite. I heard futa desu. It\'s futari desu. Say it once more.');
  assert.equal(rig.library.runtime.snapshot().script_current, 1, 'still on the same step');

  const second = await rig.conductor.answerStudent('futa desu');
  assert.equal(second.say, `It's "futari desu". Let's keep going. ${SAMPLE_WALK[2]}`, 'then the answer is given and the lesson goes on');
  rig.conductor.stop();
});

await test('a step asked again for a reply that is not an answer is asked twice, not forever', async () => {
  // A test student who said "Okay." was asked what "neko" meant eight times running.
  const rig = conductorRig({}, { directed: true });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  rig.conductor.openingTurn();
  rig.conductor.handleTutorTurn(SAMPLE_WALK[0]);
  const says = [];
  for (let i = 0; i < 3; i += 1) {
    const decided = await rig.conductor.answerStudent('Okay.');
    says.push(decided.say);
    rig.conductor.handleTutorTurn(decided.say);
  }
  assert.equal(says[0], says[1], 'asked again, plainly');
  assert.notEqual(says[2], says[1], 'and the third time they are given it');
  assert.match(says[2], /"sumimasen"/);
  rig.conductor.stop();
});

await test('asking to hear it again is never counted as a stall', async () => {
  // "Can you say that again?" a third time is a fair request, not a non-answer.
  const rig = conductorRig({}, { directed: true });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  rig.conductor.openingTurn();
  rig.conductor.handleTutorTurn(SAMPLE_WALK[0]);
  const says = [];
  for (let i = 0; i < 3; i += 1) {
    const decided = await rig.conductor.answerStudent('Can you say that again?');
    says.push(decided.say);
    rig.conductor.handleTutorTurn(decided.say);
  }
  assert.equal(says[2], says[0], 'the third time, it is said again too');
  assert.doesNotMatch(says[2], /^It's "sumimasen"/);
  rig.conductor.stop();
});

await test('the planner is shown every saved word the code treats as known', () => {
  // planPhase marks an item known if it is anywhere in the saved list; the
  // prompt showed only the newest 20 of it.
  const known = Array.from({ length: 30 }, (_, i) => `word${i} — meaning ${i}`);
  const skill = SKILLS.find((entry) => entry.id === 'vocabulary_builder');
  const prompt = buildPlanPrompt({ language: 'Japanese', level: 'Beginner', skill, phase: skill.phases[1], mode: 'teach', subject: 'colors', facts: [], taught: [], known });
  assert.ok(prompt.includes('word0 — meaning 0'), 'the oldest of thirty is there');
  assert.ok(prompt.includes('word29 — meaning 29'));
});

await test('a complaint that quotes the tutor is answered, not taken as "move on"', async () => {
  // 07-15-54 at 147.9: sent to script.skip because it quoted "something else".
  const told = 'That meant "What color would you like?" In Japanese, say: light blue, please — or something else that fits.';
  const complaint = 'You said or something else that fits and I gave you red. Why are you insisting that I say specifically light blue?';
  assert.equal(wantsToMoveOn(complaint, told), false);
  assert.equal(wantsToMoveOn('or something else that fits', told), false, 'what is quoted back is not a request');
  assert.equal(wantsToMoveOn("let's do something else"), true, 'said in their own words, it still is');
  assert.equal(wantsToMoveOn('can we move on'), true);
  // And in a lesson, it does not leave the part.
  const rig = conductorRig({}, { directed: true });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  rig.conductor.openingTurn();
  rig.conductor.handleTutorTurn(SAMPLE_WALK[0]);
  const phase = rig.library.runtime.phaseId;
  await rig.conductor.answerStudent(complaint);
  assert.equal(rig.library.runtime.phaseId, phase);
  assert.ok(!rig.logs.some((entry) => entry.type === 'script.skip'), 'no skip');
  rig.conductor.stop();
});

await test('"not supposed to tell me" is not giving up', () => {
  // 07-15-54 at 480.3: answered "It's "mizuiro". Say it."
  assert.equal(givesUp("No. You are not supposed to tell me what it is. You're supposed to give me a single English color and I tell you the Japanese name."), false);
  assert.equal(givesUp("don't tell me the answer"), false);
  assert.equal(givesUp('tell me'), true, 'asked plainly, it is');
  assert.equal(givesUp("I don't know"), true);
});

await test('a sentence about how to practise is not a subject for a lesson', () => {
  // 07-15-54 at 437.9: a lesson on "single word not sentences just a single word".
  assert.equal(topicRequest("No, no, no, no, no. This isn't teaching. I want a drill. I want you to give me an English word, single word, not sentences, just a single word color, and I'll tell you what the color is in Japanese", SKILLS), null);
  assert.equal(topicRequest('I want one word prompts', SKILLS), null);
  assert.equal(topicRequest('teach me single words', SKILLS), null);
  assert.equal(topicRequest('teach me some food words', SKILLS).topic, 'food', 'a real subject still is');
});

await test('a subject given in answer to the opening question starts the lesson on it', async () => {
  // 07-15-54 at 12.0: "About colors" started nothing.
  assert.equal(openingTopic('About colors', SKILLS).topic, 'colors');
  assert.equal(openingTopic('colors please', SKILLS).topic, 'colors');
  for (const text of ["I'm not sure", 'Hello!', 'How do I say thank you?', 'restaurants', 'Again.', 'Okay.']) {
    assert.equal(openingTopic(text, SKILLS), null, text);
  }
  const rig = conductorRig({}, { directed: true });
  rig.library.runtime.deactivate({ reason: 'test', silent: true });
  await rig.conductor.answerStudent('About colors');
  assert.equal(rig.library.runtime.skillId, 'vocabulary_builder');
  assert.equal(rig.library.runtime.inputValues.topic, 'colors');
  rig.conductor.stop();
  // Only as the first answer: later in the call, a bare word is an answer.
  const later = conductorRig({}, { directed: true });
  later.library.runtime.deactivate({ reason: 'test', silent: true });
  later.conductor.studentTurns = 3;
  await later.conductor.answerStudent('colors');
  assert.equal(later.library.isActive, false);
  later.conductor.stop();
});

await test('"the purple one" is not a number, and the answers marked wrong for it are right', () => {
  // 07-15-54 at 282.7 and 340.5: "Murasaki noはいらないです" went to the judge,
  // with the strictness of a number, and was marked wrong twice.
  assert.equal(isCount("I don't want the purple one"), false);
  assert.equal(isCount('two people'), true, 'a number in words still is one');
  assert.equal(isCount('1,200 yen'), true);
  const heardAs = (raw) => `${toDisplayText(raw, 'Japanese')} ${raw}`;
  const steps = (say, meaning, script) => [{ kind: 'recall', say, meaning, script }, { kind: 'recall', say: 'aoi', meaning: 'blue' }, { kind: 'wrap', items: [] }];
  for (const [say, meaning, script, raw] of [
    ['kiiro no wa iranai desu', "I don't want the yellow one", '黄色のはいらないです', '黄色のはいらないです'],
    ['murasaki no wa iranai desu', "I don't want the purple one", '紫のはいらないです', 'Murasaki noはいらないです'],
    ['murasaki no wa iranai desu', "I don't want the purple one", '紫のはいらないです', 'Murasakiのはいらないです'],
  ]) {
    const turn = turnFor(steps(say, meaning, script), { language: 'Japanese', current: 0, heard: heardAs(raw) });
    assert.equal(turn.reason, 'right', raw);
  }
});

await test('は after の, or after romaji, is read as the particle', () => {
  // "kiiro nohairanaidesu" was what the tutor's reading of 黄色のはいらないです was.
  assert.equal(toRomaji('黄色のはいらないです'), 'kiiro no wa iranaidesu');
  assert.equal(toRomaji('Murasaki noはいらないです'), 'Murasaki no wa iranaidesu');
  assert.equal(toRomaji('Murasakiのはいらないです'), 'Murasaki no wa iranaidesu');
  assert.equal(toRomaji('日本にはいます'), 'nihon ni wa imasu');
  assert.equal(toRomaji('こんにちは'), 'konnichiwa', 'inside a word, it is not a particle');
  assert.equal(toRomaji('これは青いです'), 'kore wa ao idesu');
});

await test('in a role-play, a word from their saved list fits, and a colour comes back as its noun', () => {
  // 07-15-54 at 123.2 and 135.9: "akai onegaishimasu" was refused twice, after
  // "or something else that fits", because red was known from memory.
  const scene = {
    kind: 'scene', tutor: 'naniiro ga yoroshii desu ka', meaning: 'What color would you like?', expect: 'mizuiro o onegaishimasu',
    cue: 'light blue, please', reply: 'kashikomarimashita', replyMeaning: 'certainly', single: true,
  };
  const lesson = [{ say: 'mizuiro', meaning: 'light blue' }, { say: 'mizuiro o onegaishimasu', meaning: 'light blue, please' }];
  const saved = vocabItems(['赤い (akai) — red', '青い (aoi) — blue']);
  const raw = '赤いお願いします。';
  const heard = `${toDisplayText(raw, 'Japanese')} ${raw}`;
  const turn = turnFor([scene, { kind: 'wrap', items: [] }], { language: 'Japanese', current: 0, heard, taught: [...lesson, ...saved] });
  assert.equal(turn.reason, 'right');
  assert.match(turn.line, /^"aka desu ne\. kashikomarimashita" — red, right\? Certainly\./, 'said back as the noun, without calling it wrong');
  assert.equal(orderWord('akai'), 'aka');
  assert.equal(orderWord('mizuiro'), 'mizuiro');
});

await test('the conductor grades with the saved words as well as the lesson\'s', async () => {
  const rig = conductorRig({}, { directed: true, getProfile: () => ({ ...profileFor('Japanese'), recent_vocab: ['赤い (akai) — red'] }) });
  assert.deepEqual(rig.conductor.savedItems(), [{ say: 'akai', script: '赤い', meaning: 'red' }]);
  // The role-play from the call, as the step being answered.
  await rig.conductor.ensurePlan('', { quiet: true });
  const runtime = rig.library.runtime;
  runtime.scripts[runtime.phaseId] = [
    { kind: 'scene', tutor: 'naniiro ga yoroshii desu ka', meaning: 'What color would you like?', expect: 'sumimasen', cue: 'excuse me', single: true },
    { kind: 'wrap', items: [] },
  ];
  runtime.cursors[runtime.phaseId] = 0;
  const decided = rig.conductor.decideTurn('akai onegaishimasu 赤いお願いします。', { dry: true });
  assert.equal(decided.turn.reason, 'right', 'red, from memory, is a fitting answer');
  rig.conductor.stop();
});

await test('a planner note is proofread, and one it will not vouch for is not said', async () => {
  // 07-15-54 at 241.6: "Irai means 'want'" (it is iru, iranai).
  const plan = {
    items: [
      { say: 'kiiro no wa iranai desu', meaning: "I don't want the yellow one", note: "Irai means 'want', iranai means 'do not want'.", reply: '', replyMeaning: '' },
      { say: 'murasaki', meaning: 'purple', note: '', reply: '', replyMeaning: '' },
    ],
    scene: { setup: '', lines: [] },
  };
  let shown = '';
  const doubted = await proofread({
    language: 'Japanese', level: 'Beginner', plan,
    ask: async (messages) => { shown = messages[0].content; return { wrong: [2] }; },
  });
  assert.match(shown, /2\. "Irai means 'want', iranai means 'do not want'\." — meant as: a true explanation/);
  assert.ok(doubted.notes.has(fold("Irai means 'want', iranai means 'do not want'.")));
  assert.equal(doubted.items.size, 0, 'the phrase itself stands');
});

await test('the drill lesson is a drill', () => {
  const skill = SKILLS.find((entry) => entry.id === 'word_drill');
  assert.equal(skill.type, 'drill');
  assert.deepEqual(skill.phases.map((phase) => phase.mode), ['drill']);
  assert.equal(skill.runtime_inputs[0].required, false, 'with no subject, the newest words are drilled');
});

/** The eleven basic colours, saved as the memory extractor saves them. */
const COLOURS = [
  ['赤い', 'akai', 'red'], ['青い', 'aoi', 'blue'], ['黄色', 'kiiro', 'yellow'], ['緑', 'midori', 'green'],
  ['黒', 'kuro', 'black'], ['白', 'shiro', 'white'], ['茶色', 'chairo', 'brown'], ['紫', 'murasaki', 'purple'],
  ['灰色', 'haiiro', 'gray'], ['オレンジ', 'orenji', 'orange'], ['ピンク', 'pinku', 'pink'],
].map(([script, say, meaning]) => `${script} (${say}) — ${meaning}`);
const VEG = ['ほうれん草 (hourensou) — spinach', 'キャベツ (kyabetsu) — cabbage'];
const COLOUR_WORDS = new Set(['red', 'blue', 'yellow', 'green', 'black', 'white', 'brown', 'purple', 'gray', 'orange', 'pink']);

/**
 * A call with words on file, and a planner that picks the colours from what
 * it is offered — never anything else.
 */
function drillRig(saved = [...VEG, ...COLOURS]) {
  const asked = [];
  const rig = conductorRig({}, { directed: true, getProfile: () => ({ ...profileFor('Japanese'), recent_vocab: saved }) });
  rig.library.runtime.deactivate({ reason: 'test', silent: true });
  rig.library.fetchPlan = async (phaseId, options = {}) => {
    asked.push({ phaseId, ...options, topic: rig.library.runtime.inputValues.topic || '' });
    if (rig.library.runtime.phaseMode(phaseId) !== 'drill') return { ok: true, plan: JSON.parse(JSON.stringify(SAMPLE_PLAN)), error: null };
    const items = (options.candidates || []).filter((item) => COLOUR_WORDS.has(item.meaning)).map((item) => ({ ...item, known: true }));
    return { ok: true, plan: { items, scene: { lines: [] }, drill: true }, error: null };
  };
  return { rig, asked };
}

/** Say something, and return everything the tutor is given to say back. */
async function hear(rig, text) {
  const before = rig.replies.length;
  const decided = await rig.conductor.answerStudent(text);
  const said = [];
  if (decided) {
    said.push(decided.say);
    rig.conductor.handleTutorTurn(decided.say);
  }
  await rig.conductor.idle();
  for (const reply of rig.replies.slice(before)) {
    said.push(reply.say);
    rig.conductor.handleTutorTurn(reply.say);
  }
  return said;
}

await test('asked for a drill on 14 Oct, each way it was asked starts one, and no teach line', async () => {
  for (const sentence of [
    'Drill me on the basic colors. Give me one word prompts for the basic colors in English, and I will give you the Japanese word',
    "No, no, no, no, no. This isn't teaching. I want a drill. I want you to give me an English word, single word, not sentences, just a single word color, and I'll tell you what the color is in Japanese",
    "No. You are not supposed to tell me what it is. You're supposed to give me a single English color and I tell you the Japanese name.",
  ]) {
    const { rig, asked } = drillRig();
    rig.conductor.lastTopic = 'colors';
    const said = await hear(rig, sentence);
    assert.equal(rig.library.runtime.skill?.id || rig.logs.find((entry) => entry.type === 'lesson.drill') && 'word_drill', 'word_drill', sentence);
    assert.equal(said[0], 'OK. One moment.');
    assert.match(said[1], /^Quick round\. What is (red|blue|yellow|green|black|white|brown|purple|gray|orange|pink)\?$/, sentence);
    assert.ok(!said.some((line) => /\bmeans\b|Say it\./.test(line)), 'nothing is taught');
    assert.ok(asked.length && asked[0].candidates.some((item) => item.say === 'akai' && item.script === '赤い'), 'the saved words are offered, as written');
    rig.conductor.stop();
  }
});

/** The romaji of each colour, by its English. */
const COLOUR_SAY = Object.fromEntries(COLOURS.map((entry) => { const [, , say, meaning] = /^(.+) \((.+)\) — (.+)$/.exec(entry); return [meaning, say]; }));

/**
 * Run a whole drill of the eleven colours, answering every one right except
 * the one `misses` picks (given the colour and how many have been asked),
 * which is answered "I don't remember." the first time it is asked.
 */
async function runDrill(misses) {
  const { rig } = drillRig();
  const said = await hear(rig, 'Drill me on the basic colors.');
  const asks = [said[1]];
  let missed = '';
  for (let i = 0; i < 20; i += 1) {
    const colour = /What is ([a-z]+)\?/.exec(asks[asks.length - 1])?.[1];
    if (!colour) break;
    const miss = !missed && misses(colour, asks.length);
    if (miss) missed = colour;
    // In romaji, but yellow in its written form, as a transcript has it. (A word
    // of one kanji is the judge's to read, and this rig has no judge.)
    const answer = miss ? "I don't remember." : colour === 'yellow' ? '黄色' : COLOUR_SAY[colour];
    asks.push((await hear(rig, answer))[0]);
  }
  rig.conductor.stop();
  return { asks, missed, colours: asks.map((line) => /What is ([a-z]+)\?/.exec(line)?.[1]).filter(Boolean) };
}

await test('a drill asks every word once, in English, before any comes round again', async () => {
  const { asks, missed, colours } = await runDrill((colour, asked) => asked === 1);
  assert.equal(new Set(colours.slice(0, 11)).size, 11, `every colour once first: ${colours.join(', ')}`);
  assert.deepEqual(colours.slice(11), [missed], 'the miss comes round once more, at the end');
  assert.ok(asks.slice(0, -1).every((line) => !/[ぁ-んァ-ン一-龯]|\b(akai|aoi|kiiro|midori|kuro|shiro|chairo|murasaki|orenji|pinku)\b.*\?/.test(line.replace(/^It's "[a-z']+"\. (Next: )?/, ''))), 'no Japanese in a question');
  assert.equal(asks[asks.length - 1], `Drill done: 10 of 11. For next time: "${COLOUR_SAY[missed]}" for ${missed}. Again, or something else?`);
});

await test('a miss on the last word of a drill is told and named, not asked straight back', async () => {
  // Asked again at once, just after being told, it would test only repeating.
  const { asks, missed, colours } = await runDrill((colour, asked) => asked === 11);
  assert.equal(colours.length, 11);
  assert.equal(asks[asks.length - 1], `It's "${COLOUR_SAY[missed]}". Drill done: 10 of 11. For next time: "${COLOUR_SAY[missed]}" for ${missed}. Again, or something else?`);
});

await test('"Keep drilling me." runs another round, not the next part of a lesson', async () => {
  // At 468.3 on 14 Oct it fell through to '"mizuiro" means light blue. Say it.'
  const { rig, asked } = drillRig();
  rig.library.activate('vocabulary_builder', { reason: 'ui' });
  rig.library.runtime.setInput('topic', 'colors', 'user');
  rig.library.advancePhase();
  await rig.conductor.ensurePlan('', { quiet: true });
  rig.conductor.openingTurn();
  const said = await hear(rig, 'Keep drilling me.');
  assert.equal(rig.library.runtime.phaseMode(), 'drill');
  assert.equal(asked[asked.length - 1].topic, 'colors', 'on the subject of the lesson it was in');
  assert.match(said[1], /^Quick round\. What is [a-z]+\?$/);
  rig.conductor.stop();
});

await test('after a drill, "again" runs it again, and nothing else does', async () => {
  const { rig } = drillRig();
  rig.conductor.drillDone = { topic: 'colors' };
  const said = await hear(rig, 'Again.');
  assert.match(said[1], /^Quick round\. What is [a-z]+\?$/);
  const other = drillRig();
  assert.equal(await other.rig.conductor.answerStudent('Again.'), null, 'with no drill just finished, "again" is not a drill');
  rig.conductor.stop();
  other.rig.conductor.stop();
});

await test('with too few words on file, the drill offers a lesson, and yes starts it', async () => {
  const { rig } = drillRig([...VEG, COLOURS[0]]);
  const said = await hear(rig, 'Drill me on the basic colors.');
  assert.deepEqual(said, ['OK. One moment.', "You don't have basic colors on file yet. Want to learn them first?"]);
  assert.equal(rig.library.isActive, false, 'no drill is left running');
  await hear(rig, 'Yes.');
  assert.equal(rig.library.runtime.skillId, 'vocabulary_builder');
  assert.equal(rig.library.runtime.inputValues.topic, 'basic colors');
  rig.conductor.stop();
});

await test('"don\'t drill me" is not a request for a drill', () => {
  assert.equal(drillRequest("Don't drill me"), null);
  assert.equal(drillRequest('no more drills'), null);
  assert.equal(drillRequest('I want to learn colors'), null);
  assert.deepEqual(drillRequest('Drill me on the basic colors. Give me one word prompts for the basic colors in English'), { topic: 'basic colors' });
  assert.deepEqual(drillRequest('Keep drilling me.'), { topic: '' });
  assert.deepEqual(drillRequest("I want to do a drill where you give me the English color and I tell you the Japanese name for that color"), { topic: '' });
});

await test('saved words are read as things to ask for', () => {
  assert.deepEqual(vocabItems(['赤い (akai) — red', 'der Bahnhof (train station)', 'numbers 1-20', '現金で — in cash']), [
    { say: 'akai', script: '赤い', meaning: 'red' },
    { say: 'der Bahnhof', script: '', meaning: 'train station' },
  ], 'a range of numbers has nothing to ask by, and kanji alone have no reading');
});

await test('the drill planner can only choose from what it is offered', async () => {
  const words = [{ say: 'akai', meaning: 'red' }, { say: 'aoi', meaning: 'blue' }, { say: 'kyabetsu', meaning: 'cabbage' }];
  const all = await planDrill({ subject: '', candidates: words });
  assert.deepEqual(all.plan.items.map((item) => item.say), ['akai', 'aoi', 'kyabetsu'], 'with no subject, the newest words');
  assert.ok(all.plan.items.every((item) => item.known));
  const prompt = buildDrillPrompt({ language: 'Japanese', subject: 'colors', words });
  assert.match(prompt, /1\. akai = red\n2\. aoi = blue\n3\. kyabetsu = cabbage/);
});

await test('with no judge, or a slow one, the lesson still answers', async () => {
  const rig = conductorRig({}, { directed: true, judgeMs: 20, judge: () => new Promise(() => {}) });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  rig.conductor.openingTurn();
  rig.conductor.handleTutorTurn(SAMPLE_WALK[0]);
  const decided = await rig.conductor.answerStudent('sumasen');
  assert.equal(decided.turn.mode, 'judge', 'the tutor chooses, between two written turns');
  assert.equal(decided.fresh, false, 'and for that it needs to have heard them');
  rig.conductor.stop();
});

await test('an answer to a turn the student has already talked over is dropped', async () => {
  let release;
  const rig = conductorRig({}, {
    directed: true,
    judge: () => new Promise((resolve) => { release = () => resolve({ ok: true, verdict: 'wrong', heard: 'x', other: '' }); }),
  });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  rig.conductor.openingTurn();
  rig.conductor.handleTutorTurn(SAMPLE_WALK[0]);
  const slow = rig.conductor.answerStudent('sumasen');
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  const quick = await rig.conductor.answerStudent('sumimasen');
  release();
  assert.equal(await slow, false, 'the earlier one is not answered as well');
  assert.ok(quick.say.endsWith(SAMPLE_WALK[1]), quick.say);
  rig.conductor.stop();
});

await test('asked to move on, the app goes to the part they asked for', async () => {
  // "like paying for things" took a student to "Larger numbers".
  const rig = conductorRig({}, { directed: true });
  rig.library.activate('numbers_time_money', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  rig.conductor.openingTurn();
  rig.replies.length = 0;
  const decided = await rig.conductor.answerStudent('I already know the numbers. Can we move on to something I will actually use, like paying for things?');
  assert.equal(rig.library.runtime.phaseId, 'money', 'the part called Paying');
  assert.match(decided.turn.line, /^OK\. One moment\.$/, 'which has to be written first, around what they asked for');
  await rig.conductor.idle();
  rig.conductor.stop();
  assert.equal(rig.replies.length, 1, 'and then the tutor starts it without being spoken to');
  assert.equal(rig.replies[0].say, `Next: paying. ${SAMPLE_WALK[0]}`);
  assert.equal(rig.replies[0].fresh, true);
  assert.equal(rig.replies[0].after, true, 'behind "OK. One moment.", not instead of it');
  assert.deepEqual(rig.library.runtime.revisit, ['larger_numbers', 'prices', 'time', 'dates'], 'and what was passed over is kept, to come back to');
});

await test('asked to move on with nothing named, it is the next part', async () => {
  const rig = conductorRig({}, { directed: true });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  rig.conductor.openingTurn();
  await rig.conductor.answerStudent('this is too easy, skip it');
  assert.equal(rig.library.runtime.phaseId, 'useful_vocabulary');
  await rig.conductor.idle();
  rig.conductor.stop();
});

await test('while a part is being written the student is told to wait, and then it starts', async () => {
  const rig = conductorRig({}, { directed: true });
  rig.library.activate('restaurant', { reason: 'ui' });
  let release;
  rig.library.fetchPlan = () => new Promise((resolve) => {
    release = () => resolve({ ok: true, plan: JSON.parse(JSON.stringify(SAMPLE_PLAN)), error: null });
  });
  const pending = rig.conductor.ensurePlan();
  const decided = await rig.conductor.answerStudent('hello?');
  assert.equal(decided.turn.line, 'One moment.');
  rig.transcript.push({ role: 'assistant', text: 'One moment.' });
  release();
  await pending;
  rig.conductor.stop();
  assert.equal(rig.replies.length, 1);
  assert.ok(rig.replies[0].say.endsWith(SAMPLE_WALK[0]), rig.replies[0].say);
});

await test('outside a script the tutor answers from its standing instructions', async () => {
  const rig = conductorRig({}, { directed: true });
  assert.equal(await rig.conductor.answerStudent('I want food words'), null, 'the topic is still being settled');
  rig.conductor.stop();
  const prompt = buildTutorPrompt(profileFor('Japanese'), rig.library.promptContext('Japanese'), { directed: true });
  assert.match(prompt, /# Teaching\n\nTeach a few things at a time/, 'which are the general ones');
});

await test('the standing instructions do not carry the script when the app is choosing the words', () => {
  const { runtime, skill } = runtimeOn('restaurant');
  runtime.setPlan('introduction', sanitizePlan(SAMPLE_PLAN));
  const text = buildActiveLessonSection(skill, runtime.snapshot(), { language: 'Japanese', directed: true });
  assert.match(text, /For this part you are given the words of each turn as you go\./);
  assert.ok(!text.includes('sumimasen'), 'two sets of instructions for one job is how neither gets followed');
});

await test('the judge is told what was asked, what counts, and to compare by sound', () => {
  const prompt = buildJudgePrompt({
    language: 'Japanese', kind: 'recall', say: 'menyuu o onegaishimasu', meaning: 'the menu, please',
    also: ['menyuu o kudasai'], asked: 'how to say "the menu, please" in Japanese', transcript: 'メニューをください',
    taught: [{ say: 'sumimasen', meaning: 'excuse me' }],
  });
  assert.match(prompt, /The answer wanted: "menyuu o onegaishimasu" \(the menu, please\)\. Just as right: "menyuu o kudasai"\./);
  assert.match(prompt, /Compare by sound, not by spelling or script/);
  assert.match(prompt, /It is wrong if a particle has been swapped for a different one/);
  assert.match(prompt, /- sumimasen = excuse me/);
  assert.match(prompt, /What was written down: "メニューをください"/);
});

await test('the session is told to wait for the app, and the app knows whether it is', async () => {
  const server = await readAll(['src/routes/realtime.js', 'src/config.js']);
  assert.match(server, /TUTOR_TURNS === 'app' \? \{ create_response: false \} : \{\}/);
  assert.match(server, /turns: TUTOR_TURNS/);
  assert.match(server, /env\('TUTOR_TURNS', 'app'\)/, 'on by default, and one setting to go back');

  const { session, sent } = fakeSession();
  /** @type {boolean[]} */
  const modes = [];
  session.callbacks.onTurnMode = (directed) => modes.push(directed);
  session.setTurnMode(true);
  // The server reports a session that is going to answer by itself after all.
  feed(session, 'session.updated', { session: { audio: { input: { turn_detection: { type: 'semantic_vad', create_response: true } } } } });
  assert.deepEqual(modes, [true, false], 'so the app stops asking as well');
  assert.equal(session.directed, false);
  assert.equal(sent.length, 0);
});

await test('when the app asks for the replies, hearing the student does not mean one is coming', async () => {
  /** @type {any[]} */
  const events = [];
  const session = new RealtimeSession({});
  session.active = true;
  session.dc = { readyState: 'open', send: (json) => events.push(JSON.parse(json)) };
  session.directed = true;
  /** @type {string[]} */
  const committed = [];
  session.callbacks.onStudentCommitted = ({ itemId }) => committed.push(itemId);

  feed(session, 'input_audio_buffer.speech_stopped');
  feed(session, 'input_audio_buffer.committed', { item_id: 'item_1' });
  assert.deepEqual(committed, ['item_1'], 'the app is told there is a turn to answer');
  assert.equal(session.responseActive, false, 'and its request will not queue behind a reply that is not coming');

  session.respond('Say exactly: Hai.', { fresh: true });
  await settle();
  const asks = events.filter((event) => event.type === 'response.create');
  assert.equal(asks.length, 1);
  assert.deepEqual(asks[0].response, { instructions: 'Say exactly: Hai.', input: [] }, 'with its own instructions and nothing else in view');

  feed(session, 'response.created');
  feed(session, 'response.done', { response: { status: 'completed' } });
  // A line to read is handed over as the only thing in view, and a second
  // reply can wait behind it.
  session.respond('Read it aloud.', { fresh: true, say: 'Hai. Say it.', examples: ['One.'] });
  session.respond('Then this.', { fresh: true, say: 'Next.', after: true });
  await settle();
  const reads = events.filter((event) => event.type === 'response.create');
  assert.equal(reads.length, 2, 'one at a time');
  assert.deepEqual(reads[1].response.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'One.' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'One.' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hai. Say it.' }] },
  ], 'a line shown as already read back, then the line to read');
  assert.deepEqual(reads[1].response.reasoning, { effort: 'minimal' }, 'reading needs no thinking about');
  feed(session, 'response.created');
  feed(session, 'response.done', { response: { status: 'completed' } });
  await settle();
  assert.equal(events.filter((event) => event.type === 'response.create')[2].response.input[0].content[0].text, 'Next.', 'the second goes when the first is done');

  feed(session, 'response.created');
  feed(session, 'response.done', { response: { status: 'completed' } });
  session.respond('');
  await settle();
  assert.deepEqual(events.filter((event) => event.type === 'response.create').pop(), { type: 'response.create' }, 'outside a lesson, a plain request');
  session.active = false;
});

await test('the page waits for the transcript, but not for long', async () => {
  const app = await readAll(['public/js/app.js']);
  // (What a turn is, and how long its transcript is waited for, is now
  // shared/turns.js: see "The third real call" below.)
  const turnsCode = await readAll(['public/shared/turns.js']);
  assert.match(turnsCode, /export const TRANSCRIPT_WAIT_MS = 1500;/);
  assert.match(app, /onStudentCommitted: \(\{ itemId \}\) => \{ if \(conductor\.directed\) studentTurns\.committed\(itemId\); \}/);
  assert.match(app, /if \(itemId\) studentTurns\.transcript\(itemId, text\);/);
  assert.match(app, /unheard: !text/, 'no transcript in time: the reply is asked for without it, and nothing is called wrong');
  assert.match(app, /if \(decided === false\) \{\s+if \(!text\) state\.session\?\.clearSilenceWatchdog\(\);\s+return;\s+\}/);
  assert.match(app, /opening: openingTurn\s+\? \{ instructions: openingTurn\.instructions, say: openingTurn\.say, examples: openingTurn\.examples \}/);
  assert.match(app, /if \(decided\) conductor\.speak\(decided\);/);
});

section('A lesson, not a flashcard machine');

// Round six: every line delivered word for word, replies in half a second,
// every correction true — and all three students said the same thing. "An
// accurate, fast flashcard machine." The role-play handed over the English of
// the answer, the waiter never reacted, the recap claimed a phrase the student
// had just been given, and what came back in the next part was the one they
// already knew.

/** A part with a role-play whose waiter says something back. */
const ORDER_PLAN = Object.freeze({
  items: [
    { say: 'biiru o kudasai', meaning: 'a beer, please' },
    { say: 'omizu o kudasai', meaning: 'water, please' },
  ],
  scene: {
    setup: "I'm the waiter and you are ready to order.",
    lines: [
      { tutor: 'onomimono wa', meaning: 'And to drink?', expect: 'biiru o kudasai', reply: 'kashikomarimashita', reply_meaning: 'Certainly' },
    ],
  },
});
const orderSteps = () => buildScript(sanitizePlan(ORDER_PLAN));
const sceneAt = (steps) => steps.findIndex((step) => step.kind === 'scene');

await test('in a role-play the student works out what to answer', () => {
  const steps = orderSteps();
  const at = sceneAt(steps);
  assert.equal(
    lineFor(steps[at], 'Japanese'),
    'Let\'s try it for real. I\'m the waiter and you are ready to order. "onomimono wa" — that means "And to drink?" What do you say?',
  );
});

await test('and the person they are talking to answers them', () => {
  const steps = orderSteps();
  const turn = turnFor(steps, { language: 'Japanese', current: sceneAt(steps), heard: 'biiru o kudasai' });
  // And says the order back first: it is how they know what they chose was heard.
  // And when the role-play ends there, what they asked for arrives.
  assert.match(turn.line, /^"kashikomarimashita" — certainly\. A little later: "omatase shimashita\. biiru desu" — thank you for waiting: a beer\. In Japanese you can now say/, 'not "Hai.": the waiter says what a waiter says');
});

await test('any reply that fits is a good reply', () => {
  // Asked for their order, a student who said water was told "Not quite… say:
  // a beer, please". One who said cash was told to say card. One who ordered
  // chicken was told to say eggplant.
  const steps = orderSteps();
  const at = sceneAt(steps);
  const water = turnFor(steps, { language: 'Japanese', current: at, heard: 'omizu o kudasai' });
  assert.equal(water.reason, 'right', 'another thing they know, of the same kind, is right without asking anyone');
  assert.match(water.line, /^"kashikomarimashita" — certainly\. A little later: "omatase shimashita\. omizu desu" — thank you for waiting: water\. /, 'and it is the water that arrives, not the beer');
  assert.equal(water.fit.say, 'omizu o kudasai');
  assert.ok(fitsScene({ kind: 'scene', expect: 'kaado de' }, 'genkin de onegaishimasu', [{ say: 'genkin de' }]));
  assert.ok(fitsScene({ kind: 'scene', expect: 'nasu o onegaishimasu' }, 'toriniku o onegaishimasu', [{ say: 'toriniku o onegaishimasu' }]));
  assert.equal(fitsScene({ kind: 'scene', expect: 'futari desu' }, 'sumimasen', [{ say: 'sumimasen' }]), null, '"excuse me" does not answer "how many people?"');
  // A word they know, in the asking they know: onion had been taught as a
  // bare word, and "tamanegi o onegaishimasu" was refused.
  const onion = fitsScene({ kind: 'scene', expect: 'gyuuniku o onegaishimasu' }, 'tamanegi o onegaishimasu', [{ say: 'tamanegi', meaning: 'onion' }]);
  assert.deepEqual(onion, { say: 'tamanegi o onegaishimasu', meaning: 'onion, please', thing: 'onion' }, 'in the words it was said in');
  // And where the plan's own answer was a bare word, a whole request is still a request.
  assert.equal(fitsScene({ kind: 'scene', expect: 'gyuuniku' }, 'kyabetsu o onegaishimasu', [{ say: 'kyabetsu', meaning: 'cabbage' }]).thing, 'cabbage');

  // What the app cannot place is for a judge, who is told it is a conversation.
  const unsure = turnFor(steps, { language: 'Japanese', current: at, heard: 'ocha ga ii desu' });
  assert.equal(unsure.mode, 'judge');
  assert.equal(unsure.line, 'onomimono wa');
  assert.equal(unsure.lineMeaning, 'And to drink?');
  assert.equal(unsure.asked, 'to reply, in a role-play, to "onomimono wa" (And to drink)', 'not "to answer with a beer": nothing was asked for by name');
  const natural = turnFor(steps, { language: 'Japanese', current: at, heard: 'iie, daijoubu desu', verdict: { verdict: 'alternative', heard: 'iie, daijoubu desu' } });
  assert.equal(natural.reason, 'right', 'the short reply people really give is simply right');

  const prompt = buildJudgePrompt({
    language: 'Japanese', kind: 'scene', say: 'biiru o kudasai', meaning: 'a beer, please', also: [],
    asked: unsure.asked, transcript: 'ocha ga ii desu', taught: [], line: 'onomimono wa', lineMeaning: 'And to drink?',
  });
  assert.match(prompt, /THIS IS A ROLE-PLAY, AND THAT CHANGES THE QUESTION\. The tutor, in character, had just said to them: "onomimono wa" \(And to drink\?\)/);
  assert.match(prompt, /is what they said correct Japanese that makes sense as a reply to that line\? If it is, the verdict is "right"/);
  assert.match(prompt, /A taught phrase that DOES answer it is "right", never "other"/);
});

await test('the first help in a role-play is what to answer, and only then the words', () => {
  const steps = orderSteps();
  const at = sceneAt(steps);
  // (Saying so when something else they know would do as well.)
  const hint = 'That meant "And to drink?" In Japanese, say: a beer, please — or something else that fits.';
  const stuck = turnFor(steps, { language: 'Japanese', current: at, heard: 'um, what am I supposed to say?' });
  assert.deepEqual({ line: stuck.line, advances: stuck.advances }, { line: hint, advances: false });
  // A reply that does not fit gets the same help — not "Not quite", and not a
  // lecture on which word is which. ("tamanegi is onion. Beef is gyuuniku.")
  const taught = [{ say: 'sumimasen', meaning: 'excuse me' }];
  const off = turnFor(steps, { language: 'Japanese', current: at, taught, heard: 'sumimasen', verdict: { verdict: 'other', heard: 'sumimasen', other: 'sumimasen' } });
  assert.equal(off.line, hint);
  // Still stuck: the words, and a chance to say them — so the scene is
  // finished, not abandoned. ("It's futari desu. In Japanese you can now say…")
  const given = turnFor(steps, { language: 'Japanese', current: at, tries: 1, heard: 'eeto', verdict: { verdict: 'unclear', heard: '' } });
  assert.deepEqual({ line: given.line, advances: given.advances }, { line: 'It\'s "biiru o kudasai". Say it.', advances: false });
  const said = turnFor(steps, { language: 'Japanese', current: at, tries: 2, heard: 'biiru o kudasai' });
  assert.match(said.line, /^"kashikomarimashita" — certainly\. A little later: "omatase shimashita\. biiru desu" — thank you for waiting: a beer\. /, 'and the waiter answers');
  const never = turnFor(steps, { language: 'Japanese', current: at, tries: 2, heard: 'eeto', verdict: { verdict: 'unclear', heard: '' } });
  assert.equal(never.advances, true, 'three goes, and the lesson moves on');
});

await test('a judge that writes down a near miss and calls it right is overruled', () => {
  // "gyuuni" — verdict right, heard "gyuuni" — "Hai."
  assert.equal(nearMiss('gyuuni', 'gyuuniku'), true);
  assert.equal(nearMiss('hourenso', 'hourensou'), false, 'a long vowel written short is the same sound');
  assert.equal(nearMiss('kaado de ii desu ka', 'kaado de'), false, 'a different, longer sentence is not a slip');
  const steps = buildScript(sanitizePlan({ items: [{ say: 'gyuuniku', meaning: 'beef' }, { say: 'tamanegi', meaning: 'onion' }] }));
  const turn = turnFor(steps, { language: 'Japanese', current: 0, heard: 'gyuuni', verdict: { verdict: 'right', heard: 'gyuuni' } });
  assert.equal(turn.reason, 'wrong');
  assert.match(turn.line, /^Not quite\. You left off "ku": "gyuuniku"\./);
});

await test('the closing line says what they can say and what is still to get', async () => {
  // "You can now say two people" — one turn after "It's futari desu. Say it."
  const rig = conductorRig({}, { directed: true });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  const runtime = rig.library.runtime;
  const say = async (student, tutor) => {
    const decided = await rig.conductor.answerStudent(student);
    rig.conductor.handleTutorTurn(tutor || decided.say);
    return decided;
  };
  const opening = rig.conductor.openingTurn();
  rig.conductor.handleTutorTurn(opening.say);
  await say('sumimasen');                 // repeats the first
  await say('futari desu');               // repeats the second
  await say('sumimasen');                 // recalls the first
  await say('menyuu o onegaishimasu');    // repeats the third
  await say('two people');                // knows what the second means
  await say('I do not remember');         // cannot recall the third...
  await say('menyuu o onegaishimasu');    // ...says it once it has been given
  const last = await say('futari desu');  // and answers the waiter
  rig.conductor.stop();
  assert.match(last.say, /In Japanese you can now say: "excuse me" and "two people"\./);
  assert.match(last.say, /Still to get: "menyuu o onegaishimasu" for the menu, please\. We'll come back to that\. Ready for the next part\?$/);
  assert.ok(runtime.fumbled.has('menyuu o onegaishimasu'));
});

await test('what comes back in the next part is what they missed', () => {
  // Part two brought back "excuse me", which the student had got right twice,
  // and never "two people", which they had failed four times.
  const { runtime } = runtimeOn('restaurant');
  runtime.taught = [
    { say: 'sumimasen', meaning: 'excuse me' },
    { say: 'futari desu', meaning: 'two people' },
    { say: 'menyuu o onegaishimasu', meaning: 'the menu, please' },
  ];
  runtime.setPhase('useful_vocabulary');
  runtime.setPlan('useful_vocabulary', sanitizePlan(ORDER_PLAN));
  runtime.noteFumble({ kind: 'recall', say: 'futari desu' });
  runtime.applyCarry();
  const carried = runtime.currentScript().find((step) => step.carried);
  assert.equal(carried.say, 'futari desu');
  assert.equal(lineFor(carried, 'Japanese'), 'How do you say "two people"?');
});

await test('what they said they already know is not brought back to be asked again', async () => {
  // "I already know the numbers" — and two turns later, in Paying: "How do you say 47?"
  const rig = conductorRig({}, { directed: true });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  const opening = rig.conductor.openingTurn();
  rig.conductor.handleTutorTurn(opening.say);
  const next = await rig.conductor.answerStudent('sumimasen');
  rig.conductor.handleTutorTurn(next.say);
  assert.ok(rig.library.runtime.taught.some((item) => item.say === 'sumimasen'));
  await rig.conductor.answerStudent('I already know these, can we move on');
  await rig.conductor.idle();
  rig.conductor.stop();
  assert.ok(!rig.library.runtime.taught.some((item) => item.say === 'sumimasen'));
});

await test('saying back the phrase the tutor just gave is not a wrong answer', async () => {
  // "How do I ask for the check?" — "Okaikei onegaishimasu." — the student
  // says it — "Not quite. It's reshiito o onegaishimasu."
  const rig = conductorRig({}, { directed: true });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  const opening = rig.conductor.openingTurn();
  rig.conductor.handleTutorTurn(opening.say);

  const asked = await rig.conductor.answerStudent('hang on, how do I ask for the check?');
  assert.equal(asked.turn.mode, 'question');
  rig.conductor.handleTutorTurn('You\'d say "okaikei onegaishimasu". It means the check, please.');
  rig.conductor.handleTutorTurn(asked.then.say);

  const echo = await rig.conductor.answerStudent('okaikei onegaishimasu');
  assert.equal(echo.turn.reason, 'echo');
  assert.equal(echo.say, 'Hai. "sumimasen" means excuse me. Say it.');
  rig.conductor.handleTutorTurn(echo.say);
  assert.equal(rig.library.runtime.snapshot().script_misses, 0, 'and it does not use up their one retry');
  rig.conductor.stop();
});

await test('a student on file as knowing something is not taught it again', async () => {
  const code = await readAll(['src/planner.js']);
  assert.match(code, /item\.known = onFile \|\| coveredNumber;/, 'whether or not the planner noticed');
  assert.match(code, /plan\.items\.every\(\(item\) => item\.known\)\) \{\s+plan\.items = plan\.items\.slice\(0, 2\);\s+plan\.scene\.lines = \[\];/, 'and a part of nothing new is a quick check of two');
  assert.match(code, /\\bosusume wa\\b/, 'a waiter is not given the customer\'s question to ask');
});

await test('what a proofreader will not vouch for is not taught and not said', async () => {
  // "go-rann", "menii", "nanika goyoi desu ka": written fluently, and not Japanese.
  const plan = sanitizePlan({
    items: [{ say: 'biiru o kudasai', meaning: 'a beer, please' }, { say: 'omizu o kudasai', meaning: 'water, please' }],
    scene: {
      setup: "I'm the waiter.",
      lines: [
        { tutor: 'onomimono wa', meaning: 'and to drink?', expect: 'biiru o kudasai', reply: 'kashikomarimashita', reply_meaning: 'certainly' },
        { tutor: 'nanika goyoi desu ka', meaning: 'anything else?', expect: 'omizu o kudasai', reply: 'kashikomarimasu', reply_meaning: 'certainly' },
      ],
    },
  });
  /** @type {any[]} */
  let seen = [];
  const doubted = await proofread({
    language: 'Japanese', level: 'Beginner', plan,
    ask: async (messages) => { seen = messages; return { wrong: [5, 6] }; },
  });
  assert.match(seen[0].content, /5\. "nanika goyoi desu ka" — meant as: anything else\? — said by the other person in the scene/);
  assert.deepEqual([...doubted.lines], ['nanika goyoi desu ka']);
  assert.deepEqual([...doubted.replies], ['kashikomarimasu']);
  assert.equal(doubted.items.size, 0);
  const failed = await proofread({ language: 'Japanese', level: 'Beginner', plan, ask: async () => { throw new Error('down'); } });
  assert.equal(failed.lines.size + failed.items.size + failed.replies.size, 0, 'a check that cannot run removes nothing');
});

await test('said in its moment, a phrase gets an answer', () => {
  // All three students of round seven asked for the same thing: make the
  // exchange the spine of a part, not its tail.
  const steps = buildScript(sanitizePlan({
    items: [
      { say: 'sumimasen', meaning: 'excuse me', use: 'You want the waiter to come over.', reply: 'hai, shoushou omachi kudasai', reply_meaning: 'Yes, one moment please' },
      { say: 'futari desu', meaning: 'two people' },
    ],
  }));
  const recall = steps.findIndex((step) => step.kind === 'recall' && step.say === 'sumimasen');
  const turn = turnFor(steps, { language: 'Japanese', current: recall, heard: 'sumimasen' });
  assert.match(turn.line, /^"hai, shoushou omachi kudasai" — yes, one moment please\. /, 'what the waiter says back, not "Hai."');
  const plain = steps.findIndex((step) => step.kind === 'recall' && step.say === 'futari desu');
  assert.match(turnFor(steps, { language: 'Japanese', current: plain, heard: 'futari desu' }).line, /^Hai\. /, 'asked from the English, it is the one word');
});

await test('a meaning given in other English words is the meaning', () => {
  // "What does genkin de mean?" — "um, paying with cash" — and no "Hai."
  const turn = nextTurn({ current: 4, heard: 'um, a table for two', verdict: { verdict: 'alternative', heard: 'a table for two' } });
  assert.equal(turn.reason, 'right');
  assert.match(turn.line, /^Hai\. /);
});

await test('"I don\'t know how to say thank you" is a question, not a surrender', () => {
  const turn = nextTurn({ current: 2, heard: "um, thank you? I don't know how to say thank you" });
  assert.equal(turn.mode, 'question');
});

await test('what is brought back is the worst miss; never what they knew, never twice', () => {
  const { runtime } = runtimeOn('restaurant');
  runtime.taught = [
    { say: 'yonjuu nana', meaning: '47', known: true },
    { say: 'futari desu', meaning: 'two people' },
    { say: 'menyuu o onegaishimasu', meaning: 'the menu, please' },
    { say: 'sumimasen', meaning: 'excuse me' },
  ];
  const plan = sanitizePlan({
    items: [
      { say: 'biiru o kudasai', meaning: 'a beer, please' },
      { say: 'omizu o kudasai', meaning: 'water, please' },
      { say: 'kore o kudasai', meaning: 'this one, please' },
    ],
  });
  runtime.setPhase('useful_vocabulary');
  runtime.setPlan('useful_vocabulary', plan);
  assert.equal(runtime.currentScript().filter((step) => step.carried).length, 2, 'two places for something from earlier');
  for (let i = 0; i < 3; i += 1) runtime.noteFumble({ kind: 'recall', say: 'futari desu' });
  runtime.noteFumble({ kind: 'recall', say: 'menyuu o onegaishimasu' });
  runtime.applyCarry();
  assert.deepEqual(
    runtime.currentScript().filter((step) => step.carried).map((step) => step.say),
    ['futari desu', 'menyuu o onegaishimasu'],
    'the one missed three times first, though the other was missed more recently',
  );

  // With nothing missed: one thing that has not been back yet, and then nothing.
  const fresh = runtimeOn('restaurant').runtime;
  fresh.taught = [{ say: 'yonjuu nana', meaning: '47', known: true }, { say: 'sumimasen', meaning: 'excuse me' }];
  fresh.setPhase('useful_vocabulary');
  fresh.setPlan('useful_vocabulary', plan);
  fresh.applyCarry();
  assert.deepEqual(fresh.currentScript().filter((step) => step.carried).map((step) => step.say), ['sumimasen'], 'never the number they knew before the call');
  fresh.setPhase('guided_ordering');
  fresh.setPlan('guided_ordering', sanitizePlan({ items: [{ say: 'osusume wa nan desu ka', meaning: 'what do you recommend' }, { say: 'hai, ijou desu', meaning: 'yes, that is all' }] }));
  fresh.applyCarry();
  assert.equal(fresh.currentScript().filter((step) => step.carried).length, 0, 'and not the same thing a second time');
});

await test('a remark is not an attempt, and is not corrected', () => {
  // "Oh good, that's exactly the one I'll need in Tokyo." — "Not quite. I
  // heard 'Oh good, that's exactly the one I'll need in Tokyo'. It's…"
  const remark = "Oh good, that's exactly the one I'll need in Tokyo";
  const turn = nextTurn({ current: 0, heard: remark, verdict: { verdict: 'aside', heard: remark } });
  assert.deepEqual(
    { line: turn.line, advances: turn.advances, reason: turn.reason },
    { line: 'OK. "sumimasen" means excuse me. Say it.', advances: false, reason: 'echo' },
  );
  assert.equal(correctionFor(remark, 'kaado wa tsukaemasu ka'), 'Once more: "kaado wa tsukaemasu ka".', 'and is never read back as what was "heard"');
});

await test('a part asked for by name is gone to, however it is asked', async () => {
  // "Actually, can we go straight to paying for things in a shop?" —
  // "You'd say, 'May I pay, please?'"
  assert.equal(wantsToMoveOn('Actually, can we go straight to paying for things in a shop?'), true);
  assert.equal(asksForPart('could we do the paying part now'), true);
  const rig = conductorRig({}, { directed: true });
  rig.library.activate('numbers_time_money', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  rig.conductor.openingTurn();
  await rig.conductor.answerStudent("I'd like to do paying now, please");
  assert.equal(rig.library.runtime.phaseId, 'money');
  await rig.conductor.idle();
  rig.conductor.stop();
});

await test('progress does not fall when the lesson goes back for a part it passed over', () => {
  const { runtime } = runtimeOn('numbers_time_money');
  runtime.setPlan('numbers', sanitizePlan(SAMPLE_PLAN));
  runtime.finishedParts.numbers = true;
  runtime.setPhase('money');
  runtime.setPlan('money', sanitizePlan(SAMPLE_PLAN));
  runtime.finishedParts.money = true;
  const after = runtime.progress();
  runtime.setPhase('larger_numbers');
  runtime.setPlan('larger_numbers', sanitizePlan(SAMPLE_PLAN));
  assert.ok(runtime.progress() >= after, `${runtime.progress()} after ${after}`);
});

section('The exchange is the lesson');

// Round nine: three students, seventy turns, every line word for word, every
// correction true. "The first one that listens." And still: "a well-mannered
// drill". Every sentence was handed over whole before it was asked for; the
// waiter asked "and to drink?" straight after an order for water; every reply
// came with its English every time; and the role-play was one line, the same
// one in every part.

/** A part that follows one in which a request has been taught. */
const DRINKS_PLAN = Object.freeze({
  items: [
    { say: 'biiru o kudasai', meaning: 'a beer, please', use: 'You want to order a beer.', reply: 'kashikomarimashita', reply_meaning: 'certainly', note: 'O kudasai is how you ask for something.' },
    { say: 'omizu o kudasai', meaning: 'water, please', use: 'You want some water.', reply: 'kashikomarimashita', reply_meaning: 'certainly' },
    { say: 'kore o kudasai', meaning: 'this one, please', note: "Kore means 'this one' when pointing." },
  ],
  scene: {
    setup: "I'm the waiter and you are ready to order.",
    lines: [
      { tutor: 'onomimono wa', meaning: 'something to drink?', expect: 'biiru o kudasai', reply: 'kashikomarimashita', reply_meaning: 'certainly' },
      { tutor: 'gochuumon wa', meaning: 'your order?', expect: 'omizu o kudasai', reply: 'kashikomarimashita', reply_meaning: 'certainly' },
    ],
  },
});
const drinkSteps = () => buildScript(sanitizePlan(DRINKS_PLAN));

await test('a request is taught whole once, and after that they make it themselves', () => {
  assert.deepEqual(requestParts('omizu o kudasai'), { word: 'omizu', frame: 'kudasai' });
  assert.equal(requestParts('kaado de onegaishimasu'), null, '"by card" is not a thing asked for');
  assert.equal(requestParts('omizu o futatsu kudasai'), null, 'nor is a request with a number in it built this way');
  assert.equal(requestThing('a beer, please'), 'a beer');
  const steps = drinkSteps();
  const teach = steps.filter((step) => step.kind === 'teach');
  assert.deepEqual(teach.map((step) => Boolean(step.build)), [false, true, true], 'the first whole; the rest from the word');
  assert.equal(lineFor(teach[0], 'Japanese'), '"biiru o kudasai" means a beer, please. Say it.');
  assert.equal(lineFor(teach[1], 'Japanese'), '"omizu" means water. Ask for water, the way you asked for a beer.');
  assert.equal(lineFor(teach[2], 'Japanese'), '"kore" means this one. Ask for this one.', 'a note that only says what the word is has just been said');
  // Made right, it is answered as a request is; and it counts as theirs.
  const at = steps.indexOf(teach[1]);
  const right = turnFor(steps, { language: 'Japanese', current: at, heard: 'omizu o kudasai' });
  assert.match(right.line, /^"omizu desu ne\. kashikomarimashita" — water, right\? Certainly\. /, 'said back, so that each reply is about what they said');
  // The word alone is the word alone — and the help is the request they have
  // already made, not this one handed over whole.
  const word = turnFor(steps, { language: 'Japanese', current: at, heard: 'um, omizu' });
  assert.deepEqual(
    { line: word.line, advances: word.advances },
    { line: 'That\'s the word. A beer, please was "biiru o kudasai". So how do you ask for water?', advances: false },
  );
  assert.match(turnFor(steps, { language: 'Japanese', current: at, tries: 1, heard: 'omizu' }).line, /^It's "omizu o kudasai"\. /, 'and then it is given');
  // And it comes back as its word: that is the new thing in it.
  const back = steps.find((step) => step.kind === 'recognise');
  assert.equal(lineFor(back, 'Japanese'), 'What does "omizu" mean?');
  assert.ok(!taughtSoFar(steps, steps.length).some((item) => item.say === 'omizu'), 'without being counted as a second thing taught');
  // A request made in an earlier part is one to build on as well.
  const later = buildScript(sanitizePlan({ items: [{ say: 'butaniku o onegaishimasu', meaning: 'pork, please', note: 'Buta is pig, niku is meat.' }, { say: 'nasu o onegaishimasu', meaning: 'eggplant, please' }] }), {
    taught: [{ say: 'gyuuniku o onegaishimasu', meaning: 'beef, please' }],
  });
  assert.equal(lineFor(later.find((step) => step.kind === 'teach'), 'Japanese'), '"butaniku" means pork: buta is pig, niku is meat. Ask for pork, the way you asked for beef.');
});

await test('the waiter says back what was actually ordered', () => {
  // "omizu o kudasai" — "kashikomarimashita. onomimono wa — and to drink?"
  const steps = drinkSteps();
  const at = sceneAt(steps);
  const water = turnFor(steps, { language: 'Japanese', current: at, heard: 'omizu o kudasai' });
  assert.match(water.line, /^"omizu desu ne\. kashikomarimashita" — water, right\? Certainly\. "gochuumon wa"/);
  // A judge may pass a reply that is not the planned one. What that was is
  // not known, so nothing is said back as if it were.
  const other = turnFor(steps, { language: 'Japanese', current: at, heard: 'ocha ga ii desu', verdict: { verdict: 'right', heard: 'ocha ga ii desu' } });
  assert.match(other.line, /^"kashikomarimashita" — certainly\. /);
});

await test('a later line does not ask for what they have just said', async () => {
  const rig = conductorRig({}, { directed: true });
  rig.library.activate('restaurant', { reason: 'ui' });
  rig.library.fetchPlan = async () => ({ ok: true, plan: JSON.parse(JSON.stringify(DRINKS_PLAN)), error: null });
  await rig.conductor.ensurePlan('', { quiet: true });
  const runtime = rig.library.runtime;
  const steps = runtime.currentScript();
  const at = sceneAt(steps);
  runtime.cursors[runtime.phaseId] = at;
  rig.conductor.pending = null;
  const decided = await rig.conductor.answerStudent('omizu o kudasai');
  rig.conductor.stop();
  assert.match(decided.say, /^"omizu desu ne/);
  assert.equal(steps[at + 1].expect, 'biiru o kudasai', 'the next line now wants the one they did not say');
  assert.ok(runtime.got.has('omizu o kudasai'), 'and the credit is for what they said');
});

await test('what is said back is translated twice, and then it is theirs', () => {
  const steps = drinkSteps();
  const recall = steps.findIndex((step) => step.kind === 'recall' && step.say === 'biiru o kudasai');
  const replies = new Map();
  const first = turnFor(steps, { language: 'Japanese', current: recall, heard: 'biiru o kudasai', replies });
  assert.match(first.line, /^"biiru desu ne\. kashikomarimashita" — a beer, right\? Certainly\. /);
  assert.equal(first.reply, 'kashikomarimashita', 'the turn says which reply it used, so that it can be counted');
  replies.set('kashikomarimashita', 2);
  // "kashikomarimashita" nine times in twenty-four turns had become the new "Hai."
  assert.match(turnFor(steps, { language: 'Japanese', current: recall, heard: 'biiru o kudasai', replies }).line, /^"biiru desu ne" — a beer, right\? (?!"kashiko)/, 'the third time, the order said back is the whole of it');
  const at = sceneAt(steps);
  assert.match(turnFor(steps, { language: 'Japanese', current: at, heard: 'biiru o kudasai', replies }).line, /^"biiru desu ne" — a beer, right\? "kashikomarimashita"\. /, 'in a role-play the reply is still said, without its English');
  const plain = buildScript(sanitizePlan({ items: [
    { say: 'sumimasen', meaning: 'excuse me', use: 'You want the waiter to come over.', reply: 'hai, shoushou omachi kudasai', reply_meaning: 'yes, one moment please' },
    { say: 'futari desu', meaning: 'two people' },
  ] }));
  const call = plain.findIndex((step) => step.kind === 'recall' && step.say === 'sumimasen');
  assert.match(turnFor(plain, { language: 'Japanese', current: call, heard: 'sumimasen', replies: new Map([['hai shoushou omachi kudasai', 2]]) }).line, /^"hai, shoushou omachi kudasai"\. /);
});

await test('a price said to them is asked about, not translated', () => {
  // "Asking what something costs and understanding the answer" — and every
  // price they heard came with its English attached.
  const steps = buildScript(sanitizePlan({
    items: [
      { say: 'kore wa ikura desu ka', meaning: 'how much is this', use: 'You want to know the price of something.', reply: 'sen nihyaku en desu', reply_meaning: 'it is 1,200 yen' },
      { say: 'kore o kudasai', meaning: "I'll take this" },
    ],
  }));
  const ask = steps.findIndex((step) => step.kind === 'recall' && step.check);
  assert.ok(ask > 0);
  const listen = steps[ask + 1];
  assert.deepEqual({ kind: listen.kind, listen: listen.listen, meaning: listen.meaning }, { kind: 'recognise', listen: true, meaning: '1,200 yen' });
  const turn = turnFor(steps, { language: 'Japanese', current: ask, heard: 'kore wa ikura desu ka' });
  assert.equal(turn.line, '"sen nihyaku en desu". How much is that?', 'the price is the reply, and the question');
  assert.equal(answersStep(listen, 'um, 1200 yen?'), true);
  assert.equal(answersStep(listen, '1,200'), true, 'the number is what there was to catch');
  assert.equal(answersStep(listen, '2000 yen'), false);
  // Not caught, it is said once more before it is told.
  const missed = turnFor(steps, { language: 'Japanese', current: ask + 1, heard: '2000 yen', verdict: { verdict: 'wrong', heard: '2000 yen' } });
  assert.deepEqual({ line: missed.line, advances: missed.advances }, { line: 'Not quite. Listen again: "sen nihyaku en desu". How much is that?', advances: false });
  const again = turnFor(steps, { language: 'Japanese', current: ask + 1, tries: 1, heard: '2000 yen', verdict: { verdict: 'wrong', heard: '2000 yen' } });
  assert.match(again.line, /^Not quite\. "sen nihyaku en desu" means 1,200 yen\. /);
  assert.equal(again.advances, true);
  assert.equal(lineFor({ kind: 'recognise', listen: true, say: 'sanji han desu', meaning: '3:30' }, 'Japanese'), '"sanji han desu". What time is that?');
});

await test('part of a note that has been said is not said again', () => {
  // "Gyuu is cow, niku is meat." "Buta is pig, niku is meat." "Tori is bird, niku is meat."
  const steps = buildScript(sanitizePlan({
    items: [
      { say: 'gyuuniku', meaning: 'beef', note: 'Gyuu is cow, niku is meat.' },
      { say: 'butaniku', meaning: 'pork', note: 'Buta is pig, niku is meat.' },
    ],
  }));
  assert.deepEqual(steps.filter((step) => step.kind === 'teach').map((step) => step.note), ['Gyuu is cow, niku is meat', 'Buta is pig']);
  const { runtime } = runtimeOn('vocabulary_builder');
  runtime.setPlan('first_pass', sanitizePlan({ items: [{ say: 'gyuuniku', meaning: 'beef', note: 'Gyuu is cow, niku is meat.' }, { say: 'tamanegi', meaning: 'onion' }] }));
  runtime.setPlan('recall', sanitizePlan({ items: [{ say: 'toriniku', meaning: 'chicken', note: 'Tori is bird, niku is meat.' }, { say: 'nasu', meaning: 'eggplant' }] }));
  assert.equal(runtime.scripts.recall.find((step) => step.kind === 'teach').note, 'Tori is bird', 'nor in a later part');
});

await test('a remark with "again" in it is not a question', () => {
  // "Ah, niku again, that makes sense." — "It's butaniku o onegaishimasu, which means pork, please."
  assert.equal(looksLikeQuestion('Ah, niku again, that makes sense.'), false);
  assert.equal(looksLikeQuestion('wait, I know this one'), false);
  assert.equal(looksLikeQuestion('Again?'), true);
  assert.equal(looksLikeQuestion('sorry?'), true);
  assert.equal(looksLikeQuestion('can you say that again'), true);
  assert.equal(looksLikeQuestion('one more time please'), true);
});

await test('a line cut short is finished, not started again', async () => {
  // The closing line stopped five words early, was asked for again, and was
  // said again from the top.
  const line = '"kashikomarimashita" — certainly. In Japanese you can now say: "by card" and "in cash". Ready for the next part?';
  assert.equal(remainderOf('kashikomarimashita — certainly. In Japanese you can now say: by card and in cash.', line), 'Ready for the next part?');
  assert.equal(remainderOf('futari desu', '"futari desu" means two people. Say it.'), '', 'a scrap is not a beginning: the line is said whole');
  assert.equal(remainderOf('Something else altogether was said here.', line), '');
  assert.equal(saysPhrases('kaardo de means by card. Say it.', '"kaado de" means by card. Say it.'), false, 'a phrase said wrongly is not the line');
  assert.equal(saysPhrases('kaado de means by card. Say it.', '"kaado de" means by card. Say it.'), true);

  const rig = conductorRig({}, { directed: true });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  const opening = rig.conductor.openingTurn();
  rig.conductor.handleTutorTurn(opening.say);
  const decided = await rig.conductor.answerStudent('sumimasen');
  assert.equal(decided.say, 'To call the waiter. Next: "futari desu" means two people. Say it.');
  rig.replies.length = 0;
  rig.conductor.handleTutorTurn('To call the waiter. Next: futari desu means');
  assert.equal(rig.replies.length, 1);
  assert.equal(rig.replies[0].say, 'two people. Say it.', 'only the rest is asked for');
  rig.conductor.handleTutorTurn('two people. Say it.');
  assert.equal(rig.library.runtime.snapshot().script_current, 1, 'and the two halves together are the line');
  rig.conductor.stop();
});

await test('which part they asked for is read, not matched by its first four letters', async () => {
  // "Can we try that one more time?" went to the part called Time; "can we do
  // the shop stuff instead?" went nowhere.
  /** @type {any[]} */
  const asked = [];
  const rig = conductorRig({}, {
    directed: true,
    judge: async (question) => {
      asked.push(question);
      if (question.kind !== 'part') return { ok: true, verdict: 'aside', heard: '', other: '' };
      return { ok: true, verdict: 'request', part: /shop/.test(question.transcript) ? 'money' : '' };
    },
  });
  rig.library.activate('numbers_time_money', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  const opening = rig.conductor.openingTurn();
  rig.conductor.handleTutorTurn(opening.say);

  await rig.conductor.answerStudent('Can we try that one more time?');
  assert.equal(rig.library.runtime.phaseId, 'numbers', 'asking for it again is not asking for another part');
  assert.equal(asked.filter((question) => question.kind === 'part').length, 0, 'and nobody needs asking');

  await rig.conductor.answerStudent('Can we do the shop stuff instead?');
  const routed = asked.find((question) => question.kind === 'part');
  assert.deepEqual(routed.parts.map((part) => part.id).slice(0, 3), ['larger_numbers', 'prices', 'time'], 'the judge is shown the parts still to come');
  assert.equal(rig.library.runtime.phaseId, 'money');
  await rig.conductor.idle();
  rig.conductor.stop();

  const prompt = buildPartPrompt({
    language: 'Japanese', transcript: 'Can we do the shop stuff instead?',
    current: { name: 'Numbers', purpose: 'Numbers up to 99.' },
    parts: [{ id: 'money', name: 'Paying', purpose: 'Paying for something.' }],
  });
  assert.match(prompt, /- money: Paying — Paying for something\./);
  assert.match(prompt, /by what the part is about, not by a shared word/);
  assert.match(prompt, /If in doubt, ""/);
});

await test('a part left before it began is come back to', async () => {
  // Asked for paying while "Ready for the next part?" was still in the air,
  // a student was taken to have known the part that had only been announced.
  const rig = conductorRig({}, { directed: true });
  rig.library.activate('numbers_time_money', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  const runtime = rig.library.runtime;
  runtime.finishedParts.numbers = true;
  runtime.setPhase('larger_numbers');
  await rig.conductor.ensurePlan('', { quiet: true });
  rig.conductor.pending = null;
  await rig.conductor.answerStudent('Actually, can we go straight to paying for things in a shop?');
  await rig.conductor.idle();
  rig.conductor.stop();
  assert.equal(runtime.phaseId, 'money');
  assert.equal(runtime.revisit[0], 'larger_numbers');
  assert.ok(!runtime.finishedParts.larger_numbers, 'it is not counted as done');
});

await test('a word is theirs once they have said something with it in', () => {
  // "you can now say: beef, please. Still to get: gyuuniku for beef"
  const { runtime } = runtimeOn('vocabulary_builder');
  runtime.setPhase('first_pass');
  runtime.setPlan('first_pass', sanitizePlan({
    items: [{ say: 'gyuuniku', meaning: 'beef' }, { say: 'tamanegi', meaning: 'onion' }, { say: 'gyuuniku o onegaishimasu', meaning: 'beef, please' }],
  }));
  runtime.noteFumble({ kind: 'recall', say: 'gyuuniku' });
  runtime.noteFumble({ kind: 'recall', say: 'tamanegi' });
  runtime.noteRight({ kind: 'recall', say: 'gyuuniku o onegaishimasu' });
  runtime.refreshWrap();
  const wrap = runtime.currentScript().find((step) => step.kind === 'wrap');
  assert.deepEqual(wrap.missed.map((item) => item.say), ['tamanegi']);
});

await test('a mix-up in a role-play is named when the words are given', () => {
  // "nanmei-sama desu ka" — "sumimasen" — "It's futari desu. Say it."
  const steps = buildScript(sanitizePlan(SAMPLE_PLAN));
  const at = sceneAt(steps);
  const turn = turnFor(steps, { language: 'Japanese', current: at, tries: 1, heard: 'sumimasen', verdict: { verdict: 'other', heard: 'sumimasen', other: 'sumimasen' } });
  assert.equal(turn.line, '"sumimasen" is excuse me. Here it\'s "futari desu". Say it.');
});

await test('the word for "right" is explained when it is first used, not promised', async () => {
  const rig = conductorRig({}, { directed: true });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  const said = async (student) => {
    const decided = await rig.conductor.answerStudent(student);
    rig.conductor.handleTutorTurn(decided.say);
    return decided.say;
  };
  rig.conductor.handleTutorTurn(rig.conductor.openingTurn().say);
  await said('sumimasen');
  await said('futari desu');
  assert.match(await said('sumimasen'), /^Hai — yes\. "menyuu o onegaishimasu" means/);
  await said('menyuu o onegaishimasu');
  assert.match(await said('two people'), /^Hai\. How do you say/, 'once');
  rig.conductor.stop();
});

await test('a part named "Second set" is not announced by its label', async () => {
  const code = await readAll(['public/shared/conductor.js']);
  assert.match(code, /this\.startedParts > 0 && !plainName\(name\)/);
});

await test('a role-play is filled out from the moments the phrases are for', async () => {
  // Part one's role-play was one line: a waiter asks one thing on the way in.
  // The rest of that scene is the customer's: calling them over, asking for
  // the menu.
  const steps = buildScript(sanitizePlan({
    items: [
      { say: 'sumimasen', meaning: 'excuse me', use: 'You want the waiter to come over.', reply: 'hai, shoushou omachi kudasai', reply_meaning: 'yes, one moment please' },
      { say: 'futari desu', meaning: 'two people' },
      { say: 'menyuu o onegaishimasu', meaning: 'the menu, please', use: 'You want to see the menu.', reply: 'hai, douzo', reply_meaning: 'here you are' },
    ],
    scene: { setup: "I'm the waiter and you have just walked in.", lines: [{ tutor: 'nanmei-sama desu ka', meaning: 'how many people?', expect: 'futari desu', reply: 'kochira e douzo', reply_meaning: 'this way, please' }] },
  }));
  const scenes = steps.filter((step) => step.kind === 'scene');
  assert.deepEqual(scenes.map((step) => step.expect), ['futari desu', 'sumimasen', 'menyuu o onegaishimasu']);
  assert.equal(lineFor(scenes[1], 'Japanese'), 'You want the waiter to come over. What do you say?', 'the student speaks first');
  assert.equal(lineFor(scenes[1], 'Japanese', { hint: true }), 'In Japanese, say: excuse me.');
  assert.equal(steps.filter((step) => step.kind === 'recall' && step.say === 'menyuu o onegaishimasu').length, 0, 'and what the role-play will ask for is not asked for just before it');
  const at = steps.indexOf(scenes[1]);
  const turn = turnFor(steps, { language: 'Japanese', current: at, heard: 'sumimasen' });
  assert.match(turn.line, /^"hai, shoushou omachi kudasai" — yes, one moment please\. You want to see the menu\. What do you say\?$/);
  // In a moment, only what the moment calls for will do.
  const other = turnFor(steps, { language: 'Japanese', current: at, heard: 'futari desu' });
  assert.equal(other.mode, 'judge');
  assert.equal(other.asked, 'what they would say at this moment: You want the waiter to come over');
  // Two lines from the planner are a role-play already.
  assert.equal(drinkSteps().filter((step) => step.kind === 'scene').length, 2);
  // And a part with no lines at all still has one, opened by the student.
  const shop = buildScript(sanitizePlan({
    items: [
      { say: 'kore wa ikura desu ka', meaning: 'how much is this', use: 'You want to know the price of something.', reply: 'gohyaku en desu', reply_meaning: '500 yen' },
      { say: 'sen en', meaning: '1000 yen' },
      { say: 'yonhyaku en', meaning: '400 yen' },
      { say: 'kore o kudasai', meaning: "I'll take this", use: 'You have decided to buy the fan.', reply: 'kashikomarimashita', reply_meaning: 'certainly' },
    ],
  }));
  const opening = shop.find((step) => step.kind === 'scene');
  assert.equal(lineFor(opening, 'Japanese'), "Let's try it for real. You want to know the price of something. What do you say?");
  assert.equal(lineFor(shop[shop.indexOf(opening) + 1], 'Japanese'), '"sen yonhyaku en desu". How much is that?', 'and the price they hear is a new one, made of parts they have been taught');
  // A price is taught, and then heard as a shop assistant says it.
  assert.ok(shop.some((step) => step.listen && step.say === 'sen en desu'));
});

await test('a line that states a price is caught first, and then answered', () => {
  const steps = buildScript(sanitizePlan({
    items: [{ say: 'kore o kudasai', meaning: "I'll take this" }, { say: 'kaado de', meaning: 'by card' }],
    scene: { setup: "I'm the shop assistant.", lines: [
      { tutor: 'sen nihyaku en desu', meaning: 'it is 1200 yen', expect: 'kore o kudasai', reply: 'kashikomarimashita', reply_meaning: 'certainly' },
      { tutor: 'oshiharai wa', meaning: 'how will you pay?', expect: 'kaado de' },
    ] },
  }));
  const at = steps.findIndex((step) => step.listen);
  assert.equal(lineFor(steps[at], 'Japanese'), 'Let\'s try it for real. I\'m the shop assistant. "sen nihyaku en desu". How much is that?');
  assert.equal(lineFor(steps[at + 1], 'Japanese'), 'What do you say back?');
  assert.equal(lineFor(steps[at + 1], 'Japanese', { hint: true }), 'That meant "it is 1200 yen". In Japanese, say: I\'ll take this.');
  assert.equal(lineFor(steps[at + 1], 'Japanese', { again: true }), '"sen nihyaku en desu". What do you say back?');
});

await test('when a role-play ends, what they ordered arrives', () => {
  // "Nothing arrives, nothing I chose has a consequence, and the scene ends in a tally."
  const steps = drinkSteps();
  const last = steps.length - 2;
  assert.equal(steps[last].kind, 'scene');
  const turn = turnFor(steps, { language: 'Japanese', current: last, heard: 'biiru o kudasai', ordered: [{ word: 'omizu', thing: 'water' }] });
  // (Accepted, and then — a little later — brought: not both in one breath.)
  assert.match(turn.line, /^"kashikomarimashita" — certainly\. A little later: "omatase shimashita\. omizu to biiru desu" — thank you for waiting: water and a beer\. In Japanese you can now say/);
  assert.deepEqual(turn.ordered, { word: 'biiru', thing: 'a beer' }, 'and each order is handed back to be kept');
  const pointing = turnFor(steps, { language: 'Japanese', current: last, heard: 'kore o kudasai', ordered: [] });
  assert.match(pointing.line, /^"kore desu ne\. kashikomarimashita" — this one, right\? Certainly\. /, '"this one" cannot be brought to the table by name');
});

await test('asking for it again gets it again, not an answer', () => {
  // "can we try that one more time" — "You were asked to say the full yen
  // phrase you learned, without changing it."
  const turn = nextTurn({ current: 1, heard: 'can we try that one more time' });
  assert.deepEqual({ mode: turn.mode, line: turn.line, advances: turn.advances }, { mode: 'exact', line: 'Sure. "futari desu" means two people. Say it.', advances: false });
  assert.equal(nextTurn({ current: 2, heard: 'Sorry?' }).line, 'Sure. How do you say "excuse me"?');
  assert.equal(nextTurn({ current: 2, heard: 'sorry, what does that mean?' }).mode, 'question', 'a real question is still one');
});

await test('"I know that one" is not made to repeat it', () => {
  const remark = 'ah, that one again, I know that one';
  const turn = nextTurn({ current: 0, heard: remark, verdict: { verdict: 'aside', heard: remark } });
  assert.deepEqual({ line: turn.line, advances: turn.advances, reason: turn.reason }, { line: `OK. Next: ${SAMPLE_WALK[1]}`, advances: true, reason: 'known' });
});

await test('a slip in the asking is not answered with what the word means', () => {
  // "gyuuniku o onegaimasu" — "gyuuniku is beef. Beef, please starts gyuuniku…"
  const step = { kind: 'recall', say: 'gyuuniku o onegaishimasu', meaning: 'beef, please' };
  assert.equal(confusedWith(step, 'gyuuniku o onegaimasu', [{ say: 'gyuuniku', meaning: 'beef' }, { say: 'kyabetsu', meaning: 'cabbage' }]), null);
  assert.equal(confusedWith(step, 'kyabetsu', [{ say: 'gyuuniku', meaning: 'beef' }, { say: 'kyabetsu', meaning: 'cabbage' }]).say, 'kyabetsu', 'a different word still is one');
  assert.equal(correctionFor('gyuuniku o onegaimasu', 'gyuuniku o onegaishimasu'), 'Not quite. It\'s "onegaishimasu", not "onegaimasu": "gyuuniku o onegaishimasu". Say it once more.');
});

await test('what they said in a role-play is what they are credited with', async () => {
  // "Still to get: gyuuniku o onegaishimasu" — two turns after they had
  // answered the waiter with exactly that.
  const { runtime } = runtimeOn('vocabulary_builder');
  runtime.setPhase('first_pass');
  runtime.setPlan('first_pass', sanitizePlan({
    items: [{ say: 'gyuuniku', meaning: 'beef' }, { say: 'kyabetsu', meaning: 'cabbage' }, { say: 'gyuuniku o onegaishimasu', meaning: 'beef, please' }],
  }));
  runtime.noteFumble({ kind: 'recall', say: 'gyuuniku o onegaishimasu' });
  runtime.noteRight({ kind: 'scene', expect: 'kyabetsu' }, 'gyuuniku o kudasai');
  runtime.refreshWrap();
  assert.deepEqual(runtime.currentScript().find((step) => step.kind === 'wrap').missed, [], 'in either wording of it');
});

await test('a question is answered from everything the lesson draws on', async () => {
  // "why is it yon here and not shi?" — asked in the part about prices,
  // answered in the section about numbers, which the tutor had not been given.
  const { runtime } = runtimeOn('numbers_time_money');
  runtime.setPhase('prices');
  const facts = referenceFacts({ skill: runtime.skill, state: runtime.snapshot(), reference: JAPANESE_REFERENCE, topics: {} });
  assert.match(facts, /kore wa ikura desu ka/);
  assert.match(facts, /4, 7 and 9 have second readings/);
});

await test('the planner keeps to one way of asking, and a shop assistant may state a price', async () => {
  const prompt = buildPlanPrompt({
    language: 'Japanese', level: 'Beginner', skill: SKILLS.find((skill) => skill.id === 'restaurant'),
    phase: SKILLS.find((skill) => skill.id === 'restaurant').phases[1], mode: 'teach', subject: '', facts: [], taught: [], known: [],
    scenes: ['gochuumon wa'],
  });
  assert.match(prompt, /ALREADY SAID TO THE STUDENT IN THIS LESSON'S ROLE-PLAYS — this role-play does not open on any of these, and uses at most one of them:\n- gochuumon wa/);
  assert.match(prompt, /A narrow question comes before an open one\./);
  assert.match(prompt, /A line may state a price or a time instead of asking something/);
  assert.match(prompt, /The student is taught the first one whole and makes the others from the word/);
  assert.match(prompt, /its "reply_meaning" is the figure alone/);

  const originalFetch = globalThis.fetch;
  /** @type {any[]} */
  const calls = [];
  const answers = [
    {
      items: [
        { say: 'kore wa ikura desu ka', meaning: 'how much is this', use: 'You want to buy the thing you asked about.', reply: 'gohyaku en desu', reply_meaning: '500 yen' },
        { say: 'kyuuhyaku gojuu en', meaning: '950 yen', note: 'Kyuu is nine. Hyaku is hundred.' },
        { say: 'sen en', meaning: '1000 yen', note: 'Sen is one thousand.' },
        { say: 'kore o kudasai', meaning: 'this one, please' },
      ],
      scene: { setup: "I'm the shop assistant.", lines: [
        { tutor: 'kore wa ikura desu ka', meaning: 'how much is this?', expect: 'kyuuhyaku gojuu en' },
        { tutor: 'sen en desu', meaning: 'it is 1000 yen', expect: 'kore o kudasai' },
      ] },
    },
    { wrong: [] },
  ];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    const content = JSON.stringify(answers[calls.length - 1] || {});
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
  try {
    const skill = SKILLS.find((entry) => entry.id === 'numbers_time_money');
    const result = await planPhase({
      skill, phaseId: 'prices', language: 'Japanese', level: 'Beginner',
      taught: [{ say: 'reshiito o onegaishimasu', meaning: 'a receipt, please' }],
      known: ['kyuu hyaku en — 900 yen', 'sanbyaku gojuu en — 350 yen'],
    });
    if (result.error && /API key/.test(result.error)) return; // no key in this environment: nothing was asked
    assert.equal(result.ok, true, result.error || '');
    assert.equal(calls.length, 2, 'the plan and its proofreading: nothing is asked for twice');
    // "sen en desu" contains the item "sen en" — and is what a shop assistant
    // says. With that rule applied to figures, Prices never had a role-play.
    assert.deepEqual(result.plan.scene.lines.map((line) => line.tutor), ['sen en desu']);
    const items = Object.fromEntries(result.plan.items.map((item) => [item.meaning, item]));
    // A price is on file when each word of it is, however it was spaced there.
    assert.equal(items['950 yen'].known, true);
    assert.equal(items['950 yen'].note, '', 'and a note about words on file says nothing new');
    assert.equal(items['1000 yen'].note, 'Sen is one thousand.');
    assert.equal(items['how much is this'].use, '', 'a moment that leans on an earlier one is not a moment');
    assert.equal(items['this one, please'].say, 'kore o onegaishimasu', 'the asking already taught is the one kept to');
    assert.equal(result.plan.scene.lines[0].expect, 'kore o onegaishimasu');
    assert.ok(!JSON.stringify(calls.map((call) => call.messages)).includes('sk-'), 'and nothing key-shaped is in what was sent');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

section('A shop, not a price list');

// Round eleven: "the first one that is no longer only a flashcard machine" —
// and a role-play that ran backwards (told a price, bought it, then asked what
// it cost), the same 2000 yen three times running, "hai" refused as an answer
// to "is that everything?", and "X desu ne" translated eight times in thirteen
// turns.

await test('the app can say any price, as the reference writes them', () => {
  const said = Object.fromEntries([21, 47, 99, 300, 350, 600, 800, 1200, 3000, 8000, 10000, 12500].map((n) => [n, japaneseNumber(n)]));
  assert.deepEqual(said, {
    21: 'nijuu ichi', 47: 'yonjuu nana', 99: 'kyuujuu kyuu', 300: 'sanbyaku', 350: 'sanbyaku gojuu', 600: 'roppyaku',
    800: 'happyaku', 1200: 'sen nihyaku', 3000: 'sanzen', 8000: 'hassen', 10000: 'ichiman', 12500: 'ichiman nisen gohyaku',
  });
  assert.equal(japaneseNumber(0), '');
  // New prices are made only of parts of prices already taught.
  const fresh = freshPrices([{ say: 'yonhyaku en', meaning: '400 yen' }, { say: 'nisen en', meaning: '2000 yen' }]);
  assert.deepEqual(fresh, [{ say: 'nisen yonhyaku en desu', meaning: '2400 yen' }]);
  assert.deepEqual(freshPrices([{ say: 'sumimasen', meaning: 'excuse me' }]), [], 'and from nothing, nothing');
});

await test('a price is asked for before it is given, and is one they have not just said', () => {
  const steps = buildScript(sanitizePlan({
    items: [
      { say: 'kore wa ikura desu ka', meaning: 'how much is this', use: 'You want to know the price of something.', reply: 'sen gohyaku en desu', reply_meaning: '1500 yen' },
      { say: 'yonhyaku en', meaning: '400 yen' },
      { say: 'nisen en', meaning: '2000 yen' },
      { say: 'kore o kudasai', meaning: "I'll take this" },
    ],
    scene: { setup: "I'm the shop assistant and you want to buy something.", lines: [
      { tutor: 'nisen en desu', meaning: 'it is 2000 yen', expect: 'kore o kudasai', reply: 'kashikomarimashita', reply_meaning: 'certainly' },
    ] },
  }));
  const at = steps.findIndex((step) => step.kind === 'scene');
  assert.deepEqual(
    steps.slice(at, at + 3).map((step) => lineFor(step, 'Japanese')),
    [
      "Let's try it for real. I'm the shop assistant and you want to buy something. You want to know the price of something. What do you say?",
      '"nisen yonhyaku en desu". How much is that?',
      'What do you say back?',
    ],
    'asked, told, bought — in that order, and the price is a new one',
  );
  assert.equal(steps[at + 2].expect, 'kore o kudasai');
  assert.equal(lineFor(steps[at + 2], 'Japanese', { hint: true }), 'That meant "it is 2400 yen". In Japanese, say: I\'ll take this.');
  // Before the scene, the asking is asked for from its English: not the same prompt twice.
  const recall = steps.find((step) => step.kind === 'recall' && step.say === 'kore wa ikura desu ka');
  assert.equal(lineFor(recall, 'Japanese'), 'How do you say "how much is this"?');
});

await test('a part does not open on something carried over from another', () => {
  // "Next: larger numbers. How do you say I'll take this?"
  const steps = buildScript(sanitizePlan({
    items: [{ say: 'sanbyaku en', meaning: '300 yen', known: true }, { say: 'roppyaku en', meaning: '600 yen' }, { say: 'sen nihyaku en', meaning: '1200 yen' }],
  }), { taught: [{ say: 'kore o kudasai', meaning: "I'll take this" }] });
  assert.equal(lineFor(steps[0], 'Japanese'), 'How do you say "300 yen"?');
  assert.equal(steps.filter((step) => step.kind === 'recall' && step.say === 'sanbyaku en').length, 1, 'and what they know is asked for once');
});

await test('a plain yes or no answers a yes-or-no question', () => {
  // "ijou de yoroshii desu ka" — "hai" — "In Japanese, say: pork, please."
  const steps = buildScript(sanitizePlan({
    items: [{ say: 'butaniku o onegaishimasu', meaning: 'pork, please' }, { say: 'nasu o onegaishimasu', meaning: 'eggplant, please' }],
    scene: { setup: "I'm the waiter.", lines: [
      { tutor: 'nani ni nasaimasu ka', meaning: 'what will you have?', expect: 'nasu o onegaishimasu', reply: 'kashikomarimashita', reply_meaning: 'certainly' },
      { tutor: 'ijou de yoroshii desu ka', meaning: 'is that everything?', expect: 'butaniku o onegaishimasu', reply: 'kashikomarimashita', reply_meaning: 'certainly' },
    ] },
  }));
  const last = steps.length - 2;
  const ordered = [{ word: 'nasu', thing: 'eggplant' }];
  const yes = turnFor(steps, { language: 'Japanese', current: last, heard: 'hai', ordered });
  assert.equal(yes.reason, 'right');
  assert.equal(yes.credit, false, 'right, but not the order the plan had there');
  assert.match(yes.line, /^"kashikomarimashita" — certainly\. A little later: "omatase shimashita\. nasu desu" — thank you for waiting: eggplant\. /);
  assert.equal(turnFor(steps, { language: 'Japanese', current: last, heard: 'hai, ijou desu', ordered }).reason, 'right');
  // Said in English by someone who has not been given the words: they are given them.
  const english = turnFor(steps, { language: 'Japanese', current: last, heard: "um... no, that's all, thank you?", ordered });
  assert.match(english.line, /^In Japanese that's "ijou desu" — that's all\. "kashikomarimashita" — certainly\. A little later: /);
  assert.equal(english.advances, true);
  // And the help says so.
  const stuck = turnFor(steps, { language: 'Japanese', current: last, heard: 'um, what do I say', ordered });
  assert.equal(stuck.line, 'That meant "is that everything?" Say "hai" for yes, or "iie" for no.');
  // "How many people?" is not a yes-or-no question.
  const sample = buildScript(sanitizePlan(SAMPLE_PLAN));
  assert.equal(turnFor(sample, { language: 'Japanese', current: sceneAt(sample), heard: 'hai' }).mode, 'judge');
});

await test('an order said back is translated twice, like anything else said to them', async () => {
  const steps = drinkSteps();
  const build = steps.findIndex((step) => step.build && step.word === 'kore');
  const replies = new Map();
  const first = turnFor(steps, { language: 'Japanese', current: build, heard: 'kore o kudasai', replies });
  assert.match(first.line, /^"kore desu ne" — this one, right\? /);
  assert.equal(first.echo, true, 'the turn says an order was said back, so that it can be counted');
  replies.set('desu ne', 2);
  assert.match(turnFor(steps, { language: 'Japanese', current: build, heard: 'kore o kudasai', replies }).line, /^"kore desu ne"\. /);
  // "Pork, right? You want to order beef." — a sentence stands between.
  const water = steps.findIndex((step) => step.build && step.word === 'omizu');
  assert.match(turnFor(steps, { language: 'Japanese', current: water, heard: 'omizu o kudasai' }).line, /Certainly\. Now a different one\. You want to order a beer\. What do you say\?$/);
  const code = await readAll(['public/shared/conductor.js']);
  assert.match(code, /if \(turn\.reason === 'right' && turn\.echo\) this\.replies\.set\('desu ne'/);
});

await test('a role-play does not open on a line the lesson has used', async () => {
  const code = await readAll(['src/planner.js']);
  assert.match(code, /if \(rolePlay !== 'full' \|\| !usedBefore\.has\(fold\(line\.tutor\)\)\) return true;\s+reused \+= 1;\s+return index > 0 && reused <= 1;/);
});

section('The first real call');

// The first call made on this design by the person it is for. "Overall major
// improvement" — and ten corrections, eight of them of things said correctly:
// the recogniser wrote "genkin de" as "Gen keen de" and then as 元気で. The
// tutor read "genkin de" aloud as English. And "I am not ready for the next
// part" took the lesson past it to the one after.

await test('what the recogniser blurred is given to the student', () => {
  const pairs = [
    ['Gen keen de.', 'genkin de'], ['genki de.', 'genkin de'], ['Hassan yen', 'hassen en'],
    ['Gozen shichiji an.', 'gozen shichiji han'], ['geuji jupeun', 'kuji juppun'], ['yuujuu san.', 'kyuujuu san'],
    ['rokujuuyonjuugofun', 'rokuji yonjuugofun'], ['kadeu de', 'kaado de'],
  ];
  for (const [heard, answer] of pairs) assert.equal(soundsLike(heard, answer), true, `${heard} is ${answer}`);
  assert.equal(soundKey('Gen keen de.'), soundKey('genkin de'));
  // A different word, a missing syllable, a short word that is another word: still not it.
  for (const [heard, answer] of [['yonjuuban', 'rokuji yonjuugofun'], ['shijuu hachi', 'yonjuu nana'], ['futa desu', 'futari desu'], ['gyuuni', 'gyuuniku'], ['goji', 'kuji'], ['roku hyaku en', 'roppyaku en']]) {
    assert.equal(soundsLike(heard, answer), false, `${heard} is not ${answer}`);
  }

  const steps = buildScript(sanitizePlan({ items: [{ say: 'kaado de', meaning: 'by card' }, { say: 'genkin de', meaning: 'in cash' }, { say: 'kore wa ikura desu ka', meaning: 'how much is this' }] }));
  const at = steps.findIndex((step) => step.kind === 'teach' && step.say === 'genkin de');
  // Written as English words: right, and nobody needs asking.
  const english = turnFor(steps, { language: 'Japanese', current: at, heard: 'Gen keen de.' });
  assert.deepEqual({ mode: english.mode, reason: english.reason }, { mode: 'exact', reason: 'right' });
  // Written as another Japanese word, and ruled wrong by the judge: right all the same.
  const kanji = turnFor(steps, { language: 'Japanese', current: at, heard: '元気で。', verdict: { verdict: 'wrong', heard: 'genki de.' } });
  assert.equal(kanji.reason, 'right');
  // A swapped little word is the student's slip, however close it sounds.
  const ask = steps.findIndex((step) => step.kind === 'teach' && step.say === 'kore wa ikura desu ka');
  const particle = turnFor(steps, { language: 'Japanese', current: ask, heard: 'kore o ikura desu ka', verdict: { verdict: 'wrong', heard: 'kore o ikura desu ka' } });
  assert.equal(particle.line, 'Not quite. It\'s "wa", not "o": "kore wa ikura desu ka". Say it once more.');
  const noKa = turnFor(steps, { language: 'Japanese', current: ask, heard: 'kore wa ikura desu', verdict: { verdict: 'wrong', heard: 'kore wa ikura desu' } });
  assert.equal(noKa.reason, 'wrong', 'and so is a question with its "ka" left off');
  // And another thing they have been taught is another thing, not a blur of this one.
  const card = turnFor(steps, { language: 'Japanese', current: at, heard: 'kaado de' });
  assert.notEqual(card.reason, 'right');

  const prompt = buildJudgePrompt({ language: 'Japanese', kind: 'teach', say: 'genkin de', meaning: 'in cash', also: [], asked: 'to say "genkin de"', transcript: 'Gen keen de.', taught: [] });
  assert.match(prompt, /"Gen keen de" is "genkin de"/);
  assert.match(prompt, /Korean hangul/);
  assert.match(prompt, /is the recogniser's doing as often as theirs: that is "right"/);
  assert.match(prompt, /A sentence in English is never "wrong"/);
});

await test('the voice is told that what it is reading is Japanese', () => {
  // "genkin de" came out as "gen kin day": the instructions for a line replace
  // the tutor's standing ones, and said nothing about what language it was.
  const { instructions } = renderTurn(nextTurn({ current: 1, heard: 'futari desu' }), { tutor: 'Aiko', student: 'Jeremy', language: 'Japanese' });
  assert.match(instructions, /^Repeat the user's message back word for word\. Output every word of it, in order, with nothing added, nothing removed and nothing changed\. Do not answer it\.\n\nPronunciation: /);
  assert.match(instructions, /never read as an English word/);
  assert.match(instructions, /"de" is "deh", "genkin" is "gen-keen"/);
  assert.match(pronunciationOf('German'), /spoken as a native German speaker says it/);
  const question = renderTurn(nextTurn({ current: 2, heard: 'wait, what is the o for?' }), { tutor: 'Aiko', student: 'Jeremy', language: 'Japanese' });
  assert.match(question.instructions, /- Pronunciation: this is a line from a Japanese lesson/);
});

await test('"not ready for the next part" is not a request for the next part', () => {
  const said = 'I am not ready for the next part in terms of hours and minutes. It seems very different from regular numbers';
  assert.equal(wantsToMoveOn(said), false);
  assert.equal(declinesToGoOn(said), true);
  assert.equal(wantsToMoveOn("no, don't skip this"), false);
  assert.equal(wantsToMoveOn('can we skip this'), true, 'asking to leave is still asking to leave');
  assert.equal(objectsToMoving('No, I did not want you to move to.'), true);
  assert.equal(objectsToMoving('can we go back to the time part'), true);
  assert.equal(objectsToMoving('kaado de'), false);
  assert.equal(declinesToGoOn('Yes.'), false);
  assert.equal(declinesToGoOn('Yep, go on'), false);
});

await test('asked if they are ready, a student who says no goes back through the part', async () => {
  const rig = conductorRig({}, { directed: true });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  const runtime = rig.library.runtime;
  const said = async (student) => {
    const decided = await rig.conductor.answerStudent(student);
    rig.conductor.handleTutorTurn(decided.say);
    return decided;
  };
  rig.conductor.handleTutorTurn(rig.conductor.openingTurn().say);
  await said('sumimasen');
  await said('futari desu');
  await said('sumimasen');
  await said('menyuu o onegaishimasu');
  await said('two people');
  await said('I do not remember');
  await said('menyuu o onegaishimasu');
  const wrap = await said('futari desu');
  assert.match(wrap.say, /Ready for the next part\?$/);
  assert.equal(runtime.phaseId, 'useful_vocabulary', 'the next part is waiting');

  const back = await rig.conductor.answerStudent('No, I am not ready. Go back.');
  assert.equal(runtime.phaseId, 'introduction', 'and they are taken back, not on');
  assert.ok(rig.logs.some((entry) => entry.type === 'script.back'));
  // Not the same pass twice: what they had is asked for; what they missed is taught again.
  assert.equal(back.say, 'OK. Back to arriving. How do you say "excuse me"?');
  const kinds = runtime.currentScript().filter((step) => step.kind === 'teach').map((step) => step.say);
  assert.deepEqual(kinds, ['menyuu o onegaishimasu'], 'only what was missed is taught again');
  assert.ok(!runtime.finishedParts.introduction);

  // And when it is done, the lesson carries on with the part it turned back from.
  rig.conductor.handleTutorTurn(back.say);
  for (let i = 0; i < 12 && runtime.phaseId === 'introduction'; i += 1) {
    const steps = runtime.currentScript();
    const step = steps[runtime.cursors.introduction];
    await said(step.kind === 'recognise' ? step.meaning : step.kind === 'scene' ? step.expect : step.say);
  }
  assert.equal(runtime.phaseId, 'useful_vocabulary');
  rig.conductor.stop();
});

await test('"I did not want you to move on" takes the lesson back where it was', async () => {
  // "No, I did not want you to move to." — "Once more: kaado de."
  /** @type {any[]} */
  const asked = [];
  const rig = conductorRig({}, {
    directed: true,
    judge: async (question) => {
      asked.push(question);
      return question.kind === 'part' ? { ok: true, verdict: 'request', part: question.before || '' } : { ok: true, verdict: 'aside', heard: '', other: '' };
    },
  });
  rig.library.activate('numbers_time_money', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  const runtime = rig.library.runtime;
  rig.conductor.handleTutorTurn(rig.conductor.openingTurn().say);
  const moved = await rig.conductor.answerStudent('this is too easy, skip it');
  rig.conductor.handleTutorTurn(moved.say || 'OK.');
  await rig.conductor.idle();
  assert.equal(runtime.phaseId, 'larger_numbers');

  const back = await rig.conductor.answerStudent('No, I did not want you to move to.');
  const routed = asked.find((question) => question.kind === 'part');
  assert.equal(routed.before, 'numbers', 'the judge is told where they were');
  assert.ok(routed.parts.some((part) => part.id === 'numbers' && part.done), 'and is shown the parts already been through');
  assert.equal(runtime.phaseId, 'numbers');
  assert.match(back.say, /^OK\. Back to numbers\. /);
  await rig.conductor.idle();
  rig.conductor.stop();

  // With nobody to ask, it is still the part they were in before.
  const bare = conductorRig({}, { directed: true });
  bare.library.activate('numbers_time_money', { reason: 'ui' });
  await bare.conductor.ensurePlan('', { quiet: true });
  bare.conductor.handleTutorTurn(bare.conductor.openingTurn().say);
  await bare.conductor.answerStudent('this is too easy, skip it');
  await bare.conductor.idle();
  await bare.conductor.answerStudent('wait, go back, I did not ask for that');
  assert.equal(bare.library.runtime.phaseId, 'numbers');
  await bare.conductor.idle();
  bare.conductor.stop();

  const prompt = buildPartPrompt({
    language: 'Japanese', transcript: 'No, I did not want you to move to.', current: { name: 'Paying', purpose: '' },
    parts: [{ id: 'time', name: 'Time', purpose: 'Telling the time.', done: true }], before: 'time',
  });
  assert.match(prompt, /- time: Time — Telling the time\. \(already been through\)/);
  assert.match(prompt, /it is the part they were in before this one: "time"/);
});

await test('a time they did not catch is told to them, not asked for as if it were a phrase', () => {
  // "gozen shichiji han". What time is that? — "I don't know." — "It's "7:30 am". Say it."
  const steps = [
    { kind: 'recognise', say: 'gozen shichiji han desu', meaning: '7:30 am', listen: true, wordOnly: true },
    { kind: 'recall', say: 'ima nanji desu ka', meaning: 'what time is it' },
    { kind: 'wrap', items: [] },
  ];
  const turn = turnFor(steps, { language: 'Japanese', current: 0, heard: "I don't know." });
  assert.deepEqual(
    { line: turn.line, advances: turn.advances },
    { line: '"gozen shichiji han desu" means 7:30 am. Now a different one. How do you say "what time is it"?', advances: true },
  );
});

section('Repetition, if there is to be any, is quick');

// "I did start to get tired of the same phrases over and over. I understand
// repetition works, but if I'm going to do repetition I would prefer it's
// quick. I don't need two full sentences as a prompt each time, and my
// response doesn't need to be a full sentence each time." — and, from the same
// call, made outside any lesson: "kore wa ni juu-san desu. That means this is
// a carrot."

/** A second set of words, in a part that closes on a quick round. */
const WORDS_PLAN = Object.freeze({
  items: [
    { say: 'tamanegi', meaning: 'onion' }, { say: 'jagaimo', meaning: 'potato' },
    { say: 'kyabetsu', meaning: 'cabbage' }, { say: 'piiman', meaning: 'green pepper' },
  ],
  scene: { setup: "I'm the waiter.", lines: [
    { tutor: 'nani ni nasaimasu ka', meaning: 'what will you have?', expect: 'tamanegi', reply: 'kashikomarimashita', reply_meaning: 'certainly' },
    { tutor: 'hoka ni gochuumon wa gozaimasu ka', meaning: 'anything else?', expect: 'jagaimo', reply: 'kashikomarimashita', reply_meaning: 'certainly' },
  ] },
});
const EARLIER_WORDS = [
  { say: 'daikon', meaning: 'radish' }, { say: 'ninjin', meaning: 'carrot' }, { say: 'kyuuri', meaning: 'cucumber' },
  { say: 'ninjin o onegaishimasu', meaning: 'a carrot, please' },
];
const wordSteps = () => buildScript(sanitizePlan(WORDS_PLAN), { taught: EARLIER_WORDS, round: true });

await test('a part can close on a quick round: the English, the word, the next one', () => {
  const steps = wordSteps();
  const quick = steps.filter((step) => step.quick);
  assert.deepEqual(quick.map((step) => lineFor(step, 'Japanese')), [
    'Quick round. What is onion?', 'What is cucumber?', 'What is potato?', 'What is carrot?', 'What is cabbage?', 'What is green pepper?',
  ], 'this part\'s words, with a couple from earlier mixed in — and "carrot", not "a carrot, please"');
  assert.equal(steps[steps.length - 1].kind, 'wrap');
  assert.ok(!steps.some((step) => step.carried), 'with a quick round coming, nothing is carried over to be asked on the way');
  // Without being asked to, a part ends as it did.
  assert.ok(!buildScript(sanitizePlan(WORDS_PLAN), { taught: EARLIER_WORDS }).some((step) => step.quick));

  const at = steps.indexOf(quick[0]);
  // Right: the next question is the whole reply.
  assert.equal(turnFor(steps, { language: 'Japanese', current: at, heard: 'tamanegi' }).line, 'What is cucumber?');
  assert.equal(turnFor(steps, { language: 'Japanese', current: at, heard: 'tamanegi o onegaishimasu' }).line, 'What is cucumber?', 'a whole sentence is not needed, and is not refused');
  // Wrong, or not known: told, and on. No second try now.
  const missed = turnFor(steps, { language: 'Japanese', current: at, heard: 'um, I do not know' });
  assert.deepEqual({ line: missed.line, advances: missed.advances, requeue: missed.requeue }, { line: 'It\'s "tamanegi". Next: What is cucumber?', advances: true, requeue: true });
  const other = turnFor(steps, { language: 'Japanese', current: at, heard: 'jagaimo' });
  assert.equal(other.line, 'It\'s "tamanegi". Next: What is cucumber?');
  const wrong = turnFor(steps, { language: 'Japanese', current: at, heard: 'tamago', verdict: { verdict: 'wrong', heard: 'tamago' } });
  assert.equal(wrong.requeue, true);
  // The last one right closes the round.
  const last = steps.indexOf(quick[quick.length - 1]);
  assert.match(turnFor(steps, { language: 'Japanese', current: last, heard: 'piiman' }).line, /^Hai\. In Japanese you can now say/);
  // And the role-play before it ends as a role-play does: what they ordered arrives.
  const scene = at - 1;
  const served = turnFor(steps, { language: 'Japanese', current: scene, heard: 'jagaimo o onegaishimasu', ordered: [{ word: 'tamanegi', thing: 'onion' }] });
  assert.match(served.line, /A little later: "omatase shimashita\. tamanegi to jagaimo desu" — thank you for waiting: onion and potato\. Quick round\. What is onion\?$/);
});

await test('what was missed in a quick round comes round once more', async () => {
  const rig = conductorRig({}, { directed: true });
  rig.library.activate('vocabulary_builder', { reason: 'ui' });
  const runtime = rig.library.runtime;
  runtime.setInput('topic', 'vegetables', 'user');
  runtime.taught = EARLIER_WORDS.map((item) => ({ ...item }));
  runtime.setPhase('recall');
  assert.equal(runtime.quickRound('recall'), true, 'the lesson file asks for it');
  runtime.setPlan('recall', sanitizePlan(WORDS_PLAN));
  const steps = runtime.currentScript();
  const at = steps.findIndex((step) => step.quick);
  runtime.cursors.recall = at;
  const before = steps.filter((step) => step.quick).length;
  const decided = await rig.conductor.answerStudent('I do not remember');
  assert.equal(decided.say, 'It\'s "tamanegi". Next: What is cucumber?');
  const quick = runtime.currentScript().filter((step) => step.quick);
  assert.equal(quick.length, before + 1);
  assert.equal(quick[quick.length - 1].say, 'tamanegi', 'at the end of the round');
  assert.equal(quick[quick.length - 1].again, true);
  rig.conductor.stop();
  // The closing line of the part lists what the part taught, not what the round brought back.
  runtime.refreshWrap();
  const wrap = runtime.currentScript().find((step) => step.kind === 'wrap');
  assert.deepEqual(wrap.items, ['potato', 'cabbage', 'green pepper'], 'not "cucumber" or "carrot", which the round only brought back');
  assert.deepEqual(wrap.missed.map((item) => item.say), ['tamanegi'], 'and what they missed in it is still to get');
});

await test('the review at the end of a lesson is a quick round', () => {
  const steps = buildScript(null, { mode: 'review', taught: [...EARLIER_WORDS, { say: 'kore wa ikura desu ka', meaning: 'how much is this' }] });
  assert.deepEqual(steps.map((step) => lineFor(step, 'Japanese')).slice(0, 4), [
    'How do you say "how much is this"?', 'Quick round. What is radish?', 'What is carrot?', 'What is cucumber?',
  ], 'what is short goes round quickly; what is longer is asked for as before');
});

await test('asked for words on a subject outside a lesson, the lesson starts — nothing is made up', async () => {
  // "I want to talk about vocabulary, specifically vegetables." started
  // nothing: the tutor improvised, and ten minutes in taught "ni juu-san".
  assert.deepEqual(topicRequest('I want to talk about vocabulary, specifically vegetables.', SKILLS), { skillId: 'vocabulary_builder', inputId: 'topic', topic: 'vegetables' });
  assert.equal(topicRequest('teach me some food words', SKILLS).topic, 'food');
  assert.equal(topicRequest('can we do some words about animals and colors please', SKILLS).topic, 'animals and colors');
  assert.equal(topicRequest('I want to work on vocabulary', SKILLS).topic, '', 'no subject named: the lesson has to ask');
  assert.equal(topicRequest('what is the word for carrot', SKILLS), null, 'a question is not a request for a lesson');
  assert.equal(topicRequest("I don't know the word for tomato", SKILLS), null);
  assert.equal(topicRequest('I ate vegetables yesterday', SKILLS), null);
  // "Let's talk about colors. Teach me all the basic colors." started nothing:
  // thirteen improvised minutes, ending in a drill that named purple three
  // times running.
  assert.equal(topicRequest("Let's talk about colors. Teach me all the basic colors", SKILLS).topic, 'all the basic colors');
  assert.equal(topicRequest('I want to learn the days of the week', SKILLS).topic, 'days of the week');
  assert.equal(topicRequest('teach me how to say hello', SKILLS), null, 'a question for the tutor, not a lesson');
  assert.equal(topicRequest('teach me numbers', SKILLS), null, 'numbers have a lesson of their own');
  assert.equal(topicRequest('I want to learn Japanese', SKILLS), null);
  assert.equal(topicRequest('teach me something', SKILLS), null);
  assert.equal(topicRequest("I don't want to learn colors", SKILLS), null);

  const rig = conductorRig({}, { directed: true });
  rig.library.runtime.deactivate({ reason: 'test', silent: true });
  assert.equal(rig.library.isActive, false);
  const decided = await rig.conductor.answerStudent('I want to talk about vocabulary, specifically vegetables.');
  const runtime = rig.library.runtime;
  assert.equal(runtime.skillId, 'vocabulary_builder');
  assert.equal(runtime.inputValues.topic, 'vegetables');
  assert.equal(runtime.phaseId, 'first_pass', 'the part that settles the subject is over: it is settled');
  assert.equal(decided.say, 'OK. One moment.');
  await rig.conductor.idle();
  rig.conductor.stop();
  assert.equal(rig.replies.length, 1, 'and when its material is written, the tutor begins');
  assert.ok(rig.replies[0].say.endsWith(SAMPLE_WALK[0]), rig.replies[0].say);
  assert.ok(rig.logs.some((entry) => entry.type === 'lesson.topic' && entry.payload.topic === 'vegetables'));
});

await test('asked for more of the subject mid-lesson, they are told it is coming', async () => {
  // "Let's talk about more vegetables. Tell me about onions, potatoes, and peppers."
  const rig = conductorRig({}, { directed: true });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  rig.conductor.handleTutorTurn(rig.conductor.openingTurn().say);
  const decided = await rig.conductor.answerStudent('Tell me about onions, potatoes, and peppers.');
  assert.equal(decided.say, 'OK. Those are coming up. "sumimasen" means excuse me. Say it.');
  assert.ok(rig.library.runtime.requests.some((request) => /onions/.test(request)), 'and the parts still to come are written with it in view');
  await rig.conductor.idle();
  rig.conductor.stop();
});

section('The third real call');

// A vocabulary lesson asked for by voice: nine and a half minutes, and it
// worked end to end. What was wrong with it was at the edges. "I barely paused
// long enough to think and it thought I was done." A right answer split in two
// was refused twice over. "hourensou" was asked for seven times and
// "toumorokoshi" six, because the recogniser wrote them "Lorenzo" and "kao
// morokoshi". A cough was answered "Not quite. I heard yes."

/** A turn-taker with a clock that only moves when told to. */
function turnRig(options = {}) {
  const timers = [];
  const rig = {
    answers: /** @type {{text: string, detail: any}[]} */ ([]),
    noise: /** @type {any[]} */ ([]),
    retracts: 0,
    logs: /** @type {{type: string, detail: any}[]} */ ([]),
    canRetract: true,
    /** Let every timer due within `ms` fire. */
    pass(ms) {
      const until = rig.now + ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.cancelled || timer.fired || timer.at > until) continue;
        timer.fired = true;
        rig.now = Math.max(rig.now, timer.at);
        timer.fn();
      }
      rig.now = until;
    },
    now: 0,
    turns: /** @type {any} */ (null),
  };
  rig.turns = new StudentTurns({
    onAnswer: (text, detail) => rig.answers.push({ text, detail }),
    onNoise: (detail) => rig.noise.push(detail),
    onRetract: () => { rig.retracts += 1; return rig.canRetract; },
    log: (type, detail) => rig.logs.push({ type, detail }),
    setTimer: (fn, ms) => { const timer = { fn, at: rig.now + ms, cancelled: false, fired: false }; timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer) timer.cancelled = true; },
    ...options,
  });
  /** One stretch of speech, start to written version. */
  rig.say = (id, text, { overTutor = false, from = 0, to = 1200 } = {}) => {
    rig.turns.speechStarted({ overTutor, atMs: from });
    rig.turns.speechStopped({ atMs: to });
    rig.turns.committed(id);
    if (text !== null) rig.turns.transcript(id, text);
  };
  return rig;
}

await test('a pause in the middle of an answer does not make it two answers', () => {
  // "toumorokoshi to ramu…" — a breath — "…kudasai". On the call the first
  // half was answered while the second was being said, and then the second
  // was answered on its own: "It's ramu. Say it."
  const rig = turnRig();
  rig.turns.speechStarted({});
  rig.turns.speechStopped({});
  rig.turns.committed('a');
  // They are speaking again before the first half has even been written down.
  rig.turns.speechStarted({});
  rig.turns.transcript('a', 'Tomorokushiとランボ');
  assert.equal(rig.answers.length, 0, 'nothing is answered while they are still speaking');
  rig.turns.speechStopped({});
  rig.turns.committed('b');
  rig.turns.transcript('b', 'Kudasai.');
  assert.deepEqual(rig.answers.map((answer) => answer.text), ['Tomorokushiとランボ Kudasai.'], 'one turn, answered once');
  assert.deepEqual(rig.answers[0].detail.itemIds, ['a', 'b']);
  assert.ok(rig.logs.some((entry) => entry.type === 'student.joined'));
});

await test('a reply on its way is taken back when they go on speaking', () => {
  const rig = turnRig();
  rig.say('a', 'gyuuniku');
  assert.deepEqual(rig.answers.map((answer) => answer.text), ['gyuuniku'], 'it reads as finished, so it is answered at once');
  // The reply has been asked for and not yet heard — and they carry on.
  rig.say('b', 'o kudasai');
  assert.equal(rig.retracts, 1, 'the reply being prepared is not wanted');
  assert.deepEqual(rig.answers.map((answer) => answer.text), ['gyuuniku', 'gyuuniku o kudasai'], 'and all of it is answered together');

  // Once the reply can be heard, what they say next is a new turn.
  const heard = turnRig();
  heard.say('a', 'gyuuniku');
  heard.turns.replyHeard();
  heard.say('b', 'o kudasai', { overTutor: true });
  assert.equal(heard.retracts, 0);
  assert.deepEqual(heard.answers.map((answer) => answer.text), ['gyuuniku', 'o kudasai']);

  // And a reply that changed where the lesson is cannot be taken back: what
  // follows is answered on its own.
  const fixed = turnRig();
  fixed.canRetract = false;
  fixed.say('a', 'go back');
  fixed.say('b', 'kudasai');
  assert.deepEqual(fixed.answers.map((answer) => answer.text), ['go back', 'kudasai']);
});

await test('something that trails off is waited on a little longer; a whole answer is not', () => {
  assert.equal(trailsOff('toumorokoshi to'), true);
  assert.equal(trailsOff('とうもろこしと'), true);
  assert.equal(trailsOff('gyuuniku o'), true);
  assert.equal(trailsOff('pork and'), true);
  assert.equal(trailsOff('um'), true);
  assert.equal(trailsOff('牛肉をください。'), false);
  assert.equal(trailsOff('gyuuniku o kudasai'), false);
  assert.equal(trailsOff('I want to'), false, '"to" ends English sentences too');
  assert.equal(trailsOff('現金で'), false, '"genkin de" is a whole answer');
  assert.equal(trailsOff('食べ物'), false);
  assert.equal(joinSpeech([' a ', '', 'b']), 'a b');

  const rig = turnRig();
  rig.say('a', 'toumorokoshi to');
  assert.equal(rig.answers.length, 0, 'held: there is more coming');
  rig.say('b', 'ramu');
  assert.deepEqual(rig.answers.map((answer) => answer.text), ['toumorokoshi to ramu']);

  // Nothing more came: it is answered as it stands, a moment later.
  const alone = turnRig();
  alone.say('a', 'toumorokoshi to');
  alone.pass(1000);
  assert.equal(alone.answers.length, 0);
  alone.pass(2000);
  assert.deepEqual(alone.answers.map((answer) => answer.text), ['toumorokoshi to']);

  // And if that IS what was asked for, there is nothing to wait for.
  const whole = turnRig({ isWhole: (text) => text === 'ringo to' });
  whole.say('a', 'ringo to');
  assert.equal(whole.answers.length, 1);
});

await test('a sound with no words in it is not an answer', () => {
  // The tutor's own voice coming back, or a cough while it is talking.
  const over = turnRig();
  over.say('n', '', { overTutor: true, to: 2000 });
  assert.equal(over.answers.length, 0);
  assert.equal(over.noise.length, 1);
  assert.equal(over.noise[0].overTutor, true);

  // A click: too short to have been speech.
  const click = turnRig();
  click.say('n', '', { from: 1000, to: 1200 });
  assert.equal(click.answers.length, 0);
  assert.equal(click.noise.length, 1);

  // Three seconds of speech the recogniser made nothing of: they spoke. It is
  // handed over as that — not as noise, and not as a wrong answer.
  const spoke = turnRig();
  spoke.say('s', '', { from: 1000, to: 4000 });
  assert.equal(spoke.noise.length, 0);
  assert.deepEqual(spoke.answers.map((answer) => answer.text), ['']);
  assert.deepEqual(spoke.answers[0].detail.itemIds, ['s']);

  // A cough before the reply to a real answer is heard: the answer is
  // answered again, since the cough will have stopped the reply.
  const cough = turnRig();
  cough.say('a', 'gyuuniku');
  cough.say('n', '', { from: 0, to: 150 });
  assert.deepEqual(cough.answers.map((answer) => answer.text), ['gyuuniku', 'gyuuniku']);
  assert.equal(cough.noise.length, 0);
});

await test('a written version that is slow to come does not hold the reply up, and is used if it arrives in time', () => {
  const rig = turnRig();
  rig.say('a', null, { from: 0, to: 2500 });
  rig.pass(1000);
  assert.equal(rig.answers.length, 0, 'waited for');
  rig.pass(1000);
  assert.deepEqual(rig.answers.map((answer) => answer.text), [''], 'but not for long');
  // It turns up before the reply has been heard: that is what is answered.
  rig.turns.transcript('a', 'hourensou');
  assert.equal(rig.retracts, 1);
  assert.deepEqual(rig.answers.map((answer) => answer.text), ['', 'hourensou']);
  // After the reply has been heard it is too late to matter.
  const late = turnRig();
  late.say('a', null, { from: 0, to: 2500 });
  late.pass(2000);
  late.turns.replyHeard();
  late.turns.transcript('a', 'hourensou');
  assert.equal(late.answers.length, 1);
  assert.equal(late.turns.waiting, false);
});

await test('the session is asked to be patient, and keeps its settings when the hint changes', async () => {
  const server = await readAll(['src/routes/realtime.js', 'src/config.js']);
  assert.match(server, /eagerness: TURN_EAGERNESS,/);
  assert.match(server, /env\('TURN_EAGERNESS', 'low'\)/, 'patient by default, and one setting to go back');
  assert.match(server, /input: sessionConfig\.audio\.input,/, 'the browser is told how the session listens');

  const sent = [];
  const configs = [];
  const session = new RealtimeSession({ onTranscriptionConfig: (config) => configs.push(config) });
  session.active = true;
  session.dc = { readyState: 'open', send: (json) => sent.push(JSON.parse(json)) };
  assert.equal(session.updateTranscriptionHint('anything'), false, 'not before it knows how the session was set up');
  session.noteInputConfig({
    transcription: { model: 'gpt-live-transcribe', language: 'ja', prompt: 'first' },
    turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: false },
  });
  assert.equal(session.updateTranscriptionHint('first'), false, 'nothing is sent when nothing has changed');
  assert.equal(session.updateTranscriptionHint('They are about to practise: ほうれん草 (hourensou, spinach).'), true);
  const update = sent.pop();
  assert.equal(update.type, 'session.update');
  assert.deepEqual(update.session.audio.input.turn_detection, { type: 'semantic_vad', eagerness: 'low', create_response: false },
    'restated, so that the update cannot put the session back to answering on its own');
  assert.equal(update.session.audio.input.transcription.language, 'ja');
  assert.match(update.session.audio.input.transcription.prompt, /ほうれん草/);
  assert.equal(configs.pop().updated, true, 'and the log shows what the transcriber was told');
  session.active = false;
});

await test('the transcriber is told the words of the part in progress', () => {
  const { runtime } = runtimeOn('vocabulary_builder');
  runtime.setInput('topic', 'vegetables and meats', 'user');
  runtime.setPhase('first_pass', 'test');
  runtime.setPlan('first_pass', sanitizePlan({ items: [
    { say: 'gyuuniku', script: '牛肉', meaning: 'beef' },
    { say: 'hourensou', script: 'ほうれん草', meaning: 'spinach' },
    { say: 'butaniku', script: '豚肉', meaning: 'pork' },
  ] }));
  const items = runtime.hintItems();
  assert.deepEqual(items.slice(0, 3).map((item) => item.say), ['gyuuniku', 'hourensou', 'butaniku']);
  const prompt = buildTranscriptionPrompt({ profile: profileFor('Japanese'), expected: items });
  assert.match(prompt, /They are about to practise: 牛肉 \(gyuuniku, beef\); ほうれん草 \(hourensou, spinach\); 豚肉 \(butaniku, pork\)\./,
    'as it is written, as the student reads it, and what it means');
  assert.ok(prompt.length <= 900);
});

/** The vocabulary of the third call, as the planner wrote it. */
const MEATS = Object.freeze({ items: [
  { say: 'gyuuniku', script: '牛肉', meaning: 'beef', note: 'Gyuu is cow, niku is meat.' },
  { say: 'hourensou', script: 'ほうれん草', meaning: 'spinach' },
  { say: 'butaniku', script: '豚肉', meaning: 'pork', note: 'Buta is pig.' },
  { say: 'toumorokoshi', script: 'とうもろこし', meaning: 'corn' },
  { say: 'ramu', script: 'ラム', meaning: 'lamb' },
] });

await test('a long word with a letter or two misheard is the same word', () => {
  // What the recogniser wrote on the call, for words the student says he said.
  for (const [heard, answer] of [['Haorensu', 'hourensou'], ['Lorenzo', 'hourensou'], ['Howdenso', 'hourensou'], ['kao morokoshi', 'toumorokoshi'], ['Tomorokushi', 'toumorokoshi'], ['Botânica', 'butaniku'], ['Ram', 'ramu']]) {
    assert.equal(soundsLike(heard, answer, { wide: true }), true, `${heard} is ${answer}`);
  }
  // Still not it: a syllable that is not there, and something else altogether.
  for (const [heard, answer] of [['gyuuni', 'gyuuniku'], ['sumasen', 'sumimasen'], ['Paurenchu', 'hourensou'], ['gyokuro shi', 'toumorokoshi'], ['toriniku', 'butaniku'], ['ranbo', 'ramu']]) {
    assert.equal(soundsLike(heard, answer, { wide: true }), false, `${heard} is not ${answer}`);
  }
  // A number gets no extra room: one syllable is the whole of the difference.
  assert.equal(isCount('7 o\'clock'), true);
  assert.equal(isCount('600 yen'), true);
  assert.equal(isCount('spinach'), false);
  assert.equal(soundsLike('ichiji', 'shichiji'), false);

  const steps = buildScript(sanitizePlan(MEATS));
  const at = steps.findIndex((step) => step.kind === 'teach' && step.say === 'hourensou');
  assert.ok(at >= 0);
  for (const heard of ['Haorensu', 'Lorenzo']) {
    const turn = turnFor(steps, { language: 'Japanese', current: at, heard });
    assert.deepEqual({ mode: turn.mode, reason: turn.reason }, { mode: 'exact', reason: 'right' }, `${heard}: right, and nobody needs asking`);
  }
  // Unless it is as near to another thing they know: then it may be that.
  const two = buildScript(sanitizePlan({ items: [{ say: 'toriniku', meaning: 'chicken' }, { say: 'butaniku', meaning: 'pork' }, { say: 'nasu', meaning: 'eggplant' }] }));
  const pork = two.findIndex((step) => step.kind === 'recall' && step.say === 'butaniku');
  assert.ok(soundGap('boriniku', 'toriniku') < soundGap('boriniku', 'butaniku'));
  assert.notEqual(turnFor(two, { language: 'Japanese', current: pork, heard: 'boriniku' }).reason, 'right');
});

await test('a meaning is right a letter out, and what was heard is not read back as noise', () => {
  // "What does ramu mean?" — "Lab." — "Not quite. ramu means lamb."
  assert.equal(meaningNear('Lab.', 'lamb'), true);
  assert.equal(meaningNear('corn', 'pork'), false);
  assert.equal(meaningNear('yes', 'lamb'), false);
  assert.equal(meaningNear('600', '600 yen'), false, 'figures are matched as figures');
  const steps = buildScript(sanitizePlan(MEATS));
  const at = steps.findIndex((step) => step.kind === 'recognise' && step.say === 'ramu');
  if (at >= 0) assert.equal(turnFor(steps, { language: 'Japanese', current: at, heard: 'Lab.' }).reason, 'right');
  const any = steps.findIndex((step) => step.kind === 'recognise');
  assert.equal(turnFor(steps, { language: 'Japanese', current: any, heard: `${steps[any].meaning.slice(0, -1)}` }).reason, 'right');

  // "It's oumo, not amu" — said of toumorokoshi.
  assert.doesNotMatch(correctionFor('tamurokoshi', 'toumorokoshi'), /"oumo"|"amu"/);
  // Three words of something else are not read back as an attempt at one.
  assert.equal(correctionFor('taoma o hoshii', 'toumorokoshi'), 'Once more: "toumorokoshi".');
});

await test('speech that could not be made out is not called wrong', () => {
  // An empty transcript was answered "Not quite. I heard yes. It's butaniku o kudasai."
  const steps = buildScript(sanitizePlan(MEATS));
  const first = turnFor(steps, { language: 'Japanese', current: 0, heard: '', unheard: 1 });
  assert.equal(first.mode, 'exact');
  assert.equal(first.line, 'Sorry, I didn\'t catch that. "gyuuniku" means beef. Say it.');
  assert.equal(first.advances, false);
  const second = turnFor(steps, { language: 'Japanese', current: 0, heard: '', unheard: 2 });
  assert.match(second.line, /^I'm still not catching it\. Let's keep going\. /, 'the second time running, the lesson goes on');
  assert.equal(second.advances, true);
  assert.doesNotMatch(`${first.line} ${second.line}`, /Not quite|I heard/);
  // Heard by the model, when it is asked: right.
  const heard = turnFor(steps, { language: 'Japanese', current: 0, heard: '', unheard: 1, verdict: { verdict: 'right', heard: '' } });
  assert.equal(heard.reason, 'right');
});

await test('before a guess is used against them, the model that heard them is asked', async () => {
  assert.match(earPrompt({ language: 'Japanese', answer: 'hourensou', meaning: 'spinach' }), /They were asked to say: "hourensou" \(spinach\)\./);
  assert.equal(hearsYes('Yes.'), 'yes');
  assert.equal(hearsYes('no'), 'no');
  assert.equal(hearsYes('They said spinach'), '');

  const asked = [];
  let answer = 'yes';
  const rig = conductorRig({}, {
    directed: true,
    judge: async (question) => ({ ok: true, verdict: 'wrong', heard: question.transcript, other: '' }),
    hear: (itemIds, instructions) => { asked.push({ itemIds, instructions }); return { result: Promise.resolve(answer), cancel() {} }; },
  });
  rig.library.activate('restaurant', { reason: 'ui' });
  rig.library.fetchPlan = async () => ({ ok: true, plan: sanitizePlan(MEATS), error: null });
  await rig.conductor.ensurePlan('', { quiet: true });
  rig.conductor.handleTutorTurn(rig.conductor.openingTurn().say);

  // "gyuuniku" — written down as noise. Heard by the model: right.
  let decided = await rig.conductor.answerStudent('Paurenchu', { itemIds: ['item_1'] });
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].itemIds, ['item_1']);
  assert.match(asked[0].instructions, /"gyuuniku" \(beef\)/);
  assert.equal(decided.turn.reason, 'right');
  assert.doesNotMatch(decided.say, /Not quite|I heard|Once more/);
  rig.conductor.handleTutorTurn(decided.say);

  // Not heard by the model either: then it is corrected.
  answer = 'no';
  decided = await rig.conductor.answerStudent('Paurenchu', { itemIds: ['item_2'] });
  assert.equal(asked.length, 2);
  assert.notEqual(decided.turn.reason, 'right');
  rig.conductor.handleTutorTurn(decided.say);

  // A plain attempt a letter or two out is believed as written: nobody is asked.
  const here = rig.library.runtime.currentScript()[rig.library.runtime.cursors[rig.library.runtime.phaseId]];
  const wanted = here.kind === 'scene' ? here.expect : here.say;
  decided = await rig.conductor.answerStudent(wanted.slice(0, -2), { itemIds: ['item_3'] });
  assert.equal(asked.length, 2, 'a syllable left off is a syllable left off');

  // Nothing written down at all: asked, and if it was said, it was said.
  answer = 'yes';
  const blank = conductorRig({}, { directed: true, hear: (itemIds) => { asked.push({ itemIds }); return { result: Promise.resolve(answer), cancel() {} }; } });
  blank.library.activate('restaurant', { reason: 'ui' });
  await blank.conductor.ensurePlan('', { quiet: true });
  blank.conductor.handleTutorTurn(blank.conductor.openingTurn().say);
  decided = await blank.conductor.answerStudent('', { itemIds: ['item_9'], unheard: true });
  assert.equal(decided.turn.reason, 'right');
  blank.conductor.handleTutorTurn(decided.say);
  answer = '';
  decided = await blank.conductor.answerStudent('', { itemIds: ['item_10'], unheard: true });
  assert.match(decided.say, /^Sorry, I didn't catch that\. /, 'no answer from it: nothing is assumed either way');
  blank.conductor.handleTutorTurn(decided.say);
  decided = await blank.conductor.answerStudent('', { itemIds: ['item_11'], unheard: true });
  assert.match(decided.say, /^I'm still not catching it\. /);
  rig.conductor.stop();
  blank.conductor.stop();
});

await test('the judge and the ear are asked together, and the ear is let go when it is not needed', async () => {
  const order = [];
  let cancelled = 0;
  const rig = conductorRig({}, {
    directed: true,
    judge: async () => { order.push('judge'); return { ok: true, verdict: 'question', heard: '', other: '' }; },
    hear: () => { order.push('ear'); return { result: new Promise(() => {}), cancel() { cancelled += 1; } }; },
  });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  rig.conductor.handleTutorTurn(rig.conductor.openingTurn().say);
  const decided = await rig.conductor.answerStudent('zzz kkk ppp', { itemIds: ['item_1'] });
  assert.deepEqual(order, ['ear', 'judge'], 'the ear is asked before the judge has answered, not after');
  assert.equal(cancelled, 1, 'and is not waited for when the judge says it was a question');
  assert.equal(decided.turn.mode, 'question');
  rig.conductor.stop();
});

await test('a session can be asked what it heard, outside the conversation', async () => {
  const sent = [];
  const events = [];
  const spoken = [];
  const session = new RealtimeSession({
    onTurnEvent: (event) => events.push(event),
    onTutorDelta: (payload) => spoken.push(payload),
    onTutorDone: (payload) => spoken.push(payload),
  });
  session.active = true;
  session.dc = { readyState: 'open', send: (json) => sent.push(JSON.parse(json)) };
  const feedTo = (type, extra = {}) => session.handleServerEvent({ data: JSON.stringify({ type, ...extra }) });

  const ear = session.listen(['item_7'], 'Did they say "hourensou"?');
  const request = sent[0];
  assert.equal(request.type, 'response.create');
  assert.equal(request.response.conversation, 'none', 'not part of the conversation');
  assert.deepEqual(request.response.output_modalities, ['text'], 'and not spoken');
  assert.deepEqual(request.response.input[0], { type: 'item_reference', id: 'item_7' }, 'it is pointed at what the student said');
  assert.equal(session.earBusy, true);

  // A reply asked for meanwhile waits behind it.
  session.respond('Say the line.', { say: 'Hai.' });
  await settle();
  assert.equal(sent.filter((event) => event.type === 'response.create').length, 1);

  feedTo('response.created', { response: { id: 'resp_ear', metadata: { purpose: 'ear' } } });
  feedTo('response.output_text.delta', { response_id: 'resp_ear', delta: 'Yes' });
  feedTo('response.output_text.done', { response_id: 'resp_ear', text: 'Yes.' });
  feedTo('response.done', { response: { id: 'resp_ear', status: 'completed', output: [{ content: [{ type: 'output_text', text: 'Yes.' }] }] } });
  assert.equal(await ear.result, 'Yes.');
  assert.deepEqual(spoken, [], 'none of it is the tutor speaking');
  assert.ok(!events.some((event) => event.event === 'created' || event.event === 'done'), 'or a turn of the lesson');
  await settle();
  assert.equal(sent.filter((event) => event.type === 'response.create').length, 2, 'and then the reply goes out');

  // If the session will not take the question, it is not asked again on this call.
  feedTo('response.created', { response: { id: 'r2' } });
  feedTo('response.done', { response: { id: 'r2', status: 'completed' } });
  const refused = session.listen(['item_8'], 'Did they say it?');
  const refusedId = sent[sent.length - 1].event_id;
  feedTo('error', { error: { message: 'Unknown parameter', event_id: refusedId } });
  assert.equal(await refused.result, '');
  assert.equal(session.earOff, true);
  const before = sent.length;
  assert.equal(await session.listen(['item_9'], 'Did they say it?').result, '');
  assert.equal(sent.length, before);
  session.active = false;
});

await test('a word missed twice is let go: not asked for again, and said once more at the end', async () => {
  // "hourensou" was asked for seven times in one lesson, "toumorokoshi" six.
  const { runtime } = runtimeOn('vocabulary_builder');
  runtime.setInput('topic', 'vegetables and meats', 'user');
  runtime.setPhase('first_pass', 'test');
  runtime.setPlan('first_pass', sanitizePlan(MEATS));
  const steps = runtime.currentScript();
  const quick = () => runtime.currentScript().filter((step) => step.quick).map((step) => step.say);
  assert.ok(quick().includes('hourensou'), 'the part closes on a quick round with the word in it');
  const teach = steps.find((step) => step.kind === 'teach' && step.say === 'hourensou');
  assert.equal(runtime.noteTold(teach), false, 'once is a miss');
  assert.equal(runtime.noteTold(teach), true, 'twice, and it is let go');
  assert.ok(!quick().includes('hourensou'), 'it is taken out of the round that was going to ask for it');
  assert.ok(runtime.currentScript().find((step) => step.quick).first, 'which still opens as a round');
  assert.equal(runtime.noteTold(teach), false, 'and is only let go once');

  // The review does not test it a third time. It says it once more.
  runtime.moveTo(steps.length - 1);
  const review = buildScript(null, { mode: 'review', taught: MEATS.items, ...runtime.scriptOptions('wrap_up') });
  assert.equal(lineFor(review[0], 'Japanese'), 'One to hear again: "hourensou" means spinach. Say it.');
  assert.ok(!review.some((step) => step.quick && step.say === 'hourensou'));
  // Whatever they then say, the lesson goes on without comment.
  const turn = turnFor(review, { language: 'Japanese', current: 0, heard: 'Paurenchu' });
  assert.deepEqual({ reason: turn.reason, advances: turn.advances, credit: turn.credit }, { reason: 'right', advances: true, credit: false });
  assert.doesNotMatch(turn.line, /Not quite|Hai/);

  // In the lesson itself: two misses in a quick round, and no third asking.
  const rig = conductorRig({}, { directed: true, judge: async (question) => ({ ok: true, verdict: 'wrong', heard: question.transcript, other: '' }) });
  rig.library.runtime.setInput('topic', 'meats', 'user');
  rig.library.runtime.setPhase('first_pass', 'test');
  rig.library.fetchPlan = async () => ({ ok: true, plan: sanitizePlan(MEATS), error: null });
  await rig.conductor.ensurePlan('', { quiet: true });
  const live = rig.library.runtime;
  const script = live.currentScript();
  const first = script.findIndex((step) => step.quick && step.say === 'hourensou');
  live.moveTo(first);
  let decided = await rig.conductor.answerStudent('zzzz');
  assert.match(decided.say, /^It's "hourensou"\. /);
  rig.conductor.handleTutorTurn(decided.say);
  const again = live.currentScript().findIndex((step, index) => index > first && step.quick && step.say === 'hourensou');
  assert.ok(again > first, 'missed once, it comes round once more');
  live.moveTo(again);
  decided = await rig.conductor.answerStudent('zzzz');
  rig.conductor.handleTutorTurn(decided.say);
  assert.ok(live.parked.has('hourensou'));
  assert.ok(!live.currentScript().some((step, index) => index > again && step.quick && step.say === 'hourensou'), 'missed twice, it does not');
  assert.ok(rig.logs.some((entry) => entry.type === 'script.letGo' && entry.payload.say === 'hourensou'));
  rig.conductor.stop();
});

await test('the review asks for what was missed, and the last line of a lesson says it is the last', () => {
  // Eleven things had been taught; the last eight left out the word missed
  // five times. And it closed "you can now say: without bell pepper, please.
  // Ready for the next part?" — there was no next part.
  const taught = [
    { say: 'gyuuniku', meaning: 'beef' }, { say: 'hourensou', meaning: 'spinach' }, { say: 'butaniku', meaning: 'pork' },
    { say: 'gyuuniku o kudasai', meaning: 'beef, please' }, { say: 'toriniku', meaning: 'chicken' }, { say: 'ramu', meaning: 'lamb' },
    { say: 'nasu', meaning: 'eggplant' }, { say: 'toumorokoshi', meaning: 'corn' }, { say: 'butaniku o kudasai', meaning: 'pork, please' },
    { say: 'kyabetsu o kudasai', meaning: 'cabbage, please' }, { say: 'piiman nuki de onegaishimasu', meaning: 'without bell pepper, please' },
  ];
  const review = buildScript(null, { mode: 'review', taught, fumbled: new Map([['hourensou', 5], ['toumorokoshi', 3]]) });
  const asked = review.filter((step) => step.quick).map((step) => step.say);
  assert.ok(asked.includes('hourensou') && asked.includes('toumorokoshi'), 'the most-missed are in it');
  assert.equal(new Set(asked).size, asked.length);
  assert.ok(asked.includes('gyuuniku') && asked.includes('kyabetsu'), 'a word and the request made with it are one thing, so there is room for all of them');
  const wrap = review[review.length - 1];
  assert.equal(wrap.review, true);
  assert.equal(lineFor({ ...wrap, final: true }, 'Japanese'), "Review done. That's the end of the lesson.");
  assert.equal(
    lineFor({ ...wrap, final: true, missed: [{ say: 'toumorokoshi', meaning: 'corn' }] }, 'Japanese'),
    'Review done. For next time: "toumorokoshi" for corn. That\'s the end of the lesson.',
  );
  assert.doesNotMatch(lineFor({ ...wrap, final: true }, 'Japanese'), /you can now say|Ready for the next part/);
  // A part that is not the last still asks.
  assert.match(lineFor({ kind: 'wrap', items: ['beef'] }, 'Japanese'), /Ready for the next part\?$/);

  const { runtime } = runtimeOn('vocabulary_builder');
  assert.equal(runtime.isLastPart(), false);
  runtime.setPhase('wrap_up', 'test');
  assert.equal(runtime.isLastPart(), true);
});

await test('the end of a lesson is said once, by the lesson, and nobody is congratulated', async () => {
  const code = await readAll(['public/shared/conductor.js']);
  assert.match(code, /is finished, and the student has just been told so\. Do not say it ` \+\s+'again, do not congratulate them/);
});

await test('"Yes." is not an attempt at a phrase, and a given answer said back is not a wrong one', async () => {
  // "Ask for pork." — "Yes." — "I asked you to request pork politely in
  // Japanese, but the actual phrase isn't given here."
  assert.equal(bareYes('Yes.'), true);
  assert.equal(bareYes('OK, ready'), true);
  assert.equal(bareYes('Yes, gyuuniku'), false);
  assert.equal(bareYes('hai'), false, 'which may be the answer');
  const steps = buildScript(sanitizePlan(MEATS));
  const turn = turnFor(steps, { language: 'Japanese', current: 0, heard: 'Yes.' });
  assert.deepEqual({ mode: turn.mode, reason: turn.reason, advances: turn.advances }, { mode: 'exact', reason: 'echo', advances: false });
  assert.equal(turn.line, '"gyuuniku" means beef. Say it.');

  // "It's ramu. Let's keep going. Quick round. What is chicken?" — "ramu."
  const rig = conductorRig({}, { directed: true, judge: async (question) => ({ ok: true, verdict: 'wrong', heard: question.transcript, other: '' }) });
  rig.library.activate('restaurant', { reason: 'ui' });
  rig.library.fetchPlan = async () => ({ ok: true, plan: sanitizePlan(MEATS), error: null });
  await rig.conductor.ensurePlan('', { quiet: true });
  const runtime = rig.library.runtime;
  const recall = runtime.currentScript().findIndex((step) => step.kind === 'recall' && step.say === 'gyuuniku');
  runtime.moveTo(recall);
  runtime.misses = 1;
  let decided = await rig.conductor.answerStudent('I do not know');
  assert.match(decided.say, /^It's "gyuuniku"\. /);
  rig.conductor.handleTutorTurn(decided.say);
  assert.equal(runtime.cursors[runtime.phaseId], recall + 1);
  decided = await rig.conductor.answerStudent('牛肉');
  assert.match(decided.say, /^Yes, "gyuuniku"\. /, 'said back — as the recogniser writes it — it is acknowledged');
  assert.equal(decided.turn.advances, false, 'and what was asked is asked again');
  assert.equal(decided.turn.reason, 'echo');
  rig.conductor.stop();
});

await test('a part of single words has one exchange, or none', async () => {
  // "Anything else?" as an opening. "Which would you like?" with nothing
  // offered. "Would you like any vegetables?" — "hai" — and nothing.
  const plan = sanitizePlan({ ...MEATS, scene: { setup: "I'm the waiter and you are ready to order.", lines: [
    { tutor: 'hoka ni gochuumon wa gozaimasu ka', meaning: 'Anything else?', expect: 'butaniku', reply: 'kashikomarimashita', reply_meaning: 'certainly' },
    { tutor: 'dochira ni nasaimasu ka', meaning: 'Which would you like?', expect: 'hourensou', reply: 'kashikomarimashita', reply_meaning: 'certainly' },
    { tutor: 'yasai wa ikaga nasaimasu ka', meaning: 'Would you like any vegetables?', expect: 'hourensou', reply: 'kashikomarimashita', reply_meaning: 'certainly' },
    { tutor: 'nani ni nasaimasu ka', meaning: 'What will you have?', expect: 'gyuuniku', reply: 'kashikomarimashita', reply_meaning: 'certainly' },
  ] } });
  const single = buildScript(plan, { scene: 'single', round: true });
  const scenes = single.filter((step) => step.kind === 'scene');
  assert.deepEqual(scenes.map((step) => step.tutor), ['nani ni nasaimasu ka'], 'the one open question, and only that');
  assert.equal(scenes[0].single, true);
  assert.equal(buildScript(plan, { scene: 'none', round: true }).filter((step) => step.kind === 'scene').length, 0);
  assert.ok(buildScript(plan, { scene: 'full' }).filter((step) => step.kind === 'scene').length >= 3, 'other lessons are as they were');

  // Any of the words answers it — two at once, with or without the asking.
  const at = single.findIndex((step) => step.kind === 'scene');
  const two = turnFor(single, { language: 'Japanese', current: at, heard: 'buta niku tohouren kusa kudasai 豚肉とほうれん草ください' });
  assert.equal(two.reason, 'right');
  assert.match(two.line, /^"butaniku to hourensou desu ne\. kashikomarimashita" — pork and spinach, right\? Certainly\. /);
  assert.doesNotMatch(two.line, /A little later/, 'one exchange is not a meal');
  const bareWord = turnFor(single, { language: 'Japanese', current: at, heard: 'toumorokoshi' });
  assert.equal(bareWord.reason, 'right', 'the word alone is an answer to "what will you have?"');
  assert.deepEqual(thingsNamed('Tomorokushi toranbo Kudasai.', MEATS.items), [{ word: 'toumorokoshi', thing: 'corn' }], 'found by sound');
  assert.deepEqual(thingsNamed('buta niku tohouren kusa kudasai 豚肉とほうれん草ください', [...MEATS.items, { say: 'toriniku', meaning: 'chicken', script: '鶏肉' }]).map((entry) => entry.word),
    ['butaniku', 'hourensou'], 'and never out of a stretch of letters that only happens to be near a word');

  // "Do you want bell pepper?" — "piiman to tamanegi."
  const yesNo = buildScript(sanitizePlan({ items: [{ say: 'piiman', meaning: 'bell pepper', script: 'ピーマン' }, { say: 'tamanegi', meaning: 'onion', script: '玉ねぎ' }, { say: 'piiman nuki de onegaishimasu', meaning: 'without bell pepper, please' }],
    scene: { setup: 'I am the waiter.', lines: [
      { tutor: 'gochuumon wa', meaning: 'Your order?', expect: 'piiman', reply: 'kashikomarimashita', reply_meaning: 'certainly' },
      { tutor: 'piiman wa irimasu ka', meaning: 'Do you want bell pepper?', expect: 'piiman nuki de onegaishimasu', reply: 'kashikomarimashita', reply_meaning: 'certainly' },
    ] } }));
  const ask = yesNo.findIndex((step) => step.kind === 'scene' && step.tutor === 'piiman wa irimasu ka');
  const named = turnFor(yesNo, { language: 'Japanese', current: ask, heard: 'piiman to tamanegi ピーマンと玉ねぎ' });
  assert.equal(named.reason, 'right', 'naming what they want answers being asked whether they want something');
  assert.match(named.line, /piiman to tamanegi desu" — thank you for waiting: bell pepper and onion\./, 'and it is what they named that arrives');

  // The vocabulary lesson is set up that way.
  const skill = SKILLS.find((entry) => entry.id === 'vocabulary_builder');
  assert.deepEqual(skill.phases.map((phase) => phase.role_play), ['full', 'single', 'none', 'single', 'full']);
  const base = { language: 'Japanese', level: 'Beginner', skill, mode: 'teach', subject: 'vegetables', facts: [], taught: [], known: [] };
  const one = buildPlanPrompt({ ...base, phase: skill.phases[1] });
  assert.match(one, /Exactly one line\./);
  assert.match(one, /Never a yes-or-no question, never "anything else\?", never "which would you like\?"/);
  assert.doesNotMatch(one, /A narrow question comes before an open one/);
  assert.match(buildPlanPrompt({ ...base, phase: skill.phases[2] }), /This part has no role-play\./);
  assert.match(buildPlanPrompt({ ...base, phase: SKILLS.find((entry) => entry.id === 'restaurant').phases[0] }), /A narrow question comes before an open one/);
});

await test('a word already taught is not taught again, and a long vowel is not written short', () => {
  // "Next: using them. butaniku means pork: niku means meat. Ask for pork" —
  // to a student who had said butaniku six times.
  const taught = [
    { say: 'gyuuniku', meaning: 'beef' }, { say: 'butaniku', meaning: 'pork' }, { say: 'gyuuniku o kudasai', meaning: 'beef, please' },
  ];
  const steps = buildScript(sanitizePlan({ items: [
    { say: 'butaniku o kudasai', meaning: 'pork, please', note: 'Niku means meat.', use: 'You want to order pork.', reply: 'kashikomarimashita', reply_meaning: 'certainly' },
    { say: 'kyabetsu o kudasai', meaning: 'cabbage, please', use: 'You want to order cabbage.', reply: 'kashikomarimashita', reply_meaning: 'certainly' },
  ] }), { taught });
  assert.equal(steps[0].kind, 'recall', 'it is asked for');
  assert.equal(lineFor(steps[0], 'Japanese'), 'How do you say "pork, please"?');
  assert.ok(!steps.some((step) => step.kind === 'teach' && /butaniku/.test(step.say)));
  assert.ok(steps.some((step) => step.kind === 'teach' && step.build && step.word === 'kyabetsu'), 'a new word is still given');

  // "niku is meat" in one part and "niku means meat" in the next is one explanation.
  const { runtime } = runtimeOn('vocabulary_builder');
  runtime.setInput('topic', 'meats', 'user');
  runtime.setPhase('first_pass', 'test');
  runtime.setPlan('first_pass', sanitizePlan(MEATS));
  assert.ok(runtime.notesSaid('recall').has('head:niku'));
  const later = buildScript(sanitizePlan({ items: [{ say: 'toriniku', meaning: 'chicken', note: 'Tori is bird, niku means meat.' }, { say: 'nasu', meaning: 'eggplant' }] }), { notes: runtime.notesSaid('recall') });
  assert.equal(later[0].note, 'Tori is bird');

  // "piman" was taught, said and saved for ピーマン.
  assert.deepEqual(longVowelFixes('ピーマン抜きでお願いします'), [['piman', 'piiman']]);
  assert.deepEqual(longVowelFixes('コーヒーをください'), [['kohi', 'koohii']]);
  assert.deepEqual(longVowelFixes('ナス'), []);
  assert.deepEqual(longVowelFixes('牛肉'), []);
});

await test('a reply that was never heard can be taken back, and a noise does not cost the tutor its line', async () => {
  const rig = conductorRig({}, { directed: true, judge: async (question) => ({ ok: true, verdict: 'wrong', heard: question.transcript, other: '' }) });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  const runtime = rig.library.runtime;
  const opening = rig.conductor.openingTurn();

  // The opening line was asked for and a cough stopped it before it began.
  assert.equal(rig.conductor.resay().say, opening.say, 'it is said');
  rig.conductor.handleTutorTurn(opening.say);
  assert.equal(rig.conductor.resay(), null, 'once it has been said there is nothing to say again');
  assert.equal(rig.conductor.resay({ cut: true }).say, '"sumimasen" means excuse me. Say it.', 'unless it was cut off part-way: then what was asked is asked again');
  rig.conductor.handleTutorTurn('"sumimasen" means excuse me. Say it.');

  // Half an answer, marked wrong — and then they went on speaking.
  runtime.moveTo(1);
  const before = { fumbled: new Map(runtime.fumbled), missed: new Map(runtime.missed) };
  const half = await rig.conductor.answerStudent('zzz');
  assert.notEqual(half.turn.reason, 'right');
  assert.equal(rig.conductor.retract(), true);
  assert.deepEqual([...runtime.missed], [...before.missed], 'the miss is taken back with the reply');
  assert.deepEqual([...runtime.fumbled], [...before.fumbled]);
  const whole = await rig.conductor.answerStudent('futari desu');
  assert.equal(whole.turn.reason, 'right');

  // Going back to an earlier part cannot be un-done by going on speaking.
  rig.conductor.fixed = true;
  assert.equal(rig.conductor.retract(), false);

  // Is it, as it stands, an answer? Then there is nothing to wait for.
  runtime.moveTo(2);
  const step = runtime.currentScript()[2];
  assert.equal(rig.conductor.completes(step.kind === 'recognise' ? step.meaning : step.say), true);
  assert.equal(rig.conductor.completes('zzz to'), false);
  rig.conductor.stop();
});

await test('a reply asked for a moment after they began speaking again is stopped, and nobody is told', async () => {
  const sent = [];
  const errors = [];
  const session = new RealtimeSession({ onError: (error) => errors.push(error) });
  session.active = true;
  session.dc = { readyState: 'open', send: (json) => sent.push(JSON.parse(json)) };
  const feedTo = (type, extra = {}) => session.handleServerEvent({ data: JSON.stringify({ type, ...extra }) });

  assert.equal(session.cancelReply(), false, 'nothing on its way: nothing to stop');
  session.respond('Say the line.', { say: 'Not quite.' });
  await settle();
  assert.equal(sent.filter((event) => event.type === 'response.create').length, 1);
  assert.equal(session.cancelReply(), true);
  assert.equal(sent[sent.length - 1].type, 'response.cancel');
  // If it had already stopped, the session says so. That is not an error to show.
  feedTo('error', { error: { code: 'response_cancel_not_active', message: 'Cancellation failed: no active response found' } });
  assert.deepEqual(errors, []);

  // Once it can be heard it is the session's to stop, as it always was.
  feedTo('response.created', { response: { id: 'r1' } });
  feedTo('response.output_audio_transcript.delta', { response_id: 'r1', delta: 'Not' });
  const before = sent.length;
  assert.equal(session.cancelReply(), false);
  assert.equal(sent.length, before);
  session.active = false;

  const app = await readAll(['public/js/app.js']);
  assert.match(app, /if \(taken\) state\.session\?\.cancelReply\(\);/);
});

// What a second reader found in the above, each reproduced before it was fixed.

await test('words that are slow to be written down still end up in the turn they belong to', () => {
  // The first half's written version came after the second half's, and after
  // its own wait had run out: the turn was answered as "…sou" alone.
  const rig = turnRig();
  rig.turns.speechStarted({});
  rig.turns.speechStopped({});
  rig.turns.committed('a');
  rig.pass(1200);
  rig.turns.speechStarted({});
  rig.turns.speechStopped({});
  rig.turns.committed('b');
  rig.pass(400);                        // a's wait runs out; b's has not
  rig.turns.transcript('b', 'そう');
  assert.deepEqual(rig.answers.map((answer) => answer.text), ['そう']);
  rig.turns.transcript('a', 'ほうれん');
  assert.equal(rig.retracts, 1, 'the reply to half of it is taken back');
  assert.deepEqual(rig.answers.map((answer) => answer.text), ['そう', 'ほうれん そう']);

  // Spoken over the end of the tutor's line, and slow to be written down: set
  // aside as a noise — until the words arrive.
  const over = turnRig();
  over.say('a', null, { overTutor: true, to: 2000 });
  over.pass(1600);
  assert.equal(over.noise.length, 1);
  over.turns.transcript('a', 'ほうれん草');
  assert.deepEqual(over.answers.map((answer) => answer.text), ['ほうれん草'], 'it was speech after all');
  over.turns.transcript('a', 'ほうれん草');
  assert.equal(over.answers.length, 1, 'once');
});

await test('a line cut off part-way is finished once the interruption is known for what it was', async () => {
  const rig = conductorRig({}, { directed: true, judge: async (question) => ({ ok: true, verdict: 'wrong', heard: question.transcript, other: '' }) });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  const runtime = rig.library.runtime;
  rig.conductor.handleTutorTurn(rig.conductor.openingTurn().say);
  const decided = await rig.conductor.answerStudent('sumimasen');
  rig.replies.length = 0;

  // A sentence in, something is heard and the session stops the tutor.
  const part = `${decided.say.split('. ')[0]}.`;
  assert.notEqual(part, decided.say);
  rig.conductor.handleTutorTurn(part, { cut: true });
  assert.equal(rig.replies.length, 0, 'nothing is asked for on top of whoever is speaking');
  assert.equal(runtime.cursors[runtime.phaseId], 0, 'and the lesson has not moved');
  assert.ok(rig.logs.some((entry) => entry.type === 'script.cut'));

  // It was a cough: the rest of the line, and only the rest, once.
  const rest = rig.conductor.resay();
  assert.equal(`${part} ${rest.say}`, decided.say);
  rig.conductor.handleTutorTurn(rest.say);
  assert.equal(runtime.cursors[runtime.phaseId], 1, 'the two pieces are one line, and it has now been said');
  assert.equal(rig.conductor.resay(), null, 'and there is nothing left to say again');

  // It was the student, speaking over a question they had not finished
  // hearing: the rest of it is said, and nothing they said is marked.
  const next = await rig.conductor.answerStudent('futari desu');
  const cutAt = next.say.split(' ').slice(0, 2).join(' ');
  rig.conductor.handleTutorTurn(cutAt, { cut: true });
  const missedBefore = new Map(runtime.missed);
  const over = await rig.conductor.answerStudent('zzz zzz');
  assert.ok(next.say.endsWith(over.say), 'the line, or the rest of it');
  assert.deepEqual([...runtime.missed], [...missedBefore]);
  assert.ok(rig.logs.some((entry) => entry.type === 'script.spokenOver'));

  // Without a cut — the tutor simply stopped short — it is asked for again as before.
  const plain = conductorRig({}, { directed: true });
  plain.library.activate('restaurant', { reason: 'ui' });
  await plain.conductor.ensurePlan('', { quiet: true });
  const opening = plain.conductor.openingTurn();
  plain.replies.length = 0;
  plain.conductor.handleTutorTurn(opening.say.split(' ').slice(0, 2).join(' '));
  assert.equal(plain.replies.length, 1);
  rig.conductor.stop();
  plain.conductor.stop();
});

await test('taking a reply back puts back everything the reply used up', async () => {
  const rig = conductorRig({}, { directed: true, judge: async (question) => ({ ok: true, verdict: 'wrong', heard: question.transcript, other: '' }) });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  const runtime = rig.library.runtime;
  rig.conductor.handleTutorTurn(rig.conductor.openingTurn().say);

  // Two stretches of nothing, the second before the reply to the first was
  // heard: that is one turn of nothing, not two — the step is not skipped.
  let decided = await rig.conductor.answerStudent('', { unheard: true });
  assert.match(decided.say, /^Sorry, I didn't catch that\./);
  assert.equal(rig.conductor.retract(), true);
  decided = await rig.conductor.answerStudent('', { unheard: true });
  assert.match(decided.say, /^Sorry, I didn't catch that\./, 'still the first time, as far as they have heard');

  // The answer the tutor gave to a question, said back in two breaths.
  rig.conductor.retract();
  rig.conductor.lastAnswer = { text: 'It\'s okaikei onegaishimasu.', phase: runtime.phaseId };
  await rig.conductor.answerStudent('okaikei');
  assert.equal(rig.conductor.lastAnswer, null);
  rig.conductor.retract();
  assert.ok(rig.conductor.lastAnswer, 'it is still what they were just told');
  decided = await rig.conductor.answerStudent('okaikei onegaishimasu');
  assert.equal(decided.turn.reason, 'echo', 'and saying it back is still not a wrong answer');

  // A question that asks for words is not a change of place: it can be taken back too.
  rig.conductor.retract();
  await rig.conductor.answerStudent('How do I say potato');
  assert.equal(rig.conductor.fixed, false);
  assert.equal(rig.conductor.retract(), true);

  // Going back is: and then nothing about it is dropped.
  rig.conductor.fixed = true;
  const answering = rig.conductor.answering;
  assert.equal(rig.conductor.retract(), false);
  assert.equal(rig.conductor.answering, answering, 'a reply that moved the lesson is still given');

  // Letting a word go takes steps out of later parts; taking the reply back puts them back.
  const { runtime: later } = runtimeOn('vocabulary_builder');
  later.setInput('topic', 'meats', 'user');
  later.setPhase('first_pass', 'test');
  later.setPlan('first_pass', sanitizePlan(MEATS));
  later.scripts.recall = [{ kind: 'recall', say: 'nasu', meaning: 'eggplant', quick: true, first: true }, { kind: 'recall', say: 'hourensou', meaning: 'spinach', quick: true }, { kind: 'wrap', items: [] }];
  later.cursors.recall = -1;
  const mark = later.mark();
  const teach = later.currentScript().find((step) => step.kind === 'teach' && step.say === 'hourensou');
  later.noteTold(teach);
  later.noteTold(teach);
  assert.equal(later.scripts.recall.length, 2, 'let go: taken out of the part still to come');
  assert.equal(later.restore(mark), true);
  assert.equal(later.scripts.recall.length, 3, 'in every part');
  assert.equal(later.parked.has('hourensou'), false);
  rig.conductor.stop();
});

await test('the model that heard them can say there was nothing to hear', async () => {
  assert.equal(hearsYes('Nothing.'), 'nothing');
  assert.match(earPrompt({ answer: 'hourensou' }), /Answer nothing if there was no speech in it at all/);
  let answer = 'nothing';
  const rig = conductorRig({}, { directed: true, hear: () => ({ result: Promise.resolve(answer), cancel() {} }) });
  rig.library.activate('restaurant', { reason: 'ui' });
  await rig.conductor.ensurePlan('', { quiet: true });
  rig.conductor.handleTutorTurn(rig.conductor.openingTurn().say);
  assert.equal(await rig.conductor.answerStudent('', { itemIds: ['item_1'], unheard: true }), false, 'a cough is not answered');
  assert.equal(await rig.conductor.answerStudent('', { itemIds: ['item_2'], unheard: true }), false, 'nor a second one — and the step is not skipped for it');
  answer = 'no';
  const spoke = await rig.conductor.answerStudent('', { itemIds: ['item_3'], unheard: true });
  assert.match(spoke.say, /^Sorry, I didn't catch that\./, 'speech that was not the answer is');
  rig.conductor.stop();
});

await test('what merely sounds like a word does not beat what plainly is one', () => {
  const foods = [{ say: 'gyuuniku', meaning: 'beef' }, { say: 'gyuunyuu', meaning: 'milk' }, { say: 'nagaimo', meaning: 'yam' }, { say: 'jagaimo', meaning: 'potato' }];
  assert.deepEqual(thingsNamed('gyuunyuu o kudasai', foods), [{ word: 'gyuunyuu', thing: 'milk' }], '"gyuunyuu" was taken for beef');
  assert.deepEqual(thingsNamed('jagaimo o kudasai', foods), [{ word: 'jagaimo', thing: 'potato' }]);
  assert.deepEqual(thingsNamed('gyuniku to jagaimu kudasai', foods).map((entry) => entry.word), ['gyuuniku', 'jagaimo'], 'a letter out is still found');

  // A word with the answer inside it is not the answer.
  for (const [heard, answer] of [['shichiji', 'ichiji'], ['juuichiji', 'ichiji'], ['nijuppun', 'juppun'], ['nihyakuen', 'hyakuen'], ['yonjuugofun', 'juugofun']]) {
    assert.equal(answersStep({ kind: 'recall', say: answer }, heard), false, `${heard} is not ${answer}`);
    assert.equal(soundsLike(heard, answer), false, `${heard} does not sound like ${answer}`);
  }
  // Run together with a little word, or said as separate words, it still is.
  assert.equal(answersStep({ kind: 'recall', say: 'gyuuniku' }, 'hai gyuunikudesu'), true);
  assert.equal(answersStep({ kind: 'recall', say: 'nanajuu hachi' }, 'nana juu hachi'), true);
  // The ending is the meaning.
  assert.equal(soundsLike('fukuro wa irimasu', 'fukuro wa irimasen'), false);
  assert.equal(soundsLike('wakarimasu', 'wakarimasen', { wide: true }), false);
  assert.equal(soundsLike('sumimase', 'sumimasen'), true, 'a letter dropped is still a letter dropped');

  // A letter out — unless that is exactly another thing they know.
  const counters = buildScript(sanitizePlan({ items: [{ say: 'muttsu', meaning: 'six things' }, { say: 'mittsu', meaning: 'three things' }, { say: 'hitotsu', meaning: 'one thing' }] }));
  const three = counters.findIndex((step) => step.kind === 'teach' && step.say === 'mittsu');
  assert.notEqual(turnFor(counters, { language: 'Japanese', current: three, heard: 'mutsu' }).reason, 'right', '"mutsu" is muttsu');
  assert.equal(turnFor(counters, { language: 'Japanese', current: three, heard: 'mitsu' }).reason, 'right');

  // And a meaning a letter out is not right when it is another thing's meaning.
  const drinks = buildScript(sanitizePlan({ items: [{ say: 'biiru', meaning: 'beer' }, { say: 'gyuuniku o kudasai', meaning: 'beef, please' }, { say: 'omizu', meaning: 'water' }, { say: 'ocha', meaning: 'tea' }] }));
  const beer = drinks.findIndex((step) => step.kind === 'recognise' && step.say === 'biiru');
  if (beer >= 0) {
    assert.notEqual(turnFor(drinks, { language: 'Japanese', current: beer, heard: 'beef', taught: [{ say: 'gyuuniku o kudasai', meaning: 'beef, please' }] }).reason, 'right');
    assert.equal(turnFor(drinks, { language: 'Japanese', current: beer, heard: 'bear' }).reason, 'right');
  }
});

await test('a reply is not sent over the student, and a question to the ear is never the tutor speaking', async () => {
  const sent = [];
  const spoken = [];
  let speaking = 0;
  const session = new RealtimeSession({ onTutorDone: (payload) => spoken.push(payload), onTutorDelta: () => {}, onTutorSpeaking: () => { speaking += 1; } });
  session.active = true;
  session.directed = true;
  session.dc = { readyState: 'open', send: (json) => sent.push(JSON.parse(json)) };
  const feedTo = (type, extra = {}) => session.handleServerEvent({ data: JSON.stringify({ type, ...extra }) });
  const creates = () => sent.filter((event) => event.type === 'response.create').length;

  // Asked for while they are speaking: held.
  feedTo('input_audio_buffer.speech_started');
  session.respond('Say the line.', { say: 'One.', after: true });
  await settle(120);
  assert.equal(creates(), 0, 'not on top of them');
  // They stop. It still waits, for the app to say what that sound was…
  feedTo('input_audio_buffer.speech_stopped');
  await settle(120);
  assert.equal(creates(), 0);
  // …a noise: let go.
  session.releaseHeld();
  await settle();
  assert.equal(creates(), 1);
  assert.equal(session.replyOnItsWay, true);

  // A reply that is running is still running when they stop speaking: the
  // next one is not sent on top of it.
  feedTo('response.created', { response: { id: 'r1' } });
  feedTo('input_audio_buffer.speech_stopped');
  feedTo('input_audio_buffer.committed', { item_id: 'x' });
  session.respond('Say the line.', { say: 'Two.' });
  await settle(120);
  assert.equal(creates(), 1);
  feedTo('response.done', { response: { id: 'r1', status: 'completed' } });
  await settle();
  assert.equal(creates(), 2);
  feedTo('response.created', { response: { id: 'r2' } });

  // A cut-off reply says so.
  feedTo('response.output_audio_transcript.delta', { response_id: 'r2', delta: 'Tw' });
  feedTo('input_audio_buffer.speech_started');
  feedTo('response.output_audio_transcript.done', { response_id: 'r2', transcript: 'Tw' });
  assert.equal(spoken.pop().cut, true);
  feedTo('response.done', { response: { id: 'r2', status: 'cancelled' } });
  feedTo('input_audio_buffer.speech_stopped');

  // A hint is not sent under a sentence: it goes when they stop.
  session.noteInputConfig({ transcription: { model: 'm', language: 'ja', prompt: 'a' }, turn_detection: { type: 'semantic_vad', create_response: false } });
  feedTo('input_audio_buffer.speech_started');
  assert.equal(session.updateTranscriptionHint('b'), false);
  assert.ok(!sent.some((event) => event.type === 'session.update'));
  feedTo('input_audio_buffer.speech_stopped');
  assert.ok(sent.some((event) => event.type === 'session.update' && event.session.audio.input.transcription.prompt === 'b'));

  // A session that never reports playback: the tutor is taken to be heard for as long as its line is.
  const quiet = new RealtimeSession({});
  quiet.active = true;
  quiet.dc = { readyState: 'open', send: () => {} };
  const feedQuiet = (type, extra = {}) => quiet.handleServerEvent({ data: JSON.stringify({ type, ...extra }) });
  feedQuiet('response.created', { response: { id: 'q1' } });
  feedQuiet('response.output_audio_transcript.delta', { response_id: 'q1', delta: 'How do you say beef, please? Take your time with it.' });
  feedQuiet('response.done', { response: { id: 'q1', status: 'completed' } });
  assert.equal(quiet.tutorHeard, true, 'written in an instant, still being spoken');
  quiet.audibleUntil = Date.now() - 1;
  assert.equal(quiet.tutorHeard, false);

  // A question to its ear given up on, whose answer turns up late: swallowed.
  const before = speaking;
  session.earStrayAt = Date.now();
  feedTo('response.created', { response: { id: 'late' } });
  feedTo('response.output_text.delta', { response_id: 'late', delta: 'No.' });
  feedTo('response.output_text.done', { response_id: 'late', text: 'No.' });
  feedTo('response.done', { response: { id: 'late', status: 'completed' } });
  assert.equal(spoken.length, 0, 'it is not a line of the lesson');
  assert.equal(speaking, before);
  // A reply in text alone counts as the tutor having spoken.
  feedTo('response.created', { response: { id: 't1' } });
  feedTo('response.output_text.delta', { response_id: 't1', delta: 'Hello' });
  assert.equal(speaking, before + 1);
  session.active = false;
  quiet.active = false;

  const app = await readAll(['public/js/app.js']);
  assert.match(app, /if \(session\?\.replyOnItsWay\) \{\s+session\.releaseHeld\(\);\s+return;/, 'a noise does not ask for what is already on its way');
  assert.match(app, /if \(cut\) session\?\.respond\(''\);/, 'and outside a script, a tutor cut off by one picks up by itself');
});

await test('quiz me, drill me and test me are requests for another part of the lesson', () => {
  // "I want to do a drill where you give me the English color..."
  assert.equal(asksForPart('quiz me on all the words'), true);
  assert.equal(asksForPart('can you drill me on the colours, one word at a time'), true);
  assert.equal(asksForPart('test me'), true);
  // "Keep drilling me." fell through to the next part's teach line (07-15-54 at 468.3).
  for (const text of ['Keep drilling me.', 'drill me again', 'quiz me again', 'more drills please', 'can you keep quizzing']) {
    assert.equal(asksForPart(text), true, text);
  }
  assert.equal(asksForPart('midori'), false);
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
