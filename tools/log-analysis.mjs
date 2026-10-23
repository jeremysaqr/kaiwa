/**
 * tools/log-analysis.mjs
 *
 * The checks `npm run logs` runs over a session.
 *
 * Pure functions, separated from the printing so they can be tested. None of
 * these is proof of anything — they are signposts towards the part of the log
 * worth reading.
 */

/**
 * Two tens words in a row: "sanjuu sanjuu", "nijuu juu". Never a Japanese
 * number, and the specific failure the language reference exists to prevent.
 */
export const CHAINED_TENS =
  /\b(?:(?:ni|san|yon|go|roku|nana|hachi|kyuu)?juu)\s+(?:(?:ni|san|yon|go|roku|nana|hachi|kyuu)?juu)\b/i;

/** The tutor saying the thing is wrong, rather than saying it. */
const DISOWNING = /not a number|isn'?t a number|never a number|is wrong|not correct/i;

/**
 * A turn that opens by grading the student instead of teaching them.
 *
 * Every one of these costs the student a second of listening and tells them
 * nothing. A few are fine. Most of the turns in a call is the complaint that
 * the tutor never shuts up and never moves on.
 */
const PRAISE_OPENER =
  /^\s*(?:sugoi|subarashii|yoku dekimashita|daijoubu|ii desu(?: ne)?|nice|great|perfect|excellent|wonderful|amazing|good job|well done|awesome|that'?s (?:great|good|correct|perfect|right|natural)|nice (?:try|job|work)|almost there|you'?re (?:doing|almost))\b/i;

/** Praise is only a problem once it is the shape of every turn. */
const PRAISE_LIMIT = 0.25;

/** Student turns in one phase before a stuck lesson is worth reporting. */
const STUCK_PHASE_TURNS = 20;

/** "Next, say rokujuu ichi." The tutor handing over a phrase to parrot. */
const ASKS_FOR_A_PHRASE = /\b(?:next|now)\b[^.?!]{0,40}\b(?:say|repeat)\b/i;

/** Any attempt to tell the student what something means. */
const CARRIES_A_MEANING = /\b(?:means?|meaning|translates?|stands for)\b/i;

/** The student asking, in any words, what they have just been made to say. */
const ASKING_WHAT_IT_MEANS =
  /what (?:does|do|is|are|was)\b[^?]{0,40}\bmean|what.{0,20}\bmean\b|don'?t (?:know|understand) what|no idea what|literal(?:ly)? (?:mean|translat)|translat(?:e|ion) (?:of|for)/i;

/** Below this share of asked-for phrases carrying a meaning, the lesson is parroting. */
const GLOSS_FLOOR = 0.5;

/**
 * @param {any[]} events
 * @returns {{level: 'error'|'check', at: number, text: string}[]}
 */
export function findings(events) {
  // A live log can end mid-line, and a hand-edited one can contain anything.
  // Reviewing a broken log is exactly when this must not fall over.
  const list = (Array.isArray(events) ? events : []).filter(
    (event) => event && typeof event === 'object' && !Array.isArray(event),
  );
  /** @type {{level: 'error'|'check', at: number, text: string}[]} */
  const out = [];

  const prompts = list.filter((event) => event.type === 'prompt');
  const tutorTurns = list.filter((event) => event.type === 'tutor');
  const directorRuns = list.filter((event) => event.type === 'director.response');

  // The stale-build trap: a language that HAS reference data, a lesson that is
  // running, and a prompt with no reference section in it. Nine times out of
  // ten this is a browser holding an older build.
  //
  // Reported once. The prompt is rebuilt on every Director pass, so a lesson
  // that declares no reference produces one of these a minute — thirty-one in
  // one session, which buried every other finding under a wall of identical
  // text and made the report worse than useless.
  const missingReference = prompts.filter(
    (prompt) =>
      prompt.hasLesson &&
      Array.isArray(prompt.referenceKeys) &&
      prompt.referenceKeys.length &&
      !prompt.hasReference,
  );
  if (missingReference.length) {
    const first = missingReference[0];
    const phases = [...new Set(missingReference.map((prompt) => String(prompt.phase || '?')))];
    out.push({
      level: 'check',
      at: first.at || 0,
      text:
        `${missingReference.length} prompt(s) carried no # REFERENCE even though the language has ` +
        `${first.referenceKeys.join(', ')} — phase(s) ${phases.join(', ')}. Either those phases ` +
        'declare none, or the browser is running an older build; hard-refresh and try again.',
    });
  }

  for (const turn of tutorTurns) {
    const text = String(turn.text || '');
    // Chaining tens WHILE saying it is not a number is the tutor correcting
    // itself. That is the behaviour we want, not a fault.
    if (CHAINED_TENS.test(text) && !DISOWNING.test(text)) {
      out.push({
        level: 'error',
        at: turn.at || 0,
        text: `Tutor chained two tens words — never a Japanese number: "${text.slice(0, 120)}"`,
      });
    }
  }

  if (prompts.length === 0) {
    out.push({ level: 'error', at: 0, text: 'No prompt was ever logged. The call may not have started.' });
  }

  const failed = directorRuns.filter((event) => event.ok === false);
  if (directorRuns.length && failed.length === directorRuns.length) {
    out.push({
      level: 'error',
      at: failed[0].at || 0,
      text: `Every Lesson Director pass failed (${failed[0].error || 'no reason given'}). Nothing was recorded all session.`,
    });
  }

  const lessonStarted = list.some((event) => event.type === 'lesson.change' && event.to);
  if (lessonStarted && directorRuns.length === 0) {
    out.push({ level: 'check', at: 0, text: 'A lesson ran but the Director never reported. Progress cannot move.' });
  }

  for (const event of list.filter((entry) => entry.type === 'realtime.error')) {
    out.push({ level: 'error', at: event.at || 0, text: `Session error: ${event.message}` });
  }

  // The tutor went deaf: the student spoke, it was transcribed, and the server
  // never started a response. The client now rescues these, but a run of them
  // means turn detection is fighting the student all call.
  const rescued = list.filter((event) => event.type === 'turn.rescued');
  if (rescued.length) {
    out.push({
      level: rescued.length > 3 ? 'error' : 'check',
      at: rescued[0].at || 0,
      text:
        `${rescued.length} student turn(s) went unanswered and had to be prompted by the app. ` +
        'The student experiences this as the tutor hanging.',
    });
  }

  // Praise as a verbal tic. Counted rather than quoted: one "sugoi" is warmth,
  // sixty is the reason the student cannot get a word in.
  if (tutorTurns.length >= 10) {
    const praised = tutorTurns.filter((turn) => PRAISE_OPENER.test(String(turn.text || '')));
    const share = praised.length / tutorTurns.length;
    if (share > PRAISE_LIMIT) {
      out.push({
        level: 'check',
        at: praised[0].at || 0,
        text:
          `${Math.round(share * 100)}% of the tutor's ${tutorTurns.length} turns open with praise ` +
          `(e.g. "${String(praised[0].text || '').slice(0, 60)}"). The prompt forbids this.`,
      });
    }
  }

  // Parroting: the tutor handing over phrase after phrase with no English
  // attached. The student's own summary of a session like this was "I'm saying
  // them, but I'm not getting anything out of this".
  const asked = tutorTurns.filter((turn) => ASKS_FOR_A_PHRASE.test(String(turn.text || '')));
  if (asked.length >= 10) {
    const glossed = asked.filter((turn) => CARRIES_A_MEANING.test(String(turn.text || '')));
    const share = glossed.length / asked.length;
    if (share < GLOSS_FLOOR) {
      out.push({
        level: 'error',
        at: asked[0].at || 0,
        text:
          `The tutor asked the student to say a phrase ${asked.length} time(s) and told them what ` +
          `it meant in ${glossed.length} of those. Repeating sounds they cannot translate teaches ` +
          'nothing.',
      });
    }
  }

  // The same thing from the other side, and far harder to argue with: the
  // student asking outright.
  const confused = list.filter(
    (event) => event.type === 'student' && ASKING_WHAT_IT_MEANS.test(String(event.text || '')),
  );
  if (confused.length >= 2) {
    out.push({
      level: 'error',
      at: confused[0].at || 0,
      text:
        `The student asked what something meant ${confused.length} time(s), starting with ` +
        `"${String(confused[0].text || '').slice(0, 70)}". Every one of those is a phrase they ` +
        'were asked to say blind.',
    });
  }

  // The label tic: banning praise taught the model to open with a category
  // instead, including on turns where the student was right.
  const labelled = tutorTurns.filter((turn) =>
    /^\s*(?:particle|sound|word order|correction|wrong (?:particle|month|word))\b/i.test(
      String(turn.text || ''),
    ),
  );
  // Counted absolutely rather than as a share: a correction label is desirable
  // when there IS a fault, so the tool cannot tell a good one from a bad one.
  // Five of them is enough to be worth a human glance, and few enough that a
  // session with one or two genuine corrections stays quiet.
  if (labelled.length >= 5) {
    out.push({
      level: 'check',
      at: labelled[0].at || 0,
      text:
        `${labelled.length} turn(s) open with a correction label (e.g. ` +
        `"${String(labelled[0].text || '').slice(0, 50)}"). Check these are all real faults — the ` +
        'label is meant to be absent when nothing was wrong.',
    });
  }

  // The tutor speaking twice with nothing from the student in between: one
  // question, then another before the first could be answered. The opening
  // greeting is exempt — nobody has spoken yet.
  const spoken = list.filter((event) => event.type === 'student' || event.type === 'tutor');
  let stacked = 0;
  let firstStack = null;
  for (let i = 1; i < spoken.length; i += 1) {
    if (spoken[i].type !== 'tutor' || spoken[i - 1].type !== 'tutor') continue;
    if (!spoken.slice(0, i).some((event) => event.type === 'student')) continue;
    stacked += 1;
    if (!firstStack) firstStack = spoken[i];
  }
  if (stacked) {
    out.push({
      level: stacked > 2 ? 'error' : 'check',
      at: firstStack.at || 0,
      text:
        `${stacked} time(s) the tutor spoke twice in a row, giving a second prompt before the ` +
        `student could answer the first (e.g. "${String(firstStack.text || '').slice(0, 60)}").`,
    });
  }

  // Two asks in one breath: "say X, then say Y".
  const doubled = tutorTurns.filter((turn) =>
    /\b(?:then|and then|after that|next)\b[^.?!]{0,40}\b(?:say|repeat|tell me|give me|add)\b/i.test(String(turn.text || '')) &&
    /\b(?:say|repeat)\b/i.test(String(turn.text || '').split(/\b(?:then|and then|after that)\b/i)[0] || ''),
  );
  if (doubled.length >= 3) {
    out.push({
      level: 'check',
      at: doubled[0].at || 0,
      text:
        `${doubled.length} turn(s) ask for two things at once (e.g. ` +
        `"${String(doubled[0].text || '').slice(0, 70)}"). The rule is one ask per turn.`,
    });
  }

  // A phase that never ends. The Director is meant to move the lesson and the
  // app takes over when it does not, so this should now be unreachable.
  let worstPhase = null;
  for (const event of list.filter((entry) => entry.type === 'director.request')) {
    const turnsInPhase = Number(event.turnsInPhase);
    if (!Number.isFinite(turnsInPhase)) continue;
    if (!worstPhase || turnsInPhase > worstPhase.turnsInPhase) {
      worstPhase = { turnsInPhase, at: event.at || 0, phase: String(event.phase || '') };
    }
  }
  if (worstPhase && worstPhase.turnsInPhase >= STUCK_PHASE_TURNS) {
    out.push({
      level: 'error',
      at: worstPhase.at,
      text:
        `The lesson spent ${worstPhase.turnsInPhase} student turns in "${worstPhase.phase}" ` +
        'without moving on. Neither the Director nor the automatic advance took it forward.',
    });
  }

  return out.sort((a, b) => a.at - b.at);
}
