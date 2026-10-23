/**
 * shared/conductor.js
 *
 * What the app does around the conversation, turn by turn: count the student's
 * turns, move a stuck lesson on, ask the Lesson Director what happened, and
 * tell the tutor about it.
 *
 * This used to live inside app.js, tangled up with the DOM. It is here, with
 * everything it touches passed in, for one reason: the test harness in
 * tools/sim drives a real tutor through exactly this code. A fix made here is
 * a fix the harness exercises, and a regression here is one it can catch.
 *
 * Dependency-free and DOM-free: runs unchanged in the browser and in Node.
 */

/** Student turns between Lesson Director passes. */
export const DIRECTOR_EVERY_TURNS = 3;

/** Turns of transcript the Director is shown. */
export const DIRECTOR_TURNS = 14;

/** Settle before running it, so a burst of turns costs one call. */
export const DIRECTOR_DELAY_MS = 1200;

import {
  ackFor, ackIntro, answersStep, asksForPart, asksHowToSay, asksRepeat, confusedWith, declinesToGoOn, earPrompt, fold, givesUp,
  hearsYes, isBareOk, lineFor, looksLikeQuestion, nearMiss, objectsToMoving, remainderOf, renderTurn, saysPhrases,
  soundsLike, turnFor, variantKeys, wantsToMoveOn, wentOn,
} from './script.js';
import { drillRequest, isAffirmation, isRefusal, openingTopic, topicRequest } from './lesson-activation.js';
import { vocabItems } from './vocab.js';

/** The fewest words a drill is worth running with. */
const DRILL_MIN = 3;

/** "Again." "One more round." Said straight after a drill closed with "Again, or something else?". */
function wantsAgain(text) {
  return /^(?:(?:ok(?:ay)?|yes|yeah|sure)[,.!]?\s+)?(?:again|one more(?: time| round| go)?|another(?: round| one| go)?|go again|do it again|(?:let'?s )?(?:go|do (?:that|it)) again)\b/i.test(String(text || '').trim());
}

/** "Tell me about onions, potatoes and peppers": asking for more of the subject. */
const asksForMore = (text) => /\b(tell me about|teach me|what about|how about|let'?s (?:talk about|learn|do|try) (?:some |more )?\w+|(?:can|could) we (?:learn|do|try) (?:some |more )?\w+|i(?:'d| would)? (?:want|like) (?:to learn|more)|more (?:words|vegetables|fruits?|meats?|foods?|numbers|phrases))\b/i.test(String(text || '')) &&
  !/\b(again|one more time|once more|repeat)\b/i.test(String(text || ''));

/** Asking for the same thing again is not asking for a different part. */
const asksAgain = (text) => /\b(again|one more time|once more|repeat|say that)\b/i.test(String(text || ''));

/** A part's name that says nothing about what is in it ("Second set"). */
const plainName = (name) => /\b(first|second|third|fourth|last|set|pass|round|part)\b/i.test(String(name || ''));

/** Kana or kanji: script a student who reads Latin letters cannot use. */
const containsOtherScript = (text) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(String(text || ''));

const noop = () => {};

export class LessonConductor {
  /**
   * @param {{
   *   lessons: any,
   *   getProfile: () => Record<string, any>|null,
   *   getTranscript: () => any[],
   *   isLive?: () => boolean,
   *   nudge?: (text: string, options?: {speak?: boolean}) => void,
   *   syncPrompt?: () => void,
   *   log?: (type: string, payload?: Record<string, any>) => void,
   *   note?: (text: string, kind?: string) => void,
   *   refresh?: () => void,
 *   toTutorScript?: (text: string) => string,
   *   delayMs?: number,
   *   directed?: boolean,
   *   respond?: (instructions: string) => void,
   *   getReference?: () => string,
   *   judge?: (question: Record<string, any>) => Promise<{ok: boolean, verdict: string, heard: string, other: string}>,
   *   judgeMs?: number,
   * }} deps
   */
  constructor(deps) {
    this.lessons = deps.lessons;
    this.getProfile = deps.getProfile;
    this.getTranscript = deps.getTranscript;
    this.isLive = deps.isLive || (() => true);
    this.nudge = deps.nudge || noop;
    this.syncPrompt = deps.syncPrompt || noop;
    this.log = deps.log || noop;
    this.note = deps.note || noop;
    this.refresh = deps.refresh || noop;
    /** Converts what the student was heard to say into the script the tutor uses. */
    this.toTutorScript = deps.toTutorScript || null;
    this.delayMs = Number.isFinite(deps.delayMs) ? Number(deps.delayMs) : DIRECTOR_DELAY_MS;
    /**
     * Does the app choose the tutor's words? When it does, each reply during a
     * scripted part is asked for with its own instructions — decided after the
     * student has spoken — instead of being left to the tutor's standing ones.
     */
    this.directed = Boolean(deps.directed);
    /** Ask the tutor for a turn, with these instructions for it alone. */
    this.respond = deps.respond || noop;
    /** The language facts for the lesson in progress, as plain text. */
    this.getReference = deps.getReference || (() => '');
    /** Asks a text model whether an answer was right, when the transcript does not settle it. */
    this.judge = deps.judge || null;
    /** How long to wait for that before letting the tutor decide. */
    this.judgeMs = Number.isFinite(deps.judgeMs) ? Number(deps.judgeMs) : 2500;
    /**
     * Asks the model that heard the student whether they said a given thing:
     * `(itemIds, instructions) => {result: Promise<string>, cancel: () => void}`.
     * The written version of a beginner's speech is a guess, and this is asked
     * before a guess is used to call an answer wrong.
     */
    this.hear = deps.hear || null;
    /** How many times running they have spoken on one step and nothing could be made out. */
    this.blank = { phase: '', at: -1, n: 0 };
    /** How many times running one step has been asked again for a reply that was not an answer. */
    this.echoes = { phase: '', at: -1, n: 0 };
    /** The answer they have just been given, until they have spoken again. */
    /** @type {{say: string, script: string, phase: string}|null} */
    this.lastTold = null;
    /** How things stood before the reply now on its way, so it can be taken back if it is never heard. */
    /** @type {{state: any, own: any, pending: any}|null} */
    this.undo = null;
    /** The reply now on its way changed where the lesson is: it cannot be taken back. */
    this.fixed = false;
    /** Counts student turns being answered, so a slow answer to an old one is dropped. */
    this.answering = 0;
    /** The turn the app last asked for, until the tutor has taken it. */
    /** @type {{turn: any, current: number, phase: string, counted: boolean, reissued: boolean}|null} */
    this.pending = null;
    /** What the tutor last said in answer to a question, until the student has spoken again. */
    /** @type {{text: string, phase: string}|null} */
    this.lastAnswer = null;
    /** The word that means "right" has been explained on this call. */
    this.ackIntroduced = false;
    /** Scripted parts begun on this call. */
    this.startedParts = 0;
    /** How many times each thing said back to the student has been heard, by folded phrase. */
    /** @type {Map<string, number>} */
    this.replies = new Map();
    /** The part that has just closed, while "Ready for the next part?" is still unanswered. */
    /** @type {{id: string, name: string, next: string}|null} */
    this.lastFinished = null;
    /** The part the lesson was in before the one it is in now. */
    /** @type {{id: string, name: string}|null} */
    this.cameFrom = null;
    /** The part now starting is one being gone back to: it is not announced as "next". */
    this.returning = false;
    /** How many times each part's material could not be written, by plan key. */
    /** @type {Map<string, number>} */
    this.planFailures = new Map();
    /** What the student has asked for in the role-play of the part in progress. */
    /** @type {{phase: string, items: {word: string, thing: string}[]}} */
    this.ordered = { phase: '', items: [] };

    this.turnsSinceDirector = 0;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.directorTimer = null;
    /** @type {Promise<void>|null} */
    this.directorRun = null;
    /** Plans being written right now, by key, so one part is never planned twice. */
    /** @type {Map<string, Promise<boolean>>} */
    this.planning = new Map();
    /** Student turns heard this call. */
    this.studentTurns = 0;
    /** The student turn on which the part was last skipped, so one request skips one part. */
    this.skipTurn = -1;
    /** A skip is being carried out. */
    this.skipping = false;
    /** The tutor has told the student to wait for this part's material. */
    this.heldForPlan = false;
    /** The part's material arrived while the tutor was speaking: begin when it stops. */
    this.startWhenQuiet = false;
  }

  /** A new call is starting. */
  reset() {
    this.stop();
    this.turnsSinceDirector = 0;
    this.studentTurns = 0;
    this.skipTurn = -1;
    this.skipping = false;
    this.heldForPlan = false;
    this.startWhenQuiet = false;
    this.pending = null;
    this.ackIntroduced = false;
    this.startedParts = 0;
    this.replies = new Map();
    this.ordered = { phase: '', items: [] };
    this.planFailures = new Map();
    this.lastFinished = null;
    this.cameFrom = null;
    this.returning = false;
    this.blank = { phase: '', at: -1, n: 0 };
    this.echoes = { phase: '', at: -1, n: 0 };
    this.lastTold = null;
    this.undo = null;
    this.fixed = false;
    /** The subject of the last lesson or drill on this call: what "drill me" means with none named. */
    this.lastTopic = '';
    /** Offered a lesson because there was too little to drill: what it would be on. */
    this.offer = null;
    /** A drill that has just finished, so that "again" runs it again. */
    this.drillDone = null;
  }

  /** The call is over: nothing scheduled may fire after this. */
  stop() {
    if (this.directorTimer) {
      clearTimeout(this.directorTimer);
      this.directorTimer = null;
    }
  }

  /** True while a Director pass or a plan is scheduled or running. */
  get busy() {
    return Boolean(this.directorTimer || this.directorRun || this.planning.size || this.skipping);
  }

  /** Resolves once nothing is scheduled or running. Used by the harness. */
  async idle() {
    while (this.busy) {
      if (this.directorRun) await this.directorRun.catch(noop);
      else await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
  }

  /**
   * Make sure a part of the lesson has its material.
   *
   * Idempotent and safe to call from anywhere: it does nothing when the part
   * already has a plan, does not need one, or is already being planned. When
   * the plan arrives for the part in progress, the tutor's instructions are
   * rebuilt around it.
   *
   * @param {string} [phaseId] defaults to the part in progress
   * @returns {Promise<boolean>} whether a plan is now in place
   */
  ensurePlan(phaseId = '', { quiet = false } = {}) {
    const lessons = this.lessons;
    const runtime = lessons.runtime;
    const target = phaseId || runtime.phaseId;
    if (!runtime.needsPlan(target)) return Promise.resolve(Boolean(runtime.scripts[target]));

    const key = runtime.planKey(target);
    const running = this.planning.get(key);
    if (running) return running;
    // A part planned ahead of time is asked for again at every step until it
    // has a plan. If the planner cannot write it, twice is enough asking —
    // until the part is actually reached, when it is tried once more.
    if ((this.planFailures.get(key) || 0) >= 2 && target !== runtime.phaseId) return Promise.resolve(false);

    const profile = this.getProfile() || {};
    const skillId = runtime.skillId;
    // The tutor is told a part's material is on its way, so that it waits
    // rather than making some up.
    runtime.planning.add(target);
    const job = Promise.resolve()
      .then(() =>
        lessons.fetchPlan(target, {
          language: profile.target_language,
          level: profile.proficiency_level,
          known: profile.recent_vocab,
          requests: [...runtime.requests],
          scenes: runtime.sceneLinesUsed(),
          candidates: runtime.phaseMode(target) === 'drill' ? this.drillCandidates() : [],
        }),
      )
      .then((result) => {
        this.log('plan', {
          phase: target,
          ok: Boolean(result && result.ok),
          error: (result && result.error) || null,
          items: result?.plan?.items?.map((item) => `${item.say} = ${item.meaning}`) || [],
          scene: result?.plan?.scene?.lines?.map((line) => line.tutor) || [],
          dropped: result?.plan?.dropped || [],
        });
        // The lesson may have ended, or been swapped, while this was written.
        runtime.planning.delete(target);
        // A drill with too little in it, or none at all, is not run.
        if (runtime.skillId === skillId && runtime.phaseMode(target) === 'drill' &&
          (!result || !result.ok || !result.plan || (result.plan.items || []).length < DRILL_MIN)) {
          this.drillTooShort(String(runtime.inputValues.topic || '').trim());
          return false;
        }
        if (!result || !result.ok || !result.plan || runtime.skillId !== skillId) {
          this.planFailures.set(key, (this.planFailures.get(key) || 0) + 1);
          // No material is coming: the tutor falls back on its general rules.
          if (target === runtime.phaseId) {
            this.syncPrompt();
            this.refresh();
            if (this.heldForPlan && this.isLive()) {
              this.heldForPlan = false;
              this.nudge('Carry on with this part now: teach the first thing, with its meaning.', { speak: true });
            }
          }
          return false;
        }
        const placed = runtime.setPlan(target, result.plan, key);
        if (placed.changed && target === runtime.phaseId) {
          this.syncPrompt();
          this.refresh();
          if (this.isLive() && !quiet) {
            // If the student has been told to wait, nobody is about to speak:
            // the tutor has to be the one to start.
            const held = this.heldForPlan;
            this.heldForPlan = false;
            if (this.directed) {
              // Nothing to tell the tutor: its words are chosen turn by turn.
              // But somebody has to start. If the tutor spoke last — it told
              // them to wait, or said what is coming — it starts now. If the
              // student did, the tutor is answering them; it starts when that
              // answer is finished.
              const last = this.getTranscript().slice(-1)[0];
              if (held || !last || last.role !== 'user') this.startPart();
              else this.startWhenQuiet = true;
            } else {
              this.nudge(
                'The material for this part is ready. Your next turn is the line given under RIGHT NOW.',
                { speak: held },
              );
            }
          }
        }
        return Boolean(placed.changed);
      })
      .catch(() => { runtime.planning.delete(target); return false; })
      .finally(() => { this.planning.delete(key); });

    this.planning.set(key, job);
    return job;
  }

  /**
   * Start a part of the lesson out loud, because the student pressed something
   * and nobody is talking.
   *
   * Waits, briefly, for the part's material first: a tutor told to begin
   * before it has anything to teach begins by improvising, and improvised
   * material is exactly what the plan exists to replace.
   *
   * @param {string} announcement what to tell the tutor
   * @param {{waitMs?: number}} [options]
   */
  async beginPart(announcement, { waitMs = 8000 } = {}) {
    await Promise.race([
      this.ensurePlan('', { quiet: true }),
      new Promise((resolve) => { setTimeout(resolve, waitMs); }),
    ]);
    this.syncPrompt();
    this.refresh();
    if (this.directed && this.startPart()) return;
    this.nudge(announcement, { speak: true });
  }

  // -- Choosing the tutor's words ---------------------------------------------
  //
  // Four rounds of test students said the same thing in different ways: the
  // small voice model says a line well, and cannot be relied on to work out
  // which line. Shown "if right say this, if wrong say that, then the next
  // line", it said its line in full four times in twenty-five. So during a
  // scripted part the app decides, once the student has spoken, and asks for
  // the reply with instructions for that reply alone.

  /** Who is on the call, for a turn's instructions. */
  who() {
    const profile = this.getProfile() || {};
    return {
      tutor: String(profile.tutor_name || 'the tutor'),
      student: String(profile.user_name || 'the student'),
      language: String(profile.target_language || 'the language'),
      reference: String(this.getReference() || ''),
    };
  }

  /**
   * Record a turn as the one being asked for, and write what the tutor is
   * asked for.
   * @param {any} turn from `turnFor`
   * @param {number} current the step last asked when it was chosen
   * @returns {{instructions: string, say: string, fresh: boolean, turn: any, then: any}}
   */
  issue(turn, current = -1) {
    const runtime = this.lessons.runtime;
    this.pending = { turn, current, phase: runtime.phaseId, counted: false, reissued: false };
    this.log('script.turn', {
      phase: runtime.phaseId,
      after: current + 1,
      mode: turn.mode,
      reason: turn.reason || null,
      advances: turn.advances,
      line: turn.line || turn.after || turn.right || '',
    });
    return this.asked(turn);
  }

  /**
   * A turn as what is sent: the instructions, the text to read if there is
   * any, and whether a second reply follows it.
   * @param {any} turn
   */
  asked(turn) {
    const who = this.who();
    const made = renderTurn(turn, who);
    // Only a turn the tutor has to judge by ear needs the conversation in
    // front of it. Every other is made from what it is given, and that alone.
    const fresh = turn.mode !== 'judge';
    // A question is answered, and then what had been asked is said again as a
    // turn of its own — word for word, like any other line.
    const then = turn.mode === 'question' && turn.after
      ? { ...renderTurn({ mode: 'exact', line: turn.after }, who), fresh: true }
      : null;
    return { instructions: made.instructions, say: made.say, examples: made.examples, fresh, turn, then };
  }

  /**
   * Send a decided turn to the tutor.
   * @param {ReturnType<LessonConductor['asked']>} decided
   * @param {{after?: boolean}} [options] queue it behind a reply already waiting
   */
  speak(decided, { after = false } = {}) {
    this.respond(decided.instructions, { fresh: decided.fresh, say: decided.say, examples: decided.examples, after });
    if (decided.then) {
      this.respond(decided.then.instructions, { fresh: true, say: decided.then.say, examples: decided.then.examples, after: true });
    }
  }

  /**
   * Decide the tutor's next turn.
   *
   * @param {string} [heard] what the student said, in the script the tutor uses
   * @param {{verdict?: any, dry?: boolean}} [options] a judge's verdict on the
   *        answer; `dry` to see what the turn would be without committing to it
   * @returns {{instructions: string, turn: any}|null} null when the tutor's
   *          standing instructions apply — there is no script to follow
   */
  decideTurn(heard = '', { verdict = null, dry = false, unheard = 0 } = {}) {
    const lessons = this.lessons;
    const runtime = lessons.runtime;
    if (!this.directed || !lessons.isActive) return null;

    if (!runtime.scriptRunning()) {
      // The part's material is still being written. Wait, rather than have
      // the tutor fill the gap with something of its own.
      if (runtime.planning.has(runtime.phaseId)) {
        this.heldForPlan = true;
        return this.issue({ mode: 'exact', line: 'One moment.', advances: false, reason: 'wait' });
      }
      return null;
    }

    const steps = runtime.currentScript();
    const current = runtime.cursors[runtime.phaseId] ?? -1;
    const { language } = this.who();
    // What they have asked for in this part's role-play, so that it can arrive.
    if (this.ordered.phase !== runtime.phaseId) this.ordered = { phase: runtime.phaseId, items: [] };
    // What the lesson taught, and the words they already have: in a role-play
    // "akai onegaishimasu" was refused twice after "or something else that
    // fits", because red came from memory, not from this lesson.
    const options = {
      language, current, tries: runtime.misses, heard, taught: [...runtime.taught, ...this.savedItems()], verdict, replies: this.replies, ordered: this.ordered.items, unheard,
    };
    if (!dry) this.lastTold = null;
    // The thing brought back from an earlier part is chosen as the part opens.
    if (!dry && current < 0) runtime.applyCarry();
    let turn = turnFor(steps, options);
    if (!turn) return null;
    if (!dry && current >= 0 && turn.mode === 'exact') {
      // Keep count of what they produced unaided and what they missed or had
      // to be given: the closing line says both, and the next part brings
      // back what was missed.
      const step = steps[current];
      // Producing it, that is: knowing what it means is not being able to say it.
      const produced = step.kind === 'recall' || step.kind === 'scene' || step.build === true;
      // What they said, when it was not the planned reply, is what they get
      // the credit for.
      // (A yes or a no to "is that everything?" is right, and is not the
      // order the plan had there.)
      if (turn.reason === 'right' && produced && runtime.misses === 0 && turn.credit !== false) runtime.noteRight(step, turn.fit ? turn.fit.say : '');
      // The answer was given to them and the lesson went on. If that is the
      // second time for this thing, it is let go: not asked for again.
      const gave = turn.requeue === true || (turn.advances === true && ['told', 'wrong', 'unclear', 'other'].includes(turn.reason));
      if (gave && step.kind !== 'recognise') {
        // (If they say it straight back, that is not an answer to what is asked next.)
        this.lastTold = { say: step.kind === 'scene' ? step.expect : step.say, script: step.script || '', phase: runtime.phaseId };
        if (step.kind !== 'scene' && runtime.noteTold(step)) this.log('script.letGo', { phase: runtime.phaseId, say: step.say });
      }
      // Missed in a quick round, it comes round once more at the end of it.
      if (turn.requeue && step.quick && !step.again && !runtime.parked.has(fold(step.say))) {
        let end = current;
        while (steps[end + 1] && steps[end + 1].quick) end += 1;
        if (end > current) steps.splice(end + 1, 0, { ...step, first: false, again: true });
      }
      if (turn.fit) {
        // And if a later line of the scene was going to ask for the very thing
        // they have just said, that line asks for the one they did not.
        const key = fold(turn.fit.say);
        const later = steps.slice(current + 1).find((entry) => entry.kind === 'scene' && variantKeys(entry.expect).includes(key));
        if (later) {
          later.expect = step.expect;
          later.cue = step.cue;
          later.script = step.script || '';
        }
      }
      // A slip while repeating something just heard is not yet a miss; a
      // second one is.
      else if (['wrong', 'unclear', 'other', 'told'].includes(turn.reason) && (step.kind !== 'teach' || runtime.misses >= 1)) {
        runtime.noteFumble(step);
      }
      if (steps[current + 1]?.kind === 'wrap') {
        runtime.refreshWrap();
        turn = turnFor(steps, options) || turn;
      }
    }
    if (dry) return { instructions: '', say: '', examples: [], turn, fresh: false, then: null };
    if (turn.mode === 'exact' && turn.reason === 'start') {
      // A part opens with its name, so the student knows the subject changed.
      // (As a sentence: handed a bare label and a quoted phrase, the tutor
      // once said only the phrase. And only a name that says something:
      // "Next: second set." is a label read aloud.)
      const name = runtime.currentPhase()?.name || '';
      // (Not a drill: it opens on "Quick round.", and was asked for by name.)
      if (name && this.startedParts > 0 && !plainName(name) && !this.returning && runtime.phaseMode() !== 'drill') turn.line = `Next: ${name.charAt(0).toLowerCase()}${name.slice(1)}. ${turn.line}`;
      this.returning = false;
      this.startedParts += 1;
    }
    if (turn.mode === 'exact') {
      // The first time it is used, the word that means "right" is explained.
      const ack = ackFor(language);
      // ("Hai. That means yes." straight after their answer sounded like a
      // translation of what THEY had said.) Not if a reply beginning "hai, …"
      // has already been given with its English.
      if (!this.ackIntroduced && turn.line.startsWith(`${ack} `)) {
        const intro = ackIntro(language);
        const known = [...this.replies.keys()].some((key) => key.startsWith(`${fold(ack)} `));
        if (intro && !known) turn.line = `${intro} ${turn.line.slice(ack.length + 1)}`;
        this.ackIntroduced = true;
      }
      if (turn.reason === 'right' && turn.ordered) this.ordered.items.push(turn.ordered);
      // An order said back has been heard once more, like any other reply.
      if (turn.reason === 'right' && turn.echo) this.replies.set('desu ne', (this.replies.get('desu ne') || 0) + 1);
      // What was said back to them has now been heard once more.
      if (turn.reason === 'right' && turn.reply) {
        const key = fold(turn.reply);
        this.replies.set(key, (this.replies.get(key) || 0) + 1);
      }
    }
    return this.issue(turn, current);
  }

  /**
   * The student finished saying something, and the app is choosing the reply.
   *
   * Most answers the app can place from the transcript alone. When it cannot
   * — the words are there in another script, or nearly there, or it is hard
   * to say whether that was an answer at all — a text model is asked, and
   * only if that fails is the choice left to the tutor.
   *
   * @param {string} text what the student was heard to say
   * @param {{itemIds?: string[], unheard?: boolean}} [options] `itemIds`: the
   *        turn as the session knows it, so the model that heard it can be
   *        asked about it; `unheard`: they spoke, and nothing was written down
   * @returns {Promise<{instructions: string, turn: any}|null|false>} the turn
   *          to ask for; null for the tutor's standing instructions; false
   *          when the student has spoken again and this answer is not wanted
   */
  async answerStudent(text, { itemIds = [], unheard = false } = {}) {
    const raw = String(text || '');
    const mine = ++this.answering;
    const lessons = this.lessons;
    const runtime = lessons.runtime;
    this.studentTurns += 1;
    this.undo = null;
    this.fixed = false;

    let decided = null;
    // Asked to be drilled: before any other reading of it, in a lesson or out.
    // On 14 Oct "Drill me on the basic colors", "I want a drill" and "Keep
    // drilling me" got a lesson of new colours, a lesson on "single word not
    // sentences just a single word", and a teach line.
    if (this.directed && raw) {
      const offered = this.offer;
      this.offer = null;
      const finished = this.drillDone;
      this.drillDone = null;
      const inDrill = lessons.isActive && runtime.phaseMode() === 'drill' && runtime.scriptRunning();
      const drill = inDrill ? null : drillRequest(raw) || (finished && !lessons.isActive && wantsAgain(raw) ? { topic: finished.topic } : null);
      if (drill) {
        const own = lessons.isActive ? String(runtime.inputValues.topic || '').trim() : '';
        decided = this.startDrill(drill.topic || own || this.lastTopic, raw);
      } else if (offered && !lessons.isActive && isAffirmation(raw)) {
        // "You don't have colours on file yet. Want to learn them first?" — "Yes."
        const skill = lessons.skills.find((entry) => (entry.runtime_inputs || []).some((input) => input.type === 'text' && input.required));
        const input = skill && skill.runtime_inputs.find((entry) => entry.type === 'text' && entry.required);
        if (skill && input) decided = this.startTopic({ skillId: skill.id, inputId: input.id, topic: offered.topic }, raw);
      }
      if (decided) {
        this.fixed = true;
        this.observeStudent(raw);
        return decided;
      }
    }
    // "I want to talk about vocabulary, specifically vegetables." Said outside
    // a lesson, that left the tutor to make the lesson up — and it taught
    // "kore wa ni juu-san desu" for "this is a carrot". Said now, it starts
    // the lesson that is written from the reference and checked.
    if (this.directed && !lessons.isActive && raw) {
      // (Or, as the answer to the opening question, a subject on its own: "About colors".)
      const wanted = topicRequest(raw, lessons.skills) || (this.studentTurns === 1 ? openingTopic(raw, lessons.skills) : null);
      if (wanted && wanted.topic) {
        decided = this.startTopic(wanted, raw);
        if (decided) {
          this.fixed = true;
          this.observeStudent(raw);
          return decided;
        }
      }
    }
    // "No, I am not ready — go back." Asked whether they were ready for the
    // next part, a student said that, and was taken past it to the one after.
    if (lessons.isActive && raw) {
      const back = await this.wantsBack(raw);
      if (mine !== this.answering) return false;
      if (back) {
        this.fixed = true;
        decided = this.goBack(back, raw);
        this.observeStudent(raw);
        return decided;
      }
    }
    if (lessons.isActive && runtime.scriptRunning()) {
      // "Skip this", or a later part asked for by name: "can we go straight to
      // paying for things?" was once answered "You'd say, may I pay, please?".
      // "Skip this" is plain. "Can we do the shop stuff instead?" is not: which
      // part, if any, is asked of something that can read — matching words in
      // the parts' names sent "one more time" to the part called Time.
      // How things stand before anything about this turn is used up, so that
      // all of it can be put back if the reply is never heard.
      const before = { state: runtime.mark(), own: this.markOwn() };
      /** @param {any} reply the reply to this turn: it can be taken back */
      const kept = (reply) => {
        this.undo = { ...before, pending: this.pending };
        return reply;
      };
      let skip = Boolean(raw && wantsToMoveOn(raw, this.pending && this.pending.turn ? this.pending.turn.line || '' : ''));
      // They spoke over a line that was cut off part-way. Whatever it was, it
      // was not an answer to a question they had not finished hearing: the
      // rest of the line is said, and nothing is marked. (Unless they were
      // asking to move on: that is plain enough.)
      if (this.pending && this.pending.cut && !skip && !(raw && asksForPart(raw))) {
        const rest = this.resay();
        if (rest) {
          this.log('script.spokenOver', { phase: runtime.phaseId, text: raw.slice(0, 80) });
          this.observeStudent(raw);
          return kept(rest);
        }
      }
      /** @type {{id: string, name: string}|null|undefined} */
      let target;
      if (raw && !skip && asksForPart(raw) && !asksAgain(raw)) {
        const routed = await this.askPart(raw);
        if (mine !== this.answering) return false;
        target = routed === undefined ? this.skipTarget(raw) : routed;
        skip = Boolean(target);
        // The part they named is one already been through: that is going back.
        if (target && this.isEarlier(target.id)) {
          this.fixed = true;
          decided = this.goBack(target, raw);
          this.observeStudent(raw);
          return decided;
        }
      }
      if (skip) {
        this.fixed = true;
        decided = this.skipDirected(raw, target);
      } else {
        const more = Boolean(raw) && !asksHowToSay(raw) && asksForMore(raw);
        if (raw && (more || asksHowToSay(raw)) && runtime.addRequest(raw)) {
          // The parts still to come are rewritten with the request in view.
          this.log('script.request', { text: raw.slice(0, 160) });
          const next = runtime.nextPhase();
          if (next) this.ensurePlan(next.id);
        }
        // "Tell me about onions, potatoes and peppers": they are told it is
        // coming, and what was being asked is asked again.
        const at = runtime.cursors[runtime.phaseId] ?? -1;
        if (more && at >= 0 && runtime.currentScript()[at]) {
          const { language } = this.who();
          decided = this.issue({
            mode: 'exact', advances: false, reason: 'echo',
            line: `OK. Those are coming up. ${lineFor(runtime.currentScript()[at], language, { again: true })}`,
          }, at);
          this.observeStudent(raw);
          return kept(decided);
        }
        const heard = this.toTutorScript ? this.toTutorScript(raw) : raw;
        // The native writing is matched against the transcript as it came.
        const said = heard === raw ? raw : `${heard} ${raw}`;
        const echoed = this.echoOfAnswer(heard);
        if (echoed) {
          this.observeStudent(raw);
          return kept(echoed);
        }
        const repeated = raw ? this.repeatOfTold(heard, said) : null;
        if (repeated) {
          this.observeStudent(raw);
          return kept(repeated);
        }
        // They spoke and nothing was written down: counted, per step, so that
        // the second time running the lesson goes on instead of asking again.
        const here = runtime.cursors[runtime.phaseId] ?? -1;
        if (!raw && unheard) {
          const same = this.blank.phase === runtime.phaseId && this.blank.at === here;
          this.blank = { phase: runtime.phaseId, at: here, n: same ? this.blank.n + 1 : 1 };
        } else {
          this.blank = { phase: '', at: -1, n: 0 };
        }
        const blank = this.blank.n;
        const step = runtime.currentScript()[here] || null;
        const first = this.decideTurn(said, { dry: true, unheard: blank });
        let verdict = null;
        // Before a guess at what they said is used against them, the model
        // that heard it is asked — at the same time as the judge, so that
        // nobody waits for one and then the other.
        let ear = first && this.earWorth(first.turn, step, heard, said, null) ? this.startEar(step, itemIds) : null;
        if (first && first.turn.mode === 'judge' && raw && this.judge) {
          verdict = await this.askJudge(first.turn, raw);
          if (mine !== this.answering) {
            if (ear) ear.cancel();
            return false;
          }
          this.log('script.judged', { verdict: verdict ? verdict.verdict : null, heard: verdict ? verdict.heard : '' });
        }
        if (ear) {
          const probe = verdict ? this.decideTurn(said, { verdict, dry: true, unheard: blank }) : first;
          if (probe && this.earWorth(probe.turn, step, heard, said, verdict)) {
            const answer = hearsYes(await ear.result);
            if (mine !== this.answering) return false;
            this.log('script.ear', { step: here + 1, said: answer || null });
            if (answer === 'yes') verdict = { ok: true, verdict: 'right', heard: '', other: '', ear: true };
            // Nothing written down, and the model heard no speech either: a
            // cough, a click. Nothing is said about it — unless it stopped
            // the tutor before it could say something, which is then said.
            if (answer === 'nothing' && !raw) {
              this.blank = before.own.blank;
              const owed = this.resay();
              return owed ? kept(owed) : false;
            }
          } else {
            ear.cancel();
          }
          ear = null;
        }
        // "OK." "Yes." A remark. The same thing asked again, each time: a test
        // student was asked what "neko" meant eight times running. Asked a
        // third time, it is answered for them, as "I don't know" is, and the
        // lesson goes on.
        const probe = this.decideTurn(said, { verdict, unheard: blank, dry: true });
        // ("Can you say that again?" a third time is a fair request, not a stall.)
        const again = Boolean(probe && probe.turn && probe.turn.reason === 'echo') && !asksRepeat(said);
        const same = again && this.echoes.phase === runtime.phaseId && this.echoes.at === here;
        this.echoes = again ? { phase: runtime.phaseId, at: here, n: same ? this.echoes.n + 1 : 1 } : { phase: '', at: -1, n: 0 };
        decided = kept(this.echoes.n >= 3 ? this.decideTurn("I don't know", { unheard: 0 }) : this.decideTurn(said, { verdict, unheard: blank }));
      }
    } else if (lessons.isActive) {
      decided = this.decideTurn('');
    }
    this.observeStudent(raw);
    return decided;
  }

  /**
   * Is it worth asking the model that heard them whether they said it?
   *
   * Only where the answer is about to be called wrong, or could not be made
   * out, and the written version is no guide: where it reads as a plain
   * attempt a letter or two out ("gyuuni"), or as another thing they know, it
   * is believed.
   *
   * @param {any} turn what would be said as things stand
   * @param {any} step the step being answered
   * @param {string} heard what they said, in the tutor's script
   * @param {string} said that, and the transcript as it came
   * @param {any} verdict the judge's, if it has been asked
   */
  earWorth(turn, step, heard, said, verdict) {
    if (!this.hear || !turn || !step || step.kind === 'recognise' || step.kind === 'wrap') return false;
    const doubted = turn.mode === 'judge' ||
      (turn.mode === 'exact' && ['wrong', 'unclear', 'other', 'unheard'].includes(turn.reason));
    if (!doubted) return false;
    const answer = step.kind === 'scene' ? step.expect : step.say;
    if (!answer) return false;
    // A reply in a role-play is not right or wrong by its words: it is only
    // listened for when nothing at all was written down.
    if (step.kind === 'scene' && said) return false;
    const known = this.lessons.runtime.plannedItems();
    for (const text of [heard, verdict && verdict.heard]) {
      if (!text) continue;
      if (looksLikeQuestion(text) || givesUp(text) || nearMiss(text, answer)) return false;
      if (step.build && step.word && soundsLike(text, step.word)) return false;
    }
    return !(said && confusedWith(step, said, known));
  }

  /**
   * @param {any} step
   * @param {string[]} itemIds
   * @returns {{result: Promise<string>, cancel: () => void}|null}
   */
  startEar(step, itemIds) {
    if (!this.hear || !Array.isArray(itemIds) || !itemIds.length) return null;
    const { language } = this.who();
    try {
      const asked = this.hear(itemIds, earPrompt({
        language,
        answer: step.kind === 'scene' ? step.expect : step.say,
        meaning: step.kind === 'scene' ? step.cue : step.meaning,
      }));
      return asked && asked.result && typeof asked.cancel === 'function' ? asked : null;
    } catch {
      return null;
    }
  }

  /**
   * "It's ramu. Let's keep going. Quick round. What is chicken?" — "ramu."
   * Given an answer, a student says it: that is what being given it is for.
   * It is not their answer to the next thing, and is not marked as one.
   *
   * @param {string} heard in the tutor's script
   * @param {string} said that, and the transcript as it came
   * @returns {ReturnType<LessonConductor['asked']>|null}
   */
  repeatOfTold(heard, said) {
    const told = this.lastTold;
    const runtime = this.lessons.runtime;
    if (!told || told.phase !== runtime.phaseId || !runtime.scriptRunning()) return null;
    const steps = runtime.currentScript();
    const current = runtime.cursors[runtime.phaseId] ?? -1;
    const step = steps[current];
    if (!step || step.kind === 'wrap' || answersStep(step, said)) return null;
    if (fold(step.kind === 'scene' ? step.expect : step.say) === fold(told.say)) return null;
    if (!answersStep({ kind: 'recall', say: told.say, script: told.script }, said) && !soundsLike(heard, told.say)) return null;
    this.lastTold = null;
    const { language } = this.who();
    const line = `Yes, "${told.say}". ${lineFor(step, language, { again: true })}`;
    return this.issue({ mode: 'exact', line, advances: false, reason: 'echo' }, current);
  }

  /** What this keeps about the call that a reply can change. */
  markOwn() {
    return {
      replies: new Map(this.replies),
      ordered: { phase: this.ordered.phase, items: [...this.ordered.items] },
      ackIntroduced: this.ackIntroduced,
      startedParts: this.startedParts,
      returning: this.returning,
      lastAnswer: this.lastAnswer,
      lastTold: this.lastTold,
      blank: { ...this.blank },
      echoes: { ...this.echoes },
      pending: this.pending,
    };
  }

  /**
   * The reply now on its way will not be heard: the student went on speaking.
   * Take it back, so that everything they said can be answered as one turn.
   *
   * ("toumorokoshi to ramu…" — a breath — "…kudasai" was answered twice: once
   * for each half, and neither half was the answer.)
   *
   * @returns {boolean} false if it changed where the lesson is — a part
   *          skipped, gone back to, begun — and so cannot be taken back
   */
  retract() {
    // (Left alone entirely: if it is still being worked out, it still has to
    // be said — the lesson has already moved.)
    if (this.fixed) return false;
    // Whatever is still being worked out for what they said is dropped.
    this.answering += 1;
    const undo = this.undo;
    this.undo = null;
    if (!undo) return true;
    // Only if that reply is still the one waiting to be said.
    if (this.pending !== undo.pending) return true;
    if (!this.lessons.runtime.restore(undo.state)) return true;
    const own = undo.own;
    this.replies = own.replies;
    this.ordered = own.ordered;
    this.ackIntroduced = own.ackIntroduced;
    this.startedParts = own.startedParts;
    this.returning = own.returning;
    this.lastAnswer = own.lastAnswer;
    this.lastTold = own.lastTold;
    this.blank = own.blank;
    this.echoes = own.echoes;
    this.pending = own.pending;
    this.log('script.retract', { phase: this.lessons.runtime.phaseId });
    return true;
  }

  /**
   * Is this, as it stands, an answer to what was last asked? Then there is
   * nothing to wait for, however it ends ("genkin de").
   * @param {string} text as transcribed
   */
  completes(text) {
    const runtime = this.lessons.runtime;
    if (!this.directed || !this.lessons.isActive || !runtime.scriptRunning()) return false;
    const step = runtime.currentScript()[runtime.cursors[runtime.phaseId] ?? -1];
    if (!step || step.kind === 'wrap') return false;
    const raw = String(text || '');
    const heard = this.toTutorScript ? this.toTutorScript(raw) : raw;
    return answersStep(step, heard === raw ? raw : `${heard} ${raw}`);
  }

  /**
   * A sound that was not speech got in the way of something the tutor was
   * saying or about to say. Say it.
   *
   * @param {{cut?: boolean}} [options] `cut`: the tutor was speaking and was
   *        cut off, and has said nothing since
   * @returns {ReturnType<LessonConductor['asked']>|null} null when there is
   *          nothing that needs saying again
   */
  resay({ cut = false } = {}) {
    if (!this.directed) return null;
    const runtime = this.lessons.runtime;
    const pending = this.pending;
    // Asked for and never said — the sound stopped it before it began — or
    // said in part and cut off: then only the rest of it is owed.
    if (pending && !pending.counted && !pending.reissued && pending.turn && pending.turn.mode !== 'judge' && pending.phase === runtime.phaseId) {
      const turn = pending.turn;
      const rest = pending.cut && pending.partial && turn.mode === 'exact' ? remainderOf(pending.partial, turn.line) : '';
      this.log('script.resay', { why: pending.cut ? 'cut' : 'unsaid' });
      if (pending.cut) {
        pending.cut = false;
        pending.reissued = true;
      }
      if (!rest) pending.partial = '';
      return this.asked(rest ? { ...turn, line: rest } : turn);
    }
    if (!cut || !this.lessons.isActive || !runtime.scriptRunning()) return null;
    const current = runtime.cursors[runtime.phaseId] ?? -1;
    const step = runtime.currentScript()[current];
    if (!step) return null;
    const { language } = this.who();
    this.log('script.resay', { why: 'cut', step: current + 1 });
    return this.issue({ mode: 'exact', line: lineFor(step, language, { again: true }), advances: false, reason: 'echo' }, current);
  }

  /**
   * The tutor has just answered "how do I ask for the check?", and the student
   * says the phrase it gave. That is what anyone would do, and it is not an
   * answer to the lesson's question — so it is not marked as a wrong one.
   *
   * ("Okaikei onegaishimasu" — "Not quite. It's reshiito o onegaishimasu.")
   *
   * @param {string} heard
   * @returns {ReturnType<LessonConductor['asked']>|null}
   */
  echoOfAnswer(heard) {
    const answer = this.lastAnswer;
    this.lastAnswer = null;
    const runtime = this.lessons.runtime;
    if (!answer || !heard || answer.phase !== runtime.phaseId) return null;
    const words = fold(heard).split(' ').filter(Boolean);
    if (!words.length || fold(heard).length < 4) return null;
    const given = ` ${fold(answer.text)} `;
    if (!given.includes(` ${words.join(' ')} `)) return null;
    const steps = runtime.currentScript();
    const current = runtime.cursors[runtime.phaseId] ?? -1;
    const step = steps[current];
    if (!step || answersStep(step, heard)) return null;
    const { language } = this.who();
    const line = `${ackFor(language)} ${lineFor(step, language, { again: true })}`;
    return this.issue({ mode: 'exact', line, advances: false, reason: 'echo' }, current);
  }

  /**
   * Start a lesson on a subject the student has just named, outside any lesson.
   * @param {{skillId: string, inputId: string, topic: string}} wanted
   * @param {string} request their words
   */
  startTopic(wanted, request) {
    const lessons = this.lessons;
    const result = lessons.activate(wanted.skillId, { reason: 'voice' });
    if (!result || !result.ok) return null;
    const runtime = lessons.runtime;
    if (!runtime.setInput(wanted.inputId, wanted.topic, 'user').ok) return null;
    // The part that exists to settle the subject is over: it is settled.
    if (runtime.phaseMode() === 'talk' && runtime.pendingInputs().length === 0 && runtime.nextPhase()) lessons.advancePhase();
    this.log('lesson.topic', { lesson: wanted.skillId, topic: wanted.topic, request: String(request).slice(0, 160) });
    this.lastTopic = wanted.topic;
    this.note(`Lesson started: ${result.skill?.name || 'lesson'} — ${wanted.topic}.`, 'info');
    this.syncPrompt();
    this.refresh();
    this.heldForPlan = true;
    this.ensurePlan();
    return this.issue({ mode: 'exact', line: 'OK. One moment.', advances: false, reason: 'wait' });
  }

  /**
   * Start a drill of words the student already has.
   *
   * Whatever is running is ended first; what it taught goes into the call's
   * record, and the drill is made from that and the saved words.
   *
   * @param {string} topic what to drill; "" for the newest words
   * @param {string} request their words
   */
  startDrill(topic, request) {
    const lessons = this.lessons;
    const skill = lessons.skills.find((entry) => (entry.phases || []).some((phase) => phase.mode === 'drill'));
    if (!skill) return null;
    const runtime = lessons.runtime;
    if (runtime.skill) runtime.deactivate({ reason: 'drill', silent: true });
    const result = lessons.activate(skill.id, { reason: 'voice' });
    if (!result || !result.ok) return null;
    const subject = String(topic || '').trim();
    if (subject) {
      runtime.setInput('topic', subject, 'user');
      this.lastTopic = subject;
    }
    this.log('lesson.drill', { topic: subject, request: String(request).slice(0, 160) });
    this.note(`Drill: ${subject || 'your newest words'}.`, 'info');
    this.syncPrompt();
    this.refresh();
    this.heldForPlan = true;
    this.ensurePlan();
    return this.issue({ mode: 'exact', line: 'OK. One moment.', advances: false, reason: 'wait' });
  }

  /** The student's saved words, as things to ask for. Parsed once per change of profile. */
  savedItems() {
    const saved = (this.getProfile() || {}).recent_vocab;
    if (this.saved && this.saved.from === saved) return this.saved.items;
    this.saved = { from: saved, items: vocabItems(saved) };
    return this.saved.items;
  }

  /** The words a drill may use: saved ones, and everything taught on this call. */
  drillCandidates() {
    const seen = new Set();
    const out = [];
    for (const item of [...this.savedItems(), ...this.lessons.runtime.callItems()]) {
      const key = fold(item.say);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ say: item.say, meaning: item.meaning, script: item.script || '' });
    }
    return out;
  }

  /**
   * Too few words for a drill (or none could be chosen). The drill is ended
   * and a lesson on the subject is offered; "yes" starts it.
   * @param {string} topic
   */
  drillTooShort(topic) {
    const runtime = this.lessons.runtime;
    this.log('lesson.drillShort', { topic });
    if (runtime.skill) runtime.deactivate({ reason: 'too few words', silent: true });
    this.syncPrompt();
    this.refresh();
    this.heldForPlan = false;
    this.offer = topic ? { topic } : null;
    const line = topic
      ? `You don't have ${topic} on file yet. Want to learn them first?`
      : "There aren't enough words on file to drill yet. What would you like to learn?";
    this.speak(this.asked({ mode: 'exact', line, advances: false, reason: 'offer' }), { after: true });
  }

  /** Is this part one that comes before the part in progress? */
  isEarlier(phaseId) {
    const phases = this.lessons.runtime.skill?.phases || [];
    const at = phases.findIndex((phase) => phase.id === phaseId);
    return at >= 0 && at < phases.findIndex((phase) => phase.id === this.lessons.runtime.phaseId);
  }

  /**
   * Is the student asking to go back — and to which part?
   *
   * Two moments. Asked "Ready for the next part?", any kind of no means the
   * part that has just closed. And at any time, "go back" or "I did not want
   * you to move on" means the part they name, or failing that the one the
   * lesson was in before this.
   *
   * @param {string} raw their words
   * @returns {Promise<{id: string, name: string}|null>}
   */
  async wantsBack(raw) {
    const runtime = this.lessons.runtime;
    const closed = this.lastFinished;
    const atDoor = Boolean(closed) && closed.next === runtime.phaseId && (runtime.cursors[runtime.phaseId] ?? -1) < 0 &&
      !(this.pending && this.pending.phase === runtime.phaseId);
    if (atDoor && declinesToGoOn(raw)) return { id: closed.id, name: closed.name };
    if (!objectsToMoving(raw)) return null;
    const routed = await this.askPart(raw, { anywhere: true });
    if (routed && routed.id !== runtime.phaseId) return this.isEarlier(routed.id) || routed.id === this.cameFrom?.id ? routed : null;
    // Asked, and told it is not a request to go anywhere: "I didn't mean that".
    if (routed === null) return null;
    // Nobody could say which: the part they were in before.
    const before = this.cameFrom && this.cameFrom.id !== runtime.phaseId ? this.cameFrom : null;
    if (before) return before;
    const phases = runtime.skill?.phases || [];
    const index = phases.findIndex((phase) => phase.id === runtime.phaseId);
    const previous = phases.slice(0, Math.max(0, index)).reverse().find((phase) => phase.mode !== 'review' && phase.mode !== 'talk');
    return previous ? { id: previous.id, name: previous.name } : null;
  }

  /**
   * Take the lesson back to a part, and go through it again.
   * @param {{id: string, name: string}} part
   * @param {string} request the student's own words
   */
  goBack(part, request) {
    const lessons = this.lessons;
    const runtime = lessons.runtime;
    const from = runtime.currentPhase()?.name || '';
    const leaving = runtime.phaseId;
    if (leaving !== part.id) runtime.shelve(leaving);
    const again = runtime.redoPart(part.id);
    if (!again) runtime.setPhase(part.id, 'the student asked to go back');
    this.lastFinished = null;
    this.cameFrom = null;
    this.pending = null;
    this.returning = true;
    this.log('script.back', { from, to: part.name, redo: again, request: String(request).slice(0, 160) });
    this.note(`Going back to: ${part.name}.`, 'info');
    this.syncPrompt();
    this.refresh();
    const name = `${part.name.charAt(0).toLowerCase()}${part.name.slice(1)}`;
    if (runtime.scriptRunning()) {
      const decided = this.decideTurn('');
      if (decided && decided.turn.mode === 'exact') {
        decided.turn.line = `OK. Back to ${name}. ${decided.turn.line}`;
        return this.asked(decided.turn);
      }
    }
    // Its material has to be written (again).
    this.heldForPlan = true;
    this.ensurePlan();
    return this.issue({ mode: 'exact', line: `OK. Back to ${name}. One moment.`, advances: false, reason: 'wait' });
  }

  /**
   * Which other part of the lesson, if any, is the student asking for?
   * @param {string} request their words
   * @param {{anywhere?: boolean}} [options] earlier parts as well as later ones
   * @returns {Promise<{id: string, name: string}|null|undefined>} the part;
   *          null for none; undefined when there was nobody to ask
   */
  async askPart(request, { anywhere = false } = {}) {
    if (!this.judge) return undefined;
    const runtime = this.lessons.runtime;
    const phases = runtime.skill?.phases || [];
    const index = phases.findIndex((phase) => phase.id === runtime.phaseId);
    const usable = (phase) => phase.mode !== 'review' && phase.mode !== 'talk';
    const earlier = anywhere ? phases.slice(0, Math.max(0, index)).filter(usable) : phases.slice(0, Math.max(0, index)).filter((phase) => usable(phase) && runtime.visited.has(phase.id));
    const later = [...earlier, ...phases.slice(index + 1).filter(usable)];
    if (!later.length) return null;
    const here = phases[index] || {};
    try {
      const answer = await Promise.race([
        this.judge({
          kind: 'part',
          language: this.who().language,
          transcript: request,
          current: { name: here.name || '', purpose: here.purpose || '' },
          parts: later.map((phase) => ({
            id: phase.id, name: phase.name, purpose: phase.purpose || '', done: earlier.includes(phase),
          })),
          before: this.cameFrom && this.cameFrom.id !== runtime.phaseId ? this.cameFrom.id : '',
        }),
        new Promise((resolve) => { setTimeout(() => resolve(null), this.judgeMs); }),
      ]);
      if (!answer || !answer.ok) return undefined;
      const picked = later.find((phase) => phase.id === answer.part);
      this.log('script.routed', { request: String(request).slice(0, 160), part: picked ? picked.id : null });
      return picked ? { id: picked.id, name: picked.name } : null;
    } catch {
      return undefined;
    }
  }

  /**
   * @param {any} turn a turn in 'judge' mode
   * @param {string} transcript what the student said, as transcribed
   * @returns {Promise<{verdict: string, heard: string, other: string}|null>}
   */
  async askJudge(turn, transcript) {
    const { language } = this.who();
    const runtime = this.lessons.runtime;
    try {
      const answer = await Promise.race([
        this.judge({
          language,
          kind: turn.kind,
          say: turn.say,
          meaning: turn.meaning,
          also: turn.also,
          asked: turn.asked,
          transcript,
          taught: runtime.plannedItems().slice(-12),
          line: turn.line || '',
          lineMeaning: turn.lineMeaning || '',
        }),
        new Promise((resolve) => { setTimeout(() => resolve(null), this.judgeMs); }),
      ]);
      return answer && answer.ok ? answer : null;
    } catch {
      return null;
    }
  }

  /**
   * Have the tutor begin the part in progress, now, without waiting to be
   * spoken to.
   * @returns {boolean} whether there was a line to begin with
   */
  startPart() {
    const decided = this.decideTurn('');
    if (!decided) return false;
    // Behind anything already waiting to be said ("OK. One moment.").
    this.speak(decided, { after: true });
    return true;
  }

  /**
   * The first thing the tutor says on a call that starts inside a lesson.
   * @returns {ReturnType<LessonConductor['asked']>|null}
   */
  openingTurn() {
    const lessons = this.lessons;
    const runtime = lessons.runtime;
    if (!this.directed || !lessons.isActive || !runtime.scriptRunning()) return null;
    const { language, student } = this.who();
    const steps = runtime.currentScript();
    const current = runtime.cursors[runtime.phaseId] ?? -1;
    const turn = turnFor(steps, { language, current, heard: '', taught: runtime.taught });
    if (!turn || turn.mode !== 'exact') return null;
    const hello = student && !/^(the )?student$/i.test(student) ? `Hi ${student}.` : 'Hi.';
    this.startedParts += 1;
    turn.line = `${hello} ${turn.line}`;
    turn.reason = 'opening';
    return this.issue(turn, current);
  }

  /**
   * The tutor has taken a turn the app chose. Work out where that leaves the
   * lesson: on the next step, or still on this one.
   * @param {string} text what it said
   */
  settleTurn(text, { cut = false } = {}) {
    const lessons = this.lessons;
    const runtime = lessons.runtime;
    const pending = this.pending;
    if (!pending || pending.phase !== runtime.phaseId || !runtime.scriptRunning()) return;

    const { turn, current } = pending;
    // "One moment." — said while the part's first line waits behind it,
    // because the material arrived before the tutor had finished saying so.
    // It is not a failed attempt at that line, and the line is not asked for
    // a second time on account of it.
    if (turn.reason !== 'wait' && /^(?:ok\W+)?one moment\W*$/i.test(String(text).trim())) return;
    const steps = runtime.currentScript();
    const next = steps[current + 1];
    const { language } = this.who();
    const nextLine = next ? lineFor(next, language) : '';
    const here = (runtime.cursors[runtime.phaseId] ?? -1) === current;
    // A line that was cut short and then finished is one line.
    const said = pending.partial ? `${pending.partial} ${text}` : String(text);
    // A phrase of the line said wrongly ("kaardo de") is not the line.
    const misread = turn.mode === 'exact' && !pending.reissued && wentOn(said, turn.line) && !saysPhrases(said, turn.line);

    // The lesson goes on only when the turn was meant to take it on, and did.
    // (Without the first half, a tutor answering "which meat?" by listing
    // four of them was taken to have taught the next one.)
    if (turn.advances !== false && here && !misread && wentOn(said, nextLine)) {
      this.pending = null;
      // Anything said beyond the line is logged: an answer given away, or a
      // script the student cannot read.
      if (turn.mode === 'exact' && (containsOtherScript(text) || text.length > String(turn.line).length * 1.25 + 12)) {
        this.log('script.leak', { phase: runtime.phaseId, said: String(text).slice(0, 200), wanted: turn.line });
      }
      const result = runtime.moveTo(current + 1);
      this.log('script.step', { phase: runtime.phaseId, step: result.current + 1, of: result.total });
      // Have the next part written before it is needed, so there is no gap.
      if (result.current + 1 >= result.total / 2) {
        const following = this.followingPhase();
        if (following) this.ensurePlan(following.id);
      }
      if (result.complete) this.finishPart();
      else this.refresh();
      return;
    }

    // Stopped part-way by the student, or by a sound. That is not the tutor
    // failing to say its line, and the line is not asked for again here and
    // now — on top of whoever is speaking. What stopped it is settled first:
    // a noise, and the rest of the line is said (see `resay`); the student,
    // and they are answered.
    if (cut && turn.mode === 'exact' && !pending.counted && !pending.reissued && !wentOn(said, turn.line)) {
      pending.cut = true;
      pending.partial = remainderOf(said, turn.line) ? said : '';
      this.log('script.cut', { phase: runtime.phaseId, said: String(text).slice(0, 160) });
      return;
    }

    // What the tutor composed in answer to a question is kept for one turn:
    // if the student says it back, they are not answering the lesson.
    if (turn.mode === 'question' && !pending.counted) this.lastAnswer = { text: String(text), phase: runtime.phaseId };

    // A reply can arrive as more than one message; count it once.
    if (pending.counted) return;
    pending.counted = true;
    if (turn.mode === 'question' || turn.reason === 'wait' || turn.reason === 'end' || turn.reason === 'echo' || turn.reason === 'unheard') return;
    if (turn.mode === 'exact' && (misread || !wentOn(said, turn.line))) {
      // It was given the line and did not say it — it said a piece of it,
      // usually. The student has heard something that is not a request, so
      // the line is asked for again, once, rather than leaving them waiting.
      this.log('script.offScript', { phase: runtime.phaseId, said: String(text).slice(0, 160), wanted: turn.line });
      if (!pending.reissued) {
        pending.reissued = true;
        pending.counted = false;
        // If what it said was the beginning of the line, only the rest is
        // asked for: nobody wants the first half twice.
        const rest = misread ? '' : remainderOf(said, turn.line);
        if (rest) pending.partial = said;
        this.speak(this.asked(rest ? { ...turn, line: rest } : turn), { after: true });
        return;
      }
    }
    if (turn.advances) return;
    // A correction: the same thing is being asked for once more.
    const tries = runtime.noteRetry();
    this.log('script.retry', { phase: runtime.phaseId, step: current + 1, tries });
  }

  /** The part that will follow this one: a part passed over earlier, or the next in order. */
  followingPhase() {
    const runtime = this.lessons.runtime;
    const phases = runtime.skill?.phases || [];
    if (runtime.revisit.length) return phases.find((phase) => phase.id === runtime.revisit[0]) || null;
    return runtime.nextPhase();
  }

  /**
   * The student asked to leave this part behind, and the app is choosing the
   * tutor's words: end the part and give the tutor the first line of the next.
   * @param {string} request the student's own words
   * @param {{id: string, name: string}|null} [wanted] the part they asked for,
   *        when that has already been worked out
   * @returns {{instructions: string, turn: any}|null}
   */
  skipDirected(request, wanted) {
    const lessons = this.lessons;
    const runtime = lessons.runtime;
    const from = runtime.currentPhase()?.name || '';
    const lessonName = runtime.skill?.name || 'lesson';
    if (request) runtime.addRequest(request);
    const target = wanted !== undefined ? wanted : this.skipTarget(request);
    const leaving = runtime.phaseId;
    // A part asked away from before it began was not said to be known: it
    // had only been announced. It is kept for later, like the ones passed over.
    const begun = (runtime.cursors[leaving] ?? -1) >= 0 || Boolean(this.pending && this.pending.phase === leaving);
    const untouched = Boolean(target) && !begun;
    this.cameFrom = { id: leaving, name: from };
    this.lastFinished = null;
    if (!untouched) runtime.abandonPart();
    const moved = target
      ? { ...runtime.setPhase(target.id, 'the student asked for it'), phaseName: target.name }
      : lessons.advancePhase();
    // Going straight to what they asked for passes over parts they did not
    // say they knew. Those come afterwards, rather than never.
    if (target && moved.ok) runtime.passOver(leaving, target.id, { including: untouched });
    this.log('script.skip', { from, to: moved.ok ? moved.phaseName : null, request: String(request).slice(0, 160) });

    if (!moved.ok) {
      runtime.complete({ summary: '' });
      this.note('Lesson complete. The call continues.', 'success');
      this.syncPrompt();
      this.refresh();
      return this.issue({
        mode: 'exact', advances: false, reason: 'end',
        line: `OK. That was the last part of the ${lessonName} lesson. What would you like to do now?`,
      });
    }

    this.note(`Moving on to: ${moved.phaseName}.`, 'info');
    this.syncPrompt();
    this.refresh();
    if (runtime.scriptRunning()) {
      const decided = this.decideTurn('');
      if (decided && decided.turn.mode === 'exact') {
        decided.turn.line = `OK. ${decided.turn.line}`;
        return this.asked(decided.turn);
      }
    }
    // The next part has to be written first — around what they just asked for.
    this.heldForPlan = true;
    this.ensurePlan();
    return this.issue({ mode: 'exact', line: 'OK. One moment.', advances: false, reason: 'wait' });
  }

  /**
   * Which part did they ask for? "Can we do paying for things" should go to
   * the part about paying, not merely to whichever part comes next.
   * @param {string} request
   * @returns {{id: string, name: string}|null} a later part, or null for the next one
   */
  skipTarget(request) {
    const runtime = this.lessons.runtime;
    const phases = runtime.skill?.phases || [];
    const index = phases.findIndex((phase) => phase.id === runtime.phaseId);
    const stems = (text) => fold(text).split(' ').filter((word) => word.length >= 4).map((word) => word.slice(0, 4));
    // "Can we try that one more time?" is not a request for the part on Time.
    if (asksAgain(request)) return null;
    const wanted = new Set(stems(request));
    // Words that say "move on" rather than what to move on to.
    for (const noise of ['some', 'thin', 'actu', 'alre', 'know', 'move', 'skip', 'part', 'less', 'next', 'like', 'will', 'want', 'numb']) {
      wanted.delete(noise);
    }
    if (!wanted.size) return null;
    for (const phase of phases.slice(index + 1)) {
      if (phase.mode === 'review' || phase.mode === 'talk') continue;
      if (stems(phase.name).some((stem) => wanted.has(stem))) return { id: phase.id, name: phase.name };
    }
    return null;
  }

  /**
   * The tutor finished saying something.
   *
   * This is what keeps the app's idea of the lesson attached to the
   * conversation: the step the tutor has reached is read off its own words. A
   * part ends when its script does — deterministically, here — instead of
   * whenever a second model happened to notice.
   *
   * @param {string} text
   */
  handleTutorTurn(text, { cut = false } = {}) {
    const lessons = this.lessons;
    if (!text || !lessons.isActive) return;
    const runtime = lessons.runtime;

    if (this.directed) {
      if (this.startWhenQuiet) {
        // The material for this part arrived while the tutor was answering.
        this.startWhenQuiet = false;
        if (runtime.scriptRunning() && (runtime.cursors[runtime.phaseId] ?? -1) < 0 && !this.pending) {
          this.startPart();
          return;
        }
      }
      this.settleTurn(text, { cut });
      return;
    }

    // Told to wait for this part's material, and it has: someone has to
    // speak when it arrives, and the student has been asked not to.
    if (/\bone moment\b/i.test(text)) {
      if (runtime.planning.has(runtime.phaseId)) {
        this.heldForPlan = true;
      } else if (runtime.scriptRunning() && (runtime.cursors[runtime.phaseId] ?? -1) < 0) {
        // It arrived while the tutor was saying so.
        this.nudge('The material for this part is ready. Your turn is the line given under RIGHT NOW.', { speak: true });
        return;
      }
    }

    const result = runtime.noteTutorTurn(text);
    if (!result.moved) {
      if (!result.total) return;

      // "OK." and nothing else is what the tutor is told to say when they ask
      // to move on. The request may not have matched the app's own check, so
      // the tutor's judgement counts too — once per request.
      if (isBareOk(text) && runtime.scriptRunning() && this.skipTurn !== this.studentTurns) {
        this.skipTurn = this.studentTurns;
        const last = [...this.getTranscript()].reverse().find((entry) => entry.role === 'user');
        this.skipPart(last ? last.text : '');
        return;
      }

      // The answer contained exactly what was asked for and the tutor did not
      // go on; or it asked for something that is not in the script at all; or
      // a line has now been offered so many times that it was taken out.
      if (result.falseCorrection) this.log('script.falseCorrection', { phase: runtime.phaseId });
      if (result.offScript) this.log('script.offScript', { phase: runtime.phaseId, said: String(text).slice(0, 160) });
      if (result.dropped && result.dropped.length) {
        this.log('script.dropped', {
          phase: runtime.phaseId,
          lines: result.dropped.map((step) => `${step.kind}: ${step.say || step.tutor || ''}`),
        });
      }
      if (result.gaveUp) {
        this.log('script.gaveUp', { phase: runtime.phaseId });
        this.finishPart();
        return;
      }
      // What the tutor is shown depends on how many turns it has now taken
      // without saying its line, so it is rebuilt on every one.
      this.syncPrompt();
      this.refresh();
      return;
    }

    this.log('script.step', { phase: runtime.phaseId, step: result.current + 1, of: result.total });

    // Have the next part written before it is needed, so there is no gap.
    if (result.current + 1 >= result.total / 2) {
      const next = runtime.nextPhase();
      if (next) this.ensurePlan(next.id);
    }

    if (result.complete) {
      this.finishPart();
      return;
    }

    // Tell the tutor where it has got to. The conversation it can see is
    // trimmed as the call goes on; this line is how it keeps its place.
    this.syncPrompt();
    this.refresh();
  }

  /**
   * Move to the next part: one passed over earlier, if there is one, and
   * otherwise the next in order after the furthest the lesson has been.
   */
  advance() {
    const lessons = this.lessons;
    const runtime = lessons.runtime;
    const phases = runtime.skill?.phases || [];
    if (runtime.revisit.length) {
      const id = runtime.revisit.shift();
      const phase = phases.find((entry) => entry.id === id);
      if (phase && runtime.setPhase(id, 'passed over earlier').ok) return { ok: true, phaseName: phase.name, last: false };
    }
    const furthest = runtime.furthestPhase();
    if (furthest && furthest !== runtime.phaseId) {
      const index = phases.findIndex((entry) => entry.id === furthest);
      // The furthest part may never have been begun: the lesson went back
      // from its doorstep. It is next, not the one after it.
      if (phases[index] && !runtime.finishedParts[furthest] && runtime.setPhase(furthest, 'carrying on').ok) {
        return { ok: true, phaseName: phases[index].name, last: index + 1 >= phases.length };
      }
      const after = phases[index + 1];
      if (!after) return { ok: false, phaseName: '', last: true };
      runtime.setPhase(after.id, 'carrying on');
      return { ok: true, phaseName: after.name, last: index + 2 >= phases.length };
    }
    return lessons.advancePhase();
  }

  /** The script for the part in progress has been walked to its end. */
  finishPart() {
    const lessons = this.lessons;
    const runtime = lessons.runtime;
    const from = runtime.currentPhase()?.name || '';
    const lessonName = runtime.skill?.name || 'lesson';

    runtime.creditCurrentPhase();
    const closed = { id: runtime.phaseId, name: from };
    const moved = this.advance();

    if (moved.ok) {
      this.cameFrom = closed;
      this.lastFinished = { ...closed, next: runtime.phaseId };
      this.log('lesson.partComplete', { from, to: moved.phaseName });
      this.note(`Moving on to: ${moved.phaseName}.`, 'info');
      this.ensurePlan();
      this.syncPrompt();
      this.refresh();
      if (!this.directed) {
        this.nudge('That part is finished. When they answer, your next turn is the line given under RIGHT NOW.');
      }
      return;
    }

    if (moved.last) {
      this.log('lesson.partComplete', { from, to: null });
      if (runtime.phaseMode() === 'drill') this.drillDone = { topic: String(runtime.inputValues.topic || '').trim() };
      runtime.complete({ summary: '' });
      this.note('Lesson complete. The call continues.', 'success');
      this.syncPrompt();
      this.refresh();
      if (this.directed) {
        // The closing line has said so. ("Ready for the next part?" — "Yes." —
        // "You've finished the lesson. Nice job, so we'll move to conversation.")
        this.nudge(
          `The ${lessonName} lesson is finished, and the student has just been told so. Do not say it ` +
            'again, do not congratulate them and do not sum it up. If they say nothing in particular, ask ' +
            'in one short sentence what they would like to do next.',
        );
      } else {
        this.nudge(
          `The ${lessonName} lesson is finished. Say so in one sentence in your next turn, then carry ` +
            'on with ordinary conversation.',
        );
      }
    }
  }

  /**
   * The student asked to leave this part behind.
   *
   * A request to skip was once answered with "I'm going to continue with the
   * lesson", because the only thing the tutor had been given to move on to was
   * the next drill. Here the part ends, the next one is written around what
   * they asked for, and the tutor starts it.
   *
   * @param {string} [request] the student's own words
   * @returns {Promise<boolean>} whether the lesson moved
   */
  async skipPart(request = '') {
    const lessons = this.lessons;
    const runtime = lessons.runtime;
    if (this.skipping || !lessons.isActive || !runtime.scriptRunning()) return false;
    this.skipping = true;
    try {
      const from = runtime.currentPhase()?.name || '';
      const lessonName = runtime.skill?.name || 'lesson';
      if (request) runtime.addRequest(request);
      runtime.abandonPart();
      const moved = lessons.advancePhase();
      this.log('script.skip', { from, to: moved.ok ? moved.phaseName : null, request: String(request).slice(0, 160) });

      if (moved.ok) {
        this.note(`Moving on to: ${moved.phaseName}.`, 'info');
        await this.beginPart('They asked to move on. Your turn is the line given under RIGHT NOW, and nothing before it.');
        return true;
      }

      runtime.complete({ summary: '' });
      this.note('Lesson complete. The call continues.', 'success');
      this.syncPrompt();
      this.refresh();
      this.nudge(
        `That was the last part of the ${lessonName} lesson. Say so in one sentence, then carry on ` +
          'with ordinary conversation.',
        { speak: true },
      );
      return true;
    } finally {
      this.skipping = false;
    }
  }

  /**
   * The student finished saying something.
   *
   * Everything the tutor is told from here is PASSIVE — it shapes the tutor's
   * next turn and does not make it speak — because the tutor is already
   * answering this very utterance. The one exception is a lesson the student
   * has just asked for by voice.
   *
   * @param {string} text what the student was heard to say
   * @returns {{instructions: string, turn: any}|null} when the app is choosing
   *          the tutor's words, the turn to ask for; null when the tutor's
   *          standing instructions apply
   */
  handleStudentTurn(text) {
    const heard = String(text || '');
    if (!this.directed) {
      this.observeStudent(heard);
      return null;
    }

    const lessons = this.lessons;
    const runtime = lessons.runtime;
    let decided = null;
    this.studentTurns += 1;
    if (lessons.isActive && runtime.scriptRunning()) {
      if (heard && wantsToMoveOn(heard)) {
        decided = this.skipDirected(heard);
      } else {
        if (heard && asksHowToSay(heard) && runtime.addRequest(heard)) {
          // The parts still to come are rewritten with the request in view.
          this.log('script.request', { text: heard.slice(0, 160) });
          const next = runtime.nextPhase();
          if (next) this.ensurePlan(next.id);
        }
        decided = this.decideTurn(this.toTutorScript ? this.toTutorScript(heard) : heard);
      }
    } else if (lessons.isActive) {
      decided = this.decideTurn('');
    }
    this.observeStudent(heard);
    return decided;
  }

  /**
   * Everything the app does about a student's turn other than choosing the
   * reply: counting it, moving a lesson that is going nowhere, starting a
   * lesson they asked for, and scheduling the Lesson Director.
   * @param {string} text
   */
  observeStudent(text) {
    const lessons = this.lessons;
    // The catalogue may be empty while a lesson is still running — the library
    // could have been reloaded mid-call — and "let's just chat" has to work
    // then too, so the guard checks both.
    if (!text || (!lessons.skills.length && !lessons.isActive)) return;

    const { needsPromptRefresh, autoAdvanced } = lessons.noteStudentTurn();

    // Note whether the answer was certainly right, so that a tutor who then
    // corrects it can be told. Nothing here moves the script: its place is
    // read off the tutor's words and nothing else.
    if (!this.directed) this.studentTurns += 1;
    if (lessons.isActive && !this.directed) {
      const runtime = lessons.runtime;
      const heard = this.toTutorScript ? this.toTutorScript(text) : text;
      runtime.noteStudentAnswer(heard);

      if (runtime.scriptRunning() && wantsToMoveOn(text)) {
        this.skipTurn = this.studentTurns;
        this.skipPart(text);
      } else if (asksHowToSay(text) && runtime.addRequest(text)) {
        // They asked for the words for something. The parts still to come are
        // rewritten with that in view, starting now so there is no gap.
        this.log('script.request', { text: String(text).slice(0, 160) });
        const next = runtime.nextPhase();
        if (next) this.ensurePlan(next.id);
      }
    }

    if (autoAdvanced) {
      this.log('lesson.autoAdvance', { from: autoAdvanced.from, to: autoAdvanced.to });
      this.note(`Moving on to: ${autoAdvanced.to}.`, 'info');
      this.nudge(
        `The lesson has moved on to ${autoAdvanced.to}. From your next turn, work on that. ` +
          'Do not announce the change, and do not go back over what they already got right.',
      );
    }

    if (needsPromptRefresh) {
      this.syncPrompt();
      this.refresh();
    }

    // Every few turns, have the Director read what actually happened — and on
    // every turn while the lesson is still waiting to hear what the student
    // wants to work on, because nothing can be planned until it knows.
    if (lessons.isActive) {
      this.turnsSinceDirector += 1;
      const waiting = lessons.runtime.pendingInputs().length > 0;
      if (waiting || this.turnsSinceDirector >= DIRECTOR_EVERY_TURNS) {
        this.turnsSinceDirector = 0;
        this.scheduleDirector();
      }
    }

    const outcome = lessons.observeStudentTurn(text);
    if (outcome.action === 'activated') {
      this.note(`Lesson started: ${outcome.skill?.name || 'lesson'}.`, 'info');
      // The student's own words started this, and the tutor is already
      // answering them. Forcing a second turn here stacked two openings on top
      // of each other; instead the lesson's material is written while it
      // replies, and its next turn begins the script.
      this.nudge(
        `The ${outcome.skill?.name || 'lesson'} lesson has started, because the student asked ` +
          'for it. From your next turn, follow the lesson instructions you have just been given. ' +
          'If the lesson needs something settled first, ask for it in one short question.',
      );
      this.ensurePlan();
    } else if (outcome.action === 'ended') {
      this.note(
        `Lesson ended: ${outcome.skill?.name || 'lesson'}. Back to normal conversation.`,
        'info',
      );
    } else {
      return;
    }

    this.refresh();
    this.syncPrompt();
  }

  /** Schedule the Director, coalescing bursts of turns into one call. */
  scheduleDirector() {
    if (this.directorTimer) return;
    this.directorTimer = setTimeout(() => {
      this.directorTimer = null;
      this.directorRun = this.runDirector()
        .catch(noop) // the lesson carries on unchanged
        .finally(() => { this.directorRun = null; });
    }, this.delayMs);
  }

  /**
   * Ask the Lesson Director what has happened, and act on it.
   *
   * The tutor has no tools. This runs out of band on a cheap text model, so the
   * conversation is never paused for bookkeeping, and it is fire-and-forget: if
   * it fails, the lesson simply carries on.
   */
  async runDirector() {
    const lessons = this.lessons;
    const profile = this.getProfile();
    if (!lessons.isActive || !this.isLive() || !profile) return;

    const before = lessons.runtime.snapshot();
    const excerpt = this.getTranscript().slice(-DIRECTOR_TURNS);
    this.log('director.request', {
      lesson: lessons.activeId,
      phase: before.phase,
      turns: excerpt.length,
      turnsInPhase: before.turns_in_phase,
    });

    const result = await lessons.runDirector(excerpt, {
      language: profile.target_language,
      level: profile.proficiency_level,
    });

    this.log('director.response', { ok: result.ok, error: result.error, applied: result.applied });

    const applied = result.applied;
    if (!applied) return;

    // Everything the Director found goes to the tutor as ONE passive note. Each
    // of these used to be its own nudge, and each nudge forced the tutor to
    // speak: three findings meant three extra turns stacked on top of the one
    // it had just taken, with the student unable to get a word in.
    /** @type {string[]} */
    const notes = [];

    // A factual slip — a number built wrongly, a form that does not exist.
    // Correcting it beats letting the student practise it.
    if (applied.errors.length) {
      const correction = applied.errors
        .map((error) => `You said "${error.said}". That is wrong. The correct version is: ${error.correct}.`)
        .join(' ');
      notes.push(
        `${correction} Put this right in your next turn, in one short sentence, and do not ` +
          'repeat the mistake. Trust this over what you said before.',
      );
    }

    // Phrases the student was asked to parrot with no idea what they meant.
    // Not while a script runs: every scripted line carries its meaning, an
    // unscripted request is caught the moment it is made, and this note
    // arrived a turn late — after the meaning had been given — and had the
    // tutor give it again.
    if (applied.unglossed && applied.unglossed.length && !lessons.runtime.scriptRunning()) {
      const list = applied.unglossed.map((phrase) => `"${phrase}"`).join(', ');
      notes.push(
        `You asked the student to say ${list} without saying what it means. Give the English ` +
          'meaning in your next turn.',
      );
    }

    if (applied.completed) {
      this.note('Lesson complete. The call continues.', 'success');
      notes.push(
        `The ${applied.completedName || 'lesson'} lesson is finished. Say so in one sentence in ` +
          'your next turn, then carry on with ordinary conversation.',
      );
    } else if (applied.phaseChanged) {
      this.note(`Moving on to: ${applied.phaseName}.`, 'info');
      notes.push(
        `The lesson has moved on to ${applied.phaseName}. From your next turn, work on that. ` +
          'Do not announce the change, and do not go back over what they already got right.',
      );
    }

    // A part that exists only to settle something — what to work on — is over
    // the moment it is settled.
    const runtime = lessons.runtime;
    if (
      lessons.isActive && !applied.phaseChanged && !applied.completed && applied.inputs > 0 &&
      runtime.phaseMode() === 'talk' && runtime.pendingInputs().length === 0 && runtime.nextPhase()
    ) {
      const moved = lessons.advancePhase();
      if (moved.ok) {
        applied.phaseChanged = true;
        applied.phaseName = moved.phaseName;
        this.note(`Moving on to: ${moved.phaseName}.`, 'info');
      }
    }

    // While the app is choosing the tutor's words there is nothing for a note
    // to steer: the tutor is not composing anything.
    const scriptedNow = this.directed && lessons.isActive && lessons.runtime.scriptRunning();
    if (notes.length && !scriptedNow) this.nudge(notes.join('\n'));
    if (lessons.isActive) this.ensurePlan();

    // The prompt only needs rebuilding when the advice inside it has changed.
    const after = lessons.runtime.snapshot();
    const moved =
      applied.completed ||
      applied.phaseChanged ||
      applied.inputs > 0 ||
      before.settled_vocab.length !== after.settled_vocab.length ||
      before.struggled_vocab.length !== after.struggled_vocab.length;

    if (moved) this.syncPrompt();
    this.refresh();
  }
}
