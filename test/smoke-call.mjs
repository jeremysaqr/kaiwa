/**
 * test/smoke-call.mjs
 *
 * A whole call, in a real browser, with nobody on the other end.
 *
 * The real page — app.js, realtime.js, the conductor, the turn-taker — runs in
 * Chromium against the real server, and the Realtime session itself is played
 * by this script: it sends the page the events a session sends (speech
 * started, a transcript, a reply being spoken) and reads what the page asks
 * the session for. That is the one part of the app the other suites cannot
 * reach: what happens between a microphone event arriving and a line being
 * asked for.
 *
 * It covers what went wrong on the third real call: an answer split in two by
 * a pause, a reply taken back because the student carried on, a transcript of
 * noise, no transcript at all, a click, and a cough that cuts the tutor off —
 * and, from 14 Oct, being asked for a drill of words already known.
 *
 * Nothing here calls OpenAI, and nothing is written to Users/ or Logs/: the
 * profile lives in memory, every route that would reach OpenAI is answered
 * here, and the server is started with a placeholder in place of the key.
 *
 * Opt-in, like the other smoke tests (Playwright is not a project dependency):
 *
 *     npm install --no-save playwright
 *     npx playwright install chromium
 *     node test/smoke-call.mjs
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 4003);
const BASE = `http://127.0.0.1:${PORT}`;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('\nPlaywright is not installed. Run:\n  npm install --no-save playwright\n  npx playwright install chromium\n');
  process.exit(2);
}

// The real server — but never with the real key. An environment variable that
// is already set is left alone by dotenv, so the key in .env is not loaded.
process.env.PORT = String(PORT);
process.env.OPENAI_API_KEY = 'sk-smoke-test-not-a-real-key';
await import(pathToFileURL(path.join(ROOT, 'server.js')).href);
await new Promise((resolve) => { setTimeout(resolve, 700); });

const item = (say, script, meaning, extra = {}) => ({ say, script, meaning, note: '', use: '', reply: '', replyMeaning: '', known: false, ...extra });
const PLANS = {
  first_pass: {
    items: [
      item('gyuuniku', '牛肉', 'beef', { note: 'Gyuu is cow, niku is meat.' }),
      item('hourensou', 'ほうれん草', 'spinach'),
      item('butaniku', '豚肉', 'pork', { note: 'Buta is pig.' }),
      item('gyuuniku o kudasai', '牛肉をください', 'beef, please', { note: 'O kudasai is how you ask for something.', use: 'You want to order beef.', reply: 'kashikomarimashita', replyMeaning: 'certainly' }),
    ],
    scene: { setup: "I'm the waiter at a Japanese restaurant and you are ready to order.", lines: [
      { tutor: 'nani ni nasaimasu ka', meaning: 'What will you have?', expect: 'gyuuniku o kudasai', cue: '', reply: 'kashikomarimashita', replyMeaning: 'certainly' },
      { tutor: 'hoka ni gochuumon wa gozaimasu ka', meaning: 'Anything else?', expect: 'butaniku', cue: '', reply: 'kashikomarimashita', replyMeaning: 'certainly' },
    ] },
  },
  recall: { items: [item('toriniku', '鶏肉', 'chicken'), item('ramu', 'ラム', 'lamb'), item('nasu', 'ナス', 'eggplant'), item('toumorokoshi', 'とうもろこし', 'corn')], scene: { setup: '', lines: [] } },
};

const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

{
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`); });

  const judged = [];
  await page.route('**/api/realtime/session', (route) => route.fulfill({ json: {
    ok: true, clientSecret: 'ek_test', expiresAt: null, model: 'test',
    transcription: { model: 'gpt-live-transcribe', language: 'ja', prompt: 'as the call began' },
    input: {
      transcription: { model: 'gpt-live-transcribe', language: 'ja', prompt: 'as the call began' },
      turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: false },
    },
    turns: 'app',
  } }));
  await page.route('https://api.openai.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/sdp', body: 'v=0\r\n' }));
  const COLOURS = new Set(['red', 'blue', 'yellow', 'green', 'black', 'white']);
  const drillAsked = [];
  await page.route('**/api/lessons/plan', async (route) => {
    const body = route.request().postDataJSON();
    await wait(300);
    // A drill is chosen from the words the page offers, and nothing else.
    if (body.phaseId === 'drill') {
      drillAsked.push(body);
      const items = (body.candidates || []).filter((entry) => COLOURS.has(entry.meaning)).map((entry) => ({ ...entry, known: true }));
      route.fulfill({ json: { ok: true, plan: { items, scene: { lines: [] }, drill: true }, error: null } });
      return;
    }
    const plan = PLANS[body.phaseId];
    route.fulfill({ json: plan ? { ok: true, plan, error: null } : { ok: false, plan: null, error: 'no plan in this test' } });
  });
  await page.route('**/api/lessons/judge', (route) => {
    const body = route.request().postDataJSON();
    judged.push(body.transcript);
    route.fulfill({ json: { ok: true, verdict: 'wrong', heard: String(body.transcript || ''), other: '' } });
  });
  await page.route('**/api/lessons/direct', (route) => route.fulfill({ json: { ok: false, error: 'off in this test' } }));
  await page.route('**/api/memory/extract', (route) => route.fulfill({ json: { ok: false, error: 'off in this test' } }));
  // A test call leaves no session log behind.
  await page.route('**/api/logs', (route) => route.fulfill({ json: { ok: true } }));

  await page.addInitScript(() => {
    const notFound = (name) => { const error = new Error(`${name} was not found.`); error.name = 'NotFoundError'; return error; };
    class FakeFileHandle {
      constructor(name, contents = '') { this.kind = 'file'; this.name = name; this.contents = contents; }
      async getFile() { const { contents } = this; return { text: async () => contents }; }
      async createWritable() { const handle = this; let buffer = ''; return { async write(chunk) { buffer += chunk; }, async close() { handle.contents = buffer; } }; }
    }
    class FakeDirHandle {
      constructor(name) { this.kind = 'directory'; this.name = name; this.children = new Map(); }
      async getDirectoryHandle(name, { create = false } = {}) {
        const existing = this.children.get(name);
        if (existing) { if (existing.kind !== 'directory') throw notFound(name); return existing; }
        if (!create) throw notFound(name);
        const dir = new FakeDirHandle(name); this.children.set(name, dir); return dir;
      }
      async getFileHandle(name, { create = false } = {}) {
        const existing = this.children.get(name);
        if (existing) { if (existing.kind !== 'file') throw notFound(name); return existing; }
        if (!create) throw notFound(name);
        const file = new FakeFileHandle(name); this.children.set(name, file); return file;
      }
      async *entries() { for (const [name, handle] of this.children) yield [name, handle]; }
      async *values() { for (const handle of this.children.values()) yield handle; }
      async *keys() { for (const name of this.children.keys()) yield name; }
      async queryPermission() { return 'granted'; }
      async requestPermission() { return 'granted'; }
    }
    const root = new FakeDirHandle('TutorData');
    const users = new FakeDirHandle('Users'); root.children.set('Users', users);
    const me = new FakeDirHandle('Tester'); users.children.set('Tester', me);
    const japanese = new FakeDirHandle('Japanese'); me.children.set('Japanese', japanese);
    japanese.children.set('config.json', new FakeFileHandle('config.json', JSON.stringify({
      tutor_name: 'Tanaka-san', target_language: 'Japanese', user_name: 'Tester', script_style: 'Romaji',
      proficiency_level: 'Beginner', known_weaknesses: [], last_lesson_date: '', ai_assessed_level: '', assessment_history: [],
      recent_vocab: ['赤い (akai) — red', '青い (aoi) — blue', '黄色 (kiiro) — yellow', '緑 (midori) — green', '黒 (kuro) — black', '白 (shiro) — white'],
    })));
    window.showDirectoryPicker = async () => root;
    window.__profile = () => japanese.children.get('config.json').contents;

    window.__sent = [];
    class FakeDC extends EventTarget {
      constructor() { super(); this.readyState = 'connecting'; }
      send(json) { window.__sent.push(JSON.parse(json)); }
      close() { this.readyState = 'closed'; }
    }
    class FakePC {
      constructor() { this.connectionState = 'new'; window.__pc = this; }
      addTrack() {}
      getSenders() { return []; }
      createDataChannel() { window.__dc = new FakeDC(); return window.__dc; }
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' }; }
      async setLocalDescription() {}
      async setRemoteDescription() {
        this.connectionState = 'connected';
        if (this.onconnectionstatechange) this.onconnectionstatechange();
        setTimeout(() => { window.__dc.readyState = 'open'; window.__dc.dispatchEvent(new Event('open')); }, 20);
      }
      close() {}
    }
    window.RTCPeerConnection = FakePC;
    window.__feed = (event) => window.__dc.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }));
  });

  await page.goto(`${BASE}/`);
  await wait(1200);
  await page.click('#pickFolderBtn');
  await wait(800);
  await page.selectOption('#userSelect', 'Tester');
  await wait(600);
  await page.selectOption('#languageSelect', 'Japanese');
  await wait(900);
  check('the page boots, and a profile can be chosen', await page.isEnabled('#startCallBtn'), consoleErrors.join(' | '));
  await page.click('#startCallBtn');
  await wait(1500);

  // ---- the session, played by hand ------------------------------------------
  const feed = (event) => page.evaluate((e) => window.__feed(e), event);
  const sent = () => page.evaluate(() => window.__sent);
  let seen = 0;        // how many sent events have been looked at
  let responses = 0;
  let items = 0;
  const tutorLines = [];
  const isEar = (event) => event.type === 'response.create' && event.response && event.response.conversation === 'none';
  const lineOf = (event) => {
    const input = (event.response && event.response.input) || [];
    const last = input[input.length - 1];
    return last && last.content && last.content[0] ? last.content[0].text : '(a reply of its own)';
  };
  /** Events the page has sent since last looked at. */
  const fresh = async () => { const all = await sent(); const out = all.slice(seen); seen = all.length; return out; };
  /** Wait for the page to ask for something; returns what it sent. */
  const awaitSend = async (test, ms = 4000) => {
    const start = Date.now();
    const got = [];
    while (Date.now() - start < ms) {
      got.push(...await fresh());
      if (got.some(test)) return got;
      await wait(40);
    }
    return got;
  };
  /** The tutor says a line the page asked for. `cut`: is interrupted part-way by `noise`. */
  const speak = async (request, { cut = false, unsaid = false, keep = 4 } = {}) => {
    responses += 1;
    const id = `resp_${responses}`;
    const line = lineOf(request);
    await feed({ type: 'response.created', response: { id } });
    if (unsaid) {
      await feed({ type: 'response.done', response: { id, status: 'cancelled', status_details: { reason: 'turn_detected' } } });
      return line;
    }
    await feed({ type: 'output_audio_buffer.started', response_id: id });
    const said = cut ? line.split(' ').slice(0, keep).join(' ') : line;
    await feed({ type: 'response.output_audio_transcript.delta', response_id: id, item_id: `t_${id}`, delta: said });
    if (cut) {
      await feed({ type: 'input_audio_buffer.speech_started', audio_start_ms: 1000 });
      await feed({ type: 'output_audio_buffer.cleared', response_id: id });
      await feed({ type: 'response.output_audio_transcript.done', response_id: id, item_id: `t_${id}`, transcript: said });
      await feed({ type: 'response.done', response: { id, status: 'cancelled', status_details: { reason: 'turn_detected' } } });
      tutorLines.push(`${said} [cut off]`);
      return said;
    }
    await feed({ type: 'response.output_audio_transcript.done', response_id: id, item_id: `t_${id}`, transcript: line });
    await feed({ type: 'response.done', response: { id, status: 'completed' } });
    await feed({ type: 'output_audio_buffer.stopped', response_id: id });
    tutorLines.push(line);
    return line;
  };
  /** One stretch of the student's speech. `text: null` leaves the written version out. */
  const stretch = async (text, { ms = 1500, start = true } = {}) => {
    items += 1;
    const id = `item_${items}`;
    if (start) await feed({ type: 'input_audio_buffer.speech_started', audio_start_ms: 10000 });
    await feed({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 10000 + ms });
    await feed({ type: 'input_audio_buffer.committed', item_id: id });
    if (text !== null) await feed({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: text });
    return id;
  };
  /** Answer any question the page puts to the model's ear; returns how many were asked. */
  const answerEar = async (events, answer) => {
    let asked = 0;
    for (const event of events.filter(isEar)) {
      asked += 1;
      responses += 1;
      const id = `resp_${responses}`;
      await feed({ type: 'response.created', response: { id, metadata: { purpose: 'ear' } } });
      await feed({ type: 'response.output_text.done', response_id: id, text: answer });
      await feed({ type: 'response.done', response: { id, status: 'completed', output: [{ content: [{ type: 'output_text', text: answer }] }] } });
    }
    return asked;
  };
  const isReply = (event) => event.type === 'response.create' && !isEar(event);
  /** The student says something whole; the tutor says whatever the page then asks for. */
  const exchange = async (text, { ear = 'yes', ms = 1500 } = {}) => {
    await stretch(text, { ms });
    let events = await awaitSend((event) => isReply(event) || isEar(event));
    let ears = await answerEar(events, ear);
    if (ears && !events.some(isReply)) {
      const more = await awaitSend(isReply);
      events = [...events, ...more];
    }
    const replies = events.filter(isReply);
    const lines = [];
    for (const reply of replies) lines.push(await speak(reply));
    // Anything queued behind it (a second line), or started by itself.
    await wait(250);
    for (const reply of (await fresh()).filter(isReply)) lines.push(await speak(reply));
    return { lines, ears, replies: lines.length, events };
  };

  console.log('\nA call, in the browser');
  let events = await awaitSend(isReply, 6000);
  check('the call connects and the tutor is asked to speak first', events.some(isReply), consoleErrors.join(' | '));
  await feed({ type: 'session.created', session: { audio: { input: { turn_detection: { type: 'semantic_vad', create_response: false } } } } });
  // 0. Outside any lesson, a cough cuts the greeting off. There is no line to
  //    say again, so the tutor is asked to pick up by itself — not left silent.
  await speak(events.filter(isReply)[0], { cut: true });
  await feed({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 1800 });
  await feed({ type: 'input_audio_buffer.committed', item_id: 'cough_0' });
  await feed({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'cough_0', transcript: '' });
  events = await awaitSend(isReply, 3000);
  check('cut off by a cough in ordinary conversation, the tutor is asked to carry on', events.filter(isReply).length === 1, JSON.stringify(events.map((event) => event.type)));
  for (const reply of events.filter(isReply)) await speak(reply);

  // 1. Asking for a lesson by voice.
  let out = await exchange('I want to do a vocabulary lesson on vegetables and meats.');
  check('"I want a vocabulary lesson on…" starts it: "OK. One moment."', out.lines[0] === 'OK. One moment.', JSON.stringify(out.lines));
  let more = await awaitSend(isReply, 5000);
  const first = [];
  for (const reply of more.filter(isReply)) first.push(await speak(reply));
  const firstLine = [...out.lines.slice(1), ...first].join(' ');
  check('when its material is written, the tutor begins — once', /"gyuuniku" means beef\. Say it\.$/.test(firstLine) && out.lines.length + first.length === 2, JSON.stringify([...out.lines, ...first]));
  const all1 = await sent();
  const hint = all1.filter((event) => event.type === 'session.update' && event.session && event.session.audio).pop();
  check('the transcriber is told the part\'s words, mid-call', Boolean(hint) && /ほうれん草 \(hourensou, spinach\)/.test(hint.session.audio.input.transcription.prompt), hint ? hint.session.audio.input.transcription.prompt : 'no update sent');
  check('and the turn-taking settings are restated with it', Boolean(hint) && hint.session.audio.input.turn_detection.create_response === false && hint.session.audio.input.turn_detection.eagerness === 'low');

  // 2. A plain right answer.
  out = await exchange('牛肉');
  check('a right answer goes on to the next thing', out.replies === 1 && /"hourensou" means spinach\. Say it\.$/.test(out.lines[0]), JSON.stringify(out.lines));

  // 3. A pause in the middle of an answer: the second half begins before the first has been written down.
  await feed({ type: 'input_audio_buffer.speech_started', audio_start_ms: 20000 });
  await feed({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 21000 });
  await feed({ type: 'input_audio_buffer.committed', item_id: 'split_a' });
  await feed({ type: 'input_audio_buffer.speech_started', audio_start_ms: 21600 });
  await feed({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'split_a', transcript: 'ほうれん' });
  await wait(500);
  check('half an answer is not answered while they are still speaking', !(await fresh()).some(isReply));
  await feed({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 22400 });
  await feed({ type: 'input_audio_buffer.committed', item_id: 'split_b' });
  await feed({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'split_b', transcript: 'そう' });
  events = await awaitSend(isReply);
  let lines = [];
  for (const reply of events.filter(isReply)) lines.push(await speak(reply));
  await wait(250);
  check('the two halves are one answer, answered once — and it was right', lines.length === 1 && /^How do you say "beef"\?$/.test(lines[0]) && !(await fresh()).some(isReply), JSON.stringify(lines));

  // 4. A reply on its way is taken back when they go on speaking.
  await stretch('gyuu');
  events = await awaitSend((event) => isReply(event) || isEar(event));
  await answerEar(events, 'no');
  if (!events.some(isReply)) events = [...events, ...await awaitSend(isReply)];
  const doomed = events.filter(isReply);
  check('"gyuu…" on its own gets a correction ready', doomed.length === 1 && /gyuuniku/.test(lineOf(doomed[0])), doomed.map(lineOf).join(' / '));
  // They carry on before a word of it is heard: the session stops the reply.
  await feed({ type: 'input_audio_buffer.speech_started', audio_start_ms: 30000 });
  await speak(doomed[0], { unsaid: true });
  await feed({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 30800 });
  await feed({ type: 'input_audio_buffer.committed', item_id: 'cont_b' });
  await feed({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'cont_b', transcript: 'niku' });
  events = await awaitSend((event) => isReply(event) || isEar(event));
  await answerEar(events, 'no');
  if (!events.some(isReply)) events = [...events, ...await awaitSend(isReply)];
  lines = [];
  for (const reply of events.filter(isReply)) lines.push(await speak(reply));
  check('"gyuu… niku" is answered as one thing, and is right', lines.length === 1 && /^Hai/.test(lines[0]) && /"butaniku" means pork\. Say it\.$/.test(lines[0]), JSON.stringify(lines));

  // 5. What the recogniser could not write down: the model that heard it is asked.
  out = await exchange('Paurenchu zzz', { ear: 'Yes.' });
  check('noise for a transcript: the voice model is asked what it heard', out.ears === 1, `asked ${out.ears} times`);
  const earEvent = out.events.find(isEar);
  check('outside the conversation, in text, pointed at what was said', Boolean(earEvent) && earEvent.response.output_modalities[0] === 'text' && earEvent.response.input[0].type === 'item_reference' && /"butaniku" \(pork\)/.test(earEvent.response.instructions));
  check('it heard the word: no correction, the lesson goes on', out.replies === 1 && !/Not quite|I heard|Once more/.test(out.lines[0]) && /^Buta is pig\./.test(out.lines[0]), JSON.stringify(out.lines));

  // 6. They spoke, and nothing was written down at all.
  out = await exchange('', { ear: 'no', ms: 2600 });
  check('an empty transcript is not called wrong', out.replies === 1 && /^Sorry, I didn't catch that\. /.test(out.lines[0]) && !/Not quite|I heard/.test(out.lines[0]), JSON.stringify(out.lines));
  out = await exchange('Spinach.');
  check('and the same thing answered properly goes on', out.replies === 1 && /^Hai/.test(out.lines[0]), JSON.stringify(out.lines));

  // 7. A click after the tutor has finished: not speech, not an answer.
  await stretch('', { ms: 150 });
  await wait(1200);
  events = await fresh();
  check('a click is answered with nothing — and nobody is asked about it', !events.some(isReply) && !events.some(isEar), JSON.stringify(events.map((event) => event.type)));

  // 8. A cough while the tutor is talking cuts it off; it says the rest, once, and nothing is marked.
  out = await exchange('牛肉をください。');
  check('(a right answer, to get the tutor talking)', out.replies === 1, JSON.stringify(out.lines));
  await stretch('豚肉');
  events = await awaitSend(isReply);
  const interrupted = events.filter(isReply)[0];
  const whole = lineOf(interrupted);
  await speak(interrupted, { cut: true });            // speech_started arrives part-way through
  await wait(400);
  check('nothing is asked for on top of the sound that cut it off', !(await fresh()).some(isReply));
  await feed({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 1900 });
  await feed({ type: 'input_audio_buffer.committed', item_id: 'cough' });
  await feed({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'cough', transcript: '' });
  events = await awaitSend(isReply, 2500);
  lines = [];
  for (const reply of events.filter(isReply)) lines.push(await speak(reply));
  await wait(1500);
  const after = await fresh();
  for (const reply of after.filter(isReply)) lines.push(await speak(reply));
  check('cut off by a cough, the tutor finishes its line — once', lines.length === 1 && whole.endsWith(lines[0]), JSON.stringify({ whole, lines }));
  check('and the cough is not judged', !lines.some((line) => /Not quite|I heard|didn't catch/.test(line)) && !after.some(isEar));

  // 9. The student speaks over a line they have not finished hearing: the
  //    rest of it is said, and what they said over it is not marked.
  out = await exchange('豚肉とほうれん草ください');
  check('(an order, said back — and on to the quick round)', out.replies === 1 && /butaniku to hourensou desu ne/.test(out.lines[0]), JSON.stringify(out.lines));
  await stretch('牛肉');
  events = await awaitSend(isReply);
  const talkedOver = events.filter(isReply)[0];
  const wholeLine = lineOf(talkedOver);
  await speak(talkedOver, { cut: true, keep: 1 });
  await feed({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 2400 });
  await feed({ type: 'input_audio_buffer.committed', item_id: 'over' });
  await feed({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'over', transcript: 'えっと、なに' });
  events = await awaitSend(isReply, 4000);
  lines = [];
  for (const reply of events.filter(isReply)) lines.push(await speak(reply));
  await wait(600);
  for (const reply of (await fresh()).filter(isReply)) lines.push(await speak(reply));
  check('spoken over, the tutor finishes what it was saying — and marks nothing', lines.length === 1 && wholeLine.endsWith(lines[0]) && !/Not quite|It's "/.test(lines[0]), JSON.stringify({ wholeLine, lines }));

  // 10. Nothing written down, and the model heard no speech in it either.
  await stretch('', { ms: 2600 });
  events = await awaitSend(isEar, 3000);
  const nothings = await answerEar(events, 'Nothing.');
  await wait(1200);
  const quiet = await fresh();
  check('a cough the model calls nothing is answered with nothing', nothings === 1 && !quiet.some(isReply), JSON.stringify(quiet.map((event) => event.type)));

  // 11. In ordinary conversation, asked for a drill of words already known.
  await page.click('#endLessonBtn');
  await wait(600);
  for (const reply of (await fresh()).filter(isReply)) await speak(reply);
  out = await exchange('Drill me on the basic colors. Give me one word prompts for the basic colors in English, and I will give you the Japanese word');
  more = await awaitSend(isReply, 5000);
  const drillLines = [...out.lines];
  for (const reply of more.filter(isReply)) drillLines.push(await speak(reply));
  check('"Drill me on the basic colors": it waits for the words, then a quick round of them', drillLines[0] === 'OK. One moment.' && /^Quick round\. What is (red|blue|yellow|green|black|white)\?$/.test(drillLines[drillLines.length - 1]), JSON.stringify(drillLines));
  check('the drill is made from the saved words, offered as they are written', drillAsked.length === 1 && drillAsked[0].candidates.some((entry) => entry.say === 'akai' && entry.script === '赤い'), JSON.stringify(drillAsked.map((body) => body.candidates)));
  check('and nothing is taught', !drillLines.some((line) => /\bmeans\b|Say it\./.test(line)), JSON.stringify(drillLines));

  console.log('\nWhat the tutor said, in order:');
  for (const line of tutorLines) console.log(`  T: ${line}`);
  console.log(`\nJudge consulted for: ${JSON.stringify(judged)}`);
  if (consoleErrors.length) console.log(`\nBrowser errors:\n  ${consoleErrors.join('\n  ')}`);
  check('no errors in the browser', consoleErrors.length === 0, consoleErrors.join(' | '));

  await page.click('#endCallBtn').catch(() => {});
  await wait(800);
  await browser.close();
  console.log(`\n${failures.length ? `${failures.length} FAILED` : 'all passed'}`);
  process.exit(failures.length ? 1 : 0);
}
