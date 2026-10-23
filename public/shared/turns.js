/**
 * shared/turns.js
 *
 * When has the student finished saying something?
 *
 * The server decides when a stretch of speech has ended, and on a real call it
 * decided too soon: "toumorokoshi to ramu…" — a breath — "…kudasai" arrived as
 * two turns. The first was answered while the second was being said, the
 * second was answered on its own ("Kudasai." — "It's ramu. Say it."), and the
 * student heard two replies back to back to an answer that had been right.
 * In their words: "I barely paused long enough to think and it thought I was
 * done."
 *
 * So the app does not answer a stretch of speech; it answers a turn, and this
 * decides what a turn is:
 *
 *   - Stretches that arrive before the reply to the first has been heard are
 *     one turn. Their words are put together and answered once.
 *   - Something that trails off — "… to", "um" — is waited on a little longer.
 *   - A stretch with no words in it is not an answer. It may be a cough, the
 *     tutor's own voice coming back through the microphone, or speech the
 *     recogniser could make nothing of; which of those is for the caller to
 *     say, and none of them is "wrong".
 *
 * It keeps no clock of its own beyond two timers, both injectable, so the
 * whole of it can be tested without waiting.
 *
 * Dependency-free: runs unchanged in Node and the browser.
 */

/** How long to wait for the written version of a stretch of speech. */
export const TRANSCRIPT_WAIT_MS = 1500;

/** How much longer to wait when what was said trails off. */
export const TRAILING_WAIT_MS = 1800;

/** A stretch shorter than this, with no words in it, was not speech. */
export const MIN_SPEECH_MS = 350;

/**
 * Does this sound unfinished — ending on a joining word or a hesitation?
 *
 * "toumorokoshi to", "gyuuniku o", "pork and", "um". Deliberately narrow: a
 * finished answer that is held back for no reason is a slower lesson.
 * @param {string} text
 * @returns {boolean}
 */
export function trailsOff(text) {
  const said = String(text || '').trim();
  if (!said) return false;
  if (/(?:…|\.\.\.|,|、|-)$/.test(said)) return true;
  const plain = said.toLowerCase().replace(/[.!?。！？\s]+$/u, '');
  // Japanese as the recogniser writes it: a particle with nothing after it.
  // (Only the joining ones: "genkin de" and "tabemono" are whole answers.)
  if (/[぀-ヿ一-鿿](?:と|を|や)$/u.test(plain)) return true;
  if (/(?:えっと|ええと|えーと|あの|あのう|うーん)$/u.test(plain)) return true;
  // And in Latin letters — but "to" and "no" end English sentences too, so
  // only where what comes before is not English prose.
  const words = plain.split(/[\s,]+/).filter(Boolean);
  const last = words[words.length - 1] || '';
  if (/^(um+|uh+|er+m?|hmm+|etto|eeto|ano+|and|or|but|so|the|a|an)$/.test(last)) return true;
  if (words.length >= 2 && words.length <= 4 && /^(to|o|wo|ya)$/.test(last) && !/^(i|you|we|want|need|going|have|how|what|like)$/.test(words[words.length - 2])) return true;
  return false;
}

/**
 * Stretches of speech put together as one thing said.
 * @param {string[]} texts
 * @returns {string}
 */
export function joinSpeech(texts) {
  return (Array.isArray(texts) ? texts : [])
    .map((text) => String(text || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @typedef {Object} TurnHandlers
 * @property {(text: string, detail: {itemIds: string[], parts: number, ms: number}) => void} onAnswer
 *           a whole turn, ready to be answered; `text` is empty when the
 *           student spoke and nothing could be made out
 * @property {(detail: {itemIds: string[], overTutor: boolean, ms: number}) => void} [onNoise]
 *           a stretch with no words in it that was not speech, or began while
 *           the tutor was talking
 * @property {() => boolean} [onRetract] the reply being prepared for the last
 *           turn is not wanted: they are still speaking. Returns false if it
 *           cannot be taken back, in which case what follows is a new turn.
 * @property {(text: string) => boolean} [isWhole] is this, as it stands, an
 *           answer to what was asked? Then it is not waited on, however it ends.
 * @property {(type: string, detail?: Record<string, any>) => void} [log]
 */

export class StudentTurns {
  /**
   * @param {TurnHandlers & {
   *   transcriptWaitMs?: number, trailingWaitMs?: number, minSpeechMs?: number,
   *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (id: any) => void,
   * }} options
   */
  constructor(options) {
    this.onAnswer = options.onAnswer;
    this.onNoise = options.onNoise || (() => {});
    this.onRetract = options.onRetract || (() => true);
    this.isWhole = options.isWhole || (() => false);
    this.log = options.log || (() => {});
    this.transcriptWaitMs = Number.isFinite(options.transcriptWaitMs) ? Number(options.transcriptWaitMs) : TRANSCRIPT_WAIT_MS;
    this.trailingWaitMs = Number.isFinite(options.trailingWaitMs) ? Number(options.trailingWaitMs) : TRAILING_WAIT_MS;
    this.minSpeechMs = Number.isFinite(options.minSpeechMs) ? Number(options.minSpeechMs) : MIN_SPEECH_MS;
    this.setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer || ((id) => clearTimeout(id));
    this.reset();
  }

  /** Is a turn still being put together? */
  get waiting() {
    return this.speaking || this.segments.length > 0 || Boolean(this.holdTimer);
  }

  /** Forget everything in flight. Part of starting and ending a call. */
  reset() {
    for (const segment of this.segments || []) if (segment.timer) this.clearTimer(segment.timer);
    if (this.holdTimer) this.clearTimer(this.holdTimer);
    /** The student is speaking right now. */
    this.speaking = false;
    /** The stretch being spoken: what is known of it before the server names it. */
    /** @type {{overTutor: boolean, startMs: number, endMs: number}|null} */
    this.current = null;
    /**
     * Stretches heard and not yet answered, in order.
     * @type {{itemId: string, text: string|null, overTutor: boolean, ms: number, timer: any}[]}
     */
    this.segments = [];
    /** The turn last handed over, until its reply has been heard. */
    /** @type {{text: string, itemIds: string[], segments: any[]}|null} */
    this.dispatched = null;
    /** Waiting to see whether something that trailed off goes on. */
    this.holdTimer = null;
    /** What was last waited on, so the same words are not waited on twice. */
    this.heldFor = '';
    /** Stretches already answered or set aside, so a late written version changes nothing. */
    /** @type {string[]} */
    this.settled = [];
    /** Of those, the ones set aside as noise. */
    /** @type {string[]} */
    this.noises = [];
  }

  /** @param {string[]} itemIds stretches that have now been dealt with */
  close(itemIds) {
    this.settled.push(...itemIds);
    if (this.settled.length > 40) this.settled.splice(0, this.settled.length - 40);
  }

  /**
   * The student has started speaking.
   * @param {{overTutor?: boolean, atMs?: number}} [detail] `overTutor`: the
   *        tutor's voice was still being played
   */
  speechStarted(detail = {}) {
    this.speaking = true;
    this.current = { overTutor: Boolean(detail.overTutor), startMs: Number(detail.atMs) || 0, endMs: 0 };
    if (this.holdTimer) {
      this.clearTimer(this.holdTimer);
      this.holdTimer = null;
    }
    // A reply was on its way to what they said before, and has not been
    // heard. They had not finished: that reply is not wanted, and what they
    // said before belongs with what they are saying now.
    const last = this.dispatched;
    if (last) {
      this.dispatched = null;
      const taken = this.onRetract() !== false;
      this.log('student.continued', { carried: taken, text: last.text });
      if (taken) this.segments.unshift(...last.segments.map((segment) => ({ ...segment, timer: null })));
    }
  }

  /** @param {{atMs?: number}} [detail] */
  speechStopped(detail = {}) {
    this.speaking = false;
    if (this.current) this.current.endMs = Number(detail.atMs) || 0;
  }

  /**
   * The server has a whole stretch of speech; its written version follows.
   * @param {string} itemId
   */
  committed(itemId) {
    const id = String(itemId || '');
    this.speaking = false;
    if (!id || this.segments.some((segment) => segment.itemId === id)) return;
    const current = this.current || { overTutor: false, startMs: 0, endMs: 0 };
    this.current = null;
    const segment = {
      itemId: id,
      text: null,
      overTutor: current.overTutor,
      ms: current.endMs > current.startMs ? current.endMs - current.startMs : 0,
      timer: null,
    };
    segment.timer = this.setTimer(() => {
      segment.timer = null;
      if (segment.text !== null) return;
      this.log('student.unheard', { itemId: id, afterMs: this.transcriptWaitMs });
      segment.text = '';
      this.settle();
    }, this.transcriptWaitMs);
    this.segments.push(segment);
  }

  /**
   * The written version of a stretch has arrived.
   * @param {string} itemId
   * @param {string} text
   */
  transcript(itemId, text) {
    const id = String(itemId || '');
    const words = String(text || '').trim();
    let segment = this.segments.find((entry) => entry.itemId === id);
    if (!segment) {
      const last = this.dispatched;
      if (last && last.itemIds.includes(id)) {
        // Its turn was handed over without it — its written version was slow.
        // If the reply has not been heard, these words belong in that turn:
        // "hourensou" said in two breaths was once answered as "…sou".
        const own = last.segments.find((entry) => entry.itemId === id);
        if (!words || (own && own.text)) {
          this.log('student.late', { itemId: id });
          return;
        }
        this.dispatched = null;
        if (this.onRetract() === false) {
          this.log('student.late', { itemId: id });
          return;
        }
        this.log('student.recovered', { itemId: id });
        this.segments.unshift(...last.segments.map((entry) => ({ ...entry, timer: null, text: entry.itemId === id ? words : entry.text })));
        this.settle();
        return;
      }
      if (this.settled.includes(id)) {
        // Set aside as a noise because nothing had been written down in time
        // — and now something has. It was speech after all: answer it.
        const at = this.noises.indexOf(id);
        if (words && at >= 0) {
          this.noises.splice(at, 1);
          this.log('student.recovered', { itemId: id });
          this.segments.push({ itemId: id, text: words, overTutor: false, ms: 0, timer: null });
          this.settle();
          return;
        }
        // Dealt with already, and its reply heard: too late to matter.
        this.log('student.late', { itemId: id });
        return;
      }
      // Never announced: take it as it comes.
      segment = { itemId: id, text: null, overTutor: false, ms: 0, timer: null };
      this.segments.push(segment);
    }
    if (segment.timer) {
      this.clearTimer(segment.timer);
      segment.timer = null;
    }
    segment.text = words;
    this.settle();
  }

  /**
   * The reply to the last turn can be heard. From here, anything the student
   * says is a new turn — an interruption, not a continuation.
   */
  replyHeard() {
    this.dispatched = null;
  }

  /** Nothing answered the student for a long while. Answer what there is. */
  rescue() {
    if (this.speaking) return false;
    for (const segment of this.segments) {
      if (segment.text === null) segment.text = '';
      if (segment.timer) {
        this.clearTimer(segment.timer);
        segment.timer = null;
      }
    }
    if (!this.segments.length) return false;
    this.settle({ now: true });
    return true;
  }

  /**
   * Hand the turn over, if it is whole.
   * @param {{now?: boolean}} [options] `now`: do not wait on a trailing word
   */
  settle({ now = false } = {}) {
    if (this.speaking) return;
    if (!this.segments.length || this.segments.some((segment) => segment.text === null)) return;
    if (this.holdTimer) {
      this.clearTimer(this.holdTimer);
      this.holdTimer = null;
    }
    const text = joinSpeech(this.segments.map((segment) => segment.text));

    if (!text) {
      const segments = this.segments;
      this.segments = [];
      this.heldFor = '';
      const itemIds = segments.map((segment) => segment.itemId);
      this.close(itemIds);
      const ms = segments.reduce((total, segment) => total + segment.ms, 0);
      const overTutor = segments.every((segment) => segment.overTutor);
      const brief = segments.every((segment) => segment.ms > 0 && segment.ms < this.minSpeechMs);
      // The tutor's own voice, a cough, a click: not a turn.
      if (overTutor || brief) {
        this.noises.push(...itemIds);
        if (this.noises.length > 20) this.noises.splice(0, this.noises.length - 20);
        this.log('student.noise', { itemIds, overTutor, ms });
        this.onNoise({ itemIds, overTutor, ms });
        return;
      }
      // They spoke, and it could not be made out.
      this.dispatched = { text: '', itemIds, segments };
      this.onAnswer('', { itemIds, parts: segments.length, ms });
      return;
    }

    if (!now && trailsOff(text) && this.heldFor !== text && !this.isWhole(text)) {
      this.heldFor = text;
      this.log('student.held', { text, forMs: this.trailingWaitMs });
      this.holdTimer = this.setTimer(() => {
        this.holdTimer = null;
        this.settle({ now: true });
      }, this.trailingWaitMs);
      return;
    }

    const segments = this.segments;
    this.segments = [];
    this.heldFor = '';
    const itemIds = segments.map((segment) => segment.itemId);
    this.close(itemIds);
    if (segments.length > 1) this.log('student.joined', { parts: segments.length, text });
    this.dispatched = { text, itemIds, segments };
    this.onAnswer(text, { itemIds, parts: segments.length, ms: segments.reduce((total, segment) => total + segment.ms, 0) });
  }
}
