/**
 * tools/sim/session.mjs
 *
 * One test session against the real tutor.
 *
 * It drives exactly what the app drives: the same prompt builder, the same
 * lesson runtime, the same conductor, the same Lesson Director, the same
 * turn-taking code — only the transport differs. The app speaks to the model
 * over WebRTC with a microphone; this speaks to it over a WebSocket in text,
 * which costs a fraction as much and needs no audio hardware.
 *
 * What that means for what it can and cannot show:
 *   CAN:    whether the tutor teaches — meaning given, one ask per turn, recall
 *           from English, invented corrections, stacked turns, lesson pacing.
 *   CANNOT: whether the tutor HEARS correctly. The student's words arrive as
 *           text, so nothing here exercises speech recognition.
 *
 * Isolation: this never imports the storage layer or the memory route. It reads
 * a profile, read-only, and writes only inside tools/sim/. A student's saved
 * profile, vocabulary and lesson history are not touched.
 *
 * Started by tools/sim/worker.mjs. Talks to its caller through files:
 *   tools/sim/io/req/<session>-<n>.json   ->   tools/sim/io/res/<session>-<n>.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OPENAI_API_KEY, OPENAI_BASE_URL, REALTIME_MODEL, redact,
} from '../../src/config.js';
import { getLessonLibrary } from '../../src/lessons.js';
import { getReferenceLibrary, referenceFor, topicsFor } from '../../src/reference.js';
import { planPhase } from '../../src/planner.js';
import { judgeAnswer } from '../../src/judge.js';
import { directLesson } from '../../src/director.js';
import { coerceLevel } from '../../public/shared/levels.js';
import { buildTutorPrompt } from '../../public/shared/prompt.js';
import { referenceFacts } from '../../public/shared/lesson-prompt.js';
import { renderTurn } from '../../public/shared/script.js';
import { toDisplayText } from '../../public/shared/romaji.js';
import { createDefaultProfile, migrateProfile } from '../../public/shared/profile.js';
import { LessonConductor } from '../../public/shared/conductor.js';
import { LessonLibrary } from '../../public/js/lessons.js';
import { RealtimeSession, contextLimitEvent } from '../../public/js/realtime.js';
import * as budget from './budget.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const HOME = process.env.SIM_HOME ? path.resolve(process.env.SIM_HOME) : HERE;
const IO = path.join(HOME, 'io');
const REQ = path.join(IO, 'req');
const RES = path.join(IO, 'res');
const RUNS = path.join(HOME, 'runs');

/** No single reply may cost more than this many output tokens. */
const MAX_OUTPUT_TOKENS = 1200;
/** A session ends itself after this many student turns... */
const MAX_TURNS = 40;
/** ...or this long with nobody talking to it... */
const IDLE_MS = 8 * 60 * 1000;
/** ...or this long in total. */
const MAX_SESSION_MS = 40 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const seqName = (session, n) => `${session}-${String(n).padStart(4, '0')}.json`;

// ---------------------------------------------------------------------------

const startFile = process.argv[2];
const start = startFile ? readJson(startFile) : null;
if (!start || !start.session) {
  console.error('usage: node tools/sim/session.mjs <claimed-start-request.json>');
  process.exit(2);
}

const SESSION = String(start.session).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
const startedAt = Date.now();
const logFile = path.join(RUNS, `${SESSION}.jsonl`);
let seq = 0;

/** Same shape as the app's own session log, so `npm run logs` can read it. */
function log(type, payload = {}) {
  try {
    seq += 1;
    const line = JSON.stringify({
      seq,
      at: Math.round((Date.now() - startedAt) / 100) / 10,
      type,
      ...payload,
    });
    fs.appendFileSync(logFile, `${redact(line)}\n`);
  } catch { /* a log line is never worth an exception */ }
}

function respond(n, body) {
  writeJsonAtomic(path.join(RES, seqName(SESSION, n)), { session: SESSION, seq: n, ...body });
}

function fail(n, message) {
  log('sim.error', { message: redact(message) });
  respond(n, { ok: false, error: redact(message), spend: budget.status() });
}

// --- Every HTTP call to OpenAI is metered, and refused if it will not fit ----

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  const isOpenAI = url.startsWith(OPENAI_BASE_URL) || /(^|\.)openai\.com\//.test(url.replace(/^https?:\/\//, ''));
  if (!isOpenAI) return realFetch(input, init);

  if (!/\/chat\/completions$/.test(new URL(url).pathname)) {
    throw new budget.BudgetExceeded('The harness only permits chat completions over HTTP.');
  }
  const body = typeof init.body === 'string' ? init.body : '';
  let parsed = {};
  try { parsed = JSON.parse(body); } catch { /* priced on its length regardless */ }
  const maxOut = Number(parsed.max_tokens || parsed.max_completion_tokens) || 2000;
  const id = budget.reserve(
    'text-model',
    budget.chatWorstCase({ inputTokens: budget.tokensUpperBound(body), maxOutputTokens: maxOut }),
  );

  let response;
  try {
    response = await realFetch(input, init);
  } catch (error) {
    budget.settle(id, null); // unknown outcome: charged in full
    throw error;
  }
  try {
    const data = await response.clone().json();
    const cost = budget.chatCost(data?.usage, String(parsed.model || ''));
    if (cost) {
      budget.settle(id, cost);
      log('usage', { kind: 'text-model', ...cost });
    } else if (!response.ok) {
      budget.release(id); // refused by the API: nothing was generated
    } else {
      budget.settle(id, null);
    }
  } catch {
    budget.settle(id, null);
  }
  return response;
};

// --- The student this session pretends to be --------------------------------

function loadProfile() {
  const language = String(start.language || 'Japanese');
  let profile = createDefaultProfile({ userName: 'Student', language, level: start.level });
  if (start.profile && typeof start.profile === 'string') {
    // Read-only. This file is opened for reading and never written.
    const source = path.join(ROOT, 'Users', start.profile, language, 'config.json');
    const saved = readJson(source);
    if (saved) profile = migrateProfile(saved, { userName: start.profile, language }).profile;
  }
  if (start.level) profile.proficiency_level = coerceLevel(start.level);
  if (start.overrides && typeof start.overrides === 'object') Object.assign(profile, start.overrides);
  return profile;
}

// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(RUNS, { recursive: true });
  fs.mkdirSync(RES, { recursive: true });

  if (!OPENAI_API_KEY) return fail(0, 'No OPENAI_API_KEY in .env.');
  if (typeof WebSocket !== 'function') {
    return fail(0, `The harness needs Node 22 or newer (this is ${process.version}).`);
  }

  const profile = loadProfile();
  const language = profile.target_language;

  const lessonLibrary = await getLessonLibrary();
  const referenceLibrary = await getReferenceLibrary();
  const library = new LessonLibrary();
  library.skills = lessonLibrary.skills;
  library.reference = referenceLibrary.languages;
  library.topics = referenceLibrary.topics || {};
  library.loaded = true;
  library.startCall();

  // The Director, called directly rather than through the app's HTTP route.
  library.runDirector = async (transcript, { language: lang = '', level = '' } = {}) => {
    if (!library.runtime.isActive) return { ok: false, applied: null, error: 'No lesson is running.' };
    if (library.directorBusy) return { ok: false, applied: null, error: 'Already running.' };
    const skillId = library.runtime.skillId;
    library.directorBusy = true;
    try {
      const result = await directLesson({
        skill: library.runtime.skill,
        state: library.runtime.snapshot(),
        transcript,
        language: lang,
        level: coerceLevel(level),
        reference: referenceFor(referenceLibrary.languages, lang),
      });
      if (!result || !result.direction) {
        return { ok: false, applied: null, error: result?.error || 'The Director returned nothing.' };
      }
      if (library.runtime.skillId !== skillId) {
        return { ok: false, applied: null, error: 'The lesson changed while the director was thinking.' };
      }
      return { ok: Boolean(result.ok), applied: library.applyDirection(result.direction), error: result.error || null };
    } catch (error) {
      return { ok: false, applied: null, error: redact(error?.message || String(error)) };
    } finally {
      library.directorBusy = false;
    }
  };

  // The planner, likewise called directly.
  library.fetchPlan = async (phaseId, { language: lang = '', level = '', known = [], requests = [], scenes = [], candidates = [] } = {}) => {
    if (!library.runtime.isActive) return { ok: false, plan: null, error: 'No lesson is running.' };
    if (start.plan === 'off') return { ok: false, plan: null, error: 'Planning is switched off for this run.' };
    try {
      return await planPhase({
        skill: library.runtime.skill,
        phaseId,
        state: { phase: phaseId, runtime_inputs: library.runtime.snapshot().runtime_inputs },
        language: lang,
        level: coerceLevel(level),
        reference: referenceFor(referenceLibrary.languages, lang),
        topics: topicsFor(referenceLibrary.topics, lang),
        taught: library.runtime.plannedItems(),
        known: Array.isArray(known) ? known : [],
        requests: Array.isArray(requests) ? requests : [],
        scenes: Array.isArray(scenes) ? scenes : [],
        candidates: Array.isArray(candidates) ? candidates : [],
        model: start.planModel ? String(start.planModel) : '',
      });
    } catch (error) {
      return { ok: false, plan: null, error: redact(error?.message || String(error)) };
    }
  };

  // Plan-only: write the material for a lesson's parts and stop. No call is
  // made to the realtime model, so this is the cheap way to check what the
  // planner produces.
  if (start.op === 'plan') {
    const activated = library.activate(String(start.lesson || ''), { reason: 'ui' });
    if (!activated.ok) return fail(0, activated.error || `Could not start lesson "${start.lesson}".`);
    if (start.subject) {
      for (const input of library.runtime.skill.runtime_inputs) {
        if (input.type === 'text') library.runtime.setInput(input.id, String(start.subject), 'user');
      }
    }
    const wanted = start.phase ? [String(start.phase)] : library.runtime.skill.phases.map((phase) => phase.id);
    const plans = [];
    for (const phaseId of wanted) {
      library.runtime.setPhase(phaseId, 'harness');
      if (!library.runtime.needsPlan(phaseId)) {
        plans.push({ phase: phaseId, mode: library.runtime.phaseMode(phaseId), plan: null, script: library.runtime.currentScript() });
        continue;
      }
      const result = await library.fetchPlan(phaseId, {
        language,
        level: profile.proficiency_level,
        known: profile.recent_vocab,
      });
      if (result.ok && result.plan) library.runtime.setPlan(phaseId, result.plan);
      // Treat the part as taught, so the next one is planned as it would be mid-lesson.
      for (const item of result.plan?.items || []) library.runtime.taught.push({ say: item.say, meaning: item.meaning });
      plans.push({ phase: phaseId, mode: library.runtime.phaseMode(phaseId), ok: result.ok, error: result.error, plan: result.plan });
    }
    respond(0, { ok: true, plans, spend: budget.status() });
    return undefined;
  }

  if (start.lesson) {
    const activated = library.activate(String(start.lesson), { reason: 'ui' });
    if (!activated.ok) return fail(0, activated.error || `Could not start lesson "${start.lesson}".`);
    if (start.phase) library.runtime.setPhase(String(start.phase), 'harness');
  }

  // --- State the turn loop watches -----------------------------------------
  /** @type {{role: 'user'|'assistant', text: string, at: string}[]} */
  const transcript = [];
  /** Tutor messages, system notes and errors since the last reply was sent. */
  let fresh = { tutor: [], notes: [], errors: [] };
  /** Characters of context the model is carrying, for the pre-call estimate. */
  let instructionText = '';
  let conversationChars = 0;
  /** Reservations for responses asked for but not yet finished, oldest first. */
  const reservations = [];
  let awaitingCreated = 0;
  let openResponses = 0;
  let halted = '';
  let closed = false;
  /** How many of each server event arrived: the first thing to read when a run looks wrong. */
  const eventCounts = {};
  /** Tutor messages captured so far, to notice a response whose text was missed. */
  let tutorMessages = 0;
  let tutorMessagesAtCreated = 0;

  const logPrompt = (reason, instructions) => {
    const context = library.promptContext(language);
    log('prompt', {
      reason,
      chars: instructions.length,
      hasReference: instructions.includes('# REFERENCE'),
      hasLesson: instructions.includes('# RIGHT NOW'),
      hasCatalogue: instructions.includes('# LESSONS'),
      lesson: library.activeId || null,
      phase: library.runtime.phaseId || null,
      referenceKeys: Object.keys(context.reference || {}),
      instructions,
    });
  };

  log('session.start', {
    user: profile.user_name,
    language,
    level: profile.proficiency_level,
    tutor: profile.tutor_name,
    lesson: library.activeId || null,
    phase: library.runtime.phaseId || null,
    weaknesses: (profile.known_weaknesses || []).length,
    vocabulary: (profile.recent_vocab || []).length,
    lessonsAvailable: library.skills.map((skill) => skill.id),
    referenceLanguages: Object.keys(referenceLibrary.languages),
    userAgent: `sim-harness node ${process.version}`,
    startedAt: new Date().toISOString(),
    simulated: true,
    persona: String(start.persona || ''),
    model: REALTIME_MODEL,
    reasoning: start.reasoning || null,
  });
  // --- Transport -------------------------------------------------------------
  const wsUrl = `${OPENAI_BASE_URL.replace(/^http/, 'ws')}/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;
  const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });

  /** @type {(value: any) => void} */
  let onConfigured = () => {};
  const configured = new Promise((resolve) => { onConfigured = resolve; });
  /** @type {(value: any) => void} */
  let onCreated = () => {};
  const created = new Promise((resolve) => { onCreated = resolve; });

  /** Filled in once the conductor exists; the session is built first. */
  const conductorRef = { current: /** @type {any} */ (null) };

  const session = new RealtimeSession({
    onTutorDone: ({ text }) => {
      const value = String(text || '').trim();
      if (!value) return;
      tutorMessages += 1;
      fresh.tutor.push(value);
      transcript.push({ role: 'assistant', text: value, at: new Date().toISOString() });
      conversationChars += value.length;
      log('tutor', { text: value });
      // Where the tutor has got to is read off what it says, as in the app.
      conductorRef.current?.handleTutorTurn(value);
    },
    onError: ({ message }) => {
      fresh.errors.push(redact(message));
      log('realtime.error', { message: redact(message) });
    },
    onNudge: (instruction, options) => log('nudge', { instruction, speak: Boolean(options?.speak) }),
    onTurnEvent: (detail) => log('turn', detail),
    onSilentTurn: ({ afterMs }) => log('turn.rescued', { afterMs }),
  });
  // Who asks for each reply. The app's default is that it does, giving a
  // lesson's words for it; `--turns server` runs the older arrangement, where
  // the model answers on its own from its standing instructions.
  const directed = String(start.turns || 'app') !== 'server';
  session.directed = directed;
  // A text session has no microphone, so what the server reports about turn
  // detection says nothing about who asks for the replies here.
  session.noteSessionConfig = () => {};

  const worstCaseForNextResponse = () =>
    budget.realtimeWorstCase({
      inputTokens: budget.tokensUpperBound(instructionText) + Math.ceil(conversationChars / 2) + conversationChars + 300,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });

  // What RealtimeSession believes is a WebRTC data channel. Every response the
  // tutor is asked for passes the spend gate here; there is no other way out.
  session.dc = {
    readyState: 'open',
    send: (json) => {
      let event;
      try { event = JSON.parse(json); } catch { return; }

      if (event.type === 'response.create') {
        if (halted) return;
        // A reply asked for with instructions of its own: record them, since
        // they are what the tutor was actually told, and price the reply on
        // whichever set is longer.
        const own = typeof event.response?.instructions === 'string' ? event.response.instructions : '';
        const given = Array.isArray(event.response?.input) ? event.response.input : [];
        const read = String(given[given.length - 1]?.content?.[0]?.text || '');
        if (own) log('prompt', { reason: 'turn', chars: own.length, instructions: own, say: read || null });
        try {
          const usual = instructionText;
          if (own.length > instructionText.length) instructionText = own;
          const worst = worstCaseForNextResponse();
          instructionText = usual;
          reservations.push(budget.reserve('tutor', worst));
        } catch (error) {
          halted = error?.message || 'Spend cap reached.';
          log('budget.stop', { message: halted });
          // The turn will not happen; let the session state know.
          queueMicrotask(() => session.handleServerEvent({
            data: JSON.stringify({ type: 'response.done', response: { status: 'failed' } }),
          }));
          return;
        }
        awaitingCreated += 1;
      } else if (event.type === 'session.update' && typeof event.session?.instructions === 'string') {
        instructionText = event.session.instructions;
      } else if (event.type === 'conversation.item.create') {
        for (const part of event.item?.content || []) conversationChars += String(part?.text || '').length;
      }
      if (ws.readyState === 1) ws.send(json);
    },
  };

  ws.onmessage = (message) => {
    const data = typeof message.data === 'string' ? message.data : '';
    let event;
    try { event = JSON.parse(data); } catch { return; }

    eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;

    switch (event.type) {
      case 'session.created':
        onCreated(event.session);
        break;
      case 'session.updated':
        onConfigured(event.session);
        break;
      case 'response.created':
        awaitingCreated = Math.max(0, awaitingCreated - 1);
        openResponses += 1;
        tutorMessagesAtCreated = tutorMessages;
        break;
      case 'response.done': {
        openResponses = Math.max(0, openResponses - 1);
        const id = reservations.shift();
        const cost = budget.realtimeCost(event.response?.usage, REALTIME_MODEL);
        if (id) budget.settle(id, cost);
        log('usage', { kind: 'tutor', status: event.response?.status || '', ...(cost || {}) });
        // If the streaming events for this reply were named something this
        // code does not listen for, recover the text from the finished
        // response rather than reporting a silent tutor.
        if (tutorMessages === tutorMessagesAtCreated && event.response?.status === 'completed') {
          for (const item of event.response.output || []) {
            if (item?.type !== 'message') continue;
            const text = (item.content || [])
              .map((part) => part?.text || part?.transcript || '')
              .join('')
              .trim();
            if (text) session.callbacks.onTutorDone?.({ itemId: String(item.id || ''), text });
          }
        }
        break;
      }
      case 'error': {
        // A refused response.create never produces response.created.
        const about = String(event.error?.message || '');
        if (awaitingCreated > 0 && /response|active|conversation/i.test(about)) {
          awaitingCreated -= 1;
          const id = reservations.pop();
          if (id) budget.release(id);
        }
        onConfigured({ error: about });
        break;
      }
      default:
        break;
    }
    session.handleServerEvent({ data });
  };

  ws.onerror = () => { fresh.errors.push('The connection to the Realtime API failed.'); };
  ws.onclose = (event) => {
    closed = true;
    log('sim.closed', { code: event?.code ?? null, reason: redact(String(event?.reason || '')) });
    onCreated(null);
    onConfigured({ error: `closed (${event?.code ?? '?'}) ${redact(String(event?.reason || ''))}` });
  };

  const conductor = new LessonConductor({
    lessons: library,
    getProfile: () => profile,
    getTranscript: () => transcript.map((entry) => ({ ...entry })),
    isLive: () => !closed && !halted,
    nudge: (text, options) => session.nudge(text, options),
    directed,
    respond: (instructions, options) => session.respond(instructions, options),
    getReference: () => referenceFacts(library.promptContext(language)),
    // Called directly rather than through the web server, like the planner.
    judge: (question) => judgeAnswer(question),
    toTutorScript: (text) => toDisplayText(text, language),
    syncPrompt: () => {
      // Before the call is live there is nothing to update: the opening
      // instructions are built once the first part's material is in.
      if (!session.active) return;
      const instructions = buildTutorPrompt(profile, library.promptContext(language), { opening: false, directed });
      session.updateInstructions(instructions);
      logPrompt('lesson-changed', instructions);
    },
    log,
    note: (text, kind) => {
      fresh.notes.push(text);
      log('system.note', { text, kind });
    },
  });
  conductorRef.current = conductor;

  const opened = await Promise.race([created, sleep(20000).then(() => null)]);
  if (!opened) {
    try { ws.close(); } catch { /* never opened */ }
    return fail(0, `Could not open a Realtime session with ${REALTIME_MODEL}. ${fresh.errors.join(' ')}`);
  }

  // A lesson chosen before the call starts with its material already written,
  // exactly as in the app.
  if (library.isActive) {
    await Promise.race([conductor.ensurePlan('', { quiet: true }), sleep(20000)]);
  }
  const opening = buildTutorPrompt(profile, library.promptContext(language), { directed });
  instructionText = opening;
  logPrompt('initial', opening);

  // Text in, text out. The model is the same; the bill is not.
  ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions: opening,
      output_modalities: ['text'],
      max_output_tokens: MAX_OUTPUT_TOKENS,
      ...(start.reasoning ? { reasoning: { effort: String(start.reasoning) } } : {}),
    },
  }));
  const applied = await Promise.race([configured, sleep(15000).then(() => ({ error: 'timed out' }))]);
  const modalities = Array.isArray(applied?.output_modalities) ? applied.output_modalities : null;
  if (!modalities || modalities.includes('audio')) {
    // Audio output is the expensive part of this API. If the session could not
    // be confirmed as text-only, nothing is asked of it.
    try { ws.close(); } catch { /* closing anyway */ }
    return fail(0, `The session was not confirmed as text-only (${applied?.error || JSON.stringify(modalities)}). Nothing was generated.`);
  }
  log('sim.configured', {
    output_modalities: modalities,
    max_output_tokens: applied.max_output_tokens ?? null,
    reasoning: applied.reasoning ?? null,
  });

  session.active = true;

  // The same context cap the app sets. Sending it here is also the only way it
  // gets exercised against the real API before a real call depends on it.
  session.send(contextLimitEvent());

  /** Wait until the tutor has finished everything this turn set in motion. */
  async function settle(timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    let quietSince = 0;
    while (Date.now() < deadline && !closed) {
      const busy =
        awaitingCreated > 0 || openResponses > 0 || session.responseActive ||
        session.turnPending || session.turnInFlight || Boolean(session.retryTimer) || conductor.busy;
      if (busy && !halted) quietSince = 0;
      else if (!quietSince) quietSince = Date.now();
      if (quietSince && Date.now() - quietSince >= 450) return true;
      await sleep(40);
    }
    return false;
  }

  function reply(n, extra = {}) {
    const snapshot = library.runtime.snapshot();
    const out = fresh;
    fresh = { tutor: [], notes: [], errors: [] };
    respond(n, {
      ok: !halted && !closed,
      tutor: out.tutor,
      notes: out.notes,
      errors: out.errors,
      lesson: library.activeId || null,
      phase: snapshot.phase_name || null,
      progress: snapshot.progress ?? null,
      halted: halted || null,
      closed,
      spend: budget.status(),
      log: path.relative(ROOT, logFile),
      ...extra,
    });
  }

  // The tutor speaks first, exactly as in the app: inside a lesson, with the
  // lesson's first line.
  const openingTurn = conductor.openingTurn();
  session.lastTurn = openingTurn
    ? { instructions: openingTurn.instructions, fresh: true, say: openingTurn.say, examples: openingTurn.examples }
    : null;
  session.send(session.replyRequest(session.lastTurn));
  await settle();
  reply(0);

  // --- Turn loop -------------------------------------------------------------
  let n = 1;
  let turns = 0;
  let lastActivity = Date.now();
  let reason = 'ended';

  for (;;) {
    if (halted) { reason = 'spend cap'; break; }
    if (closed) { reason = 'connection closed'; break; }
    if (turns >= MAX_TURNS) { reason = 'turn limit'; break; }
    if (Date.now() - lastActivity > IDLE_MS) { reason = 'idle'; break; }
    if (Date.now() - startedAt > MAX_SESSION_MS) { reason = 'time limit'; break; }

    const file = path.join(REQ, seqName(SESSION, n));
    const request = fs.existsSync(file) ? readJson(file) : null;
    if (!request) { await sleep(150); continue; }
    lastActivity = Date.now();

    if (request.op === 'end') { reply(n, { ended: true }); n += 1; reason = 'ended by caller'; break; }

    if (request.op === 'read') {
      // A development aid: one line, read aloud, with nothing else in view.
      const text = String(request.text || '').trim();
      const made = renderTurn({ mode: 'exact', line: text }, { tutor: profile.tutor_name, student: profile.user_name, language });
      session.readEffort = String(request.effort || '');
      if (request.shots) {
        const user = (value) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: value }] });
        const tutor = (value) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }] });
        const shots = [
          'Hai. "ichi" means one. Say it.',
          'Not quite. I heard "mizo". It\'s "mizu". Say it once more.',
          'Hai. You want to thank someone. What do you say?',
        ];
        session.send({
          type: 'response.create',
          response: {
            instructions: String(request.instructions || '') || made.instructions,
            input: [...shots.flatMap((shot) => [user(shot), tutor(shot)]), user(text)],
            ...(session.readEffort ? { reasoning: { effort: session.readEffort } } : {}),
          },
        });
      } else {
        session.respond(String(request.instructions || '') || made.instructions, {
          fresh: true, say: text, examples: request.instructions ? [] : made.examples,
        });
      }
      await settle();
      reply(n);
      n += 1;
      continue;
    }

    if (request.op === 'say') {
      const text = String(request.text || '').trim();
      if (!text) { reply(n, { ok: false, errors: ['Nothing was said.'] }); n += 1; continue; }
      turns += 1;
      transcript.push({ role: 'user', text, at: new Date().toISOString() });
      log('student', { text });

      // What the browser sees when the student stops speaking...
      session.handleServerEvent({ data: JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }) });
      // ...what the server would have heard...
      session.send({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      });
      if (directed) {
        // The server waits. The app reads the transcription, decides the
        // reply, and asks for it — as it does in a real call.
        const decided = await conductor.answerStudent(text);
        if (decided) conductor.speak(decided);
        else if (decided !== false) session.respond('');
      } else {
        // ...and the reply it would have begun on its own.
        session.send({ type: 'response.create' });
        // Then the app reacts to the transcription, as it does in a real call.
        conductor.handleStudentTurn(text);
      }

      const settled = await settle();
      reply(n, settled ? {} : { errors: ['The tutor did not finish replying in time.'] });
      n += 1;
      continue;
    }

    reply(n, { ok: false, errors: [`Unknown request "${request.op}".`] });
    n += 1;
  }

  conductor.stop();
  session.active = false;
  try { ws.close(); } catch { /* already closed */ }

  const snapshot = library.runtime.snapshot();
  log('sim.events', eventCounts);
  log('session.end', {
    turns: transcript.length,
    lessons: library.activeId ? 1 : 0,
    durationSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
    reason,
    phase: snapshot.phase || null,
    progress: snapshot.progress ?? null,
    simulated: true,
  });
  writeJsonAtomic(path.join(RES, `${SESSION}-final.json`), {
    session: SESSION,
    reason,
    turns,
    phase: snapshot.phase_name || null,
    progress: snapshot.progress ?? null,
    objectives: snapshot.objectives || null,
    spend: budget.status(),
    log: path.relative(ROOT, logFile),
  });
}

main()
  .catch((error) => {
    fail(0, error?.stack || String(error));
  })
  .finally(() => {
    // Give the last file writes a moment, then make sure nothing lingers.
    setTimeout(() => process.exit(0), 200);
  });
