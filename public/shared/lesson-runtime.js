/**
 * shared/lesson-runtime.js
 *
 * Temporary state for the Skill that is active right now.
 *
 * Three rules from the Lesson Skills prompt shape this file:
 *
 *   PART 12 — this is NOT a memory system. Nothing here is written to disk.
 *             Observations are handed to the EXISTING memory extractor at the
 *             end of the call and merged into the ordinary vocabulary and
 *             weakness pools.
 *   PART 24 — there is no resume. Deactivating discards the state completely;
 *             starting the same lesson later begins fresh.
 *   PART 16 — nothing in here may ever touch `proficiency_level`. The runtime
 *             does not even hold a reference to it.
 *
 * Dependency-free: runs unchanged in Node and the browser.
 */

import { answersStep, asksSomething, buildScript, dropStep, fold, locateStep, looksLikeQuestion, mentionsStep, taughtSoFar, variantKeys } from './script.js';

/** Objective tracking states. */
export const OBJECTIVE_STATES = Object.freeze(['pending', 'partial', 'complete']);

/** How much of the progress estimate comes from objectives vs phases. */
const OBJECTIVE_WEIGHT = 0.65;
const PHASE_WEIGHT = 0.35;

/** A partially met objective counts for this much of a completed one. */
const PARTIAL_CREDIT = 0.5;

/**
 * Practise an item this many times and it is done. Set low on purpose: a
 * student who has produced a word correctly twice does not need a third,
 * a fourth and a fifth ask.
 */
export const SETTLED_AFTER_PRACTICES = 2;

/** Student turns with no reported progress before the tutor is prompted. */
export const STALE_AFTER_TURNS = 6;

/** Student turns in one phase before the tutor is told to move to the next one. */
export const LONG_PHASE_TURNS = 6;

/**
 * Student turns in one phase, with nothing reported, before the app advances
 * the phase ITSELF.
 *
 * The tutor is asked to drive the lesson and usually will. When it does not —
 * and a voice model in mid-conversation often does not — the lesson would
 * otherwise sit in its first phase forever, showing no progress, while the
 * student wonders whether anything is working. The app takes over rather than
 * asking again.
 */
export const AUTO_ADVANCE_TURNS = 10;

/**
 * A lesson that has started is not nothing. Reporting 0% for a lesson that is
 * visibly under way reads as a broken progress bar, so the floor is the honest
 * answer to "have we begun?".
 */
export const MIN_ACTIVE_PROGRESS = 5;

/** Vocabulary buckets the tutor may report during a lesson. */
const VOCAB_BUCKETS = Object.freeze([
  'introduced_vocab', 'practiced_vocab', 'struggled_vocab', 'successful_vocab',
]);

/** @param {unknown} value */
function clean(value) {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** @param {unknown} value @returns {string[]} */
function cleanList(value) {
  if (typeof value === 'string') return clean(value) ? [clean(value)] : [];
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const item = clean(entry);
    if (item) out.push(item);
  }
  return out;
}

/**
 * The lesson currently in progress.
 *
 * A single instance lives for the lifetime of the page; `activate()` and
 * `deactivate()` swap what it is holding.
 */
export class LessonRuntime {
  /**
   * @param {{onChange?: (snapshot: any) => void, now?: () => string}} [options]
   */
  constructor({ onChange = null, now = () => new Date().toISOString() } = {}) {
    this.onChange = onChange;
    this.now = now;
    this.reset();
  }

  /** Back to "no active lesson". Also the constructor's initial state. */
  reset() {
    /** @type {Record<string, any>|null} */
    this.skill = null;
    /** @type {string} */
    this.phaseId = '';
    /** @type {Record<string, string>} */
    this.objectiveStates = {};
    /** @type {Record<string, any>} */
    this.inputValues = {};
    /** @type {Record<string, string>} */
    this.inputSources = {};
    /** @type {Record<string, string[]>} */
    this.vocab = { introduced_vocab: [], practiced_vocab: [], struggled_vocab: [], successful_vocab: [] };
    /** @type {{at: string, event: string, detail: string}[]} */
    this.log = [];
    /**
     * Student turns since the lesson started, and since the current phase
     * began. These are the only measure of pace that does not depend on the
     * tutor volunteering anything: the transcript supplies them whether or not
     * the model ever calls a tool, which is what makes it possible to notice a
     * lesson going round in circles.
     */
    this.turnsInLesson = 0;
    this.turnsInPhase = 0;
    /**
     * Student turns at the last piece of real PROGRESS: an objective changing
     * state, or the phase moving.
     *
     * Vocabulary deliberately does not count. The Director notes vocabulary on
     * almost every pass — that is its job, and it says nothing about whether
     * the lesson is advancing. Letting it reset this clock meant the clock
     * never ran, so the lesson never noticed it was stuck: one session sat in
     * a single phase for fifty-four turns, asking for the same four words,
     * while both the staleness nudge and the automatic phase advance sat behind
     * a counter that was reset every few seconds.
     */
    this.turnsAtLastReport = 0;
    /** How many times each item has been reported as practised. */
    /** @type {Record<string, number>} */
    this.practiceCounts = {};
    this.resetScripts();
    /** @type {string[]} */
    this.notes = [];
    this.completed = false;
    this.startedAt = '';
    this.endedAt = '';
    /** @type {string} */
    this.endReason = '';
    /** Kept after deactivation so end-of-call memory still sees the lesson. */
    /** @type {any[]} */
    this.finishedLessons = this.finishedLessons || [];
    /**
     * What every lesson on this call taught, and how often each thing was
     * missed. A lesson's own record is wiped when it ends; a drill later in
     * the call is made from this, misses first.
     */
    /** @type {{say: string, meaning: string, script?: string}[]} */
    this.callTaught = this.callTaught || [];
    /** @type {Map<string, number>} */
    this.callMissed = this.callMissed || new Map();
  }

  /** @returns {boolean} */
  get isActive() {
    return Boolean(this.skill) && !this.completed;
  }

  /** @returns {string} */
  get skillId() {
    return this.skill ? this.skill.id : '';
  }

  /** Notify the host that something changed. */
  emit() {
    if (typeof this.onChange === 'function') {
      try {
        this.onChange(this.snapshot());
      } catch {
        /* a listener must never be able to break the lesson */
      }
    }
  }

  /** @param {string} event @param {string} detail */
  record(event, detail = '') {
    this.log.push({ at: this.now(), event, detail: clean(detail) });
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
  }

  // -- Activation -----------------------------------------------------------

  /**
   * Make `skill` the active lesson.
   *
   * Idempotent: activating the Skill that is already running is a no-op, which
   * is what stops a UI selection and a voice request from double-starting the
   * same lesson (PART 22).
   *
   * @param {Record<string, any>|null|undefined} skill a validated Skill
   * @param {{reason?: string}} [options]
   * @returns {{ok: boolean, changed: boolean, error: string|null}}
   */
  activate(skill, { reason = 'ui' } = {}) {
    if (!skill || typeof skill !== 'object' || !skill.id) {
      // PART 51: a failed activation leaves no half-active lesson behind.
      this.deactivate({ reason: 'failed' });
      return { ok: false, changed: false, error: 'That lesson could not be loaded.' };
    }

    if (this.isActive && this.skill && this.skill.id === skill.id) {
      return { ok: true, changed: false, error: null };
    }

    // PART 18: exactly one Skill at a time. Starting a new one retires the old.
    if (this.skill) this.deactivate({ reason: 'replaced', silent: true });

    this.skill = skill;
    this.startedAt = this.now();
    this.phaseId = skill.phases.length ? skill.phases[0].id : '';
    this.objectiveStates = {};
    for (const objective of skill.objectives) {
      this.objectiveStates[objective.id] = 'pending';
    }
    this.inputValues = {};
    this.inputSources = {};
    for (const input of skill.runtime_inputs) {
      if (input.default !== null && input.default !== undefined) {
        this.inputValues[input.id] = input.default;
        this.inputSources[input.id] = 'default';
      }
    }
    this.vocab = { introduced_vocab: [], practiced_vocab: [], struggled_vocab: [], successful_vocab: [] };
    this.practiceCounts = {};
    this.resetScripts();
    this.turnsInLesson = 0;
    this.turnsInPhase = 0;
    this.turnsAtLastReport = 0;
    this.notes = [];
    this.completed = false;
    this.endedAt = '';
    this.endReason = '';
    this.record('activated', `${skill.name} (${reason})`);
    this.emit();
    return { ok: true, changed: true, error: null };
  }

  /**
   * End the active lesson and discard its state (PART 23, PART 24, PART 44).
   *
   * The observations gathered are moved to `finishedLessons` so the end-of-call
   * memory extraction can still see them; nothing is written to disk here.
   *
   * @param {{reason?: string, silent?: boolean}} [options]
   */
  deactivate({ reason = 'stopped', silent = false } = {}) {
    if (!this.skill) {
      if (!silent) this.emit();
      return { ok: true, changed: false };
    }

    this.endedAt = this.now();
    this.endReason = reason;
    this.record('deactivated', reason);
    this.finishedLessons.push(this.transcriptSummary());
    this.keepForCall();

    const skill = this.skill;
    this.skill = null;
    this.phaseId = '';
    this.objectiveStates = {};
    this.inputValues = {};
    this.inputSources = {};
    this.vocab = { introduced_vocab: [], practiced_vocab: [], struggled_vocab: [], successful_vocab: [] };
    this.resetScripts();
    this.notes = [];
    this.completed = false;
    this.log = [];

    if (!silent) this.emit();
    return { ok: true, changed: true, skillId: skill.id };
  }

  /**
   * The lesson met its objectives (PART 25). Completion returns the tutor to
   * normal conversation but does NOT end the call (PART 26) — that is the
   * caller's business, and the caller does nothing.
   * @param {{summary?: string}} [options]
   */
  complete({ summary = '' } = {}) {
    if (!this.skill) return { ok: false, changed: false };
    if (summary) this.notes.push(clean(summary));
    this.completed = true;
    this.record('completed', summary);
    const skillId = this.skill.id;
    const skillName = this.skill.name;
    this.deactivate({ reason: 'completed' });
    return { ok: true, changed: true, skillId, skillName };
  }

  // -- Runtime inputs (PART 8, PART 9) --------------------------------------

  /**
   * @param {string} inputId
   * @param {unknown} value
   * @param {string} [source] 'user' | 'tutor' | 'default'
   */
  setInput(inputId, value, source = 'user') {
    if (!this.skill) return { ok: false, error: 'No lesson is active.' };
    const id = clean(inputId);
    const definition = this.skill.runtime_inputs.find((entry) => entry.id === id);
    if (!definition) {
      return { ok: false, error: `This lesson has no input called "${id}".` };
    }

    let stored = value;
    if (definition.type === 'number') {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return { ok: false, error: `"${definition.name}" expects a number.` };
      stored = numeric;
    } else if (definition.type === 'boolean') {
      stored = value === true || value === 'true' || value === 'yes';
    } else if (definition.type === 'multiselect') {
      stored = cleanList(value);
      const unknown = stored.filter((entry) => !definition.options.includes(entry));
      if (unknown.length) {
        return {
          ok: false,
          error: `"${definition.name}" does not offer ${unknown.join(', ')}. Choose from: ${definition.options.join(', ')}.`,
        };
      }
    } else {
      stored = clean(value);
      if (!stored) return { ok: false, error: `"${definition.name}" cannot be empty.` };
      if (definition.type === 'select' && !definition.options.includes(stored)) {
        return {
          ok: false,
          error: `"${definition.name}" does not offer "${stored}". Choose from: ${definition.options.join(', ')}.`,
        };
      }
    }

    this.inputValues[id] = stored;
    this.inputSources[id] = ['user', 'tutor', 'default'].includes(source) ? source : 'user';
    this.record('input', `${id} = ${Array.isArray(stored) ? stored.join(', ') : stored} (${this.inputSources[id]})`);
    this.emit();
    return { ok: true, error: null };
  }

  /** Required inputs that still have no value. */
  pendingInputs() {
    if (!this.skill) return [];
    return this.skill.runtime_inputs.filter(
      (entry) => entry.required && this.inputValues[entry.id] === undefined,
    );
  }

  // -- Phases (PART 13, PART 14) --------------------------------------------

  /** @returns {Record<string, any>|null} */
  currentPhase() {
    if (!this.skill || !this.phaseId) return null;
    return this.skill.phases.find((entry) => entry.id === this.phaseId) || null;
  }

  // -- Scripts --------------------------------------------------------------
  //
  // A part of a lesson is run from a script built out of a plan (see
  // shared/script.js). The runtime holds the plan, the steps, and how far the
  // tutor has got — read off what it actually says, not what a second model
  // believes happened.

  /** Forget every plan and script. Part of starting, stopping and resetting. */
  resetScripts() {
    /** Plans by key — a part's id plus the subject it was written for. */
    /** @type {Record<string, any>} */
    this.plans = {};
    /** @type {Record<string, any[]>} */
    this.scripts = {};
    /** Index of the step most recently asked, per part. -1 before the first. */
    /** @type {Record<string, number>} */
    this.cursors = {};
    /** Parts whose script has been walked to the end. */
    /** @type {Record<string, boolean>} */
    this.finishedParts = {};
    /** Everything taught so far this lesson, for review and role-play. */
    /** @type {{say: string, meaning: string}[]} */
    this.taught = [];
    /** Student turns since the script last moved. */
    this.turnsAtStep = 0;
    /**
     * Tutor turns since the script last moved that did not say its next line.
     * One is a correction or an answered question. Two and the tutor is simply
     * told to say the line. Four and the line is taken out of the script.
     */
    this.misses = 0;
    /** The student's last answer certainly contained what the step asked for. */
    this.lastAnswerRight = false;
    /** Things the student has asked for in their own words, newest last. */
    /** @type {string[]} */
    this.requests = [];
    /** What the student has got right at least once, by its folded phrase. */
    /** @type {Set<string>} */
    this.got = new Set();
    /**
     * What they have missed, or had to be given, and not got unaided since —
     * with how many times, so the worst comes back first.
     * @type {Map<string, number>}
     */
    this.fumbled = new Map();
    /** Every miss on this call, by folded phrase. Never taken back: the review asks for the worst first. */
    /** @type {Map<string, number>} */
    this.missed = new Map();
    /** How many times each thing has been got right on this call. */
    /** @type {Map<string, number>} */
    this.rights = new Map();
    /** How many times each thing's answer has had to be given to them. */
    /** @type {Map<string, number>} */
    this.told = new Map();
    /**
     * What has had to be given to them twice. It is not asked for again on
     * this call: "hourensou" was asked for seven times in one lesson, and
     * "toumorokoshi" six.
     * @type {Set<string>}
     */
    this.parked = new Set();
    /** What has already been brought back from an earlier part once. */
    /** @type {Set<string>} */
    this.carriedOnce = new Set();
    /** Parts passed over on the way to one the student asked for, to come back to. */
    /** @type {string[]} */
    this.revisit = [];
    /** Every part this lesson has been in. */
    /** @type {Set<string>} */
    this.visited = new Set();
    /** Parts whose material is being written right now. */
    /** @type {Set<string>} */
    this.planning = new Set();

    /** How many times each part's material has been thrown away. */
    /** @type {Record<string, number>} */
    this.planEpochs = {};
  }

  /** What the student chose to work on, as one line. Part of a plan's identity. */
  subject() {
    return Object.values(this.inputValues)
      .map((value) => (Array.isArray(value) ? value.join(', ') : String(value ?? '')))
      .map((value) => clean(value))
      .filter(Boolean)
      .join('; ');
  }

  /** @param {string} [phaseId] */
  planKey(phaseId = this.phaseId) {
    // The last field changes when the student asks for something after a
    // part's material was written, so that material written before the
    // request — or still being written — is not used.
    return `${phaseId}|${this.subject().toLowerCase()}|${this.planEpochs[phaseId] || 0}`;
  }

  /** How much of a role-play this part has: 'full', 'single' (one exchange) or 'none'. */
  rolePlay(phaseId = this.phaseId) {
    const phase = this.skill ? this.skill.phases.find((entry) => entry.id === phaseId) : null;
    return (phase && phase.role_play) || 'full';
  }

  /** What they plainly have: right twice or more on this call, and never missed. */
  sureOf() {
    const out = new Set();
    for (const [key, count] of this.rights) if (count >= 2 && !this.missed.has(key)) out.add(key);
    return out;
  }

  /** What a script is built with, beyond its plan: how the call has gone. */
  scriptOptions(phaseId) {
    return {
      round: this.quickRound(phaseId),
      scene: this.rolePlay(phaseId),
      // A drill asks for the call's most-missed words first, from any lesson.
      fumbled: this.phaseMode(phaseId) === 'drill' ? this.callMisses() : this.missed,
      parked: this.parked,
      sure: this.sureOf(),
    };
  }

  /** Is the part in progress the last there is to do? */
  isLastPart() {
    const phases = this.skill ? this.skill.phases : [];
    if (!phases.length || this.revisit.length) return false;
    return phases[phases.length - 1].id === this.phaseId;
  }

  /** Does this part close on a quick round of what it taught? */
  quickRound(phaseId = this.phaseId) {
    const phase = this.skill ? this.skill.phases.find((entry) => entry.id === phaseId) : null;
    return Boolean(phase && phase.quick_round);
  }

  /** How a part is run: 'teach', 'roleplay', 'review' or 'talk'. */
  phaseMode(phaseId = this.phaseId) {
    const phase = this.skill ? this.skill.phases.find((entry) => entry.id === phaseId) : null;
    return (phase && phase.mode) || 'teach';
  }

  /**
   * Does this part still need its material written?
   * Not while the lesson is waiting on something from the student: a plan
   * written before the subject is known is a plan for the wrong subject.
   * @param {string} [phaseId]
   */
  needsPlan(phaseId = this.phaseId) {
    if (!this.isActive || !phaseId) return false;
    const mode = this.phaseMode(phaseId);
    if (mode !== 'teach' && mode !== 'roleplay' && mode !== 'drill') return false;
    if (this.pendingInputs().length) return false;
    return !this.plans[this.planKey(phaseId)];
  }

  /**
   * Hand a part its material. The script is built at once.
   * @param {string} phaseId
   * @param {any} plan a sanitised plan
   * @param {string} [key] the key it was requested under; a plan that arrives
   *        after the subject changed is discarded
   */
  setPlan(phaseId, plan, key = this.planKey(phaseId)) {
    if (!this.skill || !plan) return { ok: false, changed: false };
    if (key !== this.planKey(phaseId)) return { ok: false, changed: false };
    this.plans[key] = plan;
    this.scripts[phaseId] = buildScript(plan, {
      mode: this.phaseMode(phaseId), taught: this.taught, notes: this.notesSaid(phaseId), ...this.scriptOptions(phaseId),
    });
    this.cursors[phaseId] = -1;
    this.record('plan', `${phaseId}: ${this.scripts[phaseId].length} steps`);
    this.emit();
    return { ok: true, changed: true };
  }

  /** The steps for the current part, building a review script on demand. */
  currentScript() {
    if (!this.skill || !this.phaseId) return [];
    if (!this.scripts[this.phaseId] && this.phaseMode() === 'review' && this.taught.length) {
      this.scripts[this.phaseId] = buildScript(null, { mode: 'review', taught: this.taught, ...this.scriptOptions(this.phaseId) });
      this.cursors[this.phaseId] = -1;
    }
    return this.scripts[this.phaseId] || [];
  }

  /**
   * The tutor just said something. Work out which step that was.
   *
   * The place moves only when the tutor's own words are the next line. When
   * they are not, nothing is assumed: the turn is counted, and what the tutor
   * is shown next gets firmer — first "do not ask again", then "your whole
   * turn is the line", and if even that fails the line is taken out of the
   * script, so that the record of what was last asked stays true.
   *
   * @param {string} text
   * @returns {{moved: boolean, complete: boolean, current: number, total: number,
   *            offScript?: boolean, falseCorrection?: boolean, dropped?: any[], gaveUp?: boolean, misses?: number}}
   */
  noteTutorTurn(text) {
    const steps = this.currentScript();
    const before = this.cursors[this.phaseId] ?? -1;
    if (!steps.length || this.finishedParts[this.phaseId]) {
      return { moved: false, complete: false, current: before, total: steps.length };
    }

    const at = locateStep(steps, text, before);
    if (at <= before) {
      this.misses += 1;
      // About the thing it last asked — a correction, a repeat — or about
      // something else? Asking for something else is the tutor improvising.
      const onTopic = before >= 0 && mentionsStep(steps[before], text);
      const offScript = !onTopic && asksSomething(text);
      // The answer was certainly right and the tutor did not go on.
      const falseCorrection = this.lastAnswerRight;
      if (offScript || falseCorrection) this.misses = Math.max(this.misses, 2);
      this.lastAnswerRight = false;

      /** @type {any[]} */
      let dropped = [];
      let gaveUp = false;
      if (this.misses >= 4) {
        const next = steps[before + 1];
        if (next && next.kind !== 'wrap') {
          dropped = dropStep(steps, before + 1);
          this.misses = 2;
        } else {
          // Only the closing line is left and it will not be said. The part
          // is over all the same.
          gaveUp = true;
          this.finishedParts[this.phaseId] = true;
          this.misses = 0;
        }
        this.emit();
      }
      return {
        moved: false, complete: false, current: before, total: steps.length,
        offScript, falseCorrection, dropped, gaveUp, misses: this.misses,
      };
    }

    return this.moveTo(at);
  }

  /**
   * The tutor has said the line for step `at`. Record it.
   * @param {number} at
   * @returns {{moved: boolean, complete: boolean, current: number, total: number}}
   */
  moveTo(at) {
    const steps = this.currentScript();
    const before = this.cursors[this.phaseId] ?? -1;
    if (!steps.length || at <= before || at >= steps.length) {
      return { moved: false, complete: false, current: before, total: steps.length };
    }
    this.cursors[this.phaseId] = at;
    this.turnsAtStep = 0;
    this.misses = 0;
    this.lastAnswerRight = false;
    // A script moving forward is progress. Without this the automatic advance,
    // which watches for ten turns with none, would cut a twelve-step script
    // off before it finished.
    this.turnsAtLastReport = this.turnsInLesson;
    // Anything the script has now got past teaching is material for later.
    // Every step up to here was said — the place only moves on the tutor's
    // own words — so nothing is credited that the student never heard.
    const known = new Set(this.taught.map((item) => fold(item.say)));
    for (const item of taughtSoFar(steps, at)) {
      if (!known.has(fold(item.say))) this.taught.push(item);
    }
    const complete = at === steps.length - 1 && steps[at].kind === 'wrap';
    if (complete) this.finishedParts[this.phaseId] = true;
    this.emit();
    return { moved: true, complete, current: at, total: steps.length };
  }

  /**
   * The student got this step right. The closing line of a part only claims
   * what they managed at least once: "you can now say cabbage" was said to a
   * student one turn after their second miss on it.
   * @param {any} step
   * @param {string} [said] what they said, when it was a fitting reply other than the planned one
   */
  noteRight(step, said = '') {
    if (!step) return;
    const phrase = said || (step.kind === 'scene' ? step.expect : step.say);
    if (!phrase) return;
    this.got.add(fold(phrase));
    this.fumbled.delete(fold(phrase));
    this.rights.set(fold(phrase), (this.rights.get(fold(phrase)) || 0) + 1);
  }

  /**
   * The student missed this step, or had to be given its answer.
   * @param {any} step
   */
  noteFumble(step) {
    if (!step) return;
    const phrase = step.kind === 'scene' ? step.expect : step.say;
    if (!phrase) return;
    this.fumbled.set(fold(phrase), (this.fumbled.get(fold(phrase)) || 0) + 1);
    this.missed.set(fold(phrase), (this.missed.get(fold(phrase)) || 0) + 1);
  }

  /**
   * The answer to this step had to be given to them. The second time that
   * happens for the same thing, it is let go: it is not asked for again on
   * this call, and what is still waiting to ask for it is taken out.
   * @param {any} step
   * @returns {boolean} whether it has just been let go
   */
  noteTold(step) {
    const phrase = step ? (step.kind === 'scene' ? step.expect : step.say) : '';
    const key = fold(phrase);
    if (!key) return false;
    const count = (this.told.get(key) || 0) + 1;
    this.told.set(key, count);
    if (count < 2 || this.parked.has(key)) return false;
    this.parked.add(key);
    for (const [phaseId, steps] of Object.entries(this.scripts)) {
      // Not the step being answered, nor the one about to be asked: its line
      // is already on its way.
      const from = (this.cursors[phaseId] ?? -1) + 2;
      for (let index = steps.length - 1; index >= from; index -= 1) {
        const entry = steps[index];
        if (!(entry.quick || entry.carried) || entry.kind !== 'recall' || fold(entry.say) !== key) continue;
        steps.splice(index, 1);
        // The round still opens as one.
        if (entry.first && steps[index] && steps[index].quick) steps[index].first = true;
      }
    }
    this.emit();
    return true;
  }

  /**
   * How the call stands, so that a reply which was never heard can be taken
   * back: the student was still speaking, and what they went on to say is
   * answered together with what they had said.
   */
  mark() {
    this.currentScript();
    return {
      phase: this.phaseId,
      // Every part's script: letting a word go takes steps out of later parts too.
      scripts: Object.fromEntries(Object.entries(this.scripts).map(([id, steps]) => [id, steps.map((step) => ({ ...step }))])),
      got: new Set(this.got),
      fumbled: new Map(this.fumbled),
      missed: new Map(this.missed),
      rights: new Map(this.rights),
      told: new Map(this.told),
      parked: new Set(this.parked),
      carriedOnce: new Set(this.carriedOnce),
    };
  }

  /** @param {ReturnType<LessonRuntime['mark']>} state @returns {boolean} whether it could be put back */
  restore(state) {
    if (!state || state.phase !== this.phaseId) return false;
    for (const [id, saved] of Object.entries(state.scripts)) {
      const steps = this.scripts[id];
      if (steps) steps.splice(0, steps.length, ...saved);
    }
    this.got = state.got;
    this.fumbled = state.fumbled;
    this.missed = state.missed;
    this.rights = state.rights;
    this.told = state.told;
    this.parked = state.parked;
    this.carriedOnce = state.carriedOnce;
    this.emit();
    return true;
  }

  /**
   * Bring the closing line of the part in progress into line with what
   * happened: what they can say, and what they missed and have not yet got
   * right unaided.
   */
  refreshWrap() {
    const steps = this.currentScript();
    const wrap = steps.find((step) => step.kind === 'wrap');
    if (!wrap) return;
    wrap.final = this.isLastPart();
    if (wrap.allKnown) return;
    if (wrap.drill) {
      // Right first time, out of everything asked; and the worst misses, to look at again.
      const asked = new Map();
      for (const step of steps) if (step.kind === 'recall' && !step.again && !asked.has(fold(step.say))) asked.set(fold(step.say), step);
      const missed = [...asked.entries()].filter(([key]) => this.missed.has(key) || this.parked.has(key));
      wrap.firstTry = asked.size - missed.length;
      wrap.missed = missed
        .sort((a, b) => (this.missed.get(b[0]) || 0) - (this.missed.get(a[0]) || 0))
        .slice(0, 3)
        .map(([, step]) => ({ say: step.say, meaning: step.meaning }));
      return;
    }
    if (wrap.review) {
      // What is still to get, out of everything the review went through:
      // missed and not got since, or let go.
      const listed = new Set();
      const still = [];
      const mine = [...this.got].map((phrase) => ` ${phrase} `);
      const have = (key) => variantKeys(key).some((form) => mine.some((phrase) => phrase.includes(` ${form} `)));
      for (const step of steps) {
        if (step.kind !== 'recall' && step.kind !== 'teach') continue;
        const key = fold(step.say);
        if (!key || listed.has(key)) continue;
        listed.add(key);
        if (this.parked.has(key) || (this.fumbled.has(key) && !have(key))) still.push({ say: step.say, meaning: step.meaning });
      }
      wrap.missed = still.slice(0, 3);
      return;
    }
    const seen = new Set();
    const items = [];
    const missed = [];
    // A word is theirs once they have said something with it in: "Still to
    // get: gyuuniku" came straight after "you can now say: beef, please".
    // (In either wording of it: "… o kudasai" is "… o onegaishimasu".)
    const got = [...this.got].map((phrase) => ` ${phrase} `);
    const has = (key) => variantKeys(key).some((form) => got.some((phrase) => phrase.includes(` ${form} `)));
    for (const step of steps) {
      if (step.carried || step.wordOnly || step.quick || (step.kind !== 'teach' && step.kind !== 'recall' && step.kind !== 'recognise')) continue;
      const key = fold(step.say);
      if (seen.has(key)) continue;
      seen.add(key);
      // Missed, and never produced unaided at any point: that is what is
      // still to get. Something they got once and slipped on later is theirs.
      if (this.fumbled.has(key) && !has(key)) missed.push({ say: step.say, meaning: step.meaning });
      else items.push(step.meaning);
    }
    // A part with nothing of its own to teach (a role-play) keeps its list.
    if (!seen.size) return;
    wrap.items = items;
    wrap.missed = missed;
  }

  /**
   * At the start of a part: choose what is brought back from earlier.
   *
   * What they missed most comes first — "futari desu", failed four times, was
   * never heard of again while "excuse me", which they had, came back twice.
   * Nothing they already knew before the call, nothing twice ("How do you say
   * 47?" three times), and if there is nothing worth bringing back, nothing.
   */
  applyCarry() {
    const steps = this.currentScript();
    const slots = steps.filter((step) => step.carried);
    if (!slots.length) return;
    const own = new Set(steps.filter((step) => !step.carried && step.say).map((step) => fold(step.say)));
    // (Not what was let go after two misses: that is not asked for again.)
    const eligible = this.taught.filter((item) => !item.known && !own.has(fold(item.say)) && !this.parked.has(fold(item.say)));
    // Missed first, most-missed first, oldest first among equals; then what
    // has not been back yet, most recent first.
    const missed = eligible
      .map((item, index) => ({ item, index, count: this.fumbled.get(fold(item.say)) || 0 }))
      .filter((entry) => entry.count > 0)
      .sort((x, y) => y.count - x.count || x.index - y.index)
      .map((entry) => entry.item);
    const fresh = [...eligible].reverse().filter((item) => !this.fumbled.has(fold(item.say)) && !this.carriedOnce.has(fold(item.say)));
    const picks = [...missed, ...fresh.slice(0, 1)];

    for (const slot of slots) {
      const pick = picks.shift();
      if (!pick) {
        steps.splice(steps.indexOf(slot), 1);
        continue;
      }
      this.carriedOnce.add(fold(pick.say));
      slot.say = pick.say;
      slot.meaning = pick.meaning;
      slot.use = pick.use || '';
      slot.script = pick.script || '';
      slot.reply = pick.use && pick.reply ? pick.reply : '';
      slot.replyMeaning = pick.use && pick.reply ? pick.replyMeaning || '' : '';
    }
    this.emit();
  }

  /**
   * The student asked to go straight to a later part. The parts in between
   * that they did not say they knew are kept, to come back to afterwards.
   * @param {string} leaving the part they asked to leave: taken as known
   * @param {string} target the part they asked for
   * @param {{including?: boolean}} [options] keep the part being left as well:
   *        it had not begun, so nothing says they know it
   */
  passOver(leaving, target, { including = false } = {}) {
    const phases = this.skill ? this.skill.phases : [];
    const from = phases.findIndex((phase) => phase.id === leaving);
    const to = phases.findIndex((phase) => phase.id === target);
    for (const phase of phases.slice(including ? from : from + 1, Math.max(from + 1, to))) {
      const mode = phase.mode || 'teach';
      if (mode !== 'teach' || this.finishedParts[phase.id] || this.revisit.includes(phase.id)) continue;
      this.revisit.push(phase.id);
    }
  }

  /**
   * Go through a part again, because the student asked to.
   *
   * Not the same pass twice: what they produced unaided the first time is
   * asked for, and only what they missed is taught again.
   *
   * @param {string} phaseId
   * @returns {boolean} whether there was material to go through
   */
  redoPart(phaseId) {
    const plan = this.plans[this.planKey(phaseId)];
    if (!this.skill || !plan || !Array.isArray(plan.items) || !plan.items.length) return false;
    const own = new Set(plan.items.map((item) => fold(item.say)));
    const second = {
      ...plan,
      items: plan.items.map((item) => {
        const key = fold(item.say);
        return { ...item, known: item.known === true || (this.got.has(key) && !this.fumbled.has(key)) };
      }),
    };
    this.scripts[phaseId] = buildScript(second, {
      mode: this.phaseMode(phaseId),
      taught: this.taught.filter((item) => !own.has(fold(item.say))),
      notes: this.notesSaid(phaseId),
      ...this.scriptOptions(phaseId),
    });
    this.cursors[phaseId] = -1;
    delete this.finishedParts[phaseId];
    this.setPhase(phaseId, 'the student asked to go back');
    this.misses = 0;
    this.record('redo', phaseId);
    this.emit();
    return true;
  }

  /**
   * A part is being left for an earlier one. It starts afresh when the lesson
   * comes back to it.
   * @param {string} phaseId
   */
  shelve(phaseId) {
    if (this.finishedParts[phaseId] || (this.cursors[phaseId] ?? -1) < 0) return;
    const plan = this.plans[this.planKey(phaseId)];
    if (plan) {
      const own = new Set(plan.items.map((item) => fold(item.say)));
      this.scripts[phaseId] = buildScript(plan, {
        mode: this.phaseMode(phaseId),
        taught: this.taught.filter((item) => !own.has(fold(item.say))),
        notes: this.notesSaid(phaseId),
        round: this.quickRound(phaseId),
      });
    }
    this.cursors[phaseId] = -1;
    this.emit();
  }

  /** The latest part, in the lesson's own order, that it has been in. */
  furthestPhase() {
    const phases = this.skill ? this.skill.phases : [];
    let furthest = '';
    for (const phase of phases) if (this.visited.has(phase.id)) furthest = phase.id;
    return furthest || this.phaseId;
  }

  /** The step last asked was corrected, and is being asked for once more. */
  noteRetry() {
    this.misses += 1;
    return this.misses;
  }

  /**
   * The student answered. Was it, beyond doubt, what the current step asked for?
   *
   * Only ever a "yes" or a "could not tell": a transcript is not the audio, so
   * it is never used to call an answer wrong. A "yes" lets the app notice when
   * the tutor then corrects it anyway. A question is not an answer, even when
   * it has the word in it ("did I say ebi right?").
   *
   * @param {string} text the student's words, in the script the tutor uses
   * @returns {boolean}
   */
  noteStudentAnswer(text) {
    const steps = this.currentScript();
    const current = this.cursors[this.phaseId] ?? -1;
    this.turnsAtStep += 1;
    this.lastAnswerRight = current >= 0 && !looksLikeQuestion(text) && answersStep(steps[current], text);
    return this.lastAnswerRight;
  }

  /**
   * Keep something the student asked for, in their own words, so that the
   * parts still to come can be written around it. Material already written
   * for parts that have not started is thrown away: it was written before
   * they asked.
   *
   * @param {string} text
   * @returns {boolean} whether it was new
   */
  addRequest(text) {
    const request = clean(text).slice(0, 200);
    if (!request || !this.skill) return false;
    if (this.requests.includes(request)) return false;
    this.requests.push(request);
    if (this.requests.length > 4) this.requests.splice(0, this.requests.length - 4);
    for (const phase of this.skill.phases) {
      if (phase.id === this.phaseId || this.finishedParts[phase.id]) continue;
      if ((this.cursors[phase.id] ?? -1) >= 0) continue;
      delete this.scripts[phase.id];
      delete this.cursors[phase.id];
      for (const key of Object.keys(this.plans)) {
        if (key.startsWith(`${phase.id}|`)) delete this.plans[key];
      }
      this.planEpochs[phase.id] = (this.planEpochs[phase.id] || 0) + 1;
    }
    return true;
  }

  /**
   * The student asked to leave this part behind. It ends here, without its
   * closing line.
   * @returns {boolean} whether there was a part to end
   */
  abandonPart() {
    if (!this.scriptRunning()) return false;
    // What they said they already know is not brought back to be asked again
    // — except what they actually missed, which they evidently do not.
    const theirs = new Set(this.currentScript().filter((step) => !step.carried && step.say).map((step) => fold(step.say)));
    this.taught = this.taught.filter((item) => !theirs.has(fold(item.say)) || this.fumbled.has(fold(item.say)));
    this.finishedParts[this.phaseId] = true;
    this.misses = 0;
    this.lastAnswerRight = false;
    this.turnsAtLastReport = this.turnsInLesson;
    this.record('skip', `${this.phaseId}: the student asked to move on`);
    this.emit();
    return true;
  }

  /**
   * Everything this lesson has taught or is about to: what is behind the
   * cursor, plus every item in every script already written. A part planned
   * ahead of time must not re-teach what the part before it is still teaching.
   * @returns {{say: string, meaning: string}[]}
   */
  plannedItems() {
    const out = this.taught.map((item) => ({ ...item }));
    const seen = new Set(out.map((item) => fold(item.say)));
    for (const steps of Object.values(this.scripts)) {
      for (const step of steps) {
        if (step.kind !== 'teach' && step.kind !== 'recall') continue;
        const key = fold(step.say);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ say: step.say, meaning: step.meaning, script: step.script || '' });
      }
    }
    return out;
  }

  /**
   * What the microphone is about to hear, most likely first: the words of the
   * part in progress, then of the parts already written, then what has been
   * taught. For the transcriber, which is told what to expect.
   * @returns {{say: string, meaning: string, script: string}[]}
   */
  hintItems() {
    const out = [];
    const seen = new Set();
    const add = (say, meaning, script) => {
      const key = fold(say);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push({ say, meaning: meaning || '', script: script || '' });
    };
    const fromSteps = (steps) => {
      for (const step of steps || []) {
        if (step.kind === 'scene') add(step.expect, step.cue, step.script);
        else if (step.kind === 'teach' || step.kind === 'recall') add(step.say, step.meaning, step.script);
      }
    };
    fromSteps(this.scripts[this.phaseId]);
    for (const [id, steps] of Object.entries(this.scripts)) if (id !== this.phaseId && !this.finishedParts[id]) fromSteps(steps);
    for (const item of [...this.taught].reverse()) add(item.say, item.meaning, item.script);
    return out;
  }

  /**
   * Every clause of a note in the other parts' scripts, so that "niku is
   * meat" is said with the first meat and not with each one after.
   * @param {string} except the part being written
   * @returns {Set<string>}
   */
  notesSaid(except) {
    const out = new Set();
    for (const [id, steps] of Object.entries(this.scripts)) {
      if (id === except) continue;
      for (const step of steps) {
        if (step.kind !== 'teach' || !step.note) continue;
        for (const clause of String(step.note).replace(/[.!\s]+$/, '').split(/\s*[,;.]\s+/)) {
          out.add(fold(clause));
          // And the word it explains, however the explaining is put: "niku is
          // meat" in one part, "niku means meat" in the next.
          const head = /^(\S+) (?:is|means|shows|marks|makes)\b/i.exec(clause.trim());
          if (head) out.add(`head:${fold(head[1])}`);
        }
      }
    }
    return out;
  }

  /**
   * What the other person has already said in this lesson's role-plays, so
   * that the next one does not open on the same line again.
   * @returns {string[]}
   */
  sceneLinesUsed() {
    const out = [];
    for (const steps of Object.values(this.scripts)) {
      for (const step of steps) {
        if (step.kind === 'scene' && step.tutor && !out.includes(step.tutor)) out.push(step.tutor);
      }
    }
    return out;
  }

  /** True while the part in progress has a script it has not finished. */
  scriptRunning() {
    return this.currentScript().length > 0 && !this.finishedParts[this.phaseId];
  }

  /**
   * A part's script has been walked to the end: credit what it was for.
   * @returns {number} how many objectives changed
   */
  creditCurrentPhase() {
    const phase = this.currentPhase();
    if (!phase) return 0;
    let changed = 0;
    for (const id of phase.objectives || []) {
      if (this.setObjective(id, 'complete').changed) changed += 1;
    }
    return changed;
  }

  /**
   * Move to a phase. Any phase is reachable from any other: the tutor may
   * advance, repeat, skip, or return to an earlier phase when there is a
   * pedagogical reason (PART 13).
   * @param {string} phaseId
   * @param {string} [reason]
   */
  setPhase(phaseId, reason = '') {
    if (!this.skill) return { ok: false, error: 'No lesson is active.' };
    const id = clean(phaseId);
    if (!this.skill.phases.some((entry) => entry.id === id)) {
      return { ok: false, error: `This lesson has no phase called "${id}".` };
    }
    if (id === this.phaseId) return { ok: true, error: null, changed: false };
    this.phaseId = id;
    this.visited.add(id);
    this.revisit = this.revisit.filter((entry) => entry !== id);
    this.turnsInPhase = 0;
    this.misses = 0;
    this.lastAnswerRight = false;
    this.turnsAtLastReport = this.turnsInLesson;
    this.record('phase', `${id}${reason ? ` — ${reason}` : ''}`);
    this.emit();
    return { ok: true, error: null, changed: true };
  }

  /**
   * The student just finished speaking.
   *
   * Counting turns is what lets the lesson notice it is going nowhere. Nothing
   * about this is written to disk, and it is not a timer: a phase that takes
   * twenty turns because the student is engaged is fine, one that takes twenty
   * turns on the same four words is not.
   *
   * @returns {{turnsInPhase: number, turnsInLesson: number, stale: boolean}}
   */
  noteStudentTurn() {
    if (!this.skill) return { turnsInPhase: 0, turnsInLesson: 0, stale: false };
    this.turnsInLesson += 1;
    this.turnsInPhase += 1;
    return {
      turnsInPhase: this.turnsInPhase,
      turnsInLesson: this.turnsInLesson,
      stale: this.turnsSinceReport() >= STALE_AFTER_TURNS,
    };
  }

  /** Student turns since the lesson last actually moved. */
  turnsSinceReport() {
    return Math.max(0, this.turnsInLesson - this.turnsAtLastReport);
  }

  /**
   * Items the student has now practised enough. The tutor is told to leave
   * these alone: this is the direct answer to being asked for the same word a
   * dozen times.
   * @returns {string[]}
   */
  settledVocabulary() {
    return Object.entries(this.practiceCounts)
      .filter(([, count]) => count >= SETTLED_AFTER_PRACTICES)
      .map(([item]) => item);
  }

  /**
   * The phase after the current one, or null at the end of the lesson.
   * @returns {Record<string, any>|null}
   */
  nextPhase() {
    if (!this.skill || !this.skill.phases.length) return null;
    const index = this.skill.phases.findIndex((phase) => phase.id === this.phaseId);
    return this.skill.phases[index + 1] || null;
  }

  /**
   * Has this phase stalled badly enough that the app should advance it without
   * waiting for the tutor?
   *
   * Both conditions matter. A long phase where the tutor is actively recording
   * objectives and vocabulary is a lesson going well; a long phase with nothing
   * recorded at all is a lesson going nowhere.
   * @returns {boolean}
   */
  shouldAutoAdvance() {
    if (!this.isActive) return false;
    // A part with a script ends when its script does. Advancing on a turn
    // count swapped the script out from under an open question — a student
    // asked for "900 yen" answered it correctly and was told the answer was
    // "300 yen", the first line of the next part.
    if (this.scriptRunning()) return false;
    if (!this.nextPhase()) return false;
    return this.turnsInPhase >= AUTO_ADVANCE_TURNS && this.turnsSinceReport() >= AUTO_ADVANCE_TURNS;
  }

  /**
   * Is finishing right now obviously premature?
   *
   * Guards against the tutor reading "move the lesson on" as "wrap the lesson
   * up" — ending a five-phase lesson from its first phase, with nothing
   * recorded, minutes after it began.
   *
   * This never blocks the STUDENT from stopping: that is end_lesson, which is
   * unconditional.
   * @returns {boolean}
   */
  isCompletionPremature() {
    if (!this.skill) return false;

    const phases = this.skill.phases;
    if (phases.length < 2) return false;

    // Reaching the last phase is itself evidence the lesson ran its course.
    const index = phases.findIndex((phase) => phase.id === this.phaseId);
    if (index >= phases.length - 1) return false;

    // A lesson with nothing to measure can only be judged by where it got to.
    const measurable = this.skill.objectives.some((objective) => objective.required);
    if (!measurable) return index <= 0;

    // Otherwise: claiming a lesson is finished while nothing at all has been
    // recorded as achieved, and there are parts of it left, is not a judgement
    // — it is the tutor losing the thread.
    return this.requiredObjectivesMet() === 0 && !this.meetsCompletionFloor();
  }

  /** How many required objectives are recorded as complete. */
  requiredObjectivesMet() {
    if (!this.skill) return 0;
    return this.skill.objectives.filter(
      (objective) => objective.required && this.objectiveStates[objective.id] === 'complete',
    ).length;
  }

  // -- Objectives (PART 28) -------------------------------------------------

  /**
   * @param {string} objectiveId
   * @param {string} state one of OBJECTIVE_STATES
   */
  setObjective(objectiveId, state) {
    if (!this.skill) return { ok: false, error: 'No lesson is active.' };
    const id = clean(objectiveId);
    if (!(id in this.objectiveStates)) {
      return { ok: false, error: `This lesson has no objective called "${id}".` };
    }
    const next = OBJECTIVE_STATES.includes(state) ? state : 'complete';
    if (this.objectiveStates[id] === next) return { ok: true, error: null, changed: false };
    this.objectiveStates[id] = next;
    this.turnsAtLastReport = this.turnsInLesson;
    this.record('objective', `${id} -> ${next}`);
    this.emit();
    return { ok: true, error: null, changed: true };
  }

  // -- Vocabulary observations (PART 12, PART 46) ---------------------------

  /**
   * Record what happened with vocabulary during the lesson. These are
   * observations for the end-of-call extractor, not a memory store.
   * @param {{introduced?: unknown, practiced?: unknown, struggled?: unknown, successful?: unknown}} payload
   */
  noteVocabulary({ introduced, practiced, struggled, successful } = {}) {
    if (!this.skill) return { ok: false, error: 'No lesson is active.' };
    const additions = {
      introduced_vocab: cleanList(introduced),
      practiced_vocab: cleanList(practiced),
      struggled_vocab: cleanList(struggled),
      successful_vocab: cleanList(successful),
    };
    let changed = false;
    for (const bucket of VOCAB_BUCKETS) {
      for (const item of additions[bucket]) {
        // Practising and succeeding both count as an encounter; being
        // introduced to a word does not, and struggling with one means it needs
        // more, not less.
        if (bucket === 'practiced_vocab' || bucket === 'successful_vocab') {
          this.practiceCounts[item] = (this.practiceCounts[item] || 0) + 1;
        }
        if (!this.vocab[bucket].includes(item)) {
          this.vocab[bucket].push(item);
          changed = true;
        }
      }
      if (this.vocab[bucket].length > 60) {
        this.vocab[bucket].splice(0, this.vocab[bucket].length - 60);
      }
    }
    // Note: this deliberately does NOT touch `turnsAtLastReport`. Vocabulary is
    // activity, not progress; see the field's own comment.
    if (changed) this.emit();
    return { ok: true, error: null, changed };
  }

  /** A free-text observation from the tutor. */
  addNote(note) {
    const text = clean(note);
    if (!text || !this.skill) return { ok: false };
    this.notes.push(text);
    if (this.notes.length > 40) this.notes.splice(0, this.notes.length - 40);
    return { ok: true };
  }

  // -- Progress (PART 27) ---------------------------------------------------

  /**
   * An approximate completion percentage.
   *
   * Deliberately rough: objectives met and phases traversed, nothing about
   * elapsed time. Returns 0-100.
   * @returns {number}
   */
  progress() {
    if (!this.skill) return 0;
    if (this.completed) return 100;

    const objectives = this.skill.objectives;
    const phases = this.skill.phases;

    // A lesson run from scripts knows exactly how far along it is: the parts
    // behind it, plus how much of this part's script has been said. The
    // estimate below, built for lessons a model reported on, read 7% after
    // one part of six and went backwards during the second.
    const steps = this.currentScript();
    if (steps.length && phases.length) {
      // Parts done, wherever they sit in the lesson's order: a student who
      // jumps ahead and comes back must not see the figure fall.
      const done = phases.filter((entry) => entry.id !== this.phaseId && this.finishedParts[entry.id]).length;
      const within = this.finishedParts[this.phaseId]
        ? 1
        : ((this.cursors[this.phaseId] ?? -1) + 1) / steps.length;
      const share = (done + Math.min(1, within)) / phases.length;
      return Math.max(MIN_ACTIVE_PROGRESS, Math.min(99, Math.round(share * 100)));
    }

    let objectiveScore = null;
    if (objectives.length) {
      let earned = 0;
      let possible = 0;
      for (const objective of objectives) {
        const weight = objective.required ? objective.weight : objective.weight * 0.5;
        possible += weight;
        const state = this.objectiveStates[objective.id];
        if (state === 'complete') earned += weight;
        else if (state === 'partial') earned += weight * PARTIAL_CREDIT;
      }
      objectiveScore = possible > 0 ? earned / possible : 0;
    }

    // Only a multi-phase lesson has phase progression to measure. With one
    // phase (or none) there is nowhere to travel, so objectives carry the whole
    // estimate rather than being capped by a score that can never be earned.
    let phaseScore = null;
    if (phases.length > 1) {
      const index = phases.findIndex((entry) => entry.id === this.phaseId);
      phaseScore = index <= 0 ? 0 : index / (phases.length - 1);
    }

    let combined;
    if (objectiveScore !== null && phaseScore !== null) {
      combined = objectiveScore * OBJECTIVE_WEIGHT + phaseScore * PHASE_WEIGHT;
    } else if (objectiveScore !== null) {
      combined = objectiveScore;
    } else if (phaseScore !== null) {
      combined = phaseScore;
    } else {
      combined = 0;
    }

    // Never report 100 while the lesson is still running — completion is a
    // pedagogical judgement, not an arithmetic one — and never report 0 for a
    // lesson that has started.
    return Math.max(MIN_ACTIVE_PROGRESS, Math.min(99, Math.round(combined * 100)));
  }

  /** Objectives grouped for display and for the prompt. */
  objectiveBreakdown() {
    if (!this.skill) return { complete: [], partial: [], pending: [] };
    const groups = { complete: [], partial: [], pending: [] };
    for (const objective of this.skill.objectives) {
      const state = this.objectiveStates[objective.id] || 'pending';
      groups[state].push(objective);
    }
    return groups;
  }

  /** True when the Skill's own completion floor has been reached. */
  meetsCompletionFloor() {
    if (!this.skill) return false;
    const minimum = this.skill.completion.min_required_objectives;
    if (minimum === null) return false;
    const done = this.skill.objectives.filter(
      (objective) => objective.required && this.objectiveStates[objective.id] === 'complete',
    ).length;
    return done >= minimum;
  }

  // -- Serialisation --------------------------------------------------------

  /**
   * The runtime state, in the shape PART 11 describes. Safe to hand to the UI
   * and to the prompt builder.
   */
  snapshot() {
    if (!this.skill) {
      return {
        active_skill: null,
        skill_name: '',
        skill_type: '',
        phase: null,
        phase_name: '',
        progress: 0,
        objectives: {},
        introduced_vocab: [],
        practiced_vocab: [],
        struggled_vocab: [],
        successful_vocab: [],
        runtime_inputs: {},
        runtime_input_sources: {},
        pending_inputs: [],
        notes: [],
        completed: false,
        turns_in_lesson: 0,
        turns_in_phase: 0,
        turns_since_report: 0,
        settled_vocab: [],
        phase_is_dragging: false,
        meets_completion_floor: false,
        required_objectives_met: 0,
        next_phase_id: '',
        next_phase_name: '',
        phase_mode: 'talk',
        script: [],
        script_current: -1,
        script_misses: 0,
        plan_pending: false,
        script_finished: false,
        requests: [],
        taught: [],
      };
    }
    const phase = this.currentPhase();
    return {
      active_skill: this.skill.id,
      skill_name: this.skill.name,
      skill_type: this.skill.type,
      phase: this.phaseId || null,
      phase_name: phase ? phase.name : '',
      progress: this.progress(),
      objectives: { ...this.objectiveStates },
      introduced_vocab: [...this.vocab.introduced_vocab],
      practiced_vocab: [...this.vocab.practiced_vocab],
      struggled_vocab: [...this.vocab.struggled_vocab],
      successful_vocab: [...this.vocab.successful_vocab],
      runtime_inputs: { ...this.inputValues },
      runtime_input_sources: { ...this.inputSources },
      pending_inputs: this.pendingInputs().map((entry) => ({
        id: entry.id,
        name: entry.name,
        prompt: entry.prompt,
        allow_tutor_choice: entry.allow_tutor_choice,
      })),
      notes: [...this.notes],
      completed: this.completed,
      turns_in_lesson: this.turnsInLesson,
      turns_in_phase: this.turnsInPhase,
      turns_since_report: this.turnsSinceReport(),
      settled_vocab: this.settledVocabulary(),
      phase_is_dragging: this.turnsInPhase >= LONG_PHASE_TURNS,
      meets_completion_floor: this.meetsCompletionFloor(),
      required_objectives_met: this.requiredObjectivesMet(),
      next_phase_id: this.nextPhase()?.id || '',
      next_phase_name: this.nextPhase()?.name || '',
      phase_mode: this.phaseMode(),
      script: this.currentScript(),
      script_current: this.cursors[this.phaseId] ?? -1,
      script_misses: this.misses,
      plan_pending: this.planning.has(this.phaseId),
      script_finished: Boolean(this.finishedParts[this.phaseId]),
      requests: [...this.requests],
      taught: this.taught.map((item) => ({ ...item })),
    };
  }

  /**
   * A plain-language account of what happened, appended to the transcript that
   * goes to the EXISTING memory extractor (PART 46). Not persisted anywhere.
   */
  transcriptSummary() {
    if (!this.skill) return null;
    const groups = this.objectiveBreakdown();
    return {
      id: this.skill.id,
      name: this.skill.name,
      type: this.skill.type,
      completed: this.completed,
      end_reason: this.endReason || (this.completed ? 'completed' : 'in_progress'),
      phase: this.phaseId,
      phase_name: this.currentPhase()?.name || '',
      progress: this.completed ? 100 : this.progress(),
      runtime_inputs: { ...this.inputValues },
      objectives_complete: groups.complete.map((entry) => entry.description),
      objectives_partial: groups.partial.map((entry) => entry.description),
      objectives_pending: groups.pending.map((entry) => entry.description),
      introduced_vocab: [...this.vocab.introduced_vocab],
      practiced_vocab: [...this.vocab.practiced_vocab],
      struggled_vocab: [...this.vocab.struggled_vocab],
      successful_vocab: [...this.vocab.successful_vocab],
      notes: [...this.notes],
      target_grammar: [...this.skill.content.target_grammar],
      student_turns: this.turnsInLesson,
    };
  }

  /**
   * Everything the call saw: lessons that ended plus one still running.
   * @returns {any[]}
   */
  callSummary() {
    const finished = [...this.finishedLessons];
    if (this.skill) {
      const current = this.transcriptSummary();
      if (current) finished.push(current);
    }
    return finished;
  }

  /**
   * Clear the record of lessons that ended earlier in the call, WITHOUT
   * touching a lesson the student has already chosen. Called when a new call
   * starts, so the previous call's observations do not leak into this one's
   * memory extraction.
   */
  clearHistory() {
    this.finishedLessons = [];
    this.callTaught = [];
    this.callMissed = new Map();
  }

  /** Carry what this lesson taught, and what was missed in it, into the call's record. */
  keepForCall() {
    const have = new Set(this.callTaught.map((item) => fold(item.say)));
    for (const item of this.taught) {
      const key = fold(item && item.say);
      if (!key || have.has(key) || !item.meaning) continue;
      have.add(key);
      this.callTaught.push({ say: item.say, meaning: item.meaning, script: item.script || '' });
    }
    for (const [key, count] of this.missed) this.callMissed.set(key, (this.callMissed.get(key) || 0) + count);
  }

  /** Everything taught on this call so far, in the lesson running now as well. */
  callItems() {
    const have = new Set();
    const out = [];
    for (const item of [...this.callTaught, ...this.taught]) {
      const key = fold(item && item.say);
      if (!key || have.has(key) || !item.meaning) continue;
      have.add(key);
      out.push({ say: item.say, meaning: item.meaning, script: item.script || '' });
    }
    return out;
  }

  /** Misses on this call, in the lesson running now as well. */
  callMisses() {
    const out = new Map(this.callMissed);
    for (const [key, count] of this.missed) out.set(key, (out.get(key) || 0) + count);
    return out;
  }

  /** Clear the per-call history and any active lesson. */
  resetCall() {
    this.finishedLessons = [];
    this.callTaught = [];
    this.callMissed = new Map();
    this.reset();
    this.emit();
  }
}
