/**
 * tools/sim/budget.mjs
 *
 * The spend ledger for the test harness. Every OpenAI call the harness makes
 * goes through here FIRST, and is refused if it could take the running total
 * past the stop line.
 *
 * Three things make this a hard cap rather than a hopeful one:
 *
 *   1. Reserve, then spend. Before a call, its worst possible cost is reserved.
 *      If total + reservations + this one would cross the line, the call is
 *      never made. The reservation is replaced by the real figure afterwards.
 *      A process that dies mid-call leaves its reservation standing, and a
 *      stale reservation is then counted as spent in full.
 *
 *   2. A doubled meter. Each call is costed twice: at the published prices of
 *      the model it used, and at worst-case prices (the FULL realtime model,
 *      six to ten times the mini). The gate was first the worst-case total.
 *      After 1,500 calls the owner compared his OpenAI usage page with the
 *      published-price total and found they agree, and said to go by published
 *      prices. So the gate is now the published-price total, DOUBLED: the
 *      metering can be wrong by half and the stop line still holds. A call
 *      whose cost is unknown is still charged at its full worst-case
 *      reservation, and a call in flight is reserved at worst case.
 *
 *   3. A stop line below the limit. The owner's limit is $20. The harness stops
 *      at $15 on that doubled meter — $7.50 of real spend — so there is room
 *      for error twice over.
 *
 * The ledger is one JSON file, guarded by a lock directory, so several
 * sessions running at once share one total.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The owner's limit. Never to be exceeded under any circumstances. */
export const HARD_CAP_USD = 20;

/** Where the harness actually stops, on the doubled published-price meter. */
export const STOP_AT_USD = 15;

/** What the published-price total is multiplied by before it is held against the stop line. */
export const SAFETY_FACTOR = 2;

const HERE = path.dirname(fileURLToPath(import.meta.url));
// SIM_HOME exists for the harness's own tests, which must never touch the real
// ledger. Nothing else sets it.
const HOME = process.env.SIM_HOME ? path.resolve(process.env.SIM_HOME) : HERE;
export const LEDGER_PATH = path.join(HOME, 'ledger.json');
const LOCK_PATH = `${LEDGER_PATH}.lock`;

/** A reservation nobody settled within this long is counted as spent. */
const STALE_RESERVATION_MS = 10 * 60 * 1000;

/** USD per million tokens. */
const REALTIME_WORST = Object.freeze({
  textIn: 4.0, textCachedIn: 0.4, textOut: 24.0, audioIn: 32.0, audioCachedIn: 0.4, audioOut: 64.0,
});
const REALTIME_MINI = Object.freeze({
  textIn: 0.6, textCachedIn: 0.06, textOut: 2.4, audioIn: 10.0, audioCachedIn: 0.3, audioOut: 20.0,
});
/** Twice gpt-4o's list price: covers any chat model this app might be pointed at. */
const CHAT_WORST = Object.freeze({ in: 5.0, cachedIn: 5.0, out: 20.0 });
const CHAT_4O_MINI = Object.freeze({ in: 0.15, cachedIn: 0.075, out: 0.6 });
const CHAT_41 = Object.freeze({ in: 2.0, cachedIn: 0.5, out: 8.0 });

export class BudgetExceeded extends Error {
  constructor(message) {
    super(message);
    this.name = 'BudgetExceeded';
  }
}

/** Block this thread briefly. The lock is held for microseconds, so this is rare. */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(work) {
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(LOCK_PATH);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // A holder that died leaves the directory behind. Nothing holds this
      // lock for more than a few milliseconds, so ten seconds means dead.
      try {
        if (Date.now() - fs.statSync(LOCK_PATH).mtimeMs > 10000) fs.rmdirSync(LOCK_PATH);
      } catch { /* someone else cleared it */ }
      if (Date.now() - started > 15000) {
        // Failing closed: if the ledger cannot be locked, nothing may be spent.
        throw new BudgetExceeded('The spend ledger could not be locked, so no call was made.');
      }
      pause(20);
    }
  }
  try {
    return work();
  } finally {
    try { fs.rmdirSync(LOCK_PATH); } catch { /* already gone */ }
  }
}

function emptyLedger() {
  return {
    hardCapUsd: HARD_CAP_USD,
    stopAtUsd: STOP_AT_USD,
    spentWorstUsd: 0,
    spentExpectedUsd: 0,
    calls: 0,
    refused: 0,
    reservations: {},
    byKind: {},
    updatedAt: new Date().toISOString(),
  };
}

function read() {
  let raw;
  try {
    raw = fs.readFileSync(LEDGER_PATH, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyLedger();
    throw new BudgetExceeded('The spend ledger could not be read, so no call was made.');
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Number.isFinite(parsed.spentWorstUsd)) throw new Error('shape');
    return { ...emptyLedger(), ...parsed, hardCapUsd: HARD_CAP_USD, stopAtUsd: STOP_AT_USD };
  } catch {
    // A corrupt ledger is not an empty ledger. Failing closed here is the
    // difference between a cap and a suggestion.
    throw new BudgetExceeded('The spend ledger is unreadable, so no call was made. Fix or restore tools/sim/ledger.json.');
  }
}

function write(ledger) {
  ledger.updatedAt = new Date().toISOString();
  const tmp = `${LEDGER_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  fs.renameSync(tmp, LEDGER_PATH);
}

/** Reservations nobody came back for are assumed to have been spent in full. */
function sweep(ledger) {
  const now = Date.now();
  for (const [id, entry] of Object.entries(ledger.reservations)) {
    if (now - Date.parse(entry.at) > STALE_RESERVATION_MS) {
      ledger.spentWorstUsd += entry.usd;
      ledger.spentExpectedUsd += entry.usd;
      ledger.byKind.abandoned = (ledger.byKind.abandoned || 0) + entry.usd;
      delete ledger.reservations[id];
    }
  }
}

function reservedTotal(ledger) {
  return Object.values(ledger.reservations).reduce((sum, entry) => sum + entry.usd, 0);
}

/** What is held against the stop line, apart from calls in flight. */
function metered(ledger) {
  return ledger.spentExpectedUsd * SAFETY_FACTOR;
}

/**
 * Set aside the worst possible cost of a call that is about to be made.
 * Throws BudgetExceeded — and the call must then NOT be made — if it does not fit.
 * @param {string} kind
 * @param {number} worstUsd
 * @returns {string} a reservation id to settle afterwards
 */
export function reserve(kind, worstUsd) {
  const usd = Number(worstUsd);
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new BudgetExceeded('A call with no computable cost was refused.');
  }
  return withLock(() => {
    const ledger = read();
    sweep(ledger);
    const committed = metered(ledger) + reservedTotal(ledger);
    if (committed + usd > STOP_AT_USD) {
      ledger.refused += 1;
      write(ledger);
      throw new BudgetExceeded(
        `Spend cap reached: $${committed.toFixed(4)} committed of a $${STOP_AT_USD} stop line ` +
          `(owner's limit $${HARD_CAP_USD}). The call was not made.`,
      );
    }
    const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    ledger.reservations[id] = { kind, usd, at: new Date().toISOString() };
    write(ledger);
    return id;
  });
}

/**
 * Replace a reservation with what the call actually cost.
 * If the real figure is somehow unknown, the full reservation is charged.
 * @param {string} id
 * @param {{worstUsd?: number, expectedUsd?: number}|null} actual
 */
export function settle(id, actual) {
  return withLock(() => {
    const ledger = read();
    const entry = ledger.reservations[id];
    if (!entry) return ledger;
    delete ledger.reservations[id];
    const known = actual && Number.isFinite(actual.worstUsd) && actual.worstUsd >= 0;
    const worst = known ? Number(actual.worstUsd) : entry.usd;
    const expected = known && Number.isFinite(actual.expectedUsd) ? Number(actual.expectedUsd) : worst;
    ledger.spentWorstUsd += worst;
    ledger.spentExpectedUsd += expected;
    ledger.calls += 1;
    ledger.byKind[entry.kind] = (ledger.byKind[entry.kind] || 0) + worst;
    write(ledger);
    return ledger;
  });
}

/** A call that was never sent: give the reservation back. */
export function release(id) {
  return withLock(() => {
    const ledger = read();
    if (ledger.reservations[id]) {
      delete ledger.reservations[id];
      write(ledger);
    }
    return ledger;
  });
}

/** @returns {{spentWorstUsd: number, spentExpectedUsd: number, reservedUsd: number, remainingUsd: number, calls: number, refused: number, stopAtUsd: number, hardCapUsd: number}} */
export function status() {
  return withLock(() => {
    const ledger = read();
    sweep(ledger);
    const reservedUsd = reservedTotal(ledger);
    return {
      spentWorstUsd: ledger.spentWorstUsd,
      spentExpectedUsd: ledger.spentExpectedUsd,
      reservedUsd,
      meteredUsd: metered(ledger),
      remainingUsd: Math.max(0, STOP_AT_USD - metered(ledger) - reservedUsd),
      calls: ledger.calls,
      refused: ledger.refused,
      stopAtUsd: STOP_AT_USD,
      hardCapUsd: HARD_CAP_USD,
      byKind: ledger.byKind,
    };
  });
}

/** A deliberately generous token count for text we are about to send. */
export function tokensUpperBound(text) {
  const value = String(text || '');
  let ascii = 0;
  let wide = 0;
  for (const char of value) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else wide += 1;
  }
  // English runs about four characters to a token; two is twice as careful.
  // Kana and kanji can be several tokens each.
  return Math.ceil(ascii / 2) + wide * 3 + 50;
}

/** Worst-case cost of one realtime response, before it is made. */
export function realtimeWorstCase({ inputTokens, maxOutputTokens }) {
  return (inputTokens * REALTIME_WORST.textIn + maxOutputTokens * REALTIME_WORST.textOut) / 1e6;
}

/** Worst-case cost of one chat completion, before it is made. */
export function chatWorstCase({ inputTokens, maxOutputTokens }) {
  return (inputTokens * CHAT_WORST.in + maxOutputTokens * CHAT_WORST.out) / 1e6;
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * What a realtime response cost, from the usage block the API returns.
 * @param {any} usage response.done -> response.usage
 * @param {string} model
 */
export function realtimeCost(usage, model = '') {
  if (!usage || typeof usage !== 'object') return null;
  const inDetails = usage.input_token_details || {};
  const cachedDetails = inDetails.cached_tokens_details || {};
  const outDetails = usage.output_token_details || {};

  const inputTotal = count(usage.input_tokens);
  const outputTotal = count(usage.output_tokens);

  let audioIn = count(inDetails.audio_tokens);
  let textIn = count(inDetails.text_tokens);
  // Anything the breakdown does not account for is charged as text.
  if (textIn + audioIn < inputTotal) textIn += inputTotal - textIn - audioIn;

  let cachedAudio = Math.min(count(cachedDetails.audio_tokens), audioIn);
  let cachedText = Math.min(count(cachedDetails.text_tokens), textIn);
  if (!cachedAudio && !cachedText) cachedText = Math.min(count(inDetails.cached_tokens), textIn);

  let audioOut = count(outDetails.audio_tokens);
  let textOut = count(outDetails.text_tokens);
  if (textOut + audioOut < outputTotal) textOut += outputTotal - textOut - audioOut;

  const price = (p) =>
    ((textIn - cachedText) * p.textIn + cachedText * p.textCachedIn +
      (audioIn - cachedAudio) * p.audioIn + cachedAudio * p.audioCachedIn +
      textOut * p.textOut + audioOut * p.audioOut) / 1e6;

  const isMini = /mini/i.test(model);
  return {
    worstUsd: price(REALTIME_WORST),
    expectedUsd: price(isMini ? REALTIME_MINI : REALTIME_WORST),
    tokens: { textIn, cachedText, audioIn, cachedAudio, textOut, audioOut },
  };
}

/**
 * What a chat completion cost.
 * @param {any} usage chat.completions -> usage
 * @param {string} model
 */
export function chatCost(usage, model = '') {
  if (!usage || typeof usage !== 'object') return null;
  const input = count(usage.prompt_tokens);
  const output = count(usage.completion_tokens);
  const cached = Math.min(count(usage.prompt_tokens_details?.cached_tokens), input);
  const price = (p) => ((input - cached) * p.in + cached * p.cachedIn + output * p.out) / 1e6;
  let expected = CHAT_WORST;
  if (/^gpt-4o-mini/i.test(model)) expected = CHAT_4O_MINI;
  else if (/^gpt-4\.1(?!-mini|-nano)/i.test(model)) expected = CHAT_41;
  return {
    worstUsd: price(CHAT_WORST),
    expectedUsd: price(expected),
    tokens: { input, cached, output },
  };
}

/** One line for a terminal. */
export function statusLine() {
  const s = status();
  return (
    `spend: $${s.spentExpectedUsd.toFixed(4)} at published prices ($${s.spentWorstUsd.toFixed(4)} at worst-case prices) · ` +
    `${s.calls} calls · stops when twice the published figure reaches $${s.stopAtUsd} · limit $${s.hardCapUsd}`
  );
}

// `node tools/sim/budget.mjs` prints where things stand.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(statusLine());
  console.log(JSON.stringify(status(), null, 2));
}
