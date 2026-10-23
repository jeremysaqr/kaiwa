/**
 * tools/sim/client.mjs
 *
 * Talk to a test session.
 *
 *   node tools/sim/client.mjs status
 *   node tools/sim/client.mjs start --lesson numbers_time_money --profile Jeremy --persona "true beginner"
 *   node tools/sim/client.mjs say <session> "san, yon, go"
 *   node tools/sim/client.mjs end <session>
 *   node tools/sim/client.mjs transcript <session>
 *
 * This makes no network calls. It writes a request file and waits for the
 * worker (tools/sim/worker.mjs, running on a machine that can reach the API)
 * to write the answer.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.SIM_HOME ? path.resolve(process.env.SIM_HOME) : HERE;
const IO = path.join(HOME, 'io');
const REQ = path.join(IO, 'req');
const RES = path.join(IO, 'res');
const CLAIMED = path.join(IO, 'claimed');
const RUNS = path.join(HOME, 'runs');
const HEARTBEAT = path.join(IO, 'worker.json');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const seqName = (session, n) => `${session}-${String(n).padStart(4, '0')}.json`;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const argv = process.argv.slice(2);
const command = argv[0] || 'status';
const flag = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : '';
};
const asJson = argv.includes('--json');

async function workerAlive() {
  const first = readJson(HEARTBEAT);
  if (!first) return false;
  await sleep(2600);
  const second = readJson(HEARTBEAT);
  return Boolean(second && second.beat !== first.beat);
}

function spendLine(spend) {
  if (!spend) return '';
  return (
    `[spend so far: $${spend.spentExpectedUsd.toFixed(4)} at published prices ` +
    `· stops at $${(spend.stopAtUsd / 2).toFixed(2)}]`
  );
}

function print(result) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.error) console.log(`! ${result.error}`);
  const where = [
    `session ${result.session}`,
    result.lesson ? `lesson ${result.lesson}` : 'no lesson',
    result.phase ? `part: ${result.phase}` : '',
    Number.isFinite(result.progress) ? `~${result.progress}%` : '',
  ].filter(Boolean).join(' · ');
  console.log(`[${where}]`);
  const tutor = result.tutor || [];
  tutor.forEach((text, index) => {
    console.log(`TUTOR${tutor.length > 1 ? ` (message ${index + 1} of ${tutor.length})` : ''}: ${text}`);
  });
  if (!tutor.length && !result.ended) console.log('TUTOR: (said nothing)');
  for (const note of result.notes || []) console.log(`(app note) ${note}`);
  for (const error of result.errors || []) console.log(`! ${error}`);
  if (result.halted) console.log(`! STOPPED: ${result.halted}`);
  if (result.closed) console.log('! The connection to the tutor has closed.');
  const line = spendLine(result.spend);
  if (line) console.log(line);
}

/**
 * Wait for an answer — but not for a worker that has stopped. If its heartbeat
 * stands still for fifteen seconds the wait is abandoned at once, rather than
 * running out the clock and reporting a vague timeout.
 */
async function waitFor(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastBeat = readJson(HEARTBEAT)?.beat;
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    const value = readJson(file);
    if (value) return value;
    const beat = readJson(HEARTBEAT)?.beat;
    if (beat !== lastBeat) { lastBeat = beat; lastChange = Date.now(); }
    else if (Date.now() - lastChange > 15000) return { ok: false, error: 'The worker is not running (its heartbeat has stopped). Nothing can be tested until it is restarted:  npm run sim:worker', workerDown: true };
    await sleep(200);
  }
  return null;
}

function nextSeq(session) {
  let highest = 0;
  for (const dir of [REQ, CLAIMED]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const match = new RegExp(`^${session}-(\\d{4})\\.json$`).exec(name);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
  }
  return highest + 1;
}

async function main() {
  if (command === 'status') {
    const alive = await workerAlive();
    const beat = readJson(HEARTBEAT);
    console.log(alive
      ? `worker: running (node ${beat?.node}, ${beat?.platform}), ${beat?.running?.length || 0} session(s) active`
      : 'worker: NOT running. Start it on the machine that can reach the API:  npm run sim:worker');
    const line = spendLine(beat?.spend);
    if (line) console.log(line);
    process.exit(alive ? 0 : 3);
  }

  if (command === 'start') {
    if (!(await workerAlive())) {
      console.log('! The worker is not running, so nothing can be tested. Start it with:  npm run sim:worker');
      process.exit(3);
    }
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(4, 12);
    const session = `s${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    const request = {
      op: 'start',
      session,
      lesson: flag('lesson') || null,
      phase: flag('phase') || null,
      profile: flag('profile') || null,
      level: flag('level') || null,
      language: flag('language') || 'Japanese',
      persona: flag('persona') || '',
      reasoning: flag('reasoning') || null,
      planModel: flag('plan-model') || null,
      plan: flag('plan') || null,
      turns: flag('turns') || null,
    };
    writeJsonAtomic(path.join(REQ, seqName(session, 0)), request);
    const result = await waitFor(path.join(RES, seqName(session, 0)), 100000);
    if (!result) {
      console.log(`! The session did not start within 100 seconds (session ${session}).`);
      process.exit(4);
    }
    print(result);
    process.exit(result.ok === false ? 5 : 0);
  }

  if (command === 'plan') {
    if (!(await workerAlive())) {
      console.log('! The worker is not running. Start it with:  npm run sim:worker');
      process.exit(3);
    }
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(4, 12);
    const session = `p${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    writeJsonAtomic(path.join(REQ, seqName(session, 0)), {
      op: 'plan',
      session,
      lesson: flag('lesson'),
      phase: flag('phase') || null,
      subject: flag('subject') || null,
      profile: flag('profile') || null,
      level: flag('level') || null,
      language: flag('language') || 'Japanese',
      planModel: flag('plan-model') || null,
    });
    const result = await waitFor(path.join(RES, seqName(session, 0)), 110000);
    if (!result) { console.log('! No plan within 110 seconds.'); process.exit(4); }
    if (asJson) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }
    if (result.error) console.log(`! ${result.error}`);
    for (const entry of result.plans || []) {
      console.log(`\n== ${entry.phase} (${entry.mode})${entry.error ? ` — ${entry.error}` : ''}`);
      for (const item of entry.plan?.items || []) {
        console.log(`   ${item.known ? '(known) ' : ''}${item.say} = ${item.meaning}${item.note ? `  [${item.note}]` : ''}${item.use ? `  {${item.use}}` : ''}`);
      }
      if (entry.plan?.scene?.lines?.length) {
        console.log(`   scene: ${entry.plan.scene.setup}`);
        for (const line of entry.plan.scene.lines) {
          console.log(`     "${line.tutor}" (${line.meaning})  ->  ${line.expect}`);
        }
      }
    }
    const line = spendLine(result.spend);
    if (line) console.log(`\n${line}`);
    process.exit(0);
  }

  // A development aid: have the tutor read one line aloud, to measure how
  // faithfully it does so under a given wording of the instructions.
  //   read <session> <effort|-> <instructions file|-> <the line>
  if (command === 'read') {
    const session = argv[1];
    const effort = argv[2] && argv[2] !== '-' ? argv[2] : '';
    const file = argv[3] && argv[3] !== '-' ? argv[3] : '';
    const text = argv.slice(4).join(' ').trim();
    if (!session || !text) { console.log('! read <session> <effort|-> <instructions file|-> <line>'); process.exit(2); }
    const instructions = file ? fs.readFileSync(file, 'utf8').trim() : '';
    const n = nextSeq(session);
    writeJsonAtomic(path.join(REQ, seqName(session, n)), { op: 'read', session, text, effort, instructions, shots: process.env.SIM_SHOTS === '1' });
    const result = await waitFor(path.join(RES, seqName(session, n)), 105000);
    if (!result) { console.log('! No reply.'); process.exit(4); }
    console.log((result.tutor || []).join(' | '));
    process.exit(0);
  }

  if (command === 'say' || command === 'end') {
    const session = argv[1];
    if (!session) { console.log('! Which session?'); process.exit(2); }
    const text = command === 'say' ? argv.slice(2).filter((part) => part !== '--json').join(' ').trim() : '';
    if (command === 'say' && !text) { console.log('! Say what?'); process.exit(2); }
    if (readJson(path.join(RES, `${session}-final.json`))) {
      console.log('! That session has already ended.');
      process.exit(6);
    }
    const n = nextSeq(session);
    writeJsonAtomic(path.join(REQ, seqName(session, n)), { op: command, session, text });
    const result = await waitFor(path.join(RES, seqName(session, n)), 105000);
    if (!result) {
      const final = readJson(path.join(RES, `${session}-final.json`));
      console.log(final
        ? `! The session has ended (${final.reason}).`
        : '! No reply within 105 seconds. The worker may have stopped:  node tools/sim/client.mjs status');
      process.exit(4);
    }
    print(result);
    process.exit(result.ok === false ? 5 : 0);
  }

  if (command === 'transcript') {
    const session = argv[1];
    const file = path.join(RUNS, `${session}.jsonl`);
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch {
      console.log('! No such session.');
      process.exit(2);
    }
    for (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const at = `${String(Math.floor(event.at / 60)).padStart(2, '0')}:${String(Math.floor(event.at % 60)).padStart(2, '0')}`;
      if (event.type === 'student') console.log(`${at}  STUDENT  ${event.text}`);
      else if (event.type === 'tutor') console.log(`${at}  TUTOR    ${event.text}`);
      else if (event.type === 'nudge') console.log(`${at}  (app -> tutor${event.speak ? ', speak' : ''}) ${event.instruction}`);
      else if (event.type === 'system.note') console.log(`${at}  (app note) ${event.text}`);
      else if (event.type === 'realtime.error' || event.type === 'sim.error') console.log(`${at}  ! ${event.message}`);
    }
    process.exit(0);
  }

  console.log('usage: node tools/sim/client.mjs status | start [...] | say <session> <text> | end <session> | transcript <session>');
  process.exit(2);
}

main();
