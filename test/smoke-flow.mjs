/**
 * test/smoke-flow.mjs
 *
 * Drives the real UI through the real user flow against an in-memory stand-in
 * for the File System Access API:
 *
 *   pick folder -> discover users -> select user -> select language
 *   -> load/migrate config -> change comfort level -> add a language
 *
 * This is what proves BUG 2 and BUG 3 for real: clicking a user or a language
 * must change the ACTIVE profile, not merely the dropdown's appearance.
 *
 * Opt-in, like smoke-dom.mjs:
 *
 *     npm install --no-save jsdom
 *     node test/smoke-flow.mjs
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 4001);

let jsdom;
try {
  jsdom = await import('jsdom');
} catch {
  console.error('\njsdom is not installed. Run:  npm install --no-save jsdom\n');
  process.exit(2);
}
const { JSDOM, VirtualConsole } = jsdom;

// ---------------------------------------------------------------------------
// A minimal in-memory File System Access API
// ---------------------------------------------------------------------------

function notFound(name) {
  const error = new Error(`${name} was not found.`);
  error.name = 'NotFoundError';
  return error;
}

class FakeFileHandle {
  constructor(name, contents = '') {
    this.kind = 'file';
    this.name = name;
    this.contents = contents;
  }

  async getFile() {
    const { contents } = this;
    return { text: async () => contents };
  }

  async createWritable() {
    const handle = this;
    let buffer = '';
    return {
      async write(chunk) {
        buffer += chunk;
      },
      async close() {
        handle.contents = buffer;
      },
    };
  }
}

class FakeDirHandle {
  constructor(name) {
    this.kind = 'directory';
    this.name = name;
    this.children = new Map();
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'directory') throw notFound(name);
      return existing;
    }
    if (!create) throw notFound(name);
    const dir = new FakeDirHandle(name);
    this.children.set(name, dir);
    return dir;
  }

  async getFileHandle(name, { create = false } = {}) {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'file') throw notFound(name);
      return existing;
    }
    if (!create) throw notFound(name);
    const file = new FakeFileHandle(name);
    this.children.set(name, file);
    return file;
  }

  async *entries() {
    for (const [name, handle] of this.children) yield [name, handle];
  }

  async queryPermission() {
    return 'granted';
  }

  async requestPermission() {
    return 'granted';
  }
}

/** Convenience: mkdir -p style path creation. */
async function mkdirp(root, segments) {
  let dir = root;
  for (const segment of segments) dir = await dir.getDirectoryHandle(segment, { create: true });
  return dir;
}

/** Read a config.json out of the fake tree, or null. */
async function readFakeConfig(root, user, language) {
  try {
    const users = await root.getDirectoryHandle('Users');
    const userDir = await users.getDirectoryHandle(user);
    const languageDir = await userDir.getDirectoryHandle(language);
    const file = await languageDir.getFileHandle('config.json');
    return JSON.parse(file.contents);
  } catch {
    return null;
  }
}

// --- Build the tree: two users, a legacy config, and a language with none ---
const fakeRoot = new FakeDirHandle('TutorData');

const legacyConfig = {
  tutor_name: 'Franz',
  target_language: 'German',
  user_name: 'Jeremy',
  script_style: 'Standard',
  proficiency_level: 'Beginner',
  known_weaknesses: ['German article gender'],
  // Deliberately object-shaped, as an older extractor could have written.
  recent_vocab: [{ word: 'der Zug', meaning: 'the train' }],
  last_lesson_date: '2026-02-01T09:00:00Z',
  // ai_assessed_level and assessment_history are missing on purpose.
};

const germanDir = await mkdirp(fakeRoot, ['Users', 'Jeremy', 'German']);
(await germanDir.getFileHandle('config.json', { create: true })).contents = JSON.stringify(
  legacyConfig,
  null,
  2,
);
await mkdirp(fakeRoot, ['Users', 'Jeremy', 'Japanese']); // exists, but no config
const spanishDir = await mkdirp(fakeRoot, ['Users', 'Wife', 'Spanish']);
(await spanishDir.getFileHandle('config.json', { create: true })).contents = JSON.stringify({
  tutor_name: 'Sofía',
  target_language: 'Spanish',
  user_name: 'Wife',
  proficiency_level: 'Absolute Beginner',
});

// ---------------------------------------------------------------------------
// Boot the server and the DOM
// ---------------------------------------------------------------------------

process.env.PORT = String(PORT);
await import(pathToFileURL(path.join(ROOT, 'server.js')).href);
await new Promise((resolve) => setTimeout(resolve, 700));

const base = `http://127.0.0.1:${PORT}`;
const html = await readFile(path.join(ROOT, 'public/language_tutor.html'), 'utf8');

const virtualConsole = new VirtualConsole();
/** @type {string[]} */
const consoleErrors = [];
virtualConsole.on('error', (...args) => consoleErrors.push(args.join(' ')));

const dom = new JSDOM(html, {
  url: `${base}/language_tutor.html`,
  pretendToBeVisual: true,
  virtualConsole,
});
const { window } = dom;
const { document } = window;

window.HTMLDialogElement.prototype.showModal = function showModal() {
  this.setAttribute('open', '');
};
window.HTMLDialogElement.prototype.close = function close() {
  this.removeAttribute('open');
};

// THE key difference from smoke-dom.mjs: File System Access is available here.
window.showDirectoryPicker = async () => fakeRoot;

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}
for (const [name, value] of Object.entries({
  window,
  document,
  navigator: window.navigator,
  location: window.location,
  MutationObserver: window.MutationObserver,
  HTMLElement: window.HTMLElement,
  Option: window.Option,
  requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 16),
  cancelAnimationFrame: (id) => clearTimeout(id),
})) {
  defineGlobal(name, value);
}

const nodeFetch = globalThis.fetch;
defineGlobal('fetch', (input, init) =>
  typeof input === 'string' && input.startsWith('/')
    ? nodeFetch(`${base}${input}`, init)
    : nodeFetch(input, init),
);

await import(pathToFileURL(path.join(ROOT, 'public/js/app.js')).href);
await new Promise((resolve) => setTimeout(resolve, 1200));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const failures = [];
function check(name, condition, detail = '') {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const $ = (selector) => document.querySelector(selector);
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

/** Choose a value in a <select> the way a person would, then let handlers run. */
async function choose(selector, value, wait = 500) {
  const select = $(selector);
  select.value = value;
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle(wait);
}

const optionValues = (selector) =>
  [...document.querySelectorAll(`${selector} option`)].map((option) => option.value);

const statusValue = (id) =>
  document.querySelector(`#${id} .status__value`)?.textContent?.trim() || '';

const chipTexts = (selector) =>
  [...document.querySelectorAll(`${selector} li`)].map((li) => li.textContent.trim());

console.log('\nUser-flow smoke test');

// ---------------------------------------------------------------------------
// 1. Pick the storage folder
// ---------------------------------------------------------------------------

$('#pickFolderBtn').click();
await settle(900);

check(
  'BUG 13 — picking a folder connects storage',
  statusValue('statusStorage') === 'Connected',
  `shows "${statusValue('statusStorage')}"`,
);

check(
  'both users are discovered by walking the tree',
  optionValues('#userSelect').includes('Jeremy') && optionValues('#userSelect').includes('Wife'),
  optionValues('#userSelect').join(','),
);

check(
  'the user dropdown offers "Create New User…"',
  optionValues('#userSelect').includes('__create_user__'),
);

check(
  'no user is auto-selected when several exist',
  $('#userSelect').value === '',
  `value="${$('#userSelect').value}"`,
);

// ---------------------------------------------------------------------------
// 2. Select a user
// ---------------------------------------------------------------------------

await choose('#userSelect', 'Jeremy');

check(
  "BUG 2 — selecting a user refreshes that user's languages",
  optionValues('#languageSelect').includes('German') &&
    optionValues('#languageSelect').includes('Japanese'),
  optionValues('#languageSelect').join(','),
);

check(
  'the other user\'s languages are not shown',
  !optionValues('#languageSelect').includes('Spanish'),
);

// ---------------------------------------------------------------------------
// 3. Select a language — the profile must actually become active
// ---------------------------------------------------------------------------

await choose('#languageSelect', 'German', 700);

check(
  'BUG 3 — selecting a language activates it in application state',
  statusValue('statusProfile') === 'Jeremy / German',
  `Profile status shows "${statusValue('statusProfile')}"`,
);

check(
  'the memory card reflects the ACTIVE profile, not the previous one',
  $('#memStudent').textContent === 'Jeremy' &&
    $('#memLanguage').textContent === 'German' &&
    $('#memTutor').textContent === 'Franz',
  `${$('#memStudent').textContent}/${$('#memLanguage').textContent}/${$('#memTutor').textContent}`,
);

check(
  "the stored comfort level is loaded, not reset to the app's default",
  $('#levelSelect').value === 'Beginner' && $('#memLevel').textContent === 'Beginner',
  `select=${$('#levelSelect').value} card=${$('#memLevel').textContent}`,
);

check(
  'Start Call becomes available once a profile is active',
  $('#startCallBtn').disabled === false,
);

check(
  'the prompt preview becomes available',
  $('#showPromptBtn').disabled === false,
);

// ---------------------------------------------------------------------------
// 4. Migration of the legacy config
// ---------------------------------------------------------------------------

const migrated = await readFakeConfig(fakeRoot, 'Jeremy', 'German');

check('BUG 14 — the legacy config was migrated on disk', migrated !== null);

check(
  'the new fields were added',
  migrated?.ai_assessed_level === '' && Array.isArray(migrated?.assessment_history),
  JSON.stringify({
    ai_assessed_level: migrated?.ai_assessed_level,
    assessment_history: migrated?.assessment_history,
  }),
);

check(
  'nothing from the old config was lost',
  migrated?.tutor_name === 'Franz' &&
    migrated?.proficiency_level === 'Beginner' &&
    migrated?.last_lesson_date === '2026-02-01T09:00:00Z' &&
    migrated?.known_weaknesses?.includes('German article gender'),
  JSON.stringify(migrated),
);

check(
  'BUG 8 — object-shaped vocabulary was normalised to a string on disk',
  typeof migrated?.recent_vocab?.[0] === 'string' &&
    migrated.recent_vocab[0].includes('der Zug'),
  JSON.stringify(migrated?.recent_vocab),
);

check(
  'BUG 8 — and no [object Object] reached the memory card',
  !chipTexts('#memVocab').join('|').includes('[object Object]') &&
    chipTexts('#memVocab').some((text) => text.includes('der Zug')),
  chipTexts('#memVocab').join(' | '),
);

check(
  'with fewer than three assessments, no Apply button is offered',
  $('#applyRecoBtn').hidden === true,
);

// ---------------------------------------------------------------------------
// 5. The comfort level is user-controlled and persists
// ---------------------------------------------------------------------------

await choose('#levelSelect', 'Intermediate');

check(
  'changing the comfort level updates the memory card',
  $('#memLevel').textContent === 'Intermediate',
  $('#memLevel').textContent,
);

const afterLevelChange = await readFakeConfig(fakeRoot, 'Jeremy', 'German');
check(
  'and is written straight to config.json',
  afterLevelChange?.proficiency_level === 'Intermediate',
  afterLevelChange?.proficiency_level,
);

// ---------------------------------------------------------------------------
// 6. A language folder with no config gets a correct default profile
// ---------------------------------------------------------------------------

await choose('#languageSelect', 'Japanese', 700);

check(
  'switching language switches the active profile',
  statusValue('statusProfile') === 'Jeremy / Japanese',
  statusValue('statusProfile'),
);

const japanese = await readFakeConfig(fakeRoot, 'Jeremy', 'Japanese');

check(
  'a missing config.json is created from the default template',
  japanese !== null,
);

check(
  'the Japanese defaults are Tanaka-san, Romaji, Absolute Beginner',
  japanese?.tutor_name === 'Tanaka-san' &&
    japanese?.script_style === 'Romaji' &&
    japanese?.proficiency_level === 'Absolute Beginner',
  JSON.stringify(japanese),
);

check(
  'the German profile was not disturbed by the switch',
  (await readFakeConfig(fakeRoot, 'Jeremy', 'German'))?.proficiency_level === 'Intermediate',
);

// ---------------------------------------------------------------------------
// 7. The prompt preview reflects the ACTIVE profile
// ---------------------------------------------------------------------------

$('#showPromptBtn').click();
await settle(200);

const promptText = $('#promptPreview').textContent;

check(
  'the prompt preview shows the active tutor and language',
  promptText.includes('You are Tanaka-san') && promptText.includes('teaching Japanese'),
  promptText.slice(0, 90),
);

check(
  'BUG 6 — a Japanese profile carries the Romaji-only rules',
  promptText.includes('ROMAJI ONLY') && promptText.includes('speak both versions aloud'),
);

$('#promptClose').click();

// ---------------------------------------------------------------------------
// 8. Switching user resets the language selection rather than stranding it
// ---------------------------------------------------------------------------

await choose('#userSelect', 'Wife', 700);

check(
  'switching user activates that user, with their own single language',
  statusValue('statusProfile') === 'Wife / Spanish',
  statusValue('statusProfile'),
);

check(
  'the memory card follows the new user',
  $('#memStudent').textContent === 'Wife' && $('#memLanguage').textContent === 'Spanish',
  `${$('#memStudent').textContent}/${$('#memLanguage').textContent}`,
);

check(
  'no console errors during the whole flow',
  consoleErrors.filter((line) => !/Not implemented|Could not parse CSS/i.test(line)).length === 0,
  consoleErrors.join(' | ').slice(0, 300),
);

console.log(
  `\n${failures.length === 0 ? 'User-flow smoke test passed' : `${failures.length} flow check(s) failed`}\n`,
);

window.close();
process.exit(failures.length === 0 ? 0 : 1);
