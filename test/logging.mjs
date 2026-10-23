/**
 * test/logging.mjs
 *
 * Session logging and the review checks.
 *
 * Run with:  npm run test:logging   (npm test runs it too)
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { findings, CHAINED_TENS } from '../tools/log-analysis.mjs';

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

/** A logger writing into a throwaway directory. */
async function freshLogger() {
  const dir = await mkdtemp(path.join(tmpdir(), 'lt-logs-'));
  process.env.LOGS_DIR = dir;
  // A fresh module instance per test, so its session map starts empty.
  const logging = await import(`../src/logging.js?cache=${Math.random()}`);
  return { dir, logging };
}

/** @param {string} dir */
async function readLog(dir) {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
  if (!files.length) return [];
  const text = await readFile(path.join(dir, files[0]), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

section('Writing a session log');

await test('events are appended as one JSON object per line', async () => {
  const { dir, logging } = await freshLogger();
  try {
    const result = await logging.appendEvents('abcdef123456', [
      { type: 'session.start', user: 'Jeremy', language: 'Japanese' },
      { type: 'tutor', text: 'Ohayou.' },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.written, 2);

    const lines = await readLog(dir);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].type, 'session.start');
    assert.equal(lines[0].seq, 1);
    assert.ok(lines[0].at, 'every line is timestamped');
    assert.equal(lines[1].text, 'Ohayou.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('a session in progress is readable line by line', async () => {
  const { dir, logging } = await freshLogger();
  try {
    await logging.appendEvents('abcdef123456', [{ type: 'tutor', text: 'first' }]);
    const midway = await readLog(dir);
    await logging.appendEvents('abcdef123456', [{ type: 'tutor', text: 'second' }]);
    const after = await readLog(dir);

    assert.equal(midway.length, 1, 'the file is complete at every moment');
    assert.equal(after.length, 2, 'and appends rather than rewrites');
    assert.equal(after[1].seq, 2, 'sequence numbers keep counting');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('the API key can never reach a log file', async () => {
  const { dir, logging } = await freshLogger();
  try {
    await logging.appendEvents('abcdef123456', [
      { type: 'prompt', instructions: 'Authorization: Bearer sk-abcdefghijklmnop stuff' },
      { type: 'oops', apiKey: 'sk-secret-value', token: 'nope', authorization: 'Bearer x' },
    ]);
    const text = JSON.stringify(await readLog(dir));
    assert.ok(!text.includes('sk-abcdefghijklmnop'), 'a key inside free text is redacted');
    assert.ok(!text.includes('sk-secret-value'), 'and one in a field value');
    assert.ok(text.includes('[REDACTED]') || text.includes('[omitted]'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('the credential filter does not swallow innocent fields', async () => {
  const { dir, logging } = await freshLogger();
  try {
    // "referenceKeys" contains "key". A substring test omits it, and then the
    // log is missing exactly the field that diagnoses a missing reference.
    await logging.appendEvents('abcdef123456', [
      { type: 'prompt', referenceKeys: ['numbers', 'time'], monkeys: 3, apiKey: 'sk-x' },
    ]);
    const [line] = await readLog(dir);
    assert.deepEqual(line.referenceKeys, ['numbers', 'time']);
    assert.equal(line.monkeys, 3);
    assert.equal(line.apiKey, '[omitted]', 'while a real credential field still goes');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('a rubbish session id writes nothing', async () => {
  const { dir, logging } = await freshLogger();
  try {
    for (const id of ['', 'short', '../../etc/passwd', 'has spaces', 'x'.repeat(200)]) {
      const result = await logging.appendEvents(id, [{ type: 'tutor', text: 'x' }]);
      assert.equal(result.ok, false, `"${id}" is refused`);
    }
    assert.deepEqual(await readdir(dir), [], 'and no file is created');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('logging can be turned off entirely', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lt-logs-'));
  process.env.LOGS_DIR = dir;
  process.env.LOG_SESSIONS = '0';
  try {
    const logging = await import(`../src/logging.js?off=${Math.random()}`);
    assert.equal(logging.LOGGING_ENABLED, false);
    const result = await logging.appendEvents('abcdef123456', [{ type: 'tutor', text: 'x' }]);
    assert.equal(result.ok, false);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    delete process.env.LOG_SESSIONS;
    await rm(dir, { recursive: true, force: true });
  }
});

await test('a huge field is trimmed rather than written whole', async () => {
  const { dir, logging } = await freshLogger();
  try {
    await logging.appendEvents('abcdef123456', [{ type: 'prompt', instructions: 'x'.repeat(200000) }]);
    const [line] = await readLog(dir);
    assert.ok(line.instructions.length < 30000, 'trimmed');
    assert.match(line.instructions, /\[truncated\]$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('nothing here throws, whatever it is handed', async () => {
  const { dir, logging } = await freshLogger();
  try {
    for (const events of [null, undefined, 'text', 42, [null], [{ type: 'x', deep: { a: { b: { c: {} } } } }]]) {
      const result = await logging.appendEvents('abcdef123456', /** @type {any} */ (events));
      assert.equal(typeof result.ok, 'boolean');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

section('Reviewing a session log');

await test('chained tens are recognised, valid numbers are not', () => {
  for (const bad of ['try saying sanjuu sanjuu', 'nijuu juu, which is thirty', 'say juu juu']) {
    assert.equal(CHAINED_TENS.test(bad), true, `"${bad}"`);
  }
  for (const fine of [
    'rokujuu ichi is 61',
    'nisen sanjuu is correct',
    'sanbyaku rokujuu',
    'sanjuu san is 33',
    'nijuu kyuu',
  ]) {
    assert.equal(CHAINED_TENS.test(fine), false, `"${fine}"`);
  }
});

await test('the tutor correcting itself is not reported as an error', () => {
  const flagged = findings([
    { type: 'prompt', at: 0, reason: 'initial', hasLesson: true, hasReference: true, referenceKeys: ['numbers'] },
    { type: 'tutor', at: 10, text: 'Now try sanjuu sanjuu.' },
    { type: 'tutor', at: 20, text: 'You are right, sanjuu sanjuu is not a number. 33 is sanjuu san.' },
  ]);
  assert.equal(flagged.length, 1, 'only the mistake, not the correction');
  assert.match(flagged[0].text, /Now try sanjuu sanjuu/);
});

await test('a prompt missing its reference is called out as a likely stale build', () => {
  const flagged = findings([
    {
      type: 'prompt',
      at: 0,
      reason: 'initial',
      hasLesson: true,
      hasReference: false,
      referenceKeys: ['numbers', 'time'],
    },
  ]);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].level, 'check');
  assert.match(flagged[0].text, /no # REFERENCE/);
  assert.match(flagged[0].text, /older build/);
});

await test('the same finding thirty times is reported once', () => {
  // The prompt is rebuilt on every Director pass, so a lesson declaring no
  // reference produced thirty-one identical warnings and buried everything
  // else in the report.
  const flagged = findings(
    Array.from({ length: 31 }, (_, i) => ({
      type: 'prompt',
      at: i * 40,
      reason: 'lesson-changed',
      phase: 'in_context',
      hasLesson: true,
      hasReference: false,
      referenceKeys: ['numbers'],
    })),
  );
  assert.equal(flagged.length, 1);
  assert.match(flagged[0].text, /31 prompt\(s\)/);
  assert.match(flagged[0].text, /in_context/);
});

await test('turns the server never answered are surfaced', () => {
  const started = { type: 'prompt', at: 0, reason: 'initial', hasLesson: false, hasReference: false, referenceKeys: [] };

  const quiet = findings([started, { type: 'turn.rescued', at: 100, afterMs: 4000 }]);
  assert.equal(quiet.length, 1);
  assert.equal(quiet[0].level, 'check', 'one is a hiccup');

  const sick = findings([
    started,
    ...Array.from({ length: 6 }, (_, i) => ({ type: 'turn.rescued', at: i * 60 + 1, afterMs: 4000 })),
  ]);
  assert.equal(sick[0].level, 'error', 'six is a broken call');
  assert.match(sick[0].text, /6 student turn/);
});

await test('a tutor that compliments every turn is counted, not quoted sixty times', () => {
  const praise = Array.from({ length: 20 }, (_, i) => ({
    type: 'tutor',
    at: i * 10,
    text: 'Sugoi, that is great! Now try: Osusume wa nan desu ka?',
  }));
  const flagged = findings([{ type: 'prompt', at: 0, reason: 'initial', hasLesson: false, hasReference: false, referenceKeys: [] }, ...praise]).filter((entry) => /open with praise/.test(entry.text));
  assert.equal(flagged.length, 1, 'one finding, not twenty');
  assert.match(flagged[0].text, /100% of the tutor's 20 turns/);
});

await test('a tutor that praises occasionally is left alone', () => {
  const turns = Array.from({ length: 20 }, (_, i) => ({
    type: 'tutor',
    at: i * 10,
    text: i < 2 ? 'Nice. Osusume wa nan desu ka?' : 'Osusume wa nan desu ka?',
  }));
  assert.equal(
    findings([{ type: 'prompt', at: 0, reason: 'initial', hasLesson: false, hasReference: false, referenceKeys: [] }, ...turns]).filter((entry) => /praise/.test(entry.text)).length,
    0,
  );
});

await test('a tutor handing over phrases with no English is reported', () => {
  const parroting = Array.from({ length: 12 }, (_, i) => ({
    type: 'tutor',
    at: i * 10 + 1,
    text: `Next, say "sanji han".`,
  }));
  const flagged = findings([{ type: 'prompt', at: 0, reason: 'initial', hasLesson: false, hasReference: false, referenceKeys: [] }, ...parroting]).filter((e) => /told them what/.test(e.text));
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].level, 'error');
  assert.match(flagged[0].text, /say a phrase 12 time\(s\) and told them what it meant in 0/);
});

await test('a tutor that glosses what it asks for is left alone', () => {
  const taught = Array.from({ length: 12 }, (_, i) => ({
    type: 'tutor',
    at: i * 10 + 1,
    text: `Next, say "sanji han" — it means half past three.`,
  }));
  assert.equal(
    findings([{ type: 'prompt', at: 0, reason: 'initial', hasLesson: false, hasReference: false, referenceKeys: [] }, ...taught]).filter((e) => /told them what/.test(e.text)).length,
    0,
  );
});

await test('the student asking what something meant is the loudest signal', () => {
  const flagged = findings([
    { type: 'prompt', at: 0, reason: 'initial', hasLesson: false, hasReference: false, referenceKeys: [] },
    { type: 'student', at: 10, text: 'What does juppun mean?' },
    { type: 'student', at: 90, text: "I don't know what any of these things mean." },
  ]).filter((e) => /asked what something meant/.test(e.text));
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].level, 'error');
  assert.match(flagged[0].text, /2 time\(s\)/);
});

await test('one puzzled question is not a pattern', () => {
  assert.equal(
    findings([{ type: 'prompt', at: 0, reason: 'initial', hasLesson: false, hasReference: false, referenceKeys: [] }, { type: 'student', at: 10, text: 'What does juppun mean?' }]).length,
    0,
  );
});

await test('correction labels on turns with no fault are flagged for a look', () => {
  const labelled = Array.from({ length: 6 }, (_, i) => ({
    type: 'tutor',
    at: i * 10 + 1,
    text: 'Particle: Watashi wa, really. Now say sanjuu san.',
  }));
  const flagged = findings([{ type: 'prompt', at: 0, reason: 'initial', hasLesson: false, hasReference: false, referenceKeys: [] }, ...labelled]).filter((e) => /correction label/.test(e.text));
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].level, 'check', 'a real correction looks identical, so this only prompts a look');
});

await test('a couple of genuine corrections stay quiet', () => {
  const turns = [
    { type: 'prompt', at: 0, reason: 'initial', hasLesson: false, hasReference: false, referenceKeys: [] },
    { type: 'tutor', at: 10, text: 'Particle: watashi WA tomato ga suki desu.' },
    { type: 'tutor', at: 20, text: 'Sound: to-ri-ni-ku.' },
  ];
  assert.equal(findings(turns).filter((e) => /correction label/.test(e.text)).length, 0);
});

await test('a lesson that never leaves one phase is reported', () => {
  const flagged = findings([
    { type: 'prompt', at: 0, reason: 'initial', hasLesson: false, hasReference: false, referenceKeys: [] },
    { type: 'director.request', at: 100, lesson: 'vocabulary_builder', phase: 'in_context', turnsInPhase: 8 },
    { type: 'director.request', at: 900, lesson: 'vocabulary_builder', phase: 'in_context', turnsInPhase: 54 },
  ]);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].level, 'error');
  assert.match(flagged[0].text, /54 student turns in "in_context"/);
});

await test('a lesson moving through its phases is not reported as stuck', () => {
  const flagged = findings([
    { type: 'prompt', at: 0, reason: 'initial', hasLesson: false, hasReference: false, referenceKeys: [] },
    { type: 'director.request', at: 100, phase: 'choose_topic', turnsInPhase: 4 },
    { type: 'director.request', at: 300, phase: 'first_pass', turnsInPhase: 6 },
    { type: 'director.request', at: 600, phase: 'recall', turnsInPhase: 5 },
  ]);
  assert.equal(flagged.length, 0);
});

await test('a prompt that correctly carries its reference is not flagged', () => {
  const flagged = findings([
    { type: 'prompt', at: 0, reason: 'initial', hasLesson: true, hasReference: true, referenceKeys: ['numbers'] },
  ]);
  assert.deepEqual(flagged, []);
});

await test('a Director that never succeeds is reported', () => {
  const flagged = findings([
    { type: 'prompt', at: 0, hasLesson: true, hasReference: true, referenceKeys: [] },
    { type: 'director.response', at: 30, ok: false, error: 'Could not reach the OpenAI API' },
    { type: 'director.response', at: 60, ok: false, error: 'Could not reach the OpenAI API' },
  ]);
  assert.equal(flagged.length, 1);
  assert.match(flagged[0].text, /Every Lesson Director pass failed/);
});

await test('a lesson that ran with no Director at all is reported', () => {
  const flagged = findings([
    { type: 'prompt', at: 0, hasLesson: true, hasReference: true, referenceKeys: [] },
    { type: 'lesson.change', at: 5, to: 'restaurant', from: null, reason: 'ui' },
  ]);
  assert.match(flagged[0].text, /the Director never reported/);
});

await test('a call with no prompt at all is the loudest signal there is', () => {
  const flagged = findings([{ type: 'student', at: 4, text: 'hello' }]);
  assert.equal(flagged[0].level, 'error');
  assert.match(flagged[0].text, /No prompt was ever logged/);
});

await test('session errors are surfaced in order', () => {
  const flagged = findings([
    { type: 'prompt', at: 0, hasLesson: false, hasReference: false, referenceKeys: [] },
    { type: 'realtime.error', at: 40, message: 'Conversation already has an active response' },
    { type: 'realtime.error', at: 10, message: 'That turn could not be transcribed' },
  ]);
  assert.equal(flagged.length, 2);
  assert.ok(flagged[0].at < flagged[1].at, 'sorted by when they happened');
});

await test('an empty or broken log produces no crash', () => {
  for (const input of [[], null, undefined, 'nonsense', [null, 42]]) {
    const flagged = findings(/** @type {any} */ (input));
    assert.ok(Array.isArray(flagged));
  }
});

section('Wiring');

await test('the client logger never lets a failure reach the lesson', async () => {
  const code = await readFile(path.join(ROOT, 'public/js/logger.js'), 'utf8');
  assert.match(code, /keepalive: true/, 'events survive a closing page');
  assert.match(code, /sendBeacon/, 'and the final flush uses a beacon');
  assert.ok(!/throw /.test(code), 'the logger never throws');
});

await test('the prompt event records what a diagnosis needs', async () => {
  const code = await readFile(path.join(ROOT, 'public/js/logger.js'), 'utf8');
  for (const field of ['hasReference', 'hasLesson', 'hasCatalogue', 'chars', 'instructions']) {
    assert.ok(code.includes(field), `${field} is recorded`);
  }
});

await test('both sides of the conversation are logged, plus the invisible bits', async () => {
  const app = await readFile(path.join(ROOT, 'public/js/app.js'), 'utf8');
  for (const event of [
    "sessionLog.event('student'",
    "sessionLog.event('tutor'",
    "sessionLog.event('nudge'",
    "sessionLog.event('realtime.error'",
    "sessionLog.event('memory.extract'",
    'sessionLog.prompt(',
  ]) {
    assert.ok(app.includes(event), `${event} is wired`);
  }
  // The Director's side is logged by the conductor, through the page's logger.
  assert.ok(app.includes('log: (type, payload) => sessionLog.event(type, payload)'));
  const conductor = await readFile(path.join(ROOT, 'public/shared/conductor.js'), 'utf8');
  for (const event of ["this.log('director.request'", "this.log('director.response'", "this.log('lesson.autoAdvance'"]) {
    assert.ok(conductor.includes(event), `${event} is wired`);
  }
});

await test('the log directory is git-ignored', async () => {
  const ignore = await readFile(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^Logs\/$/m);
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
