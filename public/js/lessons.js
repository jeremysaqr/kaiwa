/**
 * public/js/lessons.js
 *
 * The browser's Lesson Skills controller.
 *
 * This is the single runtime PART 22 asks for. Every route into a lesson ends
 * at `activate()`, and none has a private path of its own:
 *
 *   the sidebar selector ─┐
 *   what the student said ─┼──> LessonLibrary.activate(skillId) ──> LessonRuntime
 *   the Lesson Director  ─┘                                            │
 *                                                                      v
 *                                              rebuild the prompt, session.update
 *
 * The tutor has no tools. It talks; the Director watches and records. See
 * `runDirector` below and src/director.js.
 *
 * Nothing here is persisted. Lesson state dies with the call (PART 24).
 */

import { LessonRuntime } from '../shared/lesson-runtime.js';
import {
  resolveSkillReference,
  classifyActivationIntent,
  isDeactivationRequest,
  isAffirmation,
  isRefusal,
} from '../shared/lesson-activation.js';
import { fetchWithTimeout } from './realtime.js';

/**
 * Holds the catalogue and the one lesson that may be running.
 */
export class LessonLibrary {
  /**
   * @param {{onChange?: (info: any) => void}} [options]
   */
  constructor({ onChange = null } = {}) {
    /** @type {Record<string, any>[]} */
    this.skills = [];
    /** Last pacing signature pushed to the tutor. */
    this.lastPacing = '';
    /** True while a Director request is in flight, so they cannot overlap. */
    this.directorBusy = false;
    /** A lesson the student was asked to confirm, awaiting a yes. */
    /** @type {{skillId: string, skillName: string}|null} */
    this.pendingSuggestion = null;
    /** @type {{id: string, source: string, errors: string[]}[]} */
    this.problems = [];
    /** Language reference facts, keyed by lowercase language name. */
    /** @type {Record<string, Record<string, string>>} */
    this.reference = {};
    /** @type {Record<string, Record<string, string[]>>} */
    this.topics = {};
    this.loaded = false;
    this.loadError = '';
    this.onChange = onChange;

    this.runtime = new LessonRuntime({
      onChange: () => this.emit(),
    });
  }

  emit() {
    if (typeof this.onChange === 'function') {
      try {
        this.onChange(this.info());
      } catch {
        /* a listener must never break the lesson */
      }
    }
  }

  /** Everything a view needs in one object. */
  info() {
    const snapshot = this.runtime.snapshot();
    return {
      skills: this.skills,
      problems: this.problems,
      loaded: this.loaded,
      loadError: this.loadError,
      activeSkill: this.runtime.skill,
      state: snapshot,
      progress: snapshot.progress,
    };
  }

  /**
   * The lesson layer handed to `buildTutorPrompt`. When nothing is running this
   * is just the catalogue, which is what makes voice activation possible at all.
   */
  promptContext(language = '') {
    return {
      catalog: this.skills,
      skill: this.runtime.skill,
      state: this.runtime.snapshot(),
      reference: this.referenceFor(language),
      topics: this.topicsFor(language),
    };
  }

  /**
   * The reference facts for one language, or an empty set when the language
   * has no file. Missing reference data is not an error: the tutor simply gets
   * no reference section, as it did before language files existed.
   * @param {string} language
   * @returns {Record<string, string>}
   */
  referenceFor(language) {
    const key = String(language || '').trim().toLowerCase();
    return (key && this.reference[key]) || {};
  }

  /**
   * The subject words that map onto one language's reference sections.
   * @param {string} language
   * @returns {Record<string, string[]>}
   */
  topicsFor(language) {
    const key = String(language || '').trim().toLowerCase();
    return (key && this.topics[key]) || {};
  }

  /**
   * Load the catalogue from the backend.
   *
   * A failure here is not fatal: the app runs with no lessons and behaves
   * exactly as it did before the framework existed (PART 52).
   */
  async load({ refresh = false } = {}) {
    try {
      const response = await fetchWithTimeout(
        refresh ? '/api/lessons/refresh' : '/api/lessons',
        refresh ? { method: 'POST' } : {},
        10000,
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || !Array.isArray(payload.lessons)) {
        throw new Error(payload?.error || `The server returned HTTP ${response.status}.`);
      }
      this.skills = payload.lessons;
      this.reference = payload.reference && typeof payload.reference === 'object' ? payload.reference : {};
      this.topics = payload.topics && typeof payload.topics === 'object' ? payload.topics : {};
      this.problems = Array.isArray(payload.problems) ? payload.problems : [];
      this.loaded = true;
      this.loadError = '';
    } catch (error) {
      this.skills = [];
      this.reference = {};
      this.topics = {};
      this.problems = [];
      this.loaded = false;
      this.loadError = error?.message || String(error);
    }

    // The catalogue has just been replaced. A lesson that is running but is no
    // longer in it — deleted on disk, or renamed, or the whole library failed
    // to reload — would otherwise be orphaned: still shaping the prompt, no
    // longer selectable, and invisible to the activation matcher.
    this.reconcileActiveLesson();

    this.emit();
    return this.loaded;
  }

  /**
   * Stop a running lesson that the current catalogue no longer contains.
   * @returns {{dropped: boolean, name: string}}
   */
  reconcileActiveLesson() {
    const active = this.runtime.skill;
    if (!active) return { dropped: false, name: '' };
    if (this.skills.some((skill) => skill.id === active.id)) return { dropped: false, name: '' };
    this.runtime.deactivate({ reason: 'lesson no longer available' });
    return { dropped: true, name: active.name };
  }

  /** @param {string} id */
  find(id) {
    return this.skills.find((skill) => skill.id === id) || null;
  }

  /** @returns {boolean} */
  get isActive() {
    return this.runtime.isActive;
  }

  /** @returns {string} */
  get activeId() {
    return this.runtime.skillId;
  }

  // -- The single activation path (PART 22) ---------------------------------

  /**
   * Start a lesson. Accepts an id, a name or an alias so the tutor and the UI
   * can both call it with whatever they have.
   *
   * @param {string} reference
   * @param {{reason?: string}} [options]
   * @returns {{ok: boolean, changed: boolean, skill: any, error: string|null}}
   */
  activate(reference, { reason = 'ui' } = {}) {
    if (!reference) return this.deactivate({ reason });

    const skill = this.find(reference) || resolveSkillReference(reference, this.skills);
    if (!skill) {
      // PART 51 means a FAILED activation must not leave a half-started lesson
      // behind. It does not mean tearing down a perfectly good lesson that is
      // already running: if the tutor asks for a name that does not exist, the
      // right answer is "no" and nothing else changes.
      return {
        ok: false,
        changed: false,
        skill: null,
        error: `That lesson is not available${this.loadError ? ` (${this.loadError})` : ''}.`,
      };
    }

    this.pendingSuggestion = null;
    const result = this.runtime.activate(skill, { reason });
    if (!result.ok) {
      // The runtime refused it, so nothing is half-started; make sure of it.
      this.runtime.deactivate({ reason: 'failed' });
      return { ok: false, changed: true, skill: null, error: result.error };
    }
    return { ok: true, changed: result.changed, skill, error: null };
  }

  /**
   * Move the lesson to its next phase.
   *
   * The student's own escape hatch from a phase that has outstayed its welcome.
   * They should not have to negotiate with the tutor to move on.
   *
   * @returns {{ok: boolean, phaseName: string, last: boolean}}
   */
  advancePhase() {
    const skill = this.runtime.skill;
    if (!skill || skill.phases.length === 0) return { ok: false, phaseName: '', last: false };

    const index = skill.phases.findIndex((phase) => phase.id === this.runtime.phaseId);
    const next = skill.phases[index + 1];
    if (!next) return { ok: false, phaseName: '', last: true };

    const moved = this.runtime.setPhase(next.id, 'the student asked to move on');
    return { ok: moved.ok, phaseName: next.name, last: index + 2 >= skill.phases.length };
  }

  /** @param {{reason?: string}} [options] */
  deactivate({ reason = 'stopped' } = {}) {
    const result = this.runtime.deactivate({ reason });
    return { ok: true, changed: result.changed, skill: null, error: null };
  }

  /**
   * Start of a call: forget the previous call's lesson observations.
   *
   * A lesson the student picked in the sidebar before pressing Start Call is
   * deliberately kept — that selection is the whole point of the selector.
   */
  startCall() {
    this.runtime.clearHistory();
  }

  /**
   * End of a call. The summary has already been taken; whatever was running is
   * discarded, so the same lesson starts fresh next time (PART 24).
   */
  endCall() {
    this.runtime.deactivate({ reason: 'call ended' });
    this.runtime.reset();
    this.emit();
  }

  /** Lesson observations for the end-of-call memory extraction (PART 46). */
  callSummary() {
    return this.runtime.callSummary();
  }

  // -- Tool dispatch --------------------------------------------------------

  // -- The Lesson Director -------------------------------------------------

  /**
   * Ask the Director what has happened, and apply its answer.
   *
   * Runs out of band on a cheap text model. A failure changes nothing: the
   * lesson carries on exactly as it was, which is what used to happen every
   * time the tutor declined to call a tool.
   *
   * @param {{role: string, text: string}[]} transcript recent turns
   * @param {{language?: string, level?: string}} [context]
   * @returns {Promise<{ok: boolean, applied: any, error: string|null}>}
   */
  async runDirector(transcript, { language = '', level = '' } = {}) {
    if (!this.runtime.isActive) return { ok: false, applied: null, error: 'No lesson is running.' };
    if (this.directorBusy) return { ok: false, applied: null, error: 'Already running.' };

    const skillId = this.runtime.skillId;
    this.directorBusy = true;
    try {
      const response = await fetchWithTimeout(
        '/api/lessons/direct',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lessonId: skillId,
            state: this.runtime.snapshot(),
            transcript,
            language,
            level,
          }),
        },
        25000,
      );
      const payload = await response.json().catch(() => null);
      if (!payload || !payload.direction) {
        return { ok: false, applied: null, error: payload?.error || `HTTP ${response.status}` };
      }

      // The lesson may have ended, or been swapped, while we were waiting.
      if (this.runtime.skillId !== skillId) {
        return { ok: false, applied: null, error: 'The lesson changed while the director was thinking.' };
      }

      return {
        ok: Boolean(payload.ok),
        applied: this.applyDirection(payload.direction),
        error: payload.error || null,
      };
    } catch (error) {
      return { ok: false, applied: null, error: error?.message || String(error) };
    } finally {
      this.directorBusy = false;
    }
  }

  /**
   * Have the material for one part of the lesson written.
   *
   * @param {string} phaseId
   * @param {{language?: string, level?: string, known?: string[]}} [context]
   * @returns {Promise<{ok: boolean, plan: any, error: string|null}>}
   */
  /**
   * Ask whether an answer was the one the lesson was waiting for, when the
   * transcript alone does not settle it.
   * @param {Record<string, any>} question see src/judge.js
   * @returns {Promise<{ok: boolean, verdict: string, heard: string, other: string}>}
   */
  async judgeAnswer(question) {
    try {
      const response = await fetchWithTimeout(
        '/api/lessons/judge',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(question) },
        4000,
      );
      const payload = await response.json().catch(() => null);
      if (!payload || !payload.ok) return { ok: false, verdict: 'unclear', heard: '', other: '' };
      return {
        ok: true,
        verdict: String(payload.verdict || 'unclear'),
        heard: String(payload.heard || ''),
        other: String(payload.other || ''),
        part: String(payload.part || ''),
      };
    } catch {
      return { ok: false, verdict: 'unclear', heard: '', other: '' };
    }
  }

  async fetchPlan(phaseId, { language = '', level = '', known = [], requests = [], scenes = [], candidates = [] } = {}) {
    if (!this.runtime.isActive) return { ok: false, plan: null, error: 'No lesson is running.' };
    try {
      const snapshot = this.runtime.snapshot();
      const response = await fetchWithTimeout(
        '/api/lessons/plan',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lessonId: this.runtime.skillId,
            phaseId,
            runtimeInputs: snapshot.runtime_inputs,
            taught: this.runtime.plannedItems(),
            known,
            requests,
            scenes,
            candidates,
            language,
            level,
          }),
        },
        30000,
      );
      const payload = await response.json().catch(() => null);
      if (!payload) return { ok: false, plan: null, error: `HTTP ${response.status}` };
      return { ok: Boolean(payload.ok), plan: payload.plan || null, error: payload.error || null };
    } catch (error) {
      return { ok: false, plan: null, error: error?.message || String(error) };
    }
  }

  /**
   * Fold a Director answer into the runtime.
   *
   * Everything is filtered again on the way in — the runtime rejects unknown
   * ids on its own — and completion still passes the premature guard, so a
   * confused Director cannot end a lesson that has barely started.
   *
   * @param {Record<string, any>} direction
   */
  applyDirection(direction) {
    const source = direction && typeof direction === 'object' ? direction : {};
    const applied = {
      objectives: 0,
      vocabulary: 0,
      inputs: 0,
      phaseChanged: false,
      completed: false,
      phaseName: '',
      /** @type {{said: string, correct: string}[]} */
      errors: [],
      /** Phrases asked for without their meaning. @type {string[]} */
      unglossed: [],
    };
    if (!this.runtime.isActive) return applied;

    // Factual mistakes the tutor made. Recorded as notes so they reach the
    // end-of-call memory extraction too — a tutor that keeps getting the same
    // form wrong is worth knowing about.
    for (const error of Array.isArray(source.tutor_errors) ? source.tutor_errors : []) {
      if (!error || !error.said || !error.correct) continue;
      applied.errors.push({ said: String(error.said), correct: String(error.correct) });
      this.runtime.addNote(`Tutor said "${error.said}" — correct: ${error.correct}`);
    }

    // Not a factual error — nothing wrong was SAID — but a student repeating
    // sounds they cannot translate is learning nothing, so it is corrected the
    // same way.
    for (const phrase of Array.isArray(source.unglossed) ? source.unglossed : []) {
      const text = String(phrase || '').trim();
      if (text) applied.unglossed.push(text);
    }

    for (const [id, value] of Object.entries(source.runtime_inputs || {})) {
      if (this.runtime.setInput(id, value, 'user').ok) applied.inputs += 1;
    }

    for (const id of Array.isArray(source.completed_objectives) ? source.completed_objectives : []) {
      if (this.runtime.setObjective(String(id), 'complete').changed) applied.objectives += 1;
    }
    for (const id of Array.isArray(source.partial_objectives) ? source.partial_objectives : []) {
      if (this.runtime.setObjective(String(id), 'partial').changed) applied.objectives += 1;
    }

    const vocab = this.runtime.noteVocabulary({
      introduced: source.introduced_vocabulary,
      practiced: source.practiced_vocabulary,
      successful: source.successful_vocabulary,
      struggled: source.struggled_vocabulary,
    });
    if (vocab.changed) applied.vocabulary += 1;

    if (source.note) this.runtime.addNote(String(source.note));

    // While a script is running, the script decides when the part is over. The
    // Director sees a few turns of transcript and used to move the lesson on —
    // or back — from that: one session went dates, money, prices, dates. It may
    // still move things when the STUDENT asked to.
    const scripted = this.runtime.scriptRunning();
    const studentAsked = /student|asked|request|skip|wants?/i.test(String(source.phase_reason || ''));

    if (source.phase_id && (!scripted || studentAsked)) {
      const moved = this.runtime.setPhase(String(source.phase_id), String(source.phase_reason || 'director'));
      if (moved.changed) {
        applied.phaseChanged = true;
        applied.phaseName = this.runtime.currentPhase()?.name || '';
      }
    }

    // Completion is still the app's decision, not the Director's.
    if (source.should_complete === true && !scripted && !this.runtime.isCompletionPremature()) {
      const result = this.runtime.complete({ summary: String(source.note || '') });
      applied.completed = Boolean(result.ok);
      applied.completedName = result.skillName || '';
    }

    return applied;
  }

  // -- The deterministic safety net -----------------------------------------

  /**
   * Look at a completed student turn.
   *
   * The tutor's own judgement is the primary route into a lesson; this is the
   * belt to that pair of braces, for the case where the model simply does not
   * call the tool. It activates only on an unmistakable request — the same
   * rules that keep "I ate at a restaurant yesterday" inert (PART 56) — and
   * activation is idempotent, so agreeing with the model costs nothing.
   *
   * @param {string} utterance
   * @returns {{action: 'activated'|'ended'|'none', skill?: any, suggestion?: any}}
   */
  /**
   * The student finished a turn. Returns whether the tutor now needs a fresh
   * copy of the instructions because the pacing advice in them has changed.
   * @returns {{needsPromptRefresh: boolean}}
   */
  noteStudentTurn() {
    if (!this.runtime.isActive) return { needsPromptRefresh: false, autoAdvanced: null };

    const before = this.pacingFingerprint;
    this.runtime.noteStudentTurn();

    // The tutor is asked to drive the lesson, and is told twice before this
    // point. If it still has not moved the phase or recorded anything, the app
    // moves the lesson itself — otherwise the student sits in the opening phase
    // watching a progress bar that never moves, which is exactly what happens
    // when a voice model decides bookkeeping tools are not worth interrupting
    // itself for.
    let autoAdvanced = null;
    if (this.runtime.shouldAutoAdvance()) {
      const from = this.runtime.currentPhase()?.name || '';
      const result = this.advancePhase();
      if (result.ok) autoAdvanced = { from, to: result.phaseName };
    }

    const after = this.pacingFingerprint;

    // Otherwise refresh only when the ADVICE changes — not on every turn.
    // Pushing a full instruction set into a live call several times a minute is
    // what makes the tutor feel sluggish.
    return { needsPromptRefresh: Boolean(autoAdvanced) || before !== after, autoAdvanced };
  }

  /** A cheap signature of the pacing advice currently in the prompt. */
  get pacingFingerprint() {
    const snapshot = this.runtime.snapshot();
    return [
      snapshot.phase_is_dragging ? 'drag' : '',
      snapshot.turns_since_report >= 6 ? Math.floor(snapshot.turns_since_report / 4) : '',
      (snapshot.settled_vocab || []).length,
    ].join('|');
  }

  observeStudentTurn(utterance) {
    // Checked first, and without consulting the catalogue: a student must be
    // able to say "let's just chat" even if the lesson library has since been
    // reloaded away underneath them.
    if (this.runtime.isActive && isDeactivationRequest(utterance)) {
      const skill = this.runtime.skill;
      this.runtime.deactivate({ reason: 'student request' });
      return { action: 'ended', skill };
    }

    if (this.runtime.isActive || !this.skills.length) return { action: 'none' };

    // An ambiguous request last turn became a question from the tutor —
    // "would you like the Restaurant Roleplay lesson?" — so a plain "yes" now
    // is the confirmation PART 21 asks for. Without this the student says yes
    // and nothing happens.
    if (this.pendingSuggestion) {
      const suggestion = this.pendingSuggestion;
      if (isAffirmation(utterance)) {
        this.pendingSuggestion = null;
        const result = this.activate(suggestion.skillId, { reason: 'confirmed' });
        if (result.ok && result.changed) return { action: 'activated', skill: result.skill };
        return { action: 'none' };
      }
      if (isRefusal(utterance)) {
        this.pendingSuggestion = null;
        return { action: 'none' };
      }
      // Anything else means the moment has passed.
      this.pendingSuggestion = null;
    }

    const verdict = classifyActivationIntent(utterance, this.skills);
    if (verdict.intent === 'activate') {
      const result = this.activate(verdict.skillId, { reason: 'voice' });
      if (result.ok && result.changed) return { action: 'activated', skill: result.skill };
      return { action: 'none' };
    }

    // An ambiguous request is left to the tutor, which asks the student to
    // confirm. Activating here would be exactly the guess PART 21 forbids —
    // but the answer to that question is remembered, so a "yes" next turn
    // starts the lesson.
    if (verdict.intent === 'confirm') {
      this.pendingSuggestion = { skillId: verdict.skillId, skillName: verdict.skillName };
      return { action: 'none', suggestion: verdict };
    }

    return { action: 'none' };
  }
}
