/**
 * test/smoke-dom.mjs
 *
 * Runs the REAL app.js against the REAL page markup, with a jsdom DOM and a
 * live server, so DOM wiring, event handlers and the boot path are executed
 * rather than only pattern-matched.
 *
 * jsdom cannot execute <script type="module"> itself, so the page is parsed by
 * jsdom, its globals are installed, and app.js is then imported through Node's
 * own ES module loader — which is why public/shared/ lives under public/: the
 * disk path and the URL path agree, so `../shared/x.js` resolves either way.
 *
 * jsdom is NOT a project dependency. This script is opt-in:
 *
 *     npm install --no-save jsdom
 *     node test/smoke-dom.mjs
 *
 * `npm test` runs test/verify.mjs, which needs nothing extra.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 3999);

let jsdom;
try {
  jsdom = await import('jsdom');
} catch {
  console.error('\njsdom is not installed. Run:  npm install --no-save jsdom\n');
  process.exit(2);
}
const { JSDOM, VirtualConsole } = jsdom;

// --- Start the real server -------------------------------------------------
process.env.PORT = String(PORT);
await import(pathToFileURL(path.join(ROOT, 'server.js')).href);
await new Promise((resolve) => setTimeout(resolve, 700));

const base = `http://127.0.0.1:${PORT}`;

// --- Build a DOM from the real page ---------------------------------------
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

// jsdom has no <dialog> modal support; the app already falls back to the
// `open` attribute, and stubbing these proves that path works.
window.HTMLDialogElement.prototype.showModal = function showModal() {
  this.setAttribute('open', '');
};
window.HTMLDialogElement.prototype.close = function close() {
  this.removeAttribute('open');
};

// Install the DOM globals app.js expects. Note what is deliberately ABSENT:
// showDirectoryPicker, indexedDB, navigator.mediaDevices, RTCPeerConnection.
// The app must degrade cleanly without them, which is part of what we check.
/** Node 22 defines some of these as getter-only, so assign by descriptor. */
function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
  });
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

// Relative fetches in the app ("/api/health") need an absolute base under Node.
const nodeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (typeof input === 'string' && input.startsWith('/')) {
    return nodeFetch(`${base}${input}`, init);
  }
  return nodeFetch(input, init);
};

// --- Run the app -----------------------------------------------------------
/** @type {string[]} */
const bootErrors = [];
try {
  await import(pathToFileURL(path.join(ROOT, 'public/js/app.js')).href);
} catch (error) {
  bootErrors.push(error?.message || String(error));
}

// Let boot() finish its health check and storage probe.
await new Promise((resolve) => setTimeout(resolve, 1500));

// --- Checks ----------------------------------------------------------------
const failures = [];

/** @param {string} name @param {boolean} condition @param {string} [detail] */
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const statusValue = (id) =>
  document.querySelector(`#${id} .status__value`)?.textContent?.trim() || '';
const statusDot = (id) =>
  document.querySelector(`#${id} .status__dot`)?.getAttribute('data-state') || '';
const $ = (selector) => document.querySelector(selector);

console.log('\nDOM smoke test');

check('app.js loaded and ran without throwing', bootErrors.length === 0, bootErrors.join(' | '));

check(
  'the app did not fall back to its startup-failure screen',
  !document.body.textContent.includes('could not start'),
  document.body.textContent.slice(0, 160),
);

check(
  'BUG 1 — Backend moved off "Checking…"',
  statusValue('statusBackend') !== 'Checking…' && statusValue('statusBackend') !== '',
  `shows "${statusValue('statusBackend')}"`,
);

check(
  'Backend resolved to a real state, with a matching indicator',
  ['Connected', 'No API key', 'Error'].includes(statusValue('statusBackend')) &&
    ['ok', 'warn', 'error'].includes(statusDot('statusBackend')),
  `"${statusValue('statusBackend')}" / dot=${statusDot('statusBackend')}`,
);

check(
  'Storage moved off "Checking…" too',
  statusValue('statusStorage') !== 'Checking…' && statusValue('statusStorage') !== '',
  `shows "${statusValue('statusStorage')}"`,
);

check(
  'no File System Access in jsdom, so Storage says Unsupported rather than hanging',
  statusValue('statusStorage') === 'Unsupported',
  `shows "${statusValue('statusStorage')}"`,
);

check(
  'the unsupported-browser message is surfaced in the banner',
  $('#banner').hidden === false && /Chrome or Edge/.test($('#bannerText').textContent),
  $('#bannerText').textContent.slice(0, 100),
);

check(
  'the comfort-level dropdown holds exactly the six levels',
  document.querySelectorAll('#levelSelect option').length === 6,
  `${document.querySelectorAll('#levelSelect option').length} options`,
);

check(
  'the levels are in the specified order, starting at Absolute Beginner',
  [...document.querySelectorAll('#levelSelect option')].map((o) => o.value).join('|') ===
    'Absolute Beginner|Beginner|Beginner-Intermediate|Intermediate|Upper Intermediate|Advanced',
);

check(
  'Profile status reads "None selected" before anything is chosen',
  statusValue('statusProfile') === 'None selected',
  `shows "${statusValue('statusProfile')}"`,
);

check('WebRTC starts Idle', statusValue('statusWebrtc') === 'Idle');
check('Microphone starts Off', statusValue('statusMic') === 'Off');

check('Start Call is disabled with no profile', $('#startCallBtn').disabled === true);
check('Mute is disabled with no call', $('#muteBtn').disabled === true);
check('End Call is hidden with no call', $('#endCallBtn').hidden === true);
check('the prompt preview is disabled with no profile', $('#showPromptBtn').disabled === true);

check(
  'BUG 7 — End Call lives in the persistent bottom bar',
  Boolean($('.callbar #endCallBtn')),
);

check(
  'BUG 7 — End Call is NOT inside the scrolling transcript',
  !$('#transcript').contains($('#endCallBtn')),
);

// --- Exercise handlers -----------------------------------------------------

try {
  $('#comfortInfoBtn').click();
  check('the comfort-level info dialog opens on click', $('#infoDialog').hasAttribute('open'));
  $('#infoClose').click();
  check('and closes again', !$('#infoDialog').hasAttribute('open'));
} catch (error) {
  check('dialog handlers run without throwing', false, error.message);
}

try {
  $('#sidebarToggle').click();
  check('the sidebar opens on mobile', $('#sidebar').getAttribute('data-open') === 'true');
  $('#sidebarClose').click();
  check('the sidebar closes', $('#sidebar').getAttribute('data-open') === 'false');
} catch (error) {
  check('sidebar handlers run without throwing', false, error.message);
}

try {
  $('#bannerClose').click();
  check('the banner can be dismissed', $('#banner').hidden === true);
} catch (error) {
  check('the banner close handler runs', false, error.message);
}

try {
  $('#retryHealthBtn').click();
  await new Promise((resolve) => setTimeout(resolve, 900));
  check(
    'rechecking the backend settles again rather than sticking',
    statusValue('statusBackend') !== 'Checking…',
    `shows "${statusValue('statusBackend')}"`,
  );
} catch (error) {
  check('the recheck handler runs without throwing', false, error.message);
}

// --- The transcript view ---------------------------------------------------
// jsdom performs no layout, so scrollHeight is always 0 and real scrolling
// cannot be observed. What CAN be verified is that the component asks to
// scroll on every delta, and that raw and display text stay separate.

const { TranscriptView } = await import(
  pathToFileURL(path.join(ROOT, 'public/js/transcript.js')).href
);

const container = document.createElement('div');
document.body.append(container);
const view = new TranscriptView({ container });

let scrollRequests = 0;
const realScrollToBottom = view.scrollToBottom.bind(view);
view.scrollToBottom = (smooth) => {
  scrollRequests += 1;
  return realScrollToBottom(smooth);
};

view.setLanguage('Japanese');
view.appendDelta('assistant', 'item-1', 'こんにちは');
view.appendDelta('assistant', 'item-1', '、お元気ですか。');
await new Promise((resolve) => setTimeout(resolve, 80));

check(
  'streaming deltas accumulate into one bubble',
  container.querySelectorAll('.msg--assistant').length === 1,
  `${container.querySelectorAll('.msg--assistant').length} bubbles`,
);

check(
  'BUG 4 — every delta requests a scroll to the newest content',
  scrollRequests > 0,
  `${scrollRequests} scroll requests`,
);

const displayed = container.querySelector('.msg--assistant .msg__text').textContent;

check(
  'BUG 5 — the visible transcript is Romaji, with no Japanese script',
  displayed.includes('konnichiwa') && !/[぀-ヿ一-鿿]/.test(displayed),
  displayed,
);

view.completeMessage('assistant', 'item-1', 'こんにちは、お元気ですか。');
view.completeMessage('user', 'item-2', '元気です。');

check(
  'PART 21 — the RAW transcript keeps the original Japanese for extraction',
  view.getRawTranscript()[0].text === 'こんにちは、お元気ですか。',
  view.getRawTranscript()[0]?.text,
);

check(
  'both speakers are recorded with the right roles',
  view.getRawTranscript().map((entry) => entry.role).join(',') === 'assistant,user',
  view.getRawTranscript().map((entry) => entry.role).join(','),
);

check(
  'a user bubble is rendered separately from the tutor',
  container.querySelectorAll('.msg--user').length === 1,
);

view.setLanguage('German');
view.appendDelta('assistant', 'item-3', 'Guten Tag!');
await new Promise((resolve) => setTimeout(resolve, 60));

check(
  'switching to a Roman-alphabet language leaves text untouched',
  container.querySelector('[class*="msg--assistant"]:last-of-type')?.textContent.includes(
    'Guten Tag!',
  ) || [...container.querySelectorAll('.msg__text')].some((node) => node.textContent === 'Guten Tag!'),
);

check(
  'system notes never enter the raw transcript',
  (() => {
    const before = view.getRawTranscript().length;
    view.addSystemNote('Call ended.', 'info');
    return view.getRawTranscript().length === before;
  })(),
);

check(
  'clearing resets both the bubbles and the raw transcript',
  (() => {
    view.clear();
    return view.getRawTranscript().length === 0 && view.bubbles.size === 0;
  })(),
);

view.destroy();

check(
  'no console errors from application code',
  consoleErrors.filter((line) => !/Not implemented|Could not parse CSS/i.test(line)).length === 0,
  consoleErrors.join(' | ').slice(0, 300),
);

console.log(
  `\n${failures.length === 0 ? 'DOM smoke test passed' : `${failures.length} DOM check(s) failed`}\n`,
);

window.close();
process.exit(failures.length === 0 ? 0 : 1);
