/**
 * src/openai.js
 *
 * Thin, timeout-aware wrapper around the OpenAI REST API.
 *
 * Every outbound request is authenticated here, on the server. The key is
 * never returned to the caller and never appears in a thrown error message —
 * see `redact()`.
 */

import {
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_TIMEOUT_MS,
  hasApiKey,
  redact,
} from './config.js';

/** Error carrying an HTTP status so routes can pass it through sensibly. */
export class OpenAIError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {unknown} [details]
   */
  constructor(message, status, details) {
    super(redact(message));
    this.name = 'OpenAIError';
    this.status = status;
    this.details = details === undefined ? undefined : redact(JSON.stringify(details));
  }
}

/** Throws a clear, actionable error when the key is missing. */
function requireApiKey() {
  if (!hasApiKey()) {
    throw new OpenAIError(
      'No OpenAI API key is set. Add one in Kaiwa under Settings → OpenAI API key.',
      500,
    );
  }
}

/**
 * fetch() with an abort timeout and consistent error handling.
 *
 * @param {string} path path relative to OPENAI_BASE_URL, e.g. "/realtime/calls"
 * @param {RequestInit & {timeoutMs?: number}} [options]
 * @returns {Promise<Response>}
 */
async function request(path, options = {}) {
  requireApiKey();

  const { timeoutMs = OPENAI_TIMEOUT_MS, headers, ...rest } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(`${OPENAI_BASE_URL}${path}`, {
      ...rest,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        ...headers,
      },
    });
  } catch (error) {
    if (error && /** @type {any} */ (error).name === 'AbortError') {
      throw new OpenAIError(
        `The OpenAI request timed out after ${Math.round(timeoutMs / 1000)}s.`,
        504,
      );
    }
    throw new OpenAIError(
      `Could not reach the OpenAI API: ${redact(/** @type {any} */ (error)?.message)}`,
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mint a short-lived client secret the browser can use to open a Realtime
 * WebRTC session directly with OpenAI. The permanent key stays here.
 *
 * @param {Record<string, any>} sessionConfig the `session` object
 * @param {string} [safetyIdentifier] stable, privacy-preserving user id
 * @returns {Promise<{value: string, expires_at?: number, session?: any}>}
 */
export async function createClientSecret(sessionConfig, safetyIdentifier) {
  const response = await request('/realtime/client_secrets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(safetyIdentifier ? { 'OpenAI-Safety-Identifier': safetyIdentifier } : {}),
    },
    body: JSON.stringify({ session: sessionConfig }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new OpenAIError(
      `OpenAI refused to create a Realtime session (HTTP ${response.status}).`,
      response.status,
      text.slice(0, 800),
    );
  }

  try {
    const data = JSON.parse(text);
    if (!data || typeof data.value !== 'string') {
      throw new Error('missing client secret value');
    }
    return data;
  } catch {
    throw new OpenAIError('OpenAI returned an unreadable session response.', 502);
  }
}

/**
 * Unified-interface fallback: exchange the browser's SDP offer for OpenAI's
 * SDP answer, authenticating with the permanent key on this side.
 *
 * Used when the ephemeral-token path fails (for example when the browser is
 * blocked from reaching api.openai.com directly).
 *
 * @param {string} sdp the browser's SDP offer
 * @param {Record<string, any>} sessionConfig
 * @param {string} [safetyIdentifier]
 * @returns {Promise<string>} the SDP answer
 */
export async function exchangeSdp(sdp, sessionConfig, safetyIdentifier) {
  const form = new FormData();
  form.set('sdp', sdp);
  form.set('session', JSON.stringify(sessionConfig));

  const response = await request('/realtime/calls', {
    method: 'POST',
    headers: safetyIdentifier ? { 'OpenAI-Safety-Identifier': safetyIdentifier } : {},
    body: form,
  });

  const text = await response.text();

  if (!response.ok) {
    throw new OpenAIError(
      `OpenAI refused the WebRTC offer (HTTP ${response.status}).`,
      response.status,
      text.slice(0, 800),
    );
  }

  return text;
}

/**
 * Chat Completions call that insists on a JSON object response.
 *
 * @param {{model: string, messages: any[], temperature?: number, maxTokens?: number, timeoutMs?: number}} params
 * @returns {Promise<any>} the parsed JSON object from the model
 */
export async function chatJson({
  model,
  messages,
  temperature = 0.2,
  maxTokens = 1200,
  timeoutMs,
}) {
  const response = await request('/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeoutMs,
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new OpenAIError(
      `Memory extraction failed (HTTP ${response.status}).`,
      response.status,
      text.slice(0, 800),
    );
  }

  /** @type {any} */
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new OpenAIError('OpenAI returned a malformed response body.', 502);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new OpenAIError('The model returned an empty response.', 502);
  }

  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    // The model ignored the JSON instruction. Try to salvage the first object
    // literal in the string before giving up.
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        /* fall through */
      }
    }
    throw new OpenAIError('The model did not return valid JSON.', 502);
  }
}

/**
 * Ask OpenAI whether a key works, before it is saved. Lists models: free, fast,
 * and allowed for any valid key.
 *
 * @param {string} key
 * @returns {Promise<{ok: true} | {ok: false, rejected: boolean, error: string}>}
 *   rejected is true when OpenAI refused the key itself, false when the check
 *   could not be completed (offline, timed out).
 */
export async function checkApiKey(key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${OPENAI_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (response.ok) return { ok: true };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, rejected: true, error: 'OpenAI did not accept this key. Check that it was copied in full.' };
    }
    return { ok: false, rejected: false, error: `OpenAI answered with HTTP ${response.status}.` };
  } catch (error) {
    return {
      ok: false,
      rejected: false,
      error: /** @type {any} */ (error)?.name === 'AbortError'
        ? 'OpenAI did not answer within 10 seconds.'
        : `Could not reach OpenAI: ${redact(/** @type {any} */ (error)?.message)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
