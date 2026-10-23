/**
 * tools/sim/worker.mjs
 *
 * Runs test sessions on this machine.
 *
 *   npm run sim:worker
 *
 * Leave it running in a terminal. It watches tools/sim/io/req for requests to
 * start a session, runs each one as a separate process (so it always uses the
 * code on disk as it is at that moment), and prints the running spend.
 *
 * It exists because the tools that ask for test sessions have no route to the
 * OpenAI API of their own, and this machine does. It does nothing unless a
 * request file appears, spends nothing beyond the cap in budget.mjs, and can
 * be stopped at any time with Ctrl+C.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

import * as budget from './budget.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const HOME = process.env.SIM_HOME ? path.resolve(process.env.SIM_HOME) : HERE;
const IO = path.join(HOME, 'io');
const REQ = path.join(IO, 'req');
const RES = path.join(IO, 'res');
const CLAIMED = path.join(IO, 'claimed');
const RUNS = path.join(HOME, 'runs');
const HEARTBEAT = path.join(IO, 'worker.json');

/** Sessions running at once. */
const MAX_PARALLEL = 3;
/** Below this, no new session is started: it could not get anywhere. */
const MIN_TO_START_USD = 0.25;

for (const dir of [REQ, RES, CLAIMED, RUNS]) fs.mkdirSync(dir, { recursive: true });

/**
 * Printing, kept off the main thread.
 *
 * Writing to a Windows console blocks while text in the window is selected —
 * click in it and the process that is printing stops dead until a key is
 * pressed. That happened: the worker froze on the line announcing a session,
 * with the session claimed and never started. So the terminal is written to
 * from a thread of its own, which can block for as long as it likes, and
 * everything is also appended to a log file.
 */
const LOG_FILE = path.join(HOME, 'worker.log');
const printer = new Worker(
  "const { parentPort } = require('node:worker_threads'); parentPort.on('message', (line) => { try { process.stdout.write(line + '\\n'); } catch {} });",
  { eval: true },
);
printer.unref();
function say(line = '') {
  try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`); } catch { /* the terminal still gets it */ }
  try { printer.postMessage(line); } catch { /* the log file still has it */ }
}

/** @type {Map<string, import('node:child_process').ChildProcess>} */
const running = new Map();
let beat = 0;
let lastLine = '';

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function heartbeat() {
  beat += 1;
  let spend = null;
  try { spend = budget.status(); } catch { /* reported as null */ }
  try {
    writeJson(HEARTBEAT, {
      pid: process.pid,
      beat,
      at: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      running: [...running.keys()],
      spend,
    });
  } catch { /* try again next beat */ }

  try {
    const line = budget.statusLine();
    if (line !== lastLine) {
      lastLine = line;
      say(`  ${line}`);
    }
  } catch { /* the ledger is busy */ }
}

function refuse(session, message) {
  writeJson(path.join(RES, `${session}-0000.json`), { session, seq: 0, ok: false, error: message });
}

function scan() {
  let names = [];
  try { names = fs.readdirSync(REQ); } catch { return; }

  for (const name of names.sort()) {
    const match = /^([A-Za-z0-9_-]{1,60})-0000\.json$/.exec(name);
    if (!match) continue;
    const session = match[1];
    if (running.has(session)) continue;
    if (running.size >= MAX_PARALLEL) return;

    // Claim it by moving it: only one worker can win a rename.
    const claimed = path.join(CLAIMED, name);
    try { fs.renameSync(path.join(REQ, name), claimed); } catch { continue; }

    let remaining = 0;
    try { remaining = budget.status().remainingUsd; } catch { remaining = 0; }
    if (remaining < MIN_TO_START_USD) {
      say(`  refused ${session}: the spend cap has been reached`);
      refuse(session, 'The spend cap has been reached. No more test sessions will run.');
      continue;
    }

    say(`  start   ${session}`);
    const errors = fs.openSync(path.join(RUNS, `${session}.stderr.log`), 'a');
    const child = spawn(process.execPath, [path.join(HERE, 'session.mjs'), claimed], {
      cwd: ROOT,
      stdio: ['ignore', errors, errors],
      windowsHide: true,
    });
    running.set(session, child);
    child.on('exit', (code) => {
      running.delete(session);
      try { fs.closeSync(errors); } catch { /* already closed */ }
      say(`  end     ${session}${code ? ` (exit ${code})` : ''}`);
    });
    child.on('error', (error) => {
      running.delete(session);
      refuse(session, `The session could not be started: ${error?.message || error}`);
    });
  }
}

say('');
say('  Language Tutor — test session worker');
say(`  Watching ${path.relative(ROOT, REQ)} · Ctrl+C to stop`);
say(`  Spend stops at $${budget.STOP_AT_USD} (worst-case meter); the limit is $${budget.HARD_CAP_USD}.`);
say('');

heartbeat();
setInterval(heartbeat, 2000);
setInterval(scan, 400);

function shutdown() {
  for (const child of running.values()) {
    try { child.kill(); } catch { /* already gone */ }
  }
  try { fs.unlinkSync(HEARTBEAT); } catch { /* never written */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
