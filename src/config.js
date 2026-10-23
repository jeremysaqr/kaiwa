/**
 * src/config.js
 *
 * Central place where environment configuration is read and validated.
 *
 * The OpenAI API key is read here and never leaves the server process. It is
 * not logged, not returned by any route, and not included in any diagnostic.
 *
 * It comes from one of two places, in this order:
 *   1. OPENAI_API_KEY in the environment or .env (developers, scripted runs);
 *   2. the key the user saved in the app, kept in DATA_DIR/settings.json.
 */

import 'dotenv/config';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

/** @param {string} name @param {string} fallback */
function env(name, fallback) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export const PORT = Number.parseInt(env('PORT', '3000'), 10) || 3000;

/**
 * The address the server listens on. Only this computer by default: the
 * server holds the API key, so other devices on the network should not be
 * able to use it. Set HOST=0.0.0.0 to open it up deliberately.
 */
export const HOST = env('HOST', '127.0.0.1');

/** Where the key saved from the app is kept. */
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function readSavedKey() {
  try {
    const saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    return typeof saved?.openaiApiKey === 'string' ? saved.openaiApiKey.trim() : '';
  } catch {
    return '';
  }
}

const ENV_KEY = env('OPENAI_API_KEY', '');

/** The permanent key. Server-side only. A live binding: saving a key in the app updates it. */
export let OPENAI_API_KEY = ENV_KEY || readSavedKey();

/** Where the key came from: 'env', 'saved', or '' when there is none. */
export function apiKeySource() {
  if (ENV_KEY) return 'env';
  return OPENAI_API_KEY ? 'saved' : '';
}

/**
 * Save a key entered in the app and use it from now on. The file is readable
 * by its owner only where the platform allows it.
 * @param {string} key
 */
export function saveApiKey(key) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SETTINGS_FILE, `${JSON.stringify({ openaiApiKey: key }, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(SETTINGS_FILE, 0o600);
  } catch {
    // Windows: permissions follow the user's profile folder.
  }
  OPENAI_API_KEY = key;
}

/** Forget the saved key. A key from the environment is untouched. */
export function removeSavedApiKey() {
  rmSync(SETTINGS_FILE, { force: true });
  OPENAI_API_KEY = ENV_KEY;
}

/** The last four characters, so the user can tell which key is in use. */
export function apiKeyHint() {
  return OPENAI_API_KEY.length >= 12 ? `…${OPENAI_API_KEY.slice(-4)}` : '';
}

/** Realtime voice model used for the live tutoring call. */
export const REALTIME_MODEL = env('REALTIME_MODEL', 'gpt-realtime-2.1-mini');

/** Voice the tutor speaks with. */
export const REALTIME_VOICE = env('REALTIME_VOICE', 'marin');

/** Model used for post-session memory extraction and proficiency assessment. */
export const MEMORY_MODEL = env('MEMORY_MODEL', 'gpt-4o-mini');

/**
 * Model that writes each lesson part's material ahead of time. This is the one
 * place a stronger model changes what the student is actually taught, and it
 * runs a handful of times per lesson — a fraction of a cent each. If the
 * account cannot use it, MEMORY_MODEL does the job instead.
 */
export const PLAN_MODEL = env('PLAN_MODEL', 'gpt-4.1');

/**
 * Who asks for the tutor's replies.
 *
 * 'app' (the default): the server hears the student and waits; the app asks
 * for each reply, and during a lesson gives the words for it. 'server': the
 * model replies on its own the moment the student stops, as it used to, and a
 * lesson can only steer it through its standing instructions.
 */
export const TUTOR_TURNS = env('TUTOR_TURNS', 'app').toLowerCase() === 'server' ? 'server' : 'app';

/**
 * How patient the session is about deciding the student has finished.
 *
 * 'low' (the default) lets them take their time: a pause to think is not the
 * end of a turn. 'auto' is the API's own default and is quicker to conclude
 * they are done; 'high' is quicker still. Set TURN_EAGERNESS=auto if replies
 * feel slow to come.
 */
export const TURN_EAGERNESS = ['low', 'medium', 'high', 'auto'].includes(env('TURN_EAGERNESS', 'low').toLowerCase())
  ? env('TURN_EAGERNESS', 'low').toLowerCase()
  : 'low';

/**
 * Noise reduction applied to the microphone before the session listens for
 * speech: 'near_field' for a headset, 'far_field' for a laptop or desk
 * microphone, empty (the default) for none. Worth trying if the tutor is
 * interrupted by sounds that are not speech.
 */
export const MIC_NOISE_REDUCTION = ['near_field', 'far_field'].includes(env('MIC_NOISE_REDUCTION', '').toLowerCase())
  ? env('MIC_NOISE_REDUCTION', '').toLowerCase()
  : '';

/** Transcription model for the student's own speech during the call. */
export const TRANSCRIBE_MODEL = env('TRANSCRIBE_MODEL', 'gpt-live-transcribe');

/** Base URL for the OpenAI API. */
export const OPENAI_BASE_URL = env('OPENAI_BASE_URL', 'https://api.openai.com/v1');

/** How long we wait on an OpenAI request before giving up, in milliseconds. */
export const OPENAI_TIMEOUT_MS = Number.parseInt(env('OPENAI_TIMEOUT_MS', '30000'), 10) || 30000;

/**
 * True when a key is present. Never expose the key itself — only this boolean
 * reaches the browser, via /api/health.
 */
export function hasApiKey() {
  return OPENAI_API_KEY.length > 0;
}

/**
 * A safe, non-secret description of the server configuration, suitable for
 * sending to the browser.
 */
export function publicConfig() {
  return {
    realtimeModel: REALTIME_MODEL,
    memoryModel: MEMORY_MODEL,
    transcribeModel: TRANSCRIBE_MODEL,
    voice: REALTIME_VOICE,
    apiKeyConfigured: hasApiKey(),
  };
}

/**
 * Strip anything that looks like an API key out of a string before it is
 * logged or returned. Defence in depth for PART 38.
 * @param {unknown} value
 * @returns {string}
 */
export function redact(value) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  if (OPENAI_API_KEY) {
    text = text.split(OPENAI_API_KEY).join('[REDACTED]');
  }
  return text.replace(/\b(sk|ek)-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
}
