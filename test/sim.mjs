/**
 * test/sim.mjs
 *
 * The test harness, tested — offline, against a mock of the Realtime API.
 *
 * The harness spends real money when it runs for real, so the two things
 * checked hardest here are the two that must never fail: the spend cap, and
 * the promise that a test session leaves a student's saved profile alone.
 *
 *   node test/sim.mjs
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${String(error?.message || error).split('\n')[0]}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lt-sim-'));

/** A fresh copy of the ledger module pointed at a throwaway directory. */
async function freshBudget() {
  const home = tempHome();
  process.env.SIM_HOME = home;
  const budget = await import(`../tools/sim/budget.mjs?cache=${Math.random()}`);
  return { home, budget };
}

// ===========================================================================
section('The spend cap');
// ===========================================================================

await test('the stop line sits below the owner’s limit', async () => {
  const { budget } = await freshBudget();
  assert.equal(budget.HARD_CAP_USD, 20);
  assert.ok(budget.STOP_AT_USD < budget.HARD_CAP_USD);
  assert.ok(budget.STOP_AT_USD <= 15, 'at least a quarter of the limit is held back for metering error');
});

await test('a new ledger starts at nothing spent', async () => {
  const { budget } = await freshBudget();
  const s = budget.status();
  assert.equal(s.spentWorstUsd, 0);
  assert.equal(s.remainingUsd, budget.STOP_AT_USD);
});

await test('a call is reserved before it is made and settled at its real cost', async () => {
  const { budget } = await freshBudget();
  const id = budget.reserve('tutor', 0.5);
  assert.equal(budget.status().reservedUsd, 0.5);
  budget.settle(id, { worstUsd: 0.1, expectedUsd: 0.02 });
  const s = budget.status();
  assert.equal(s.reservedUsd, 0);
  assert.ok(Math.abs(s.spentWorstUsd - 0.1) < 1e-9);
  assert.ok(Math.abs(s.spentExpectedUsd - 0.02) < 1e-9);
  assert.equal(s.calls, 1);
});

await test('a call that would cross the stop line is refused, and costs nothing', async () => {
  const { budget } = await freshBudget();
  // Held against the stop line: twice what it cost at published prices.
  budget.settle(budget.reserve('tutor', 14.99), { worstUsd: 14.99, expectedUsd: 7.495 });
  assert.throws(() => budget.reserve('tutor', 0.02), /Spend cap reached/);
  const s = budget.status();
  assert.ok(Math.abs(s.spentWorstUsd - 14.99) < 1e-9, 'the refused call added nothing');
  assert.equal(s.reservedUsd, 0);
  assert.equal(s.refused, 1);
});

await test('calls still in flight count against the cap', async () => {
  const { budget } = await freshBudget();
  budget.reserve('tutor', 10);
  budget.reserve('tutor', 4.9);
  assert.throws(() => budget.reserve('tutor', 0.2), /Spend cap reached/, 'two sessions cannot both slip under');
});

await test('a call whose real cost never comes back is charged in full', async () => {
  const { budget } = await freshBudget();
  budget.settle(budget.reserve('tutor', 0.3), null);
  assert.ok(Math.abs(budget.status().spentWorstUsd - 0.3) < 1e-9);
});

await test('a call that was never sent gives its reservation back', async () => {
  const { budget } = await freshBudget();
  budget.release(budget.reserve('tutor', 0.3));
  assert.equal(budget.status().spentWorstUsd, 0);
  assert.equal(budget.status().reservedUsd, 0);
});

await test('a corrupt ledger stops everything rather than starting again from zero', async () => {
  const { home, budget } = await freshBudget();
  budget.settle(budget.reserve('tutor', 5), { worstUsd: 5, expectedUsd: 1 });
  fs.writeFileSync(path.join(home, 'ledger.json'), '{ this is not json');
  assert.throws(() => budget.reserve('tutor', 0.01), /unreadable/);
});

await test('a call with no computable cost is refused', async () => {
  const { budget } = await freshBudget();
  assert.throws(() => budget.reserve('tutor', Number.NaN), /no computable cost/);
  assert.throws(() => budget.reserve('tutor', 0), /no computable cost/);
});

await test('usage is priced at the full model’s rates, whatever model ran', async () => {
  const { budget } = await freshBudget();
  const cost = budget.realtimeCost(
    {
      input_tokens: 1000,
      output_tokens: 100,
      input_token_details: { text_tokens: 1000, audio_tokens: 0, cached_tokens: 200, cached_tokens_details: { text_tokens: 200 } },
      output_token_details: { text_tokens: 100, audio_tokens: 0 },
    },
    'gpt-realtime-2.1-mini',
  );
  assert.ok(Math.abs(cost.worstUsd - 0.00568) < 1e-9, `worst-case was ${cost.worstUsd}`);
  assert.ok(Math.abs(cost.expectedUsd - 0.000732) < 1e-9, `expected was ${cost.expectedUsd}`);
  assert.ok(cost.worstUsd > cost.expectedUsd * 5, 'the meter the cap uses runs well ahead of the real bill');
});

await test('audio tokens, if any appear, are priced as audio', async () => {
  const { budget } = await freshBudget();
  const cost = budget.realtimeCost(
    {
      input_tokens: 100,
      output_tokens: 1000,
      input_token_details: { text_tokens: 100 },
      output_token_details: { text_tokens: 0, audio_tokens: 1000 },
    },
    'gpt-realtime-2.1-mini',
  );
  assert.ok(Math.abs(cost.worstUsd - (100 * 4 + 1000 * 64) / 1e6) < 1e-9);
});

await test('tokens the breakdown does not explain are still charged', async () => {
  const { budget } = await freshBudget();
  const cost = budget.realtimeCost({ input_tokens: 1000, output_tokens: 100 }, 'gpt-realtime-2.1-mini');
  assert.ok(Math.abs(cost.worstUsd - (1000 * 4 + 100 * 24) / 1e6) < 1e-9);
});

await test('the pre-call estimate is generous', async () => {
  const { budget } = await freshBudget();
  const english = 'The quick brown fox jumps over the lazy dog. '.repeat(40);
  assert.ok(budget.tokensUpperBound(english) > english.length / 4, 'more than a real tokeniser would count');
  assert.ok(budget.tokensUpperBound('日本語のテキスト') >= 8 * 3);
});

// ===========================================================================
section('A whole session, against a mock of the API');
// ===========================================================================

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(text) {
  const payload = Buffer.from(text);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Just enough of RFC 6455 to stand in for the Realtime API. */
function reader(socket, onText) {
  let buffer = Buffer.alloc(0);
  let parts = [];
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      const maskLength = masked ? 4 : 0;
      if (buffer.length < offset + maskLength + length) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(offset + maskLength + length);
      if (opcode === 8) { socket.end(); return; }
      if (opcode === 9) { socket.write(Buffer.from([0x8a, 0])); continue; }
      if (opcode === 1 || opcode === 0) {
        parts.push(payload);
        if (fin) { onText(Buffer.concat(parts).toString('utf8')); parts = []; }
      }
    }
  });
}

/** What the mock planner writes for any part. */
const PLAN = {
  items: [
    { say: 'ichi', meaning: 'one', note: '', known: false },
    { say: 'ni', meaning: 'two', note: '', known: false },
    { say: 'san', meaning: 'three', note: '', known: false },
  ],
  scene: {
    setup: 'You are a shop assistant.',
    // Two lines: with fewer the planner is asked for the role-play again.
    lines: [
      { tutor: 'Ikutsu desu ka?', meaning: 'How many?', expect: 'san' },
      { tutor: 'Nanko desu ka?', meaning: 'How many pieces?', expect: 'ni' },
    ],
  },
};

/**
 * @param {{modalities?: string[], direction?: Record<string, any>, plan?: Record<string, any>, usage?: Record<string, any>}} [behaviour]
 */
async function mockApi(behaviour = {}) {
  const seen = { events: [], authorization: '', chatCalls: 0, planCalls: 0, proofCalls: 0, judgeCalls: 0, directorCalls: 0, responses: 0 };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      seen.chatCalls += 1;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        // Four callers share this endpoint: the planner, which wants material;
        // its proofreader; the judge of an answer; and the Director, which
        // wants bookkeeping.
        const planning = /You write the material for one part/.test(body);
        const proofing = /careful native \w+ proofreader/.test(body);
        const judging = /Speech recognition wrote down what they said/.test(body);
        if (planning) seen.planCalls += 1;
        else if (proofing) seen.proofCalls += 1;
        else if (judging) seen.judgeCalls += 1;
        else seen.directorCalls += 1;
        let content = behaviour.direction || {};
        if (planning) content = behaviour.plan || PLAN;
        else if (proofing) content = { wrong: [] };
        else if (judging) content = { heard: '', verdict: 'unclear', other: '' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(content) } }],
          usage: { prompt_tokens: 900, completion_tokens: 80 },
        }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });

  server.on('upgrade', (req, socket) => {
    seen.authorization = String(req.headers.authorization || '');
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const send = (event) => socket.write(frame(JSON.stringify(event)));
    send({ type: 'session.created', session: { id: 'sess_mock' } });

    reader(socket, (text) => {
      const event = JSON.parse(text);
      seen.events.push(event);
      if (event.type === 'session.update') {
        send({
          type: 'session.updated',
          session: {
            output_modalities: behaviour.modalities || event.session.output_modalities || ['audio'],
            max_output_tokens: event.session.max_output_tokens ?? 'inf',
          },
        });
      } else if (event.type === 'response.create') {
        seen.responses += 1;
        const id = `resp_${seen.responses}`;
        // Handed a line to read, a tutor reads it. Otherwise it says something of its own.
        const input = Array.isArray(event.response?.input) ? event.response.input : [];
        const given = input[input.length - 1]?.content?.[0]?.text;
        const reply = typeof given === 'string' && given ? given : `Tutor reply ${seen.responses}.`;
        send({ type: 'response.created', response: { id } });
        send({ type: 'response.output_text.delta', item_id: `item_${seen.responses}`, delta: reply });
        send({ type: 'response.output_text.done', item_id: `item_${seen.responses}`, text: reply });
        send({
          type: 'response.done',
          response: {
            id,
            status: 'completed',
            usage: behaviour.usage || {
              input_tokens: 2000,
              output_tokens: 40,
              input_token_details: { text_tokens: 2000, cached_tokens: 1500, cached_tokens_details: { text_tokens: 1500 } },
              output_token_details: { text_tokens: 40 },
            },
          },
        });
      }
    });
    socket.on('error', () => {});
  });

  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  const close = () =>
    new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      server.close(() => resolve());
      // A test that failed part-way can leave a session attached; never let
      // tidying up be the thing that hangs.
      setTimeout(resolve, 1500);
    });
  return { seen, port, close };
}

function run(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, script), ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('exit', (code) => resolve({ code, out }));
  });
}

/** Everything a student owns, as paths and modification times. */
function fingerprint(dir) {
  const out = [];
  const walk = (current) => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(`${path.relative(ROOT, full)}:${fs.statSync(full).mtimeMs}:${fs.statSync(full).size}`);
    }
  };
  walk(dir);
  return out.sort().join('\n');
}

async function withWorker(behaviour, seedLedger, work) {
  const api = await mockApi(behaviour);
  const home = tempHome();
  if (seedLedger) fs.writeFileSync(path.join(home, 'ledger.json'), JSON.stringify(seedLedger));
  const env = {
    SIM_HOME: home,
    OPENAI_BASE_URL: `http://127.0.0.1:${api.port}/v1`,
    OPENAI_API_KEY: 'sk-test-not-a-real-key-000000',
  };
  const worker = spawn(process.execPath, [path.join(ROOT, 'tools/sim/worker.mjs')], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: 'ignore',
  });
  try {
    await sleep(600);
    return await work({ api, home, env });
  } finally {
    worker.kill();
    await api.close();
  }
}

const usersBefore = fingerprint(path.join(ROOT, 'Users'));
const logsBefore = fingerprint(path.join(ROOT, 'Logs'));
/** The real ledger alone: a live worker may be writing its heartbeat beside it. */
const realLedger = () => {
  try {
    const info = fs.statSync(path.join(ROOT, 'tools', 'sim', 'ledger.json'));
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return 'absent';
  }
};
const realLedgerBefore = realLedger();

await test('a session starts, takes turns, runs the Director, and ends', async () => {
  await withWorker({ direction: { practiced_vocabulary: ['ichi — one'] } }, null, async ({ api, home, env }) => {
    const started = await run('tools/sim/client.mjs', ['start', '--lesson', 'numbers_time_money', '--persona', 'test'], env);
    assert.equal(started.code, 0, started.out);
    assert.match(started.out, /TUTOR: Hi\. .*"ichi" means one\. Say it\./, started.out);
    const session = /session (s[\w-]+)/.exec(started.out)?.[1];
    assert.ok(session, 'the session id is printed');

    // Each answer is the one the script is waiting for, so each reply is the
    // next line: teach, teach, then the first one asked for again.
    const lines = [/TUTOR: "ni" means two\. Say it\./, /TUTOR: How do you say "one"\?/, /TUTOR: Hai — yes\. "san" means three\. Say it\./];
    for (const [index, said] of ['ichi', 'ni', 'ichi'].entries()) {
      const turn = await run('tools/sim/client.mjs', ['say', session, said], env);
      assert.equal(turn.code, 0, turn.out);
      assert.match(turn.out, lines[index], turn.out);
      assert.ok(!/message 2 of/.test(turn.out), `one reply per turn: ${turn.out}`);
    }

    const ended = await run('tools/sim/client.mjs', ['end', session], env);
    assert.equal(ended.code, 0, ended.out);
    await sleep(500);

    // The session was configured as text-only before anything was asked of it.
    const update = api.seen.events.find((event) => event.type === 'session.update');
    assert.deepEqual(update.session.output_modalities, ['text']);
    assert.ok(update.session.max_output_tokens <= 1500, 'every reply is bounded');
    assert.match(update.session.instructions, /# Role and Objective/, 'the real prompt was sent');
    assert.match(update.session.instructions, /# RIGHT NOW/, 'with the lesson in it');
    const firstAsk = api.seen.events.find((event) => event.type === 'response.create');
    assert.match(firstAsk.response.input.at(-1).content[0].text, /"ichi" means one\. Say it\.$/, 'and the first reply is asked for with the first line of its script, written before the call opened');
    assert.match(firstAsk.response.instructions, /Repeat the user's message back word for word/, 'as text to say back, with nothing of the conversation in view');
    assert.ok(
      api.seen.events.some((event) => event.type === 'session.update' && event.session.truncation),
      'the conversation the model carries is capped, as in the app',
    );
    assert.equal(api.seen.authorization, 'Bearer sk-test-not-a-real-key-000000');

    assert.equal(api.seen.responses, 4, 'the greeting and three replies, and nothing stacked on top');
    assert.equal(api.seen.planCalls, 2, 'the first part was planned once, and the next one ahead of time, half-way through it');
    // (The second plan — the mock planner writes the same thing for every
    // part — has nothing left in it to proofread: its items were taught in the
    // first part and its role-play lines were said there.)
    assert.equal(api.seen.proofCalls, 1, 'and a plan is proofread before anything in it is taught');
    assert.equal(api.seen.judgeCalls, 0, 'answers the transcript settles are not sent to a judge');
    assert.equal(api.seen.directorCalls, 1, 'the Director ran after the third turn');

    // Every call is in the ledger, at its worst-case price.
    const ledger = JSON.parse(fs.readFileSync(path.join(home, 'ledger.json'), 'utf8'));
    const perReply = (500 * 4 + 1500 * 0.4 + 40 * 24) / 1e6;
    const textCall = (900 * 5 + 80 * 20) / 1e6;
    assert.ok(Math.abs(ledger.spentWorstUsd - (4 * perReply + 4 * textCall)) < 1e-9, `ledger says ${ledger.spentWorstUsd}`);
    assert.equal(Object.keys(ledger.reservations).length, 0, 'nothing left reserved');

    // And the run is written where the app's own logs are not.
    const log = fs.readFileSync(path.join(home, 'runs', `${session}.jsonl`), 'utf8');
    assert.match(log, /"type":"student","text":"ichi"/);
    assert.match(log, /"type":"tutor","text":"\\"ni\\" means two\. Say it\."/);
    assert.match(log, /"type":"script\.turn"/, 'and what the app chose for each reply is on record');
    assert.match(log, /"simulated":true/);
    assert.ok(!log.includes('sk-test-not-a-real-key'), 'the key is never written to a run log');
  });
});

await test('a session started at the cap asks the API for nothing', async () => {
  const seed = {
    spentWorstUsd: 14.999, spentExpectedUsd: 7.4995, calls: 100, refused: 0, reservations: {}, byKind: {},
  };
  await withWorker({}, seed, async ({ api, env }) => {
    const started = await run('tools/sim/client.mjs', ['start', '--lesson', 'numbers_time_money'], env);
    assert.notEqual(started.code, 0, 'the caller is told it failed');
    assert.match(started.out, /spend cap has been reached/i);
    await sleep(300);
    assert.equal(api.seen.responses, 0, 'no reply was ever requested');
    assert.equal(api.seen.events.length, 0, 'the API was not even contacted');
  });
});

await test('a session that runs out mid-way stops there', async () => {
  // Room for the session to open and for a handful of replies, then no more.
  // Each reply is as large as a reply is permitted to be.
  const seed = {
    spentWorstUsd: 14.74, spentExpectedUsd: 7.37, calls: 100, refused: 0, reservations: {}, byKind: {},
  };
  const usage = {
    input_tokens: 19500,
    output_tokens: 700,
    input_token_details: { text_tokens: 19500 },
    output_token_details: { text_tokens: 700 },
  };
  await withWorker({ usage }, seed, async ({ api, home, env }) => {
    const started = await run('tools/sim/client.mjs', ['start', '--lesson', 'numbers_time_money'], env);
    const session = /session (s[\w-]+)/.exec(started.out)?.[1];
    let stopped = /STOPPED/.test(started.out);
    for (let i = 0; i < 16 && !stopped && session; i += 1) {
      const turn = await run('tools/sim/client.mjs', ['say', session, `turn ${i}`], env);
      stopped = /STOPPED|already ended|has ended/.test(turn.out);
    }
    assert.ok(stopped, 'the session reports that it was stopped');
    const ledger = JSON.parse(fs.readFileSync(path.join(home, 'ledger.json'), 'utf8'));
    assert.ok(ledger.spentExpectedUsd * 2 <= 15, `spend ended at ${ledger.spentExpectedUsd}`);
    assert.ok(ledger.refused >= 1, 'and the refusal is on record');
    assert.ok(api.seen.responses < 16, 'the API stopped being asked');
  });
});

await test('a session that cannot be confirmed as text-only generates nothing', async () => {
  // Audio output is the expensive part of this API by an order of magnitude.
  await withWorker({ modalities: ['audio'] }, null, async ({ api, env }) => {
    const started = await run('tools/sim/client.mjs', ['start', '--lesson', 'numbers_time_money'], env);
    assert.notEqual(started.code, 0);
    assert.match(started.out, /not confirmed as text-only/);
    assert.equal(api.seen.responses, 0);
  });
});

await test('with no worker running, the client says so and does nothing', async () => {
  const home = tempHome();
  const result = await run('tools/sim/client.mjs', ['start', '--lesson', 'numbers_time_money'], { SIM_HOME: home });
  assert.equal(result.code, 3);
  assert.match(result.out, /worker is not running/);
});

// ===========================================================================
section('What a test session must never touch');
// ===========================================================================

await test('no saved profile, vocabulary or lesson history was modified', () => {
  assert.equal(fingerprint(path.join(ROOT, 'Users')), usersBefore);
});

await test('the app’s own session logs were left alone', () => {
  assert.equal(fingerprint(path.join(ROOT, 'Logs')), logsBefore);
});

await test('the tests did not write to the real spend ledger', () => {
  assert.equal(realLedger(), realLedgerBefore);
});

await test('the harness never imports the code that saves a profile', async () => {
  for (const file of ['session.mjs', 'worker.mjs', 'client.mjs', 'budget.mjs']) {
    const source = fs.readFileSync(path.join(ROOT, 'tools', 'sim', file), 'utf8');
    assert.ok(!/routes\/memory|storage\.js|\/api\/memory|applyExtraction/.test(source), `${file} cannot save a profile`);
    assert.ok(!/writeFile[^\n]*Users|Users[^\n]*writeFile/.test(source), `${file} does not write under Users/`);
  }
});

await test('the key is read by the harness and never printed or logged by it', async () => {
  const session = fs.readFileSync(path.join(ROOT, 'tools/sim/session.mjs'), 'utf8');
  assert.match(session, /fs\.appendFileSync\(logFile, `\$\{redact\(line\)\}\\n`\)/, 'every log line is redacted');
  for (const file of ['worker.mjs', 'client.mjs', 'budget.mjs']) {
    const source = fs.readFileSync(path.join(ROOT, 'tools', 'sim', file), 'utf8');
    assert.ok(!source.includes('OPENAI_API_KEY'), `${file} never sees the key`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
