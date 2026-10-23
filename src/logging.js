/**
 * src/logging.js
 *
 * Session logs, on disk, for working out why a lesson went wrong.
 *
 * A voice lesson is the hardest kind of bug to chase: it is gone the moment it
 * happens, the transcript on screen is a rendering rather than the truth, and
 * the two questions that actually matter — what did the tutor HEAR, and what
 * was it actually TOLD — are invisible.
 *
 * So every call writes a `Logs/<timestamp>-<id>.jsonl`: one JSON object per
 * line, appended as it happens, readable while the call is still running.
 * It records the exact instruction text sent to the model and why, every
 * transcription in both directions, every out-of-band nudge, every Lesson
 * Director exchange, and every error.
 *
 * Two rules:
 *   - The API key can never appear. Everything goes through `redact()`, the
 *     same function the rest of the server uses.
 *   - Logging must never break a lesson. Every failure here is swallowed; the
 *     worst case is a missing log line.
 */

import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { APP_ROOT } from './paths.js';
import { redact } from './config.js';

/** Where session logs are written. */
export const LOGS_DIR = path.resolve(
  process.env.LOGS_DIR ? process.env.LOGS_DIR : path.join(APP_ROOT, 'Logs'),
);

/** Set LOG_SESSIONS=0 to turn logging off entirely. */
export const LOGGING_ENABLED = process.env.LOG_SESSIONS !== '0';

/** One session's file stops growing here, so a runaway cannot fill a disk. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Session files kept on disk. Older ones are pruned at startup. */
const MAX_SESSIONS = 50;

/** No single field may be longer than this. Prompts are the reason it is big. */
const MAX_FIELD_CHARS = 24000;

/** @type {Map<string, {file: string, bytes: number, seq: number, full: boolean}>} */
const sessions = new Map();

/** A filename-safe stamp: 2026-09-05T04-12-33. */
function stamp(date = new Date()) {
  return date.toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-');
}

/** Session ids come from the browser, so they are constrained hard. */
function safeId(value) {
  const text = String(value ?? '').trim();
  return /^[A-Za-z0-9_-]{6,64}$/.test(text) ? text : '';
}

/**
 * Recursively trim and redact a value before it is written.
 * @param {unknown} value
 * @param {number} [depth]
 */
function scrub(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const clean = redact(value);
    return clean.length > MAX_FIELD_CHARS ? `${clean.slice(0, MAX_FIELD_CHARS)}…[truncated]` : clean;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth > 6) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => scrub(entry, depth + 1));
  if (typeof value === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [key, entry] of Object.entries(value).slice(0, 60)) {
      // Belt and braces: nothing that looks like a credential is ever written,
      // whatever the caller passed. Matched on the WHOLE field name — a
      // substring test also swallows innocent fields like "referenceKeys",
      // which is how a diagnostic ends up missing the thing it diagnoses.
      if (/^(?:.*[_.])?(?:api_?keys?|secrets?|tokens?|authorization|auth|passwords?|passwd|credentials?)$/i.test(key)) {
        out[key] = '[omitted]';
        continue;
      }
      out[key] = scrub(entry, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** Keep the log directory from growing without bound. */
async function prune() {
  try {
    const entries = (await readdir(LOGS_DIR)).filter((name) => name.endsWith('.jsonl'));
    if (entries.length <= MAX_SESSIONS) return;
    const withTimes = await Promise.all(
      entries.map(async (name) => {
        try {
          return { name, at: (await stat(path.join(LOGS_DIR, name))).mtimeMs };
        } catch {
          return { name, at: 0 };
        }
      }),
    );
    withTimes.sort((a, b) => b.at - a.at);
    for (const entry of withTimes.slice(MAX_SESSIONS)) {
      await unlink(path.join(LOGS_DIR, entry.name)).catch(() => {});
    }
  } catch {
    /* pruning is housekeeping; never let it matter */
  }
}

/**
 * Begin (or resume) a session log.
 * @param {string} sessionId
 * @returns {Promise<{file: string, bytes: number, seq: number, full: boolean}|null>}
 */
async function openSession(sessionId) {
  const id = safeId(sessionId);
  if (!id) return null;

  const existing = sessions.get(id);
  if (existing) return existing;

  try {
    await mkdir(LOGS_DIR, { recursive: true });
  } catch {
    return null;
  }

  const record = { file: path.join(LOGS_DIR, `${stamp()}-${id.slice(0, 8)}.jsonl`), bytes: 0, seq: 0, full: false };
  sessions.set(id, record);
  prune();
  return record;
}

/**
 * Append events to a session log.
 *
 * @param {string} sessionId
 * @param {unknown[]} events
 * @returns {Promise<{ok: boolean, written: number, file: string}>}
 */
export async function appendEvents(sessionId, events) {
  if (!LOGGING_ENABLED) return { ok: false, written: 0, file: '' };

  const record = await openSession(sessionId);
  if (!record) return { ok: false, written: 0, file: '' };
  if (record.full) return { ok: true, written: 0, file: record.file };

  const lines = [];
  for (const event of Array.isArray(events) ? events.slice(0, 500) : []) {
    if (!event || typeof event !== 'object') continue;
    record.seq += 1;
    const scrubbed = scrub(event);
    lines.push(
      JSON.stringify({
        seq: record.seq,
        at: new Date().toISOString(),
        ...(/** @type {Record<string, any>} */ (scrubbed)),
      }),
    );
  }
  if (!lines.length) return { ok: true, written: 0, file: record.file };

  const payload = `${lines.join('\n')}\n`;
  if (record.bytes + payload.length > MAX_FILE_BYTES) {
    record.full = true;
    try {
      await appendFile(
        record.file,
        `${JSON.stringify({ at: new Date().toISOString(), type: 'log.truncated', reason: 'file size cap reached' })}\n`,
        'utf8',
      );
    } catch {
      /* nothing to be done */
    }
    return { ok: true, written: 0, file: record.file };
  }

  try {
    await appendFile(record.file, payload, 'utf8');
    record.bytes += payload.length;
    return { ok: true, written: lines.length, file: record.file };
  } catch {
    return { ok: false, written: 0, file: record.file };
  }
}

/**
 * Log one event from the server itself.
 * @param {string} sessionId
 * @param {string} type
 * @param {Record<string, any>} [payload]
 */
export async function logServerEvent(sessionId, type, payload = {}) {
  if (!LOGGING_ENABLED || !safeId(sessionId)) return;
  await appendEvents(sessionId, [{ type, source: 'server', ...payload }]).catch(() => {});
}

/** The session files on disk, newest first. */
export async function listSessions() {
  try {
    const entries = (await readdir(LOGS_DIR)).filter((name) => name.endsWith('.jsonl'));
    const detailed = await Promise.all(
      entries.map(async (name) => {
        const info = await stat(path.join(LOGS_DIR, name)).catch(() => null);
        return { name, bytes: info?.size ?? 0, modified: info ? new Date(info.mtimeMs).toISOString() : '' };
      }),
    );
    return detailed.sort((a, b) => b.modified.localeCompare(a.modified));
  } catch {
    return [];
  }
}

/** Say at startup where the logs are going. */
export function reportLogging() {
  if (!LOGGING_ENABLED) {
    console.log('  Session logs   off (LOG_SESSIONS=0)');
    return;
  }
  console.log(`  Session logs   ${LOGS_DIR}`);
}
