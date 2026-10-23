/**
 * test/verify.mjs
 *
 * Checks the pure logic behind the behaviours the spec calls out by name.
 * Run with:  npm test
 *
 * No test framework, no dependencies — just node.
 */

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMFORT_LEVELS, coerceLevel, normalizeLevel, levelIndex } from '../public/shared/levels.js';
import {
  normalizeVocabItem,
  normalizeVocabList,
  mergeVocab,
  mergeWeaknesses,
  vocabCategory,
  MAX_VOCAB,
} from '../public/shared/vocab.js';
import {
  appendAssessment,
  evaluateRecommendation,
  sanitizeHistory,
  MAX_ASSESSMENTS,
} from '../public/shared/assessment.js';
import { createDefaultProfile, migrateProfile, defaultTutorName } from '../public/shared/profile.js';
import { buildTutorPrompt } from '../public/shared/prompt.js';
import { toRomaji, toDisplayText, containsJapanese } from '../public/shared/romaji.js';
import { applyExtraction } from '../src/routes/memory.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

// ===========================================================================
section('Levels');
// ===========================================================================

await test('exactly the six specified comfort levels, in order', () => {
  assert.deepEqual(COMFORT_LEVELS, [
    'Absolute Beginner',
    'Beginner',
    'Beginner-Intermediate',
    'Intermediate',
    'Upper Intermediate',
    'Advanced',
  ]);
});

await test('level aliases the AI might emit are normalised', () => {
  assert.equal(normalizeLevel('beginner'), 'Beginner');
  assert.equal(normalizeLevel('  ADVANCED '), 'Advanced');
  assert.equal(normalizeLevel('A2'), 'Beginner-Intermediate');
  assert.equal(normalizeLevel('upper-intermediate'), 'Upper Intermediate');
  assert.equal(normalizeLevel('gibberish'), null);
  assert.equal(coerceLevel('gibberish'), 'Absolute Beginner');
});

// ===========================================================================
section('BUG 8 — vocabulary objects must never render as [object Object]');
// ===========================================================================

await test('object-shaped vocabulary becomes a readable string', () => {
  const result = normalizeVocabItem({ word: '電車', romaji: 'densha', meaning: 'train' });
  assert.equal(result, '電車 (densha) — train');
  assert.ok(!result.includes('[object Object]'));
});

await test('string-shaped vocabulary passes through', () => {
  assert.equal(normalizeVocabItem('Zug (tsook)'), 'Zug (tsook)');
});

await test('unknown object shapes are salvaged, never stringified blindly', () => {
  const result = normalizeVocabItem({ foo: 'der Hund', bar: 'the dog' });
  assert.ok(result.includes('der Hund'));
  assert.ok(!result.includes('[object Object]'));
});

await test('nested and array shapes are handled', () => {
  assert.ok(!normalizeVocabItem([['a'], { word: 'b' }]).includes('[object Object]'));
  assert.equal(normalizeVocabItem(['電車', 'densha', 'train']), '電車 (densha) — train');
});

await test('garbage input yields an empty string, not a crash', () => {
  for (const value of [null, undefined, {}, [], true, () => {}]) {
    const result = normalizeVocabItem(value);
    assert.equal(typeof result, 'string');
    assert.ok(!result.includes('[object Object]'));
  }
});

await test('no [object Object] survives a mixed list', () => {
  const list = normalizeVocabList([
    'Zug (tsook)',
    { word: '電車', romaji: 'densha', meaning: 'train' },
    { term: 'der Bahnhof', translation: 'station' },
    null,
    {},
    42,
  ]);
  assert.ok(list.every((item) => typeof item === 'string' && item.length > 0));
  assert.ok(!list.join('|').includes('[object Object]'));
});

// ===========================================================================
section('BUG 9 / BUG 10 — memory merges, never replaces');
// ===========================================================================

await test('new vocabulary merges with the existing pool', () => {
  const merged = mergeVocab(['alt', 'neu'], ['Zug (tsook)']);
  assert.ok(merged.includes('alt'));
  assert.ok(merged.includes('neu'));
  assert.ok(merged.includes('Zug (tsook)'));
  assert.equal(merged.length, 3);
});

await test('duplicate vocabulary is de-duplicated, keeping the richer entry', () => {
  const merged = mergeVocab(['Zug'], ['Zug (tsook) — train']);
  assert.equal(merged.length, 1);
  assert.equal(merged[0], 'Zug (tsook) — train');
});

await test('vocabulary is capped at the most recent MAX_VOCAB items', () => {
  const existing = Array.from({ length: MAX_VOCAB }, (_, i) => `old${i}`);
  const incoming = Array.from({ length: 5 }, (_, i) => `new${i}`);
  const merged = mergeVocab(existing, incoming);
  assert.equal(merged.length, MAX_VOCAB);
  // Newest survive, oldest fall off the front.
  assert.ok(merged.includes('new4'));
  assert.ok(!merged.includes('old0'));
});

await test('a call of colours keeps the vegetables, and says how many words were new', () => {
  // Twenty on file and eleven colours learned: saved, said "0 new vocab
  // items", and broccoli, beef and the rest were gone.
  const profile = { target_language: 'Japanese', script_style: 'romaji', proficiency_level: 'Beginner',
    recent_vocab: Array.from({ length: 20 }, (_, i) => `veg${i} — vegetable ${i}`), known_weaknesses: [] };
  const colours = Array.from({ length: 11 }, (_, i) => `colour${i} — colour ${i}`);
  const { profile: saved, added } = applyExtraction(profile, { recent_vocab: colours, known_weaknesses: ['Mixes up haiiro and ハイロー', 'Leaves ka off questions'] });
  assert.equal(added.vocab, 11);
  assert.ok(saved.recent_vocab.includes('veg0 — vegetable 0'), 'nothing learned before was pushed out');
  assert.deepEqual(saved.known_weaknesses, ['Leaves ka off questions'], 'a weakness in kana is the recogniser’s spelling, not the student’s');
  assert.equal(added.weaknesses, 1);
});

await test('an empty extraction leaves the existing pool intact', () => {
  const existing = ['der Zug', 'das Haus'];
  assert.deepEqual(mergeVocab(existing, []), existing);
  assert.deepEqual(mergeVocab(existing, null), existing);
  assert.deepEqual(mergeVocab(existing, undefined), existing);
});

await test('weaknesses merge and de-duplicate case-insensitively', () => {
  const merged = mergeWeaknesses(
    ['German word order', 'Article gender'],
    ['german word order', 'Te-form verbs'],
  );
  assert.equal(merged.length, 3);
  assert.ok(merged.includes('German word order'));
  assert.ok(merged.includes('Te-form verbs'));
});

// ===========================================================================
section('Individual numbers are not vocabulary');
// ===========================================================================

await test('a numeral collapses into the range it belongs to', () => {
  assert.equal(vocabCategory('juu (10)'), 'numbers 1-20');
  assert.equal(vocabCategory('gojuu \u2014 fifty'), 'numbers up to 100');
  assert.equal(vocabCategory('rokujuu ichi \u2014 sixty-one'), 'numbers up to 100');
  assert.equal(vocabCategory('sanbyaku \u2014 three hundred'), 'numbers in the hundreds');
  assert.equal(
    vocabCategory('nisen sanjuu go \u2014 two thousand thirty-five'),
    'numbers in the thousands',
  );
});

await test('a clock time collapses into telling the time', () => {
  assert.equal(vocabCategory('sanji han \u2014 3:30'), 'telling the time');
  assert.equal(vocabCategory('juuyoji gofun \u2014 14:05'), 'telling the time');
});

await test('real words are never mistaken for numbers', () => {
  assert.equal(vocabCategory('oishii \u2014 delicious'), '');
  assert.equal(vocabCategory('hyaku en \u2014 100 yen'), '');
  assert.equal(vocabCategory('futatsu \u2014 two (things)'), '');
  assert.equal(vocabCategory('ichiban \u2014 the best'), '');
  assert.equal(vocabCategory('\u96fb\u8eca (densha) \u2014 train'), '');
});

await test('a numbers lesson can no longer flood the review pool', () => {
  const flood = [
    'ichi \u2014 one', 'ni \u2014 two', 'san \u2014 three', 'juu \u2014 ten',
    'juuni \u2014 twelve', 'nijuu \u2014 twenty', 'gojuu \u2014 fifty',
    'rokujuu ichi \u2014 sixty-one', 'hachijuu \u2014 eighty',
    'hyaku \u2014 one hundred', 'nihyaku \u2014 two hundred',
    'sanbyaku \u2014 three hundred', 'kyuuhyaku \u2014 nine hundred',
    'sen \u2014 one thousand', 'nisen \u2014 two thousand',
    'nisen sanjuu go \u2014 two thousand thirty-five',
  ];
  const collapsed = normalizeVocabList(flood);
  assert.deepEqual(collapsed, [
    'numbers 1-20',
    'numbers up to 100',
    'numbers in the hundreds',
    'numbers in the thousands',
  ]);
});

await test('a numbers lesson no longer evicts the words already on file', () => {
  const existing = ['oishii \u2014 delicious', 'densha \u2014 train', 'takai \u2014 expensive'];
  const incoming = Array.from({ length: 20 }, (_, i) => `n${i} \u2014 ${i + 1}`);
  const merged = mergeVocab(existing, incoming);
  for (const word of existing) assert.ok(merged.includes(word), `${word} was evicted`);
  assert.ok(merged.length <= existing.length + 4);
});

await test('a pool already flooded with numerals is repaired on load', () => {
  const saved = ['gojuu \u2014 fifty', 'hyaku \u2014 one hundred', 'oishii \u2014 delicious'];
  assert.deepEqual(normalizeVocabList(saved), [
    'numbers up to 100',
    'numbers in the hundreds',
    'oishii \u2014 delicious',
  ]);
});

await test('both bookkeeping prompts forbid listing numbers one by one', async () => {
  const director = await readFile(path.join(ROOT, 'src', 'director.js'), 'utf8');
  const memory = await readFile(path.join(ROOT, 'src', 'routes', 'memory.js'), 'utf8');
  for (const [name, source] of [['director', director], ['extractor', memory]]) {
    assert.match(source, /individual numbers, times or prices/i, `${name} prompt`);
    assert.ok(source.includes('numbers in the hundreds'), `${name} names the categories`);
  }
});

// ===========================================================================
section('BUG 11 / BUG 12 — the AI never changes the comfort level');
// ===========================================================================

await test('applyExtraction preserves the user-selected comfort level', () => {
  const profile = createDefaultProfile({ userName: 'Jeremy', language: 'German' });
  profile.proficiency_level = 'Absolute Beginner';

  const { profile: updated } = applyExtraction(profile, {
    known_weaknesses: ['German article gender'],
    recent_vocab: ['der Zug'],
    proficiency_level: 'Advanced', // the AI thinks they are much better
  });

  assert.equal(updated.proficiency_level, 'Absolute Beginner');
  assert.equal(updated.ai_assessed_level, 'Advanced');
  assert.equal(updated.assessment_history.at(-1).level, 'Advanced');
});

await test('assessment history keeps at most 10 entries', () => {
  let history = [];
  for (let i = 0; i < 15; i += 1) history = appendAssessment(history, 'Beginner');
  assert.equal(history.length, MAX_ASSESSMENTS);
});

await test('malformed history entries are discarded, not crashed on', () => {
  const history = sanitizeHistory([
    null,
    'nope',
    { level: 'Beginner', date: '2026-01-01T00:00:00Z' },
    { level: 'not a level' },
    { date: '2026-01-02T00:00:00Z' },
  ]);
  assert.equal(history.length, 1);
  assert.equal(history[0].level, 'Beginner');
});

await test('no recommendation before three assessments', () => {
  for (const count of [0, 1, 2]) {
    const history = Array.from({ length: count }, () => ({
      date: '2026-01-01T00:00:00Z',
      level: 'Beginner',
    }));
    const reco = evaluateRecommendation('Absolute Beginner', history);
    assert.equal(reco.status, 'insufficient-data');
    assert.equal(reco.suggestedLevel, null);
    assert.equal(reco.actionLabel, null);
  }
});

await test('three consistent higher assessments suggest exactly one step up', () => {
  const history = ['Beginner', 'Beginner', 'Beginner'].map((level) => ({ date: '', level }));
  const reco = evaluateRecommendation('Absolute Beginner', history);
  assert.equal(reco.status, 'step-up');
  assert.equal(reco.suggestedLevel, 'Beginner');
  assert.equal(reco.message, 'You may be ready to try Beginner.');
  assert.equal(reco.actionLabel, 'Apply Beginner');
});

await test('a big jump is still limited to one level at a time', () => {
  const history = ['Advanced', 'Advanced', 'Advanced'].map((level) => ({ date: '', level }));
  const reco = evaluateRecommendation('Absolute Beginner', history);
  assert.equal(reco.suggestedLevel, 'Beginner');
});

await test('consistently lower assessments suggest staying, never auto-downgrade', () => {
  const history = ['Beginner', 'Beginner', 'Beginner'].map((level) => ({ date: '', level }));
  const reco = evaluateRecommendation('Intermediate', history);
  assert.equal(reco.status, 'step-down');
  assert.ok(reco.message.includes('Consider staying at'));
  assert.equal(reco.suggestedLevel, 'Beginner-Intermediate');
});

await test('mixed assessments say the current level looks appropriate', () => {
  const history = ['Beginner', 'Intermediate', 'Beginner'].map((level) => ({ date: '', level }));
  const reco = evaluateRecommendation('Beginner', history);
  assert.equal(reco.status, 'steady');
  assert.equal(reco.message, 'Current level looks appropriate.');
  assert.equal(reco.suggestedLevel, null);
});

await test('only the most recent three assessments count', () => {
  const history = ['Advanced', 'Advanced', 'Beginner', 'Beginner', 'Beginner'].map((level) => ({
    date: '',
    level,
  }));
  const reco = evaluateRecommendation('Beginner', history);
  assert.equal(reco.status, 'steady');
});

// ===========================================================================
section('BUG 14 — older configs keep working');
// ===========================================================================

await test('a legacy config gains the new fields without losing anything', () => {
  const legacy = {
    tutor_name: 'Tanaka-san',
    target_language: 'Japanese',
    user_name: 'Jeremy',
    script_style: 'Romaji',
    proficiency_level: 'Beginner',
    known_weaknesses: ['Particle ni vs de'],
    recent_vocab: ['densha (train)'],
    last_lesson_date: '2026-01-05T10:00:00Z',
  };

  const { profile, changed } = migrateProfile(legacy, {
    userName: 'Jeremy',
    language: 'Japanese',
  });

  assert.equal(changed, true);
  assert.equal(profile.tutor_name, 'Tanaka-san');
  assert.equal(profile.proficiency_level, 'Beginner');
  assert.equal(profile.last_lesson_date, '2026-01-05T10:00:00Z');
  assert.deepEqual(profile.known_weaknesses, ['Particle ni vs de']);
  assert.deepEqual(profile.recent_vocab, ['densha (train)']);
  assert.equal(profile.ai_assessed_level, '');
  assert.deepEqual(profile.assessment_history, []);
});

await test('a legacy config holding vocab OBJECTS is normalised on load', () => {
  const { profile } = migrateProfile(
    { recent_vocab: [{ word: '電車', romaji: 'densha', meaning: 'train' }] },
    { userName: 'Jeremy', language: 'Japanese' },
  );
  assert.equal(profile.recent_vocab[0], '電車 (densha) — train');
});

await test('a current-shape config is left alone (no pointless writes)', () => {
  const current = createDefaultProfile({ userName: 'Jeremy', language: 'German' });
  const { changed } = migrateProfile(current, { userName: 'Jeremy', language: 'German' });
  assert.equal(changed, false);
});

await test('total garbage still produces a usable profile', () => {
  for (const value of [null, 'nope', 42, []]) {
    const { profile } = migrateProfile(value, { userName: 'Jeremy', language: 'German' });
    assert.equal(profile.target_language, 'German');
    assert.equal(profile.proficiency_level, 'Absolute Beginner');
    assert.ok(Array.isArray(profile.recent_vocab));
  }
});

// ===========================================================================
section('Defaults — German / Franz / Absolute Beginner');
// ===========================================================================

await test('the default German profile matches the spec', () => {
  const profile = createDefaultProfile({ userName: 'Jeremy', language: 'German' });
  assert.deepEqual(profile, {
    tutor_name: 'Franz',
    target_language: 'German',
    user_name: 'Jeremy',
    script_style: 'Standard',
    proficiency_level: 'Absolute Beginner',
    known_weaknesses: [],
    recent_vocab: [],
    last_lesson_date: '',
    ai_assessed_level: '',
    assessment_history: [],
  });
});

await test('the default Japanese profile uses Tanaka-san and Romaji', () => {
  const profile = createDefaultProfile({ userName: 'Jeremy', language: 'Japanese' });
  assert.equal(profile.tutor_name, 'Tanaka-san');
  assert.equal(profile.script_style, 'Romaji');
});

await test('Jeremy is not hardcoded as the only user', () => {
  const profile = createDefaultProfile({ userName: 'Wife', language: 'Spanish' });
  assert.equal(profile.user_name, 'Wife');
  assert.equal(profile.target_language, 'Spanish');
  assert.equal(profile.tutor_name, defaultTutorName('Spanish'));
});

// ===========================================================================
section('BUG 5 / BUG 6 — Japanese displays as Romaji only');
// ===========================================================================

await test('kana, digraphs, gemination and long vowels convert', () => {
  assert.equal(toRomaji('こんにちは'), 'konnichiwa');
  assert.equal(toRomaji('がっこう'), 'gakkou');
  assert.equal(toRomaji('きょう'), 'kyou');
  assert.equal(toRomaji('コーヒー'), 'koohii');
  assert.equal(toRomaji('しゃしん'), 'shashin');
  assert.equal(toRomaji('ちょっと'), 'chotto');
});

await test('kanji vocabulary and okurigana convert', () => {
  assert.equal(toRomaji('日本語'), 'nihongo');
  assert.equal(toRomaji('電車'), 'densha');
  assert.equal(toRomaji('行きました'), 'ikimashita');
  assert.equal(toRomaji('大きい'), 'ookii');
});

await test('particles read correctly', () => {
  assert.equal(toRomaji('私は学生です'), 'watashi wa gakusei desu');
  assert.equal(toRomaji('本を読みます'), 'hon o yomimasu');
});

await test('no Japanese script survives conversion, even for rare kanji', () => {
  const samples = [
    'こんにちは！お元気ですか。',
    '私は毎日日本語を勉強します。',
    '鬱蒼たる森を歩いた',
    'カタカナとひらがなと漢字',
    '電車で東京に行きました。',
  ];
  for (const sample of samples) {
    const converted = toRomaji(sample);
    assert.ok(
      !containsJapanese(converted),
      `Japanese script survived: ${sample} -> ${converted}`,
    );
  }
});

await test('Latin text is never mangled', () => {
  assert.equal(toRomaji('Hello, wie geht es dir?'), 'Hello, wie geht es dir?');
  assert.equal(toRomaji('これは pen です。'), 'kore wa pen desu.');
});

await test('non-Japanese languages are displayed unchanged', () => {
  assert.equal(toDisplayText('Wie geht es dir?', 'German'), 'Wie geht es dir?');
  assert.equal(toDisplayText('¿Cómo estás?', 'Spanish'), '¿Cómo estás?');
  assert.equal(toDisplayText('日本語', 'German'), '日本語');
  assert.equal(toDisplayText('日本語', 'Japanese'), 'nihongo');
});

await test('conversion never throws on hostile input', () => {
  for (const value of [null, undefined, 42, {}, [], '']) {
    assert.equal(typeof toRomaji(value), 'string');
  }
});

// ===========================================================================
section('Tutor prompt');
// ===========================================================================

await test('the prompt carries every profile field the spec requires', () => {
  const profile = createDefaultProfile({ userName: 'Jeremy', language: 'German' });
  profile.known_weaknesses = ['German article gender'];
  profile.recent_vocab = ['der Zug (train)'];

  const prompt = buildTutorPrompt(profile);
  assert.ok(prompt.includes('You are Franz'));
  assert.ok(prompt.includes('a German tutor on a voice call with Jeremy'));
  assert.ok(prompt.includes('Absolute Beginner'));
  assert.ok(prompt.includes('German article gender'));
  assert.ok(prompt.includes('der Zug (train)'));
  assert.ok(prompt.includes('Only the student changes their level'));
});

await test('Japanese profiles get the Romaji-only rules; German ones do not', () => {
  const japanese = buildTutorPrompt(
    createDefaultProfile({ userName: 'Jeremy', language: 'Japanese' }),
  );
  assert.ok(japanese.includes('Hepburn romaji'));
  assert.ok(japanese.includes('No kanji, hiragana or katakana'));

  const german = buildTutorPrompt(createDefaultProfile({ userName: 'Jeremy', language: 'German' }));
  assert.ok(!german.includes('romaji'));
});

await test('empty memory pools are described, not left blank', () => {
  const prompt = buildTutorPrompt(createDefaultProfile({ userName: 'Jeremy', language: 'German' }));
  assert.ok(prompt.includes('nothing on file yet'));
});

// ===========================================================================
section('Full extraction cycle');
// ===========================================================================

await test('a lesson updates memory, records an assessment, and keeps the level', () => {
  let profile = createDefaultProfile({ userName: 'Jeremy', language: 'German' });
  profile.recent_vocab = ['das Haus'];
  profile.known_weaknesses = ['German word order'];

  // Three lessons, each assessed one level above the selected level.
  for (let i = 0; i < 3; i += 1) {
    const result = applyExtraction(profile, {
      known_weaknesses: ['German article gender'],
      recent_vocab: [{ word: `Wort${i}`, meaning: `word ${i}` }],
      proficiency_level: 'Beginner',
    });
    profile = result.profile;
  }

  assert.equal(profile.proficiency_level, 'Absolute Beginner'); // untouched
  assert.equal(profile.ai_assessed_level, 'Beginner');
  assert.equal(profile.assessment_history.length, 3);
  assert.ok(profile.recent_vocab.includes('das Haus')); // original preserved
  assert.ok(profile.known_weaknesses.includes('German word order'));
  assert.ok(profile.known_weaknesses.includes('German article gender'));
  assert.ok(profile.last_lesson_date);

  const reco = evaluateRecommendation(profile.proficiency_level, profile.assessment_history);
  assert.equal(reco.suggestedLevel, 'Beginner');
});

await test('a failed extraction leaves memory exactly as it was', () => {
  const profile = createDefaultProfile({ userName: 'Jeremy', language: 'German' });
  profile.recent_vocab = ['der Zug'];
  profile.known_weaknesses = ['German word order'];

  const { profile: updated } = applyExtraction(profile, {});

  assert.deepEqual(updated.recent_vocab, ['der Zug']);
  assert.deepEqual(updated.known_weaknesses, ['German word order']);
  assert.equal(updated.proficiency_level, 'Absolute Beginner');
  assert.deepEqual(updated.assessment_history, []);
});

await test('an extractor returning objects still produces clean strings on disk', () => {
  const profile = createDefaultProfile({ userName: 'Jeremy', language: 'Japanese' });
  const { profile: updated } = applyExtraction(profile, {
    recent_vocab: [{ word: '電車', romaji: 'densha', meaning: 'train' }, 'ですか'],
    known_weaknesses: [{ text: 'Te-form verbs' }],
    proficiency_level: 'Beginner',
  });

  const serialised = JSON.stringify(updated);
  assert.ok(!serialised.includes('[object Object]'));
  assert.ok(updated.recent_vocab.every((item) => typeof item === 'string'));
  assert.ok(updated.known_weaknesses.every((item) => typeof item === 'string'));
});

// ===========================================================================
section('BUG 1 / project integrity — no placeholders, wiring is consistent');
// ===========================================================================

/** Walk the project's own source files, skipping node_modules. */
async function sourceFiles(dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await sourceFiles(full, acc);
    else if (/\.(js|mjs|html|css)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const files = await sourceFiles(ROOT);

await test('no TODO / IMPLEMENT THIS / placeholder markers anywhere', async () => {
  const offenders = [];
  for (const file of files) {
    // The suites that police placeholders necessarily contain the words.
    if (
      file.endsWith(path.join('test', 'verify.mjs')) ||
      file.endsWith(path.join('test', 'lessons.mjs')) ||
      file.endsWith(path.join('test', 'director.mjs'))
    ) {
      continue;
    }
    const text = await readFile(file, 'utf8');
    // Case-sensitive on purpose: "todo" is also the romaji reading of 届.
    if (/\bTODO\b|\bFIXME\b|IMPLEMENT THIS|implement this later/.test(text)) {
      offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, []);
});

await test('every element app.js looks up exists in the HTML', async () => {
  const appJs = await readFile(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const html = await readFile(path.join(ROOT, 'public/language_tutor.html'), 'utf8');

  const idsBlock = appJs.slice(appJs.indexOf('const IDS = ['), appJs.indexOf('];', appJs.indexOf('const IDS = [')));
  const ids = [...idsBlock.matchAll(/'([A-Za-z0-9_]+)'/g)].map((match) => match[1]);
  assert.ok(ids.length > 30, 'expected the IDS list to be found');

  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const missingIds = ids.filter((id) => !htmlIds.has(id));
  assert.deepEqual(missingIds, [], `IDs missing from the HTML: ${missingIds.join(', ')}`);
});

await test('every API path the frontend calls is defined by the backend', async () => {
  const frontend = [
    await readFile(path.join(ROOT, 'public/js/app.js'), 'utf8'),
    await readFile(path.join(ROOT, 'public/js/realtime.js'), 'utf8'),
    await readFile(path.join(ROOT, 'public/js/lessons.js'), 'utf8'),
  ].join('\n');

  const called = new Set(
    [...frontend.matchAll(/['"`](\/api\/[a-z/-]+)['"`]/g)].map((match) => match[1]),
  );

  const backend = [
    await readFile(path.join(ROOT, 'src/routes/health.js'), 'utf8'),
    await readFile(path.join(ROOT, 'src/routes/realtime.js'), 'utf8'),
    await readFile(path.join(ROOT, 'src/routes/memory.js'), 'utf8'),
    await readFile(path.join(ROOT, 'src/routes/lessons.js'), 'utf8'),
    await readFile(path.join(ROOT, 'src/routes/settings.js'), 'utf8'),
  ].join('\n');

  const defined = new Set(
    [...backend.matchAll(/router\.(?:get|post|put|delete)\(\s*'([^']+)'/g)].map(
      (match) => `/api${match[1].startsWith('/') ? '' : '/'}${match[1]}`,
    ),
  );

  const undefinedRoutes = [...called].filter((route) => !defined.has(route));
  assert.deepEqual(
    undefinedRoutes,
    [],
    `Frontend calls routes the backend does not define: ${undefinedRoutes.join(', ')}`,
  );
});

await test('no API key value can reach client-side code', async () => {
  // Naming the environment variable in a help message is fine and useful.
  // What must never appear is a key literal, or client code reading the key.
  for (const file of files.filter((f) => f.includes(`${path.sep}public${path.sep}`))) {
    const text = await readFile(file, 'utf8');
    const relative = path.relative(ROOT, file);
    assert.ok(!/\b(sk|ek)-[A-Za-z0-9_-]{8,}/.test(text), `${relative} contains a key literal`);
    assert.ok(!/process\.env/.test(text), `${relative} reads process.env`);
    assert.ok(
      !/OPENAI_API_KEY\s*[=:]/.test(text),
      `${relative} assigns or reads OPENAI_API_KEY`,
    );
  }
});

await test('the backend never returns the key, only a boolean', async () => {
  const health = await readFile(path.join(ROOT, 'src/routes/health.js'), 'utf8');
  assert.ok(health.includes('hasApiKey()'));
  assert.ok(!/OPENAI_API_KEY/.test(health));

  const config = await readFile(path.join(ROOT, 'src/config.js'), 'utf8');
  const publicBlock = config.slice(config.indexOf('export function publicConfig'));
  assert.ok(!/OPENAI_API_KEY/.test(publicBlock.slice(0, publicBlock.indexOf('}\n'))));
});

await test('.gitignore excludes .env', async () => {
  const gitignore = await readFile(path.join(ROOT, '.gitignore'), 'utf8');
  assert.ok(/^\.env$/m.test(gitignore));
});

await test('the transcript view disables CSS scroll anchoring', async () => {
  const css = await readFile(path.join(ROOT, 'public/styles.css'), 'utf8');
  assert.ok(/\.transcript\s*\{[^}]*overflow-anchor:\s*none/s.test(css));
});

// ===========================================================================

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
