/**
 * test/settings.mjs
 *
 * Saving, replacing and removing the OpenAI API key from inside the app.
 *
 * Run with:  npm run test:settings   (npm test runs it too)
 *
 * Runs against a throwaway data folder and a stand-in for OpenAI: no real key
 * is read, saved or sent anywhere.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// Before config.js loads: no key from the environment or .env (dotenv never
// overrides a variable that is already set), and settings in a temp folder.
const DATA = await mkdtemp(path.join(tmpdir(), 'kaiwa-settings-'));
process.env.KAIWA_DATA_DIR = DATA;
process.env.OPENAI_API_KEY = '';

const { default: express } = await import('express');
const { default: settingsRoutes } = await import('../src/routes/settings.js');
const { default: healthRoutes } = await import('../src/routes/health.js');
const config = await import('../src/config.js');

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

const GOOD = 'sk-test-good-key-000000000000000000000';
const BAD = 'sk-test-refused-key-0000000000000000000';

// OpenAI stand-in: accepts GOOD, refuses everything else. Local requests to
// the test server go through untouched.
const realFetch = globalThis.fetch;
const openaiCalls = [];
globalThis.fetch = async (url, options = {}) => {
  if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, options);
  openaiCalls.push(String(url));
  const auth = options.headers?.Authorization;
  return new Response('{}', { status: auth === `Bearer ${GOOD}` ? 200 : 401 });
};

const app = express();
app.use(express.json());
app.use('/api', healthRoutes);
app.use('/api', settingsRoutes);
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
});
const base = `http://127.0.0.1:${server.address().port}/api`;

async function call(method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}

console.log('\nThe OpenAI API key, entered in the app');

await test('with no key anywhere, the app is told none is set', async () => {
  const { data } = await call('GET', '/settings/api-key');
  assert.deepEqual(data, { ok: true, configured: false, source: '', hint: '' });
  assert.equal((await call('GET', '/health')).data.apiKeyConfigured, false);
});

await test('something that is not a key is refused without asking OpenAI', async () => {
  const before = openaiCalls.length;
  const { status, data } = await call('PUT', '/settings/api-key', { apiKey: 'hello' });
  assert.equal(status, 400);
  assert.match(data.error, /sk-/);
  assert.equal(openaiCalls.length, before);
});

await test('a key OpenAI refuses is not saved', async () => {
  const { status, data } = await call('PUT', '/settings/api-key', { apiKey: BAD });
  assert.equal(status, 400);
  assert.match(data.error, /did not accept/);
  await assert.rejects(stat(config.SETTINGS_FILE));
  assert.equal(config.hasApiKey(), false);
});

await test('a good key is saved, used at once, and only its last four characters come back', async () => {
  const { status, data } = await call('PUT', '/settings/api-key', { apiKey: `  ${GOOD}\n` });
  assert.equal(status, 200);
  assert.deepEqual(data, { ok: true, configured: true, source: 'saved', hint: '…0000', warning: '' });
  assert.ok(!JSON.stringify(data).includes(GOOD), 'the key never goes back to the browser');
  assert.equal(config.OPENAI_API_KEY, GOOD, 'no restart needed');
  assert.equal(JSON.parse(await readFile(config.SETTINGS_FILE, 'utf8')).openaiApiKey, GOOD);
  assert.equal((await call('GET', '/health')).data.apiKeyConfigured, true);
});

await test('the saved key is redacted from anything logged', async () => {
  assert.equal(config.redact(`Bearer ${GOOD}`), 'Bearer [REDACTED]');
});

await test('when OpenAI cannot be reached, the key is saved with a warning', async () => {
  const offline = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, options);
    throw new TypeError('fetch failed');
  };
  try {
    const other = 'sk-test-offline-key-000000000000000000001';
    const { status, data } = await call('PUT', '/settings/api-key', { apiKey: other });
    assert.equal(status, 200);
    assert.equal(data.hint, '…0001');
    assert.match(data.warning, /not yet checked/);
  } finally {
    globalThis.fetch = offline;
  }
});

await test('removing the key deletes the file and the app is back to asking', async () => {
  const { data } = await call('DELETE', '/settings/api-key');
  assert.deepEqual(data, { ok: true, configured: false, source: '', hint: '' });
  await assert.rejects(stat(config.SETTINGS_FILE));
  assert.equal(config.hasApiKey(), false);
});

server.close();
globalThis.fetch = realFetch;
await rm(DATA, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
