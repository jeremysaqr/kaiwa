/**
 * public/js/realtime.js
 *
 * The live voice session: microphone -> WebRTC -> OpenAI Realtime -> speakers,
 * with transcript events surfaced through callbacks.
 *
 * Connection strategy:
 *   1. Ask our backend for a short-lived client secret, then POST the SDP offer
 *      straight to OpenAI. (Fastest; the permanent key stays on the server.)
 *   2. If that fails for any reason, fall back to relaying the SDP through our
 *      own backend.
 *
 * Teardown is deliberately thorough (PART 3, items 11-14): stop the session,
 * stop every microphone track, close the peer connection, reset state.
 */

const OPENAI_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

/** How long we allow the whole connection dance to take. */
const CONNECT_TIMEOUT_MS = 20000;

/** How long a queued turn waits before re-checking whether it can go. */
const TURN_RETRY_MS = 700;

/**
 * How long to wait, after the student stops speaking, for the server to start
 * a response on its own before concluding it is not going to.
 *
 * `semantic_vad` does not merely detect silence — it judges whether the student
 * has finished a thought, and sometimes decides they have not. When it decides
 * wrongly the server commits the audio and then waits, forever, for a
 * continuation that is never coming. On screen that is the tutor going deaf:
 * the student said something, it was transcribed, and nothing answered it.
 *
 * Nothing recovers from this on its own, so the client does. Four seconds is
 * long enough that a response which is merely slow is never pre-empted
 * (`response.created` normally arrives inside a second) and short enough that
 * the student has not yet started wondering whether the app has crashed.
 */
const SILENT_TURN_MS = 4000;

/**
 * How much of the conversation the model carries, in tokens, on top of its
 * instructions.
 *
 * Every reply re-sends the whole conversation, and in a voice call the
 * conversation is audio — hundreds of tokens for every few seconds of speech.
 * Left alone, the request grows for as long as the call does. That costs more
 * with every turn, and it also runs into the account's tokens-per-minute limit:
 * the API then refuses to reply at all, and the tutor goes silent mid-lesson.
 * Measured with a 40,000-per-minute limit, that is what "the tutor gets stuck
 * as the call gets longer" was.
 *
 * The tutor does not need a long memory. What has been taught and where the
 * lesson has got to are in its instructions, which are rebuilt as the lesson
 * moves. So the conversation is capped at a few minutes' worth, and when the
 * cap is reached it is cut back to 70% rather than trimmed a sliver every turn.
 */
const CONTEXT_TOKENS = 4000;
const CONTEXT_RETENTION = 0.7;

/** A reply the API refused is asked for again this many times before giving up. */
const MAX_REPLY_RETRIES = 2;

/** How many times it re-checks before assuming response.done is not coming. */
const MAX_TURN_WAITS = 17;

/**
 * @typedef {Object} SessionCallbacks
 * @property {(status: string, detail?: string) => void} [onStatus]
 * @property {(state: string) => void} [onConnectionState]
 * @property {(payload: {itemId: string, delta: string}) => void} [onUserDelta]
 * @property {(payload: {itemId: string, text: string}) => void} [onUserDone]
 * @property {(payload: {itemId: string, delta: string}) => void} [onTutorDelta]
 * @property {(payload: {itemId: string, text: string}) => void} [onTutorDone]
 * @property {(payload: {message: string, fatal: boolean}) => void} [onError]
 * @property {(instruction: string) => void} [onNudge]
 * @property {(config: Record<string, any>) => void} [onTranscriptionConfig]
 * @property {() => void} [onClosed]
 */

/** The session setting that caps how much conversation the model carries. */
export function contextLimitEvent() {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      truncation: {
        type: 'retention_ratio',
        retention_ratio: CONTEXT_RETENTION,
        token_limits: { post_instructions: CONTEXT_TOKENS },
      },
    },
  };
}

/**
 * How long to wait before asking again for a refused reply. The API usually
 * says ("Please try again in 1.855s"); otherwise a second and a half.
 * @param {string} reason
 * @returns {number} milliseconds
 */
export function retryDelayMs(reason) {
  const match = /try again in\s+([\d.]+)\s*(ms|s)\b/i.exec(String(reason || ''));
  let wait = 1500;
  if (match) wait = Number(match[1]) * (match[2].toLowerCase() === 's' ? 1000 : 1);
  if (!Number.isFinite(wait)) wait = 1500;
  // A little longer than asked, never absurdly short or long.
  return Math.round(Math.min(8000, Math.max(600, wait + 300)));
}

export class RealtimeSession {
  /** @param {SessionCallbacks} callbacks */
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    /** @type {RTCPeerConnection|null} */
    this.pc = null;
    /** @type {RTCDataChannel|null} */
    this.dc = null;
    /** @type {MediaStream|null} */
    this.micStream = null;
    /** @type {HTMLAudioElement|null} */
    this.audioElement = null;
    this.active = false;
    this.closing = false;
    /** How the session was established, for diagnostics. */
    this.transport = null;
    /** True between `response.created` and `response.done`. */
    this.responseActive = false;
    /** A turn has been asked for and is waiting for the current one to finish. */
    this.turnPending = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.turnTimer = null;
    /** How many times a queued turn has waited for the current one to end. */
    this.turnWaits = 0;
    /** A response.create has been sent and not yet acknowledged. */
    this.turnInFlight = false;
    /** Did the tutor actually say anything during the current response? */
    this.responseSpoke = false;
    /** Fires when the student's turn goes unanswered. @type {ReturnType<typeof setTimeout>|null} */
    this.silenceTimer = null;
    /** How long to wait for a response the server may never start. */
    this.silentTurnMs = SILENT_TURN_MS;
    /** Replies the API has refused in a row. */
    this.failedReplies = 0;
    /** Waiting to ask again for a refused reply. @type {ReturnType<typeof setTimeout>|null} */
    this.retryTimer = null;
    /**
     * Does the app ask for each reply itself?
     *
     * When true the server has been told not to answer on its own
     * (`create_response: false`): it hears the student, and waits. The app
     * then asks for the reply — with instructions for that reply alone when a
     * lesson is choosing the tutor's words. Confirmed from what the server
     * reports about the session, not assumed.
     */
    this.directed = false;
    /**
     * Replies waiting to be asked for, in order. Usually one. Two when the
     * tutor is to answer a question and then say a given line, or tell the
     * student to wait and then begin.
     * @type {{instructions: string, fresh: boolean, say: string}[]}
     */
    this.turnQueue = [];
    /** Reasoning effort for a line that is simply read aloud. Empty to leave the session's own. */
    this.readEffort = 'minimal';
    /** When the last request for a reply was sent. */
    this.turnSentAt = 0;
    /** What the last reply was asked for with, so a refused one is asked for again the same way. */
    /** @type {{instructions: string, fresh: boolean, say: string}|null} */
    this.lastTurn = null;
    /** How the session listens, as the server set it up: sent back whole when the hint changes. */
    /** @type {Record<string, any>|null} */
    this.inputConfig = null;
    /** The transcription hint the session has now. */
    this.hint = '';
    /** Is the student speaking right now, as far as the session can tell? */
    this.studentSpeaking = false;
    /** A reply has been created and is not yet done. */
    this.responseOpen = false;
    /** The reply in progress was cut off by the student, or by a noise. */
    this.replyCut = false;
    /** A reply asked for while the student was speaking is held until this time, for the app to decide. */
    this.heldUntil = 0;
    /** Does this session report when the tutor's voice starts and stops being played? */
    this.sawBuffer = false;
    /** Without that: when the reply was first heard, how long it is, and so when it should be over. */
    this.replyHeardAt = 0;
    this.replyChars = 0;
    this.audibleUntil = 0;
    /** A transcription hint waiting for the student to stop speaking. */
    this.pendingHint = '';
    /** Replies that were questions to the model's ear: never the tutor speaking. @type {Set<string>} */
    this.earIds = new Set();
    /** When a question to its ear was last given up on without being acknowledged. */
    this.earStrayAt = 0;
    /** Is the tutor's voice being played right now? */
    this.tutorAudible = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.audibleTimer = null;
    /**
     * A question put to the model about something the student said, outside
     * the conversation: its answer is text, and is never spoken or shown.
     * @type {{eventId: string, responseId: string, text: string, sentAt: number, settled: boolean, over: boolean,
     *         timer: any, finish: (text: string) => void}|null}
     */
    this.ear = null;
    this.earCount = 0;
    /** Questions in a row that the session never acknowledged. */
    this.earMisses = 0;
    /** The session would not take such a question. It is not asked again on this call. */
    this.earOff = false;
    this.hintCount = 0;
    /** The session would not take a change of hint. It is not sent again on this call. */
    this.hintOff = false;
  }

  /** Is a question to the model's ear still on its way out or being answered? */
  get earBusy() {
    const ear = this.ear;
    if (!ear || ear.over || Date.now() - ear.sentAt >= 3000) return false;
    // Given up on, and never acknowledged: nothing to wait behind.
    return !(ear.settled && !ear.responseId);
  }

  /** Is a reply waiting, on its way, or being given? */
  get replyOnItsWay() {
    return Boolean(this.turnPending || this.turnInFlight || this.responseActive || this.turnQueue.length);
  }

  /** Is the tutor's voice, as far as can be told, still being heard? */
  get tutorHeard() {
    if (this.tutorAudible || (this.responseOpen && this.responseSpoke)) return true;
    // A session that does not report playback: go by how long the reply is.
    return !this.sawBuffer && Date.now() < this.audibleUntil;
  }

  /** A reply held back while the student was speaking may go now: what they "said" was not speech. */
  releaseHeld() {
    this.heldUntil = 0;
    if (this.turnPending && !this.studentSpeaking) this.flushPendingTurn();
  }

  /**
   * Ask the model, which heard the student, a yes-or-no question about what
   * they said — outside the conversation, answered in text, never spoken.
   *
   * The written version of a beginner's Japanese is a recogniser's guess:
   * "hourensou" came back as "Lorenzo", "Paurenchu" and "Powręzu" on one
   * call, and each was corrected. Before anything is called wrong on a guess
   * like that, the one thing that actually heard it is asked.
   *
   * @param {string[]} itemIds the student's turn, as the server's item ids
   * @param {string} instructions what to listen for
   * @param {{timeoutMs?: number}} [options]
   * @returns {{result: Promise<string>, cancel: () => void}} the answer as
   *          written ('' if there was none in time)
   */
  listen(itemIds, instructions, { timeoutMs = 1500 } = {}) {
    const none = { result: Promise.resolve(''), cancel() {} };
    const ids = (Array.isArray(itemIds) ? itemIds : []).map((id) => String(id || '')).filter(Boolean).slice(-3);
    const own = typeof instructions === 'string' ? instructions.trim() : '';
    if (!this.active || this.earOff || !ids.length || !own) return none;
    if (this.earBusy || this.responseActive || this.turnInFlight || this.turnPending) return none;

    this.earCount += 1;
    /** @type {(text: string) => void} */
    let resolve = () => {};
    const result = new Promise((done) => { resolve = done; });
    const ear = {
      eventId: `ear_${this.earCount}`,
      responseId: '',
      text: '',
      sentAt: Date.now(),
      settled: false,
      over: false,
      timer: null,
      /** @param {string} text */
      finish: (text) => {
        if (ear.settled) return;
        ear.settled = true;
        clearTimeout(ear.timer);
        this.callbacks.onTurnEvent?.({ event: 'ear', said: String(text || '').slice(0, 40), afterMs: Date.now() - ear.sentAt });
        resolve(String(text || ''));
      },
    };
    const cancel = () => {
      if (ear.settled && ear.over) return;
      ear.finish('');
      // Still being answered: stop it, so the reply does not wait behind it.
      if (!ear.over && ear.responseId) this.send({ type: 'response.cancel', response_id: ear.responseId });
    };
    /** @type {Record<string, any>} */
    const response = {
      conversation: 'none',
      output_modalities: ['text'],
      metadata: { purpose: 'ear' },
      instructions: own,
      input: [
        ...ids.map((id) => ({ type: 'item_reference', id })),
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Was that it? Answer yes or no.' }] },
      ],
    };
    if (this.readEffort) response.reasoning = { effort: this.readEffort };
    this.ear = ear;
    if (!this.send({ type: 'response.create', event_id: ear.eventId, response })) {
      this.ear = null;
      return none;
    }
    ear.timer = setTimeout(cancel, timeoutMs);
    // Never acknowledged at all: forget it — and after two of those, stop
    // asking on this call. (If its answer turns up late all the same, it is
    // still not the tutor speaking: see `earStrayAt`.)
    setTimeout(() => {
      if (ear.over || ear.responseId) return;
      ear.over = true;
      if (this.ear === ear) this.ear = null;
      this.earStrayAt = Date.now();
      this.earMisses += 1;
      if (this.earMisses >= 2) this.earOff = true;
    }, 3000);
    return { result, cancel };
  }

  /**
   * A reply that has been asked for is not wanted after all: the student went
   * on speaking before a word of it was heard.
   *
   * Usually the session has stopped it already — it stops a reply the moment
   * it hears speech. But a reply asked for a moment AFTER the speech began is
   * not stopped by anything, and would be spoken over the student. This stops
   * that one.
   *
   * @returns {boolean} whether anything was cancelled
   */
  cancelReply() {
    if (!this.active) return false;
    this.turnQueue = [];
    this.turnPending = false;
    clearTimeout(this.turnTimer);
    this.turnTimer = null;
    // Nothing on its way; or it can already be heard, and the session deals with that.
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!this.turnInFlight && !this.responseActive) return false;
    if (this.responseSpoke) return false;
    return this.send({ type: 'response.cancel' });
  }

  /**
   * Tell the transcriber what it is about to hear, part-way through a call.
   *
   * The hint used to be set once, as the call began. A lesson asked for by
   * voice had not been written by then, so its words were never in it — and
   * "hourensou" was transcribed five different ways.
   *
   * The turn-taking settings are sent with it, exactly as the server set them:
   * an update that left them out could put them back to the API's defaults,
   * and the session would start answering on its own.
   *
   * @param {string} prompt
   * @returns {boolean} whether an update was sent
   */
  updateTranscriptionHint(prompt) {
    const text = typeof prompt === 'string' ? prompt.trim().slice(0, 900) : '';
    const input = this.inputConfig;
    if (!text || !this.active || this.hintOff || !input || !input.transcription || text === this.hint) return false;
    // Not while they are speaking: the update restates how the session listens,
    // and that is not something to change under a sentence. It goes when they stop.
    if (this.studentSpeaking) {
      this.pendingHint = text;
      return false;
    }
    this.pendingHint = '';
    this.hintCount += 1;
    const sent = this.send({
      type: 'session.update',
      event_id: `hint_${this.hintCount}`,
      session: {
        type: 'realtime',
        audio: { input: { ...input, transcription: { ...input.transcription, prompt: text } } },
      },
    });
    if (sent) {
      this.hint = text;
      this.callbacks.onTranscriptionConfig?.({ ...input.transcription, prompt: text, updated: true });
    }
    return sent;
  }

  /**
   * Ask the tutor for a reply.
   *
   * @param {string} [instructions] for this reply alone, replacing the
   *        standing instructions; empty to use those
   * @param {{fresh?: boolean, say?: string, after?: boolean}} [options]
   *        `fresh` makes the reply from its instructions alone, without the
   *        conversation so far in view. A line the tutor is to say word for
   *        word is asked for this way: with the conversation in front of it,
   *        the small model follows the pattern of its own earlier turns
   *        instead — asked for one line, it repeated the one before.
   *        `say` is text handed to it to read aloud, as the only thing in view.
   *        `after` queues this reply behind any already waiting, instead of
   *        replacing them.
   */
  respond(instructions = '', { fresh = false, say = '', examples = [], after = false } = {}) {
    if (!this.active) return;
    const own = typeof instructions === 'string' ? instructions.trim() : '';
    const entry = {
      instructions: own,
      fresh: Boolean(fresh) && Boolean(own),
      say: own ? String(say || '').trim() : '',
      // Lines shown as already read back word for word, ahead of the one to read.
      examples: Array.isArray(examples) ? examples.map((line) => String(line)) : [],
    };
    if (after) this.turnQueue.push(entry);
    else {
      this.turnQueue = [entry];
      // This is the reply to what was last said: nothing older is owed —
      // neither a reply that was held back, nor one being asked for again.
      this.heldUntil = 0;
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.requestTurn();
  }

  /**
   * The event that asks for a reply.
   * @param {{instructions: string, fresh: boolean, say: string}|null} turn
   */
  replyRequest(turn) {
    if (!turn || !turn.instructions) return { type: 'response.create' };
    /** @type {Record<string, any>} */
    const response = { instructions: turn.instructions };
    if (turn.say) {
      const said = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
      const read = (text) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      response.input = [...(turn.examples || []).flatMap((line) => [said(line), read(line)]), said(turn.say)];
      // Reading a line aloud needs no thinking about, and thinking about it is
      // where the extra words came from — and the extra seconds.
      if (this.readEffort) response.reasoning = { effort: this.readEffort };
    } else if (turn.fresh) {
      response.input = [];
    }
    return { type: 'response.create', response };
  }

  /**
   * The server has said how the session is set up. If it is not going to wait
   * for the app before replying, the app must not ask as well.
   * @param {any} session
   */
  noteSessionConfig(session) {
    const detection = session?.audio?.input?.turn_detection;
    if (!detection || typeof detection !== 'object') return;
    // Only an explicit "yes, I will answer by myself" changes anything. A
    // report that leaves the setting out is not evidence either way, and
    // guessing wrong in that direction means nobody answers the student.
    if (detection.create_response !== true || !this.directed) return;
    this.directed = false;
    this.callbacks.onTurnMode?.(false);
  }

  /**
   * Replace the live session instructions.
   *
   * This is how a lesson starting, changing phase or ending reaches the model
   * mid-call: the prompt is rebuilt from the same `buildTutorPrompt` the
   * preview uses, and pushed here.
   *
   * @param {string} instructions
   * @returns {boolean} whether the update was sent
   */
  updateInstructions(instructions) {
    const text = typeof instructions === 'string' ? instructions : '';
    if (!text.trim()) return false;
    return this.send({
      type: 'session.update',
      session: { type: 'realtime', instructions: text },
    });
  }

  /** @param {string} status @param {string} [detail] */
  emitStatus(status, detail) {
    this.callbacks.onStatus?.(status, detail);
  }

  /** @param {string} message @param {boolean} fatal */
  emitError(message, fatal = false) {
    this.callbacks.onError?.({ message, fatal });
  }

  /**
   * Open the microphone, negotiate WebRTC, and start the tutor.
   *
   * @param {{instructions: string, language: string, userName: string, voice?: string}} options
   * @returns {Promise<void>}
   */
  async start(options) {
    if (this.active) throw new Error('A session is already running.');
    this.closing = false;

    // --- 1. Microphone ------------------------------------------------------
    this.emitStatus('requesting-mic');
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      const name = error?.name || '';
      const message =
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again.'
          : name === 'NotFoundError'
            ? 'No microphone was found. Connect one and try again.'
            : `Could not open the microphone: ${error?.message || name || 'unknown error'}`;
      this.emitStatus('mic-denied');
      throw new Error(message);
    }
    this.emitStatus('mic-active');

    // --- 2. Peer connection -------------------------------------------------
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    this.pc = pc;

    // Remote audio: created here and played automatically.
    const audioElement = document.createElement('audio');
    audioElement.autoplay = true;
    audioElement.setAttribute('playsinline', '');
    this.audioElement = audioElement;

    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        audioElement.srcObject = event.streams[0];
        const played = audioElement.play();
        if (played && typeof played.catch === 'function') {
          played.catch(() => {
            // Autoplay policies can block this before a user gesture. The
            // gesture that started the call normally satisfies them; if not,
            // say so rather than failing silently.
            this.emitError(
              'The browser blocked audio playback. Click anywhere on the page to enable sound.',
              false,
            );
          });
        }
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.callbacks.onConnectionState?.(state);
      if (state === 'failed') {
        this.emitError('The voice connection failed. Check your network and start a new call.', true);
        this.stop();
      } else if (state === 'disconnected' && !this.closing) {
        this.emitStatus('reconnecting');
      }
    };

    for (const track of this.micStream.getTracks()) {
      pc.addTrack(track, this.micStream);
    }

    // --- 3. Data channel for events ----------------------------------------
    const dc = pc.createDataChannel('oai-events');
    this.dc = dc;
    dc.addEventListener('message', (event) => this.handleServerEvent(event));
    dc.addEventListener('error', () => {
      this.emitError('The Realtime event channel reported an error.', false);
    });

    const channelReady = new Promise((resolve) => {
      dc.addEventListener('open', () => resolve(true), { once: true });
      setTimeout(() => resolve(false), CONNECT_TIMEOUT_MS);
    });

    // --- 4. Offer / answer ---------------------------------------------------
    this.emitStatus('connecting');
    let offer;
    try {
      offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch (error) {
      // Without this the microphone stays open and the browser's recording
      // indicator stays lit, with no session object left for the user to stop.
      await this.stop();
      throw new Error(`The browser could not create a session offer: ${error?.message || error}`);
    }

    let answerSdp;
    try {
      answerSdp = await this.negotiate(offer.sdp, options);
    } catch (error) {
      await this.stop();
      throw error;
    }

    try {
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    } catch (error) {
      await this.stop();
      throw new Error(`The browser rejected the session answer: ${error?.message || error}`);
    }

    this.active = true;

    const opened = await channelReady;
    if (!opened) {
      this.emitError(
        'The session connected but the event channel did not open, so transcripts may not appear.',
        false,
      );
    } else {
      // Re-send the instructions over the data channel. The session was already
      // created with them, but this makes the live session state explicit and
      // survives any server-side default that might differ.
      this.send({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: options.instructions,
        },
      });
      // Keep the request from growing for as long as the call does. Sent on
      // its own, so that if the API ever declines it the call is unaffected.
      this.send(contextLimitEvent());
      // Ask the tutor to speak first so the student is not staring at silence.
      // When a lesson is choosing its words, the opening line is one of them.
      const opening = this.directed && options.opening && typeof options.opening.instructions === 'string'
        ? {
            instructions: options.opening.instructions.trim(),
            fresh: true,
            say: String(options.opening.say || ''),
            examples: Array.isArray(options.opening.examples) ? options.opening.examples : [],
          }
        : null;
      this.lastTurn = opening;
      this.send(this.replyRequest(opening));
    }

    this.emitStatus('connected');
  }

  /**
   * Obtain an SDP answer, trying the ephemeral-token path first.
   * @param {string} offerSdp
   * @param {{instructions: string, language: string, userName: string, voice?: string}} options
   * @returns {Promise<string>}
   */
  async negotiate(offerSdp, options) {
    const body = {
      instructions: options.instructions,
      language: options.language,
      userName: options.userName,
      ...(options.transcriptionPrompt ? { transcriptionPrompt: options.transcriptionPrompt } : {}),
      ...(options.voice ? { voice: options.voice } : {}),
    };

    // --- Path 1: ephemeral client secret -----------------------------------
    let ephemeralError = null;
    try {
      const tokenResponse = await fetchWithTimeout('/api/realtime/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const tokenPayload = await readJson(tokenResponse);

      if (!tokenResponse.ok || !tokenPayload?.clientSecret) {
        throw new Error(tokenPayload?.error || `Backend returned HTTP ${tokenResponse.status}.`);
      }

      const sdpResponse = await fetchWithTimeout(OPENAI_CALLS_URL, {
        method: 'POST',
        body: offerSdp,
        headers: {
          Authorization: `Bearer ${tokenPayload.clientSecret}`,
          'Content-Type': 'application/sdp',
        },
      });

      const answer = await sdpResponse.text();
      if (!sdpResponse.ok) {
        throw new Error(`OpenAI rejected the offer (HTTP ${sdpResponse.status}).`);
      }
      this.transport = 'ephemeral-token';
      this.noteInputConfig(tokenPayload.input);
      this.setTurnMode(tokenPayload.turns === 'app');
      // What the server actually asked for, rather than what we believe it did.
      if (tokenPayload.transcription) {
        this.callbacks.onTranscriptionConfig?.(tokenPayload.transcription);
      }
      return answer;
    } catch (error) {
      ephemeralError = error;
    }

    // --- Path 2: relay the SDP through our own backend ----------------------
    try {
      const response = await fetchWithTimeout('/api/realtime/sdp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, sdp: offerSdp }),
      });
      const payload = await readJson(response);
      if (!response.ok || !payload?.sdp) {
        throw new Error(payload?.error || `Backend returned HTTP ${response.status}.`);
      }
      this.transport = 'server-relay';
      this.noteInputConfig(payload.input);
      this.setTurnMode(payload.turns === 'app');
      return payload.sdp;
    } catch (relayError) {
      throw new Error(
        `Could not start the voice session.\n\n` +
          `Direct connection: ${describeError(ephemeralError)}\n` +
          `Server relay: ${describeError(relayError)}`,
      );
    }
  }

  /** @param {any} input how the server set the session up to listen */
  noteInputConfig(input) {
    this.inputConfig = input && typeof input === 'object' && input.transcription ? input : null;
    this.hint = this.inputConfig ? String(this.inputConfig.transcription.prompt || '') : '';
  }

  /** @param {boolean} directed whether the app asks for each reply */
  setTurnMode(directed) {
    this.directed = Boolean(directed);
    this.callbacks.onTurnMode?.(this.directed);
  }

  /**
   * Give the tutor an out-of-band instruction.
   *
   * By default this is PASSIVE: the instruction is placed in the conversation
   * and shapes the tutor's next natural turn, but does not make it speak. That
   * default matters. Almost every nudge the app sends is a reaction to something
   * the student just said — the lesson moved on, the Director spotted a slip —
   * and by the time it arrives the tutor has already answered that same
   * utterance. Forcing a turn then makes the tutor speak twice in a row: one
   * question, then immediately another, with the student given no chance to
   * answer the first. That was measured in real sessions and is exactly what
   * "it gave me several prompts before I could respond" means.
   *
   * `speak: true` is for the cases where nobody is talking and the tutor would
   * otherwise sit silent: the student pressed a button in the app.
   *
   * @param {string} instruction
   * @param {{speak?: boolean}} [options]
   * @returns {boolean}
   */
  nudge(instruction, { speak = false } = {}) {
    const text = typeof instruction === 'string' ? instruction.trim() : '';
    if (!text || !this.active) return false;
    this.callbacks.onNudge?.(text, { speak });
    const sent = this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text }],
      },
    });
    if (sent && speak) this.requestTurn();
    return sent;
  }

  /**
   * A reply has ended. If the API refused it outright, ask again.
   *
   * A refusal — a rate limit, almost always — produces no audio and no text:
   * the student said something and simply hears nothing back. The API says how
   * long to wait, so wait that long and ask once more, and only tell the
   * student if it keeps happening.
   *
   * @param {string} status
   * @param {string} reason
   */
  settleReply(status, reason) {
    if (status !== 'failed') {
      if (status === 'completed') this.failedReplies = 0;
      return;
    }
    if (this.responseSpoke || !this.active) return;

    this.failedReplies += 1;
    if (this.failedReplies > MAX_REPLY_RETRIES) {
      this.failedReplies = 0;
      this.emitError(
        /rate limit/i.test(reason)
          ? 'The tutor could not reply: the OpenAI account is at its rate limit. Wait a few seconds and say it again.'
          : 'The tutor could not reply. Say it again.',
        false,
      );
      return;
    }

    const wait = retryDelayMs(reason);
    this.callbacks.onTurnEvent?.({ event: 'retry', afterMs: wait, attempt: this.failedReplies });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.lastTurn) this.turnQueue.unshift(this.lastTurn);
      this.requestTurn();
    }, wait);
  }

  /**
   * Start (or restart) the clock on an unanswered student turn.
   *
   * Armed when the student stops speaking, cancelled the moment the server
   * starts a response of its own, or the student starts speaking again.
   */
  armSilenceWatchdog() {
    clearTimeout(this.silenceTimer);
    if (!this.active) return;
    this.silenceTimer = setTimeout(() => this.rescueSilentTurn(), this.silentTurnMs);
  }

  /** The server started talking, or the student did. Stand down. */
  clearSilenceWatchdog() {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }

  /**
   * The student spoke and nothing answered. Ask for the turn ourselves.
   *
   * Two things have to happen here, not one. `responseActive` was set
   * optimistically when the student stopped speaking, on the assumption that
   * the server was about to create a response; that assumption has just been
   * proved wrong, and if the flag is left standing every later turn we ask for
   * — a lesson nudge, a correction — queues behind a response that does not
   * exist and is delayed by twelve seconds for the rest of the call.
   */
  rescueSilentTurn() {
    this.silenceTimer = null;
    if (!this.active) return;
    // The tutor is already talking, or a turn is already on its way out. Either
    // way the student is not being ignored.
    if (this.responseSpoke || this.turnPending || this.turnInFlight) return;
    this.responseActive = false;
    this.callbacks.onSilentTurn?.({ afterMs: this.silentTurnMs });
    // When the app asks for each reply, it is the one to ask for this one too,
    // so that a lesson's words are still the lesson's.
    if (this.directed && this.callbacks.onUnansweredTurn) {
      this.callbacks.onUnansweredTurn();
      return;
    }
    this.requestTurn();
  }

  /**
   * Ask the tutor to take a turn.
   *
   * Creating a response while one is already running is an error the student
   * sees, and a turn requested during the student's own speech interrupts them.
   * So the request is queued and settled when the current response finishes.
   * The flag is a single boolean, so several requests inside one window — a
   * nudge and a tool result, say — produce exactly one turn.
   */
  requestTurn() {
    if (!this.active) return;
    this.turnPending = true;
    this.turnWaits = 0;
    this.scheduleTurnFlush(0);
  }

  /**
   * Try to settle the queued turn shortly.
   * @param {number} delay milliseconds
   */
  scheduleTurnFlush(delay) {
    clearTimeout(this.turnTimer);
    this.turnTimer = setTimeout(() => this.flushPendingTurn(), delay);
  }

  /**
   * Settle a queued turn request, at most once, and never on top of a response
   * that is still running.
   *
   * The hard case is a turn requested from the transcription callback: the
   * student has stopped speaking, so the server is already building a response,
   * but `response.created` may not have reached us yet. Firing then produces
   * "conversation already has an active response". So this waits, re-checks,
   * and gives up its politeness only after a long stretch of hearing nothing.
   */
  flushPendingTurn() {
    clearTimeout(this.turnTimer);
    this.turnTimer = null;
    if (!this.turnPending || !this.active) return;

    const waits = this.turnWaits;
    // A request already on its way counts as a reply in progress for a few
    // seconds: the server has not said so yet, but asking again would collide.
    const inFlight = this.turnInFlight && Date.now() - this.turnSentAt < 3000;
    // Not over the student, and — when the app chooses the replies — not until
    // it has had the chance to say what the sound that held this up was: an
    // answer, whose reply replaces this one, or a noise, which releases it.
    const held = this.directed && (this.studentSpeaking || Date.now() < this.heldUntil);
    if (this.responseActive || inFlight || this.earBusy || held) {
      // Wait for response.done. The re-arm is only a backstop in case that
      // event never comes; after about twelve seconds, assume it will not.
      this.turnWaits += 1;
      if (this.turnWaits < MAX_TURN_WAITS) {
        this.scheduleTurnFlush(TURN_RETRY_MS);
        return;
      }
    }

    this.turnPending = false;
    this.turnWaits = 0;
    this.turnInFlight = true;
    this.turnSentAt = Date.now();
    this.clearSilenceWatchdog();
    const turn = this.turnQueue.shift() || null;
    this.lastTurn = turn;
    this.callbacks.onTurnEvent?.({
      event: 'requested', waited: waits, directed: Boolean(turn && turn.instructions), fresh: Boolean(turn && turn.fresh),
    });
    this.send(this.replyRequest(turn));
    // Another reply is waiting behind this one: it goes when this one is done.
    if (this.turnQueue.length) {
      this.turnPending = true;
      this.turnWaits = 0;
    }
  }

  /**
   * Send a client event over the data channel. No-op when it is not open, so
   * callers never have to guard.
   * @param {Record<string, any>} event
   */
  send(event) {
    if (this.dc && this.dc.readyState === 'open') {
      try {
        this.dc.send(JSON.stringify(event));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /** @param {MessageEvent} event */
  handleServerEvent(event) {
    /** @type {any} */
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!payload || typeof payload.type !== 'string') return;

    // A question put to the model's ear is answered outside the conversation.
    // Nothing of it is the tutor speaking: it is not shown, not logged as a
    // turn, and not taken for a line of the lesson.
    if (this.handleEarEvent(payload)) return;

    switch (payload.type) {
      // --- The student's own speech ---------------------------------------
      case 'conversation.item.input_audio_transcription.delta':
        this.callbacks.onUserDelta?.({
          itemId: String(payload.item_id || 'user'),
          delta: String(payload.delta ?? ''),
        });
        break;

      case 'conversation.item.input_audio_transcription.completed':
        this.callbacks.onUserDone?.({
          itemId: String(payload.item_id || 'user'),
          text: String(payload.transcript ?? ''),
        });
        break;

      case 'conversation.item.input_audio_transcription.failed':
        this.emitError('That turn could not be transcribed. The tutor still heard you.', false);
        break;

      // --- The tutor's speech ----------------------------------------------
      case 'response.output_audio_transcript.delta':
        // The first word of a reply: from here the student can hear it.
        if (!this.responseSpoke) {
          this.callbacks.onTutorSpeaking?.();
          this.replyHeardAt = Date.now();
          this.replyChars = 0;
        }
        this.responseSpoke = true;
        this.replyChars += String(payload.delta ?? '').length;
        // About fifteen characters a second, spoken.
        this.audibleUntil = this.replyHeardAt + this.replyChars * 65;
        this.callbacks.onTutorDelta?.({
          itemId: String(payload.item_id || payload.response_id || 'tutor'),
          delta: String(payload.delta ?? ''),
        });
        break;

      case 'response.output_audio_transcript.done':
        this.callbacks.onTutorDone?.({
          itemId: String(payload.item_id || payload.response_id || 'tutor'),
          text: String(payload.transcript ?? ''),
          // Stopped by the student — or by a sound — before it was finished.
          cut: this.replyCut,
        });
        break;

      // Text-only responses (the model occasionally answers without audio).
      case 'response.output_text.delta':
        if (!this.responseSpoke) this.callbacks.onTutorSpeaking?.();
        this.responseSpoke = true;
        this.callbacks.onTutorDelta?.({
          itemId: String(payload.item_id || payload.response_id || 'tutor'),
          delta: String(payload.delta ?? ''),
        });
        break;

      case 'response.output_text.done':
        this.callbacks.onTutorDone?.({
          itemId: String(payload.item_id || payload.response_id || 'tutor'),
          text: String(payload.text ?? ''),
        });
        break;

      // --- Turn taking -----------------------------------------------------
      // The student has stopped talking, so the server is about to create a
      // response on its own. Treat one as running from this moment: waiting for
      // response.created leaves a window in which a turn requested from the
      // transcription callback fires straight into a live response.
      case 'input_audio_buffer.speech_stopped':
      case 'input_audio_buffer.committed':
        // When the app asks for each reply, the server is NOT about to create
        // one, and pretending it is would make the app's own request wait
        // behind a reply that does not exist.
        // (Unless a reply really is still running: one asked for a moment
        // after they began to speak is not stopped by the session, and the
        // next must not be sent on top of it.)
        this.responseActive = this.directed ? this.responseOpen : true;
        if (!(this.directed && this.responseOpen)) this.responseSpoke = false;
        this.armSilenceWatchdog();
        if (this.studentSpeaking) {
          this.studentSpeaking = false;
          // Something was asked for while they were speaking. It waits a
          // moment longer, for the app to say what that sound was.
          if (this.directed && this.turnPending) {
            this.heldUntil = Date.now() + 2500;
            this.scheduleTurnFlush(2500);
          }
          if (this.pendingHint) this.updateTranscriptionHint(this.pendingHint);
        }
        if (payload.type === 'input_audio_buffer.speech_stopped') {
          this.callbacks.onStudentStopped?.({ atMs: Number(payload.audio_end_ms) || 0 });
        }
        if (this.directed && payload.type === 'input_audio_buffer.committed') {
          this.callbacks.onStudentCommitted?.({ itemId: String(payload.item_id || '') });
        }
        break;

      // The tutor's voice, as it is actually played: a reply is finished being
      // written well before it has finished being heard.
      case 'output_audio_buffer.started':
        this.sawBuffer = true;
        this.tutorAudible = true;
        // (If the session never says it stopped, it is not taken to be
        // playing for ever: every sound after it would count as an echo.)
        clearTimeout(this.audibleTimer);
        this.audibleTimer = setTimeout(() => { this.tutorAudible = false; }, 30000);
        break;
      case 'output_audio_buffer.stopped':
        this.sawBuffer = true;
        this.tutorAudible = false;
        break;
      case 'output_audio_buffer.cleared':
        // Cut off part-way: the student did not hear the rest of it.
        this.sawBuffer = true;
        this.tutorAudible = false;
        this.replyCut = true;
        this.callbacks.onTutorCut?.();
        break;

      // How the session is really configured, as the server reports it.
      case 'session.created':
      case 'session.updated':
        this.noteSessionConfig(payload.session);
        break;

      // The student is talking again, so there is no unanswered turn to rescue
      // — and interrupting them with one would be worse than the silence.
      case 'input_audio_buffer.speech_started': {
        // Speaking over the tutor — or the tutor's own voice coming back.
        const overTutor = this.tutorHeard;
        this.studentSpeaking = true;
        if (overTutor) {
          // The session stops the tutor the moment it hears anything.
          if (this.responseOpen && this.responseSpoke) this.replyCut = true;
          // (Where the session does not say that it has, take it that it has.)
          if (!this.sawBuffer) {
            this.audibleUntil = 0;
            this.callbacks.onTutorCut?.();
          }
        }
        this.callbacks.onStudentSpeaking?.({ overTutor, atMs: Number(payload.audio_start_ms) || 0 });
        this.clearSilenceWatchdog();
        // A refused reply that was going to be asked for again is not, now.
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        // Anything still waiting to be said was an answer to what they said
        // before. They are saying something new.
        if (this.directed && this.turnQueue.length) {
          this.turnQueue = [];
          this.turnPending = false;
        }
        break;
      }

      // A new model turn is starting: nothing has been said in it yet, and any
      // turn we asked for has now been granted.
      case 'response.created':
        this.responseActive = true;
        this.responseOpen = true;
        this.responseSpoke = false;
        this.replyCut = false;
        this.turnInFlight = false;
        this.clearSilenceWatchdog();
        this.callbacks.onTurnEvent?.({ event: 'created', id: String(payload.response?.id || '') });
        break;

      // The turn is over, so it is now safe to ask for another one.
      case 'response.done':
        this.responseActive = false;
        this.responseOpen = false;
        this.clearSilenceWatchdog();
        this.callbacks.onTurnEvent?.({
          event: 'done',
          id: String(payload.response?.id || ''),
          status: String(payload.response?.status || ''),
          reason: String(
            payload.response?.status_details?.reason ||
              payload.response?.status_details?.error?.message ||
              '',
          ),
          spoke: this.responseSpoke,
        });
        if (String(payload.response?.status || '') === 'cancelled' && this.responseSpoke) this.callbacks.onTutorCut?.();
        this.settleReply(String(payload.response?.status || ''), String(
          payload.response?.status_details?.error?.message ||
            payload.response?.status_details?.reason || '',
        ));
        if (this.turnPending) this.flushPendingTurn();
        break;

      case 'error': {
        const message = String(
          payload.error?.message || payload.message || 'The Realtime session reported an error.',
        );
        const code = String(payload.error?.code || payload.error?.type || '');

        // Asked to stop a reply that had already stopped, or never started:
        // that is the outcome that was wanted, not something to show anyone.
        if (/cancel/i.test(code) || /no active response|cancellation failed/i.test(message)) break;

        // The session would not take a change of transcription hint. The call
        // goes on with the hint it has; the student is not shown an error
        // about something they never asked for, and it is not tried again.
        if (/^hint_/.test(String(payload.error?.event_id || ''))) {
          this.hintOff = true;
          this.callbacks.onTurnEvent?.({ event: 'hint-refused', reason: message.slice(0, 160) });
          break;
        }

        // Losing a race with the server's own turn-taking is a coordination
        // detail, not something the student should see in their transcript.
        // Recover from it instead: a response evidently IS running, so mark it
        // so and let the queued turn go out when that one finishes.
        // If the API will not take a per-reply reasoning setting, stop sending
        // one and ask again: the line matters, the setting does not.
        if (this.readEffort && /reasoning/i.test(message)) {
          this.readEffort = '';
          this.callbacks.onTurnEvent?.({ event: 'read-effort-refused' });
          if (this.lastTurn && this.lastTurn.instructions) this.turnQueue.unshift(this.lastTurn);
          this.turnInFlight = false;
          this.requestTurn();
          break;
        }

        if (isActiveResponseCollision(code, message)) {
          this.responseActive = true;
          // Our request was refused, so it still has to happen. Put it back in
          // the queue; it will go out when the response that beat us finishes.
          if (this.turnInFlight || this.turnPending) {
            // With the words it was asked for with, if it had any.
            if (this.turnInFlight && this.lastTurn && this.lastTurn.instructions) this.turnQueue.unshift(this.lastTurn);
            this.turnInFlight = false;
            this.turnPending = true;
            this.turnWaits = 0;
            this.scheduleTurnFlush(TURN_RETRY_MS);
          }
          break;
        }

        this.emitError(message, false);
        break;
      }

      default:
        break;
    }
  }

  /**
   * Is this event part of a question put to the model's ear? If so it is dealt
   * with here, and goes no further.
   * @param {any} payload
   * @returns {boolean}
   */
  handleEarEvent(payload) {
    const type = payload.type;
    // One that was given up on, turning up late: still not the tutor speaking.
    if (type === 'response.created') {
      const id = String(payload.response?.id || '');
      const named = payload.response?.metadata?.purpose === 'ear';
      const stray = !this.turnInFlight && this.earStrayAt > 0 && Date.now() - this.earStrayAt < 30000;
      const mine = this.ear && !this.ear.over;
      if (id && !mine && (named || stray)) {
        this.earIds.add(id);
        this.earStrayAt = 0;
        return true;
      }
    } else {
      const id = String(payload.response_id || payload.response?.id || '');
      if (id && this.earIds.has(id)) {
        if (type === 'response.done') this.earIds.delete(id);
        return true;
      }
    }
    const ear = this.ear;
    if (!ear || ear.over) return false;

    if (type === 'error') {
      if (String(payload.error?.event_id || '') !== ear.eventId) return false;
      // The session will not take the question as asked. Go without for the
      // rest of the call: the lesson falls back to what it did before.
      this.earOff = true;
      ear.over = true;
      this.ear = null;
      ear.finish('');
      this.callbacks.onTurnEvent?.({ event: 'ear-refused', reason: String(payload.error?.message || '').slice(0, 160) });
      if (this.turnPending) this.flushPendingTurn();
      return true;
    }

    if (type === 'response.created') {
      const named = payload.response?.metadata?.purpose === 'ear';
      // Named as ours — or, if the session does not say, the only thing that
      // has been asked for.
      if (!named && (ear.responseId || this.turnInFlight)) return false;
      ear.responseId = String(payload.response?.id || '');
      this.earMisses = 0;
      // Asked not to be answered after all, before it had begun.
      if (ear.settled && ear.responseId) this.send({ type: 'response.cancel', response_id: ear.responseId });
      return true;
    }

    const id = String(payload.response_id || payload.response?.id || '');
    if (!id || id !== ear.responseId) return false;

    if (type === 'response.output_text.delta') ear.text += String(payload.delta ?? '');
    if (type === 'response.output_text.done' && typeof payload.text === 'string') ear.text = payload.text;
    if (type === 'response.done') {
      let text = ear.text;
      for (const item of payload.response?.output || []) {
        for (const part of item?.content || []) {
          if (!text && typeof part?.text === 'string') text = part.text;
          if (!text && typeof part?.transcript === 'string') text = part.transcript;
        }
      }
      ear.over = true;
      this.ear = null;
      ear.finish(String(payload.response?.status || '') === 'completed' ? text : '');
      // A reply may have been waiting behind it.
      if (this.turnPending) this.flushPendingTurn();
    }
    return true;
  }

  /**
   * Tear everything down. Safe to call twice, and safe to call when start()
   * failed halfway through.
   */
  async stop() {
    if (this.closing) return;
    this.closing = true;

    this.clearSilenceWatchdog();
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.ear) {
      this.ear.over = true;
      this.ear.finish('');
      this.ear = null;
    }
    this.tutorAudible = false;
    clearTimeout(this.audibleTimer);
    this.audibleTimer = null;
    this.studentSpeaking = false;
    this.responseOpen = false;
    this.replyCut = false;
    this.heldUntil = 0;
    this.audibleUntil = 0;
    this.pendingHint = '';
    this.earIds.clear();

    // 1. Ask the session to stop talking before we cut the transport.
    this.send({ type: 'response.cancel' });

    // 2. Data channel.
    if (this.dc) {
      try {
        this.dc.close();
      } catch {
        /* already gone */
      }
      this.dc = null;
    }

    // 3. Microphone tracks — this is what turns off the browser's recording
    //    indicator, so it must happen even if everything else fails.
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* already stopped */
        }
      }
      this.micStream = null;
    }

    // 4. Peer connection.
    if (this.pc) {
      try {
        for (const sender of this.pc.getSenders()) {
          if (sender.track) sender.track.stop();
        }
      } catch {
        /* ignore */
      }
      try {
        this.pc.ontrack = null;
        this.pc.onconnectionstatechange = null;
        this.pc.close();
      } catch {
        /* already closed */
      }
      this.pc = null;
    }

    // 5. Audio element.
    if (this.audioElement) {
      try {
        this.audioElement.pause();
        this.audioElement.srcObject = null;
      } catch {
        /* ignore */
      }
      this.audioElement = null;
    }

    this.responseActive = false;
    this.turnPending = false;
    this.turnWaits = 0;
    this.turnInFlight = false;
    this.responseSpoke = false;
    clearTimeout(this.turnTimer);
    this.turnTimer = null;

    this.active = false;
    this.emitStatus('closed');
    this.callbacks.onClosed?.();
    this.closing = false;
  }

  /** Mute or unmute the microphone without ending the call. */
  setMicrophoneEnabled(enabled) {
    if (!this.micStream) return false;
    for (const track of this.micStream.getAudioTracks()) {
      track.enabled = Boolean(enabled);
    }
    return true;
  }

  /** @returns {boolean} */
  isMicrophoneEnabled() {
    if (!this.micStream) return false;
    return this.micStream.getAudioTracks().some((track) => track.enabled);
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * fetch() that always rejects rather than hanging.
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} [timeoutMs]
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = CONNECT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`The request to ${new URL(url, location.href).pathname} timed out.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Did this error come from asking for a turn while one was already running?
 * @param {string} code
 * @param {string} message
 */
function isActiveResponseCollision(code, message) {
  if (code === 'conversation_already_has_active_response') return true;
  return /already has an active response/i.test(message);
}

/** Parse a JSON body without throwing on an empty or HTML response. */
async function readJson(response) {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 300) };
  }
}

/** @param {unknown} error */
function describeError(error) {
  if (!error) return 'unknown error';
  if (error instanceof Error) return error.message;
  return String(error);
}
