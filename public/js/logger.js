/**
 * public/js/logger.js
 *
 * The browser half of session logging.
 *
 * Everything that matters for diagnosing a lesson happens here and is then
 * gone: the instruction text actually sent to the model, what the model heard,
 * what it said, and the out-of-band nudges nobody sees. This buffers those and
 * posts them to the local server, which appends them to a file.
 *
 * Three properties it must have:
 *   - It cannot break a lesson. Every failure is swallowed.
 *   - It cannot slow one down. Events are buffered and flushed on a timer.
 *   - It cannot lose the end of a call, which is usually the interesting part.
 *     `pagehide` flushes with sendBeacon.
 */

/** Flush at least this often while a call is running. */
const FLUSH_MS = 2000;

/** Or as soon as this many events are waiting. */
const FLUSH_AT = 25;

/** Beyond this, a single event is trimmed rather than posted whole. */
const MAX_TEXT = 24000;

/** @param {unknown} value */
function trim(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…[truncated]` : text;
}

/** A session id the server will accept. */
function newSessionId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    }
  } catch {
    /* fall through */
  }
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export class SessionLog {
  constructor() {
    /** @type {string} */
    this.sessionId = '';
    /** @type {any[]} */
    this.queue = [];
    /** @type {ReturnType<typeof setInterval>|null} */
    this.timer = null;
    this.startedAt = 0;
    this.sending = false;
    this.enabled = true;
  }

  /** @returns {boolean} */
  get active() {
    return Boolean(this.sessionId);
  }

  /** Seconds since the call began, for a readable timeline. */
  elapsed() {
    return this.startedAt ? Math.round((Date.now() - this.startedAt) / 100) / 10 : 0;
  }

  /**
   * Begin a session log. Returns the id, which also names the file.
   * @param {Record<string, any>} meta
   */
  start(meta = {}) {
    this.sessionId = newSessionId();
    this.startedAt = Date.now();
    this.queue = [];
    this.event('session.start', {
      ...meta,
      userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
      startedAt: new Date().toISOString(),
    });
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    return this.sessionId;
  }

  /**
   * Record one event.
   * @param {string} type
   * @param {Record<string, any>} [payload]
   */
  event(type, payload = {}) {
    if (!this.enabled || !this.sessionId) return;
    try {
      this.queue.push({ type, at: this.elapsed(), ...payload });
      if (this.queue.length >= FLUSH_AT) this.flush();
    } catch {
      /* a log line is never worth an exception */
    }
  }

  /**
   * The exact instruction text handed to the model, and why.
   *
   * The single most useful line in the file: it settles both "was the tutor
   * told this?" and "is the browser even running the current build?".
   *
   * @param {string} reason
   * @param {string} instructions
   * @param {Record<string, any>} [context]
   */
  prompt(reason, instructions, context = {}) {
    const text = typeof instructions === 'string' ? instructions : '';
    this.event('prompt', {
      reason,
      chars: text.length,
      // Pulled out so a glance at the file answers the common questions.
      hasReference: text.includes('# REFERENCE'),
      hasLesson: text.includes('# RIGHT NOW'),
      hasCatalogue: text.includes('# LESSONS'),
      ...context,
      instructions: trim(text),
    });
  }

  /** Send whatever is queued. Safe to call at any time. */
  flush() {
    if (!this.sessionId || this.sending || this.queue.length === 0) return;
    const events = this.queue;
    this.queue = [];
    this.sending = true;

    const body = JSON.stringify({ sessionId: this.sessionId, events });
    fetch('/api/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    })
      .catch(() => {
        /* the lesson matters more than the log */
      })
      .finally(() => {
        this.sending = false;
      });
  }

  /**
   * Last flush, using sendBeacon so a closing tab still delivers it.
   * @param {Record<string, any>} [payload]
   */
  end(payload = {}) {
    if (!this.sessionId) return;
    this.event('session.end', { ...payload, durationSeconds: this.elapsed() });

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const events = this.queue;
    this.queue = [];
    const body = JSON.stringify({ sessionId: this.sessionId, events });

    let sent = false;
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        sent = navigator.sendBeacon('/api/logs', new Blob([body], { type: 'application/json' }));
      }
    } catch {
      sent = false;
    }
    if (!sent) {
      fetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    }

    this.sessionId = '';
    this.startedAt = 0;
  }
}

/** The one log for this page. */
export const sessionLog = new SessionLog();
